// AI provider interface — the seam a real LLM / vision / STT vendor
// plugs into (Phase 3, item 1). The service ONLY talks to this interface
// and NEVER to a vendor SDK directly.
//
// Contract every provider must honour:
//   1. It receives PII-REDACTED text only. The service redacts before
//      calling; providers must also call assertNoPii() defensively.
//   2. parseIntent never throws on unparseable input — it returns
//      service=null with fallbackToKeywordSearch=true.
//   3. Capabilities a provider does not have are reported honestly via
//      the `capabilities` map and a typed error / unavailable flag —
//      never faked with invented output.
//
// The only provider wired in this repo is LocalAiProvider (rule-based,
// no network, no key). A remote provider (OpenAI / Google Gemini /
// Google Cloud Vision + Speech-to-Text + Translation) is a new class
// implementing this interface, selected by AI_PROVIDER env; see
// README.md for the exact account + cost needed to create one.

import { ParsedIntent } from '../intent-parser';
import { CategoryAlias } from './builtin-aliases';

export type ProviderName = 'local';

export interface PhotoInput {
  mediaKey?: string;
  /** Client-supplied description / OCR text / file name hints. */
  description?: string;
  tags?: string[];
}

export interface PhotoSuggestion {
  categoryId: string;
  categorySlug: string;
  nameEn: string;
  confidence: number;
}

export interface VoiceInput {
  /** Transcript from on-device STT (mobile) or a prior STT step. */
  transcript?: string;
  /** Storage key of an audio clip — local provider cannot transcribe it. */
  audioKey?: string;
  language?: string;
}

export interface TranslationResult {
  translated: string;
  /** False when the provider could not translate (local dictionary miss). */
  translatedByProvider: boolean;
  method: 'dictionary' | 'model' | 'none';
}

export interface AiProvider {
  readonly name: ProviderName;
  readonly capabilities: { intent: boolean; photo: boolean; voiceStt: boolean; translation: boolean };
  parseIntent(redactedText: string, aliases: CategoryAlias[]): Promise<ParsedIntent>;
  suggestCategoryFromPhoto(input: PhotoInput, aliases: CategoryAlias[]): Promise<{ suggestions: PhotoSuggestion[]; method: string; note: string }>;
  transcribeVoice(input: VoiceInput): Promise<{ transcript: string | null; status: 'transcribed' | 'unavailable' | 'needs_transcript'; note: string }>;
  translate(text: string, target: 'ur' | 'en'): Promise<TranslationResult>;
}
