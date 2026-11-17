// AI Gateway unit tests (Phase 3). Pure functions + service with a
// fake DatabaseService — no live DB, no network, no vendor key.
import { redactPii, assertNoPii } from '../../src/modules/ai-gateway/providers/pii-redactor';
import { parseIntentLocal } from '../../src/modules/ai-gateway/intent-parser';
import { trainFairPriceModel, estimateFairPrice, MIN_SAMPLES_FOR_MODEL } from '../../src/modules/ai-gateway/fair-price-model';
import { LocalAiProvider } from '../../src/modules/ai-gateway/providers/local-ai.provider';
import { BUILTIN_ALIASES } from '../../src/modules/ai-gateway/providers/builtin-aliases';
import { AiGatewayService } from '../../src/modules/ai-gateway/ai-gateway.service';

describe('PII redaction (no CNIC / phone / email ever reaches a provider)', () => {
  it('redacts a dashed CNIC', () => {
    const r = redactPii('meri cnic 35202-1234567-1 hai');
    expect(r.text).not.toContain('35202');
    expect(r.text).toContain('[REDACTED_CNIC]');
    expect(r.redacted).toContain('cnic');
    expect(r.hadPii).toBe(true);
  });
  it('redacts a bare 13-digit CNIC but not a quantity like 20', () => {
    expect(redactPii('cnic 3520212345671').text).toContain('[REDACTED_CNIC]');
    const clean = redactPii('meri kitabon ki jild banwani hai 20 kitabein');
    expect(clean.hadPii).toBe(false);
    expect(clean.text).toContain('20 kitabein');
  });
  it('redacts Pakistani mobiles and emails', () => {
    expect(redactPii('call 0301-2345678').redacted).toContain('phone');
    expect(redactPii('call +92 301 2345678').redacted).toContain('phone');
    expect(redactPii('mail ali@example.com').redacted).toContain('email');
  });
  it('assertNoPii refuses unredacted provider input', () => {
    expect(() => assertNoPii('cnic 35202-1234567-1')).toThrow();
    expect(() => assertNoPii('clean text')).not.toThrow();
  });
});

describe('intent parsing', () => {
  it('parses the spec example: book binding, 20 books', () => {
    const r = parseIntentLocal('meri kitabon ki jild banwani hai 20 kitabein');
    expect(r.service?.category_slug).toBe('book-binding');
    expect(r.quantity).toBe(20);
    expect(r.fallbackToKeywordSearch).toBe(false);
    expect(r.confidence).toBeGreaterThan(0.5);
  });
  it('parses Urdu script + English', () => {
    expect(parseIntentLocal('جلد سازی کروانی ہے').service?.category_slug).toBe('book-binding');
    expect(parseIntentLocal('AC repair needed, gas refill').service?.category_slug).toBe('ac-repair');
    expect(parseIntentLocal('nalka band hai, pani leakage ho raha hai').service?.category_slug).toBe('plumber');
  });
  it('parses Roman-Urdu number words and urgency', () => {
    const r = parseIntentLocal('bees kitabein jild karwani hain foran');
    expect(r.quantity).toBe(20);
    expect(r.urgency).toBe('now');
    expect(parseIntentLocal('bijli ka kaam hai aaj').urgency).toBe('today');
    expect(parseIntentLocal('kal darzi chahiye').urgency).toBe('scheduled');
    expect(parseIntentLocal('mobile theek karwana hai').urgency).toBe('flexible');
  });
  it('falls back to keyword search on unparseable input (no throw)', () => {
    const r = parseIntentLocal('xyzzy plugh frobnicate');
    expect(r.service).toBeNull();
    expect(r.fallbackToKeywordSearch).toBe(true);
    expect(r.searchQuery).toBe('xyzzy plugh frobnicate');
    const empty = parseIntentLocal('');
    expect(empty.fallbackToKeywordSearch).toBe(true);
  });
  it('folds Urdu digits', () => {
    expect(parseIntentLocal('۲۰ kitabein jild').quantity).toBe(20);
  });
});

describe('local provider', () => {
  const provider = new LocalAiProvider();
  it('never sees PII: parseIntent throws on unredacted CNIC', async () => {
    await expect(provider.parseIntent('cnic 35202-1234567-1', BUILTIN_ALIASES)).rejects.toThrow();
  });
  it('photo suggestion is heuristic keyword matching, not vision', async () => {
    const out = await provider.suggestCategoryFromPhoto({ description: 'my AC is not cooling, needs gas refill' }, BUILTIN_ALIASES);
    expect(out.suggestions[0].categorySlug).toBe('ac-repair');
    expect(out.method).toBe('heuristic-keyword');
    const none = await provider.suggestCategoryFromPhoto({ description: 'xyzzy plugh' }, BUILTIN_ALIASES);
    expect(none.suggestions).toEqual([]);
  });
  it('voice: transcript in -> transcribed; audio-only -> unavailable (no invented transcript)', async () => {
    const ok = await provider.transcribeVoice({ transcript: 'ac theek karwana hai' });
    expect(ok.status).toBe('transcribed');
    expect(ok.transcript).toBe('ac theek karwana hai');
    const no = await provider.transcribeVoice({ audioKey: 'uploads/voice/abc.m4a' });
    expect(no.status).toBe('unavailable');
    expect(no.transcript).toBeNull();
  });
  it('translation: dictionary hit translates, miss returns original unchanged', async () => {
    const hit = await provider.translate('thank you', 'ur');
    expect(hit.translated).toBe('شکریہ');
    expect(hit.translatedByProvider).toBe(true);
    const miss = await provider.translate('the motor burned out yesterday morning', 'ur');
    expect(miss.translated).toBe('the motor burned out yesterday morning');
    expect(miss.translatedByProvider).toBe(false);
  });
});

