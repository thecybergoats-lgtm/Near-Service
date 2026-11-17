// Local AI provider — the WORKING provider shipped in this repo.
//
// No network, no key, no vendor: rule-based intent parsing over the
// category taxonomy, heuristic photo-category matching over client
// supplied description/tags/filename, dictionary chat translation, and
// NO speech-to-text (honestly reported as unavailable — see
// transcribeVoice). The fair-price model lives in fair-price-model.ts
// and is trained on completed-job prices, not by this provider.
//
// A remote provider replaces this class behind AiProvider; the service
// never changes. See README.md for the account + cost to create one.

import { AiProvider, PhotoInput, PhotoSuggestion, VoiceInput, TranslationResult } from './ai-provider.interface';
import { parseIntentLocal, ParsedIntent } from '../intent-parser';
import { CategoryAlias } from './builtin-aliases';
import { assertNoPii } from './pii-redactor';
import { translateDictionary } from '../translation-phrases';

export class LocalAiProvider implements AiProvider {
  readonly name = 'local' as const;
  readonly capabilities = { intent: true, photo: true, voiceStt: false, translation: true };

  async parseIntent(redactedText: string, aliases: CategoryAlias[]): Promise<ParsedIntent> {
    assertNoPii(redactedText);
    return parseIntentLocal(redactedText, aliases);
  }

  /** Heuristic only: matches description/tags/filename tokens against
   *  category aliases. This is NOT vision — no image pixels are read.
   *  Returns ranked suggestions (best first, max 3) or an empty list
   *  with fallback guidance when nothing matches. */
  async suggestCategoryFromPhoto(input: PhotoInput, aliases: CategoryAlias[]): Promise<{ suggestions: PhotoSuggestion[]; method: string; note: string }> {
    const haystack = [input.description ?? '', (input.tags ?? []).join(' '), input.mediaKey ?? '']
      .join(' ').toLowerCase();
    if (!haystack.trim()) {
      return { suggestions: [], method: 'heuristic-keyword', note: 'No description, tags or filename supplied — add a short description of the problem so a category can be suggested.' };
    }
    const scored: Array<PhotoSuggestion & { score: number }> = [];
    for (const cat of aliases) {
      let score = 0;
      for (const alias of cat.aliases) {
        const a = alias.toLowerCase();
        if (haystack.includes(a)) score += 2 + Math.min(1, a.length / 20);
      }
      if (score > 0) scored.push({ categoryId: cat.categoryId, categorySlug: cat.slug, nameEn: cat.nameEn, confidence: Math.min(0.95, score / 6), score });
    }
    scored.sort((x, y) => y.score - x.score);
    const suggestions: PhotoSuggestion[] = scored.slice(0, 3).map(({ categoryId, categorySlug, nameEn, confidence }) => ({ categoryId, categorySlug, nameEn, confidence: Math.round(confidence * 100) / 100 }));
    return {
      suggestions,
      method: 'heuristic-keyword',
      note: suggestions.length
        ? 'Heuristic keyword match on the supplied description/tags — not image recognition. Confirm the category before posting the request.'
        : 'No category matched the description/tags — try different words or pick a category manually.',
    };
  }

  /** Local provider has no STT model. When the client already has a
   *  transcript (on-device speech recognition on the phone) it is
   *  returned for the normal intent/search path; an audio-only clip is
   *  honestly reported unavailable instead of inventing a transcript. */
  async transcribeVoice(input: VoiceInput): Promise<{ transcript: string | null; status: 'transcribed' | 'unavailable' | 'needs_transcript'; note: string }> {
    if (input.transcript?.trim()) {
      return { transcript: input.transcript.trim(), status: 'transcribed', note: 'Transcript supplied by the client (on-device speech recognition).' };
    }
    if (input.audioKey) {
      return { transcript: null, status: 'unavailable', note: 'No speech-to-text model is configured in this deployment (local provider has no STT). Create a Google Cloud Speech-to-Text account — see ai-gateway README.md — or send a transcript from on-device recognition.' };
    }
    return { transcript: null, status: 'needs_transcript', note: 'Send either a transcript (on-device speech recognition) or an audio_key once an STT provider is configured.' };
  }

  async translate(text: string, target: 'ur' | 'en'): Promise<TranslationResult> {
    assertNoPii(text);
    const hit = translateDictionary(text, target);
    if (hit.found) return { translated: hit.translated, translatedByProvider: true, method: 'dictionary' };
    return { translated: text, translatedByProvider: false, method: 'none' };
  }
}
