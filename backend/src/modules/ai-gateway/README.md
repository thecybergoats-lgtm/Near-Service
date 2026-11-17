# AI Gateway — Phase 3 items 1 (AI search) + 9 (chat translation)

One provider interface (`providers/ai-provider.interface.ts`) behind which
the service runs. The only provider wired in this repo is the **local
provider** (`providers/local-ai.provider.ts`): rule-based, no network, no
API key, no vendor. Nothing in this module invents a key, calls a vendor,
or sends PII anywhere.

## What the local provider actually does

| Feature | Local behaviour (honest) |
|---|---|
| Intent parsing (`POST /ai/intent`) | Rule-based match over the live category taxonomy + `category_keywords` (merged over `providers/builtin-aliases.ts`, copied from `db/0004_seed.sql`). Returns strict JSON `{service, quantity, quantity_unit, urgency, confidence, fallback_to_keyword_search, search_query}`. On no match: `service=null`, `fallback_to_keyword_search=true` — the client silently uses normal keyword search (`GET /search`). Quantity from digits, Urdu/Arabic digits, or Roman-Urdu/English number words (`bees` = 20). Urgency: `now` (foran/abhi/فوری), `today` (aaj), `scheduled` (kal/next week), else `flexible`. |
| Photo search (`POST /ai/photo-search`) | **Heuristic keyword match only** on the supplied `description` / `tags` / `media_key` (filename). No image pixels are read — this is NOT vision. Returns up to 3 ranked categories with a note saying so. |
| Voice search (`POST /ai/voice-search`) | **No STT in the local provider.** With a client-supplied `transcript` (on-device speech recognition on the phone) it redacts PII, parses intent, and returns `requires_confirmation: true` — the client MUST show the transcript for manual correction before a request is posted. Audio-only (`audio_key` without transcript) returns `422 STT_UNAVAILABLE`. |
| Fair price (`GET /ai/fair-price`) | OLS regression (`fair-price-model.ts`) trained on completed-job prices (`jobs.agreed_price` joined to `service_requests.specs` quantity + nearest city). Used ONLY when n ≥ 8, quantity varies, R² ≥ 0.30 — otherwise it falls back to the existing percentile range (`src/common/utils/fair-range.ts`, same as `GET /pricing/fair-range`). Every estimate writes an audit row to `fair_price_snapshots` (migration `0010`). |
| Chat translation (`GET/PUT /ai/chats/:id/translation`, `POST /ai/chats/:id/messages/:messageId/translate`) | Per-user, per-chat toggle (`chat_translation_prefs`). Local translation is an **exact-phrase dictionary** (`translation-phrases.ts`, common chat phrases EN↔UR). Unknown text is returned untranslated (`translated_by_provider=false`, original preserved) — a translation is never invented. `messages.body` is never overwritten; translations live in `message_translations` and the response always carries both `original` and `translated`. |

## PII rule (enforced in code, tested)

Every free-text input is passed through `redactPii()` (`providers/pii-redactor.ts`)
**before** any provider call: CNIC (dashed or 13-digit), Pakistani mobile
(`03xx` / `+92 3xx`), email, passport-style numbers are replaced with
`[REDACTED_*]` tokens. Providers defensively call `assertNoPii()` and
refuse to run on unredacted input. Intent logs store the redacted text
only. Unit tests cover CNIC-in-text, phone-in-text, and clean text.

## Swapping in a real LLM / vision / STT provider

No real vendor account exists in this environment. To enable one, the
**user** must create the account (Muse cannot create vendor accounts or
keys) and a developer adds one class implementing `AiProvider`:

1. **Google Cloud (recommended — one account covers all three gaps).**
   Create a Google Cloud project (different Google account/project from
   any exhausted Gemini key — quota is per project), enable **Vertex AI**
   (Gemini 2.5 Flash for intent + translation), **Cloud Vision API**
   (photo category), **Cloud Speech-to-Text** (Urdu `ur-PK` model), and
   **Cloud Translation API** (fallback for free-text translation).
   Create a service-account key, store it in the secrets manager
   (never in the repo), set `AI_PROVIDER=google` and the key path env.
   Rough cost (2026 list prices, verify at cloud.google.com/pricing):
   Gemini 2.5 Flash ~$0.30 / 1M input tokens (intent calls are ~200
   tokens, so ~10,000 intents ≈ $0.60); Vision label detection ~$1.50 /
   1,000 images; Speech-to-Text ~$0.016 / minute (ur-PK standard);
   Translation ~$20 / 1M characters. A small launch (hundreds of
   searches/day) is a few dollars a month. Free tiers: Vision 1,000
   units/month, Translation 500,000 chars/month, Speech 60 min/month.
