// AI Gateway service (Phase 3 items 1 + 9).
//
// Flow for every free-text call: redact PII FIRST, then call the
// provider with redacted text only. The provider is selected by
// AI_PROVIDER env ('local' is the only provider in this repo; any other
// value fails closed at construction so a misconfigured deploy can
// never silently call an unconfigured vendor).

import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import { AiProvider } from './providers/ai-provider.interface';
import { LocalAiProvider } from './providers/local-ai.provider';
import { BUILTIN_ALIASES, CategoryAlias } from './providers/builtin-aliases';
import { redactPii } from './providers/pii-redactor';
import { estimateFairPrice, PriceSample } from './fair-price-model';
import { resolveCategoryId, isUuid } from '../../common/utils/category-resolve';

export interface IntentLogRow { text: string; userId?: string }

@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly provider: AiProvider;

  constructor(private db: DatabaseService) {
    const configured = (process.env.AI_PROVIDER ?? 'local').toLowerCase();
    if (configured !== 'local') {
      throw new Error(`AI_PROVIDER='${configured}' is not configured in this deployment — no remote provider is wired in. Set AI_PROVIDER=local or add the provider (see ai-gateway README.md).`);
    }
    this.provider = new LocalAiProvider();
  }

  get providerName(): string { return this.provider.name; }
  get capabilities() { return this.provider.capabilities; }

  /** Load the live taxonomy + keyword aliases from the DB, merged over
   *  the built-in table (DB rows win; built-ins cover categories with
   *  no keyword rows). Falls back to built-ins alone when the DB is
   *  unavailable, so intent parsing never depends on a live database. */
  async loadAliases(): Promise<CategoryAlias[]> {
    try {
      const cats = (await this.db.query<{ id: string; slug: string; name_en: string; name_ur: string | null; name_roman: string | null }>(
        `SELECT id, slug, name_en, name_ur, name_roman FROM categories WHERE is_active ORDER BY sort_order`)).rows;
      const kws = (await this.db.query<{ category_id: string; keyword: string }>(
        `SELECT category_id, keyword FROM category_keywords`)).rows;
      const byId = new Map<string, CategoryAlias>();
      for (const c of cats) {
        byId.set(c.id, { categoryId: c.id, slug: c.slug, nameEn: c.name_en, aliases: [c.name_en, c.name_ur ?? '', c.name_roman ?? '', c.slug.replace(/-/g, ' ')].filter(Boolean) });
      }
      for (const k of kws) {
        const cat = byId.get(k.category_id);
        if (cat && !cat.aliases.includes(k.keyword)) cat.aliases.push(k.keyword);
      }
      // Merge built-in aliases for categories the DB knows, and keep
      // built-ins for any category missing from the DB entirely.
      for (const b of BUILTIN_ALIASES) {
        const live = [...byId.values()].find((c) => c.slug === b.slug);
        if (live) { for (const a of b.aliases) if (!live.aliases.includes(a)) live.aliases.push(a); }
        else byId.set(b.categoryId, b);
      }
      return [...byId.values()];
    } catch (e) {
      this.logger.warn(`alias load failed, using built-in taxonomy: ${(e as Error).message}`);
      return BUILTIN_ALIASES;
    }
  }

  /** (a) Intent parsing. Returns strict JSON; on parse failure the
   *  response itself carries fallback_to_keyword_search=true. */
  async parseIntent(text: string, userId?: string) {
    const redacted = redactPii(text);
    const aliases = await this.loadAliases();
    const intent = await this.provider.parseIntent(redacted.text, aliases);
    await this.logIntent(redacted.text, intent, userId);
    return { ...intent, provider: this.provider.name, pii_redacted: redacted.redacted };
  }

  private async logIntent(redactedText: string, intent: { service: unknown; confidence: number; fallbackToKeywordSearch: boolean }, userId?: string): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO ai_intent_logs (user_id, input_text, category_id, confidence, fell_back_to_search) VALUES ($1,$2,$3,$4,$5)`,
        [userId ?? null, redactedText, (intent.service as { category_id?: string } | null)?.category_id ?? null, intent.confidence, intent.fallbackToKeywordSearch],
      );
    } catch (e) {
      // Intent logging must never break intent parsing (table may not
      // exist yet on a deploy that has not run migration 0010).
      this.logger.warn(`ai_intent_logs insert skipped: ${(e as Error).message}`);
    }
  }

  /** (b) Photo search — heuristic category suggestion from the
   *  description/tags/filename of a photo of the problem. */
  async suggestFromPhoto(input: { media_key?: string; description?: string; tags?: string[] }) {
    if (!input.description?.trim() && !(input.tags ?? []).length && !input.media_key?.trim()) {
      throw Errors.unprocessable('PHOTO_INPUT_REQUIRED', 'Provide at least one of description, tags or media_key');
    }
    const aliases = await this.loadAliases();
    const out = await this.provider.suggestCategoryFromPhoto(
      { mediaKey: input.media_key, description: input.description, tags: input.tags }, aliases);
    return { ...out, provider: this.provider.name };
  }

  /** (c) Voice search. Transcript in -> redacted text + intent out, with
   *  requires_confirmation=true: the client MUST show the transcript
   *  for manual correction before a request is posted. Audio-only is
   *  honestly unavailable on the local provider (422 STT_UNAVAILABLE). */
  async voiceSearch(input: { transcript?: string; audio_key?: string; language?: string }) {
    const stt = await this.provider.transcribeVoice({ transcript: input.transcript, audioKey: input.audio_key, language: input.language ?? 'ur' });
    if (stt.status === 'unavailable') throw Errors.unprocessable('STT_UNAVAILABLE', stt.note);
    if (stt.status === 'needs_transcript') throw Errors.unprocessable('VOICE_INPUT_REQUIRED', stt.note);
    const redacted = redactPii(stt.transcript!);
    const aliases = await this.loadAliases();
    const intent = await this.provider.parseIntent(redacted.text, aliases);
    await this.logIntent(redacted.text, intent);
    return {
      transcript: redacted.text,
      corrected_query: intent.fallbackToKeywordSearch ? redacted.text : (intent.service?.name_en ?? redacted.text),
      intent,
      requires_confirmation: true,
      provider: this.provider.name,
      pii_redacted: redacted.redacted,
    };
  }

  /** (d) Learned fair-price model over completed-job prices for
   *  (category, city, spec quantity). Falls back to the percentile
   *  range when the sample is too thin / flat / noisy — see
   *  fair-price-model.ts. Also writes a snapshot row for audit. */
  async fairPrice(categoryId: string | undefined, categorySlug: string | undefined, cityId: string | undefined, quantity: number | null) {
    const resolved = await resolveCategoryId(
      { byId: async (id: string) => (await this.db.query<{ id: string }>(`SELECT id FROM categories WHERE id=$1 AND is_active`, [id])).rows[0] ?? null,
        bySlug: async (slug: string) => (await this.db.query<{ id: string }>(`SELECT id FROM categories WHERE slug=$1 AND is_active`, [slug])).rows[0] ?? null },
      { category_id: categoryId, category_slug: categorySlug },
    );
    if (cityId && !isUuid(cityId)) throw Errors.unprocessable('CITY_ID_NOT_UUID', 'city_id must be a UUID', { city_id: cityId });
    const rows = (await this.db.query<{ price: string; qty: string | null; city: string | null }>(
      `SELECT j.agreed_price::text AS price,
              COALESCE((r.specs->>'books')::int, (r.specs->>'rooms')::int, (r.specs->>'quantity')::int) AS qty,
              (SELECT c.id FROM cities c ORDER BY ST_Distance(c.center, r.location) ASC LIMIT 1) AS city
       FROM jobs j JOIN service_requests r ON r.id=j.request_id
       WHERE r.category_id=$1 AND j.state IN ('COMPLETED','PAYMENT_SETTLED','RATED')
         AND ($2::uuid IS NULL OR (SELECT c.id FROM cities c ORDER BY ST_Distance(c.center, r.location) ASC LIMIT 1) = $2)
       ORDER BY j.created_at DESC LIMIT 500`,
      [resolved, cityId ?? null])).rows;
    const samples: PriceSample[] = rows.map((r) => ({ price: Number(r.price), quantity: r.qty == null ? null : Number(r.qty) }));
    const estimate = estimateFairPrice(samples, quantity);
    await this.snapshotFairPrice(resolved, cityId ?? null, quantity, estimate);
    return {
      category_id: resolved, city_id: cityId ?? null, quantity,
      min: estimate.min, typical: estimate.typical, max: estimate.max,
      sample_size: estimate.sampleSize, source: estimate.source,
      r_squared: estimate.rSquared ?? null, hidden: estimate.hidden,
      provider: this.provider.name,
    };
  }

  private async snapshotFairPrice(categoryId: string, cityId: string | null, quantity: number | null, estimate: { source: string; min: number; typical: number; max: number; sampleSize: number; rSquared?: number }): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO fair_price_snapshots (category_id, city_id, quantity, source, min_price, typical_price, max_price, sample_size, r_squared)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [categoryId, cityId, quantity, estimate.source, estimate.min, estimate.typical, estimate.max, estimate.sampleSize, estimate.rSquared ?? null],
      );
    } catch (e) {
      this.logger.warn(`fair_price_snapshots insert skipped: ${(e as Error).message}`);
    }
  }

  // ---- Chat translation (item 9) ----

  private async assertParticipant(chatId: string, userId: string): Promise<void> {
    const chat = (await this.db.query<{ customer_id: string; provider_user_id: string }>(
      `SELECT c.customer_id, p.user_id AS provider_user_id FROM chats c JOIN provider_profiles p ON p.id=c.provider_id WHERE c.id=$1`, [chatId])).rows[0];
    if (!chat) throw Errors.notFound('Chat');
    if (userId !== chat.customer_id && userId !== (chat as unknown as { provider_user_id: string }).provider_user_id) {
      throw Errors.forbidden('Not a participant');
    }
  }

  async getTranslationPref(chatId: string, userId: string) {
    await this.assertParticipant(chatId, userId);
    const row = (await this.db.query<{ target_lang: string; auto_translate: boolean }>(
      `SELECT target_lang, auto_translate FROM chat_translation_prefs WHERE chat_id=$1 AND user_id=$2`, [chatId, userId])).rows[0];
    return { chat_id: chatId, target_lang: row?.target_lang ?? null, auto_translate: row?.auto_translate ?? false };
  }

  async setTranslationPref(chatId: string, userId: string, targetLang: 'ur' | 'en' | null, autoTranslate: boolean) {
    await this.assertParticipant(chatId, userId);
    if (targetLang === null && autoTranslate) {
      throw Errors.unprocessable('TRANSLATION_TARGET_REQUIRED', 'auto_translate requires a target_lang');
    }
    const row = (await this.db.query(
      `INSERT INTO chat_translation_prefs (chat_id, user_id, target_lang, auto_translate, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (chat_id, user_id) DO UPDATE SET target_lang=EXCLUDED.target_lang, auto_translate=EXCLUDED.auto_translate, updated_at=now()
       RETURNING chat_id, target_lang, auto_translate`,
      [chatId, userId, targetLang, autoTranslate])).rows[0];
    return { chat_id: row.chat_id, target_lang: row.target_lang, auto_translate: row.auto_translate };
  }

  /** Translate one message. The ORIGINAL text is always preserved and
   *  returned alongside the translation; the stored translation row
   *  never overwrites messages.body. */
  async translateMessage(chatId: string, messageId: string, userId: string, targetLang: 'ur' | 'en') {
    await this.assertParticipant(chatId, userId);
    const msg = (await this.db.query<{ id: string; body: string | null }>(
      `SELECT id, body FROM messages WHERE id=$1 AND chat_id=$2`, [messageId, chatId])).rows[0];
    if (!msg) throw Errors.notFound('Message');
    if (!msg.body?.trim()) throw Errors.unprocessable('MESSAGE_NOT_TRANSLATABLE', 'Message has no text to translate');
    const redacted = redactPii(msg.body);
    const result = await this.provider.translate(redacted.text, targetLang);
    const stored = (await this.db.query<{ translated_text: string }>(
      `INSERT INTO message_translations (message_id, target_lang, translated_text, provider, translated_by_provider)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (message_id, target_lang) DO UPDATE SET translated_text=EXCLUDED.translated_text, provider=EXCLUDED.provider,
         translated_by_provider=EXCLUDED.translated_by_provider, created_at=now()
       RETURNING translated_text`,
      [messageId, targetLang, result.translated, this.provider.name, result.translatedByProvider])).rows[0];
    return {
      message_id: messageId, chat_id: chatId,
      original: msg.body,
      translated: stored.translated_text, target_lang: targetLang,
      translated_by_provider: result.translatedByProvider, method: result.method,
      provider: this.provider.name, pii_redacted: redacted.redacted,
      note: result.translatedByProvider ? undefined : 'Local dictionary has no translation for this text — original shown unchanged. Full translation needs the real provider (see ai-gateway README.md).',
    };
  }
}
