// Contact-sharing moderation — PRD trust & safety: phone numbers / WhatsApp
// handles shared in chat are flagged so the parties stay in-app.
const PHONE_RE = /(?:\+?92|0)?3\d{2}[\s-]?\d{7}/;
const WHATSAPP_RE = /\b(whatsapp|w\.?app|wa\.me|wa\.me\/|chat\.whatsapp)\b/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
export function isContactSharing(text: string | null | undefined): boolean {
  if (!text) return false;
  return PHONE_RE.test(text) || WHATSAPP_RE.test(text) || EMAIL_RE.test(text);
}