describe('learned fair-price model', () => {
  // Clean linear data: price = 100 + 50 * books.
  const linear = Array.from({ length: 12 }, (_, i) => ({ price: 100 + 50 * (i + 1), quantity: i + 1 }));
  it('trains on clean data and predicts per-unit price', () => {
    const m = trainFairPriceModel(linear);
    expect(m).not.toBeNull();
    expect(m!.perUnit).toBeCloseTo(50, 6);
    expect(m!.rSquared).toBeCloseTo(1, 6);
    const est = estimateFairPrice(linear, 20);
    expect(est.source).toBe('model');
    expect(est.typical).toBeCloseTo(1100, 0);
  });
  it('falls back to percentiles when the sample is too small', () => {
    expect(trainFairPriceModel(linear.slice(0, MIN_SAMPLES_FOR_MODEL - 1))).toBeNull();
    const est = estimateFairPrice([{ price: 2400, quantity: 10 }, { price: 2600, quantity: 12 }], 10);
    expect(est.source).toBe('percentile');
    expect(est.sampleSize).toBe(2);
  });
  it('falls back when quantity never varies or data is noise', () => {
    const flat = Array.from({ length: 10 }, (_, i) => ({ price: 2000 + i * 37, quantity: 5 }));
    expect(trainFairPriceModel(flat)).toBeNull();
    const noisy = Array.from({ length: 10 }, (_, i) => ({ price: [100, 9000, 200, 8000, 150, 9500, 300, 7000, 250, 8500][i], quantity: i + 1 }));
    expect(trainFairPriceModel(noisy)).toBeNull();
    expect(estimateFairPrice(noisy, 5).source).toBe('percentile');
  });
});

describe('AiGatewayService (fake DB)', () => {
  function fakeDb(overrides: Record<string, unknown> = {}) {
    const query = jest.fn(async (text: string, _params?: unknown[]) => {
      if (text.includes('FROM categories')) return { rows: [{ id: '00000000-0000-4000-8000-0000b0000001', slug: 'book-binding', name_en: 'Book Binding', name_ur: 'کتاب کی جلد', name_roman: 'Book Binding' }] };
      if (text.includes('FROM category_keywords')) return { rows: [{ category_id: '00000000-0000-4000-8000-0000b0000001', keyword: 'jild saazi' }] };
      if (text.includes('ai_intent_logs') || text.includes('fair_price_snapshots')) return { rows: [] };
      if (text.includes('FROM jobs j')) return { rows: (overrides.jobRows as unknown[]) ?? [] };
      return { rows: [] };
    });
    return { query, db: { query } as unknown as import('../../src/database/database.service').DatabaseService };
  }

  it('parseIntent redacts PII before logging and returns strict JSON', async () => {
    const { db, query } = fakeDb();
    const svc = new AiGatewayService(db);
    const out = await svc.parseIntent('meri kitabon ki jild banwani hai 20 kitabein, cnic 35202-1234567-1', 'user-1');
    expect(out.service!.category_slug).toBe('book-binding');
    expect(out.quantity).toBe(20);
    expect(out.pii_redacted).toContain('cnic');
    const logCall = query.mock.calls.find((c) => String(c[0]).includes('ai_intent_logs'));
    expect(logCall).toBeDefined();
    expect(JSON.stringify(logCall![1] as unknown[])).not.toContain('35202');
  });

  it('voiceSearch requires confirmation and refuses audio-only', async () => {
    const { db } = fakeDb();
    const svc = new AiGatewayService(db);
    const out = await svc.voiceSearch({ transcript: 'ac theek karwana hai foran' });
    expect(out.requires_confirmation).toBe(true);
    expect(out.intent.service!.category_slug).toBe('ac-repair');
    expect(out.intent.urgency).toBe('now');
    await expect(svc.voiceSearch({ audio_key: 'uploads/voice/x.m4a' })).rejects.toMatchObject({ code: 'STT_UNAVAILABLE' });
    await expect(svc.voiceSearch({})).rejects.toMatchObject({ code: 'VOICE_INPUT_REQUIRED' });
  });

  it('fairPrice uses the model on enough data, percentiles on thin data', async () => {
    const jobRows = Array.from({ length: 12 }, (_, i) => ({ price: String(100 + 50 * (i + 1)), qty: String(i + 1), city: null }));
    const { db } = fakeDb({ jobRows });
    const svc = new AiGatewayService(db);
    const est = await svc.fairPrice(undefined, 'book-binding', undefined, 20);
    expect(est.source).toBe('model');
    expect(est.typical).toBeCloseTo(1100, 0);
    const { db: thinDb } = fakeDb({ jobRows: [{ price: '2400', qty: '10', city: null }] });
    const thin = await new AiGatewayService(thinDb).fairPrice(undefined, 'book-binding', undefined, 10);
    expect(thin.source).toBe('percentile');
  });
});