2. **OpenAI alternative.** OpenAI account + API key, `gpt-4o-mini` for
   intent/translation, `gpt-4o` vision for photos, Whisper (`whisper-1`,
   Urdu supported) for STT. Rough cost: gpt-4o-mini ~$0.15 / 1M input
   tokens; Whisper $0.006 / minute. No free tier beyond trial credit.
3. The new provider class must keep the contract: redacted input only,
   `parseIntent` never throws on unparseable input, unsupported
   capabilities reported via `capabilities` + honest unavailable errors.
   The service, controller, DTOs and tests do not change.

## Routes (for the integrator — NOT yet in `backend/openapi.yaml` / `app.module.ts`)

Base prefix is `/api/v1` (global, see `src/main.ts`).

| Method | Path | Auth | Body / Query | Response |
|---|---|---|---|---|
| GET | `/api/v1/ai/health` | public | — | `{provider: 'local', capabilities: {intent, photo, voiceStt, translation}}` |
| POST | `/api/v1/ai/intent` | public | `{text}` (≤1000 chars) | ParsedIntent + `provider`, `pii_redacted[]` |
| POST | `/api/v1/ai/photo-search` | public | `{media_key?, description?, tags?[]}` (≥1 required) | `{suggestions: [{category_id, category_slug, name_en, confidence}], method: 'heuristic-keyword', note, provider}` |
| POST | `/api/v1/ai/voice-search` | Bearer | `{transcript?, audio_key?, language?}` | `{transcript, corrected_query, intent, requires_confirmation: true, provider, pii_redacted[]}`; 422 `STT_UNAVAILABLE` (audio-only) / `VOICE_INPUT_REQUIRED` (neither) |
| GET | `/api/v1/ai/fair-price` | public | `?category_id | category_slug` (one required), `&city_id?`, `&quantity?` | `{category_id, city_id, quantity, min, typical, max, sample_size, source: 'model' \| 'percentile', r_squared, hidden, provider}` |
| GET | `/api/v1/ai/chats/:id/translation` | Bearer, participant | — | `{chat_id, target_lang: 'ur' \| 'en' \| null, auto_translate}` |
| PUT | `/api/v1/ai/chats/:id/translation` | Bearer, participant | `{target_lang?: 'ur' \| 'en' \| null, auto_translate: boolean}` | same as GET; 422 `TRANSLATION_TARGET_REQUIRED` if `auto_translate=true` without `target_lang` |
| POST | `/api/v1/ai/chats/:id/messages/:messageId/translate` | Bearer, participant | `{target_lang: 'ur' \| 'en'}` | `{message_id, chat_id, original, translated, target_lang, translated_by_provider, method, provider, pii_redacted[], note?}` |

Error shapes follow the repo convention: `{error: {code, message, details}, request_id}`;
validation failures are `422 VALIDATION_FAILED`.

## Files

- `ai-gateway.module.ts` — module (integrator wires it into `app.module.ts`)
- `ai-gateway.controller.ts`, `ai-gateway.dto.ts`, `ai-gateway.service.ts`
- `intent-parser.ts`, `fair-price-model.ts`, `translation-phrases.ts` (pure, unit-tested)
- `providers/ai-provider.interface.ts`, `providers/local-ai.provider.ts`,
  `providers/pii-redactor.ts`, `providers/builtin-aliases.ts`
- Migration: `db/0010_ai_gateway.sql` (`ai_intent_logs`, `fair_price_snapshots`,
  `chat_translation_prefs`, `message_translations`)
- Tests: `backend/test/unit/ai-gateway.spec.ts`,
  `backend/test/integration/ai-gateway.spec.ts`
