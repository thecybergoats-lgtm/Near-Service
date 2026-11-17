// Local dictionary translation (Phase 3, item 9).
//
// The local provider has NO machine-translation model, so it can only
// translate exact known chat phrases. Anything else is returned
// UNTRANSLATED (translated=false) with the original preserved — the
// service never invents a translation. Full free-text translation needs
// the real provider documented in README.md (Google Cloud Translation
// API). Keys are normalised lower-case English / Roman Urdu; values are
// Urdu script (target 'ur') or English (target 'en').

export type TargetLang = 'ur' | 'en';

const EN_TO_UR: Record<string, string> = {
  'hello': 'سلام', 'hi': 'سلام', 'salam': 'سلام', 'assalam o alaikum': 'السلام علیکم',
  'thank you': 'شکریہ', 'thanks': 'شکریہ',
  'how much': 'کتنے پیسے', 'what is the price': 'قیمت کیا ہے', 'price': 'قیمت',
  'when will you come': 'آپ کب آئیں گے', 'when': 'کب',
  'ok': 'ٹھیک ہے', 'okay': 'ٹھیک ہے', 'done': 'ہو گیا',
  'please come today': 'براہ کرم آج آ جائیں', 'please come tomorrow': 'براہ کرم کل آ جائیں',
  'i will come tomorrow': 'میں کل آؤں گا', 'i am coming': 'میں آ رہا ہوں',
  'the work is done': 'کام ہو گیا ہے', 'work is done': 'کام ہو گیا ہے',
  'how are you': 'آپ کیسے ہیں', 'good morning': 'صبح بخیر', 'good evening': 'شام بخیر',
  'yes': 'جی ہاں', 'no': 'نہیں', 'sorry': 'معاف کیجیے',
  'where are you': 'آپ کہاں ہیں', 'i am on my way': 'میں راستے میں ہوں',
  'what is your location': 'آپ کی جگہ کہاں ہے', 'send your location': 'اپنی لوکیشن بھیجیں',
  'how long will it take': 'کتنا وقت لگے گا', 'it will take one hour': 'ایک گھنٹہ لگے گا',
};

const UR_TO_EN: Record<string, string> = {
  'salam': 'Hello', 'assalam o alaikum': 'Hello', 'السلام علیکم': 'Hello', 'سلام': 'Hello',
  'shukriya': 'Thank you', 'شکریہ': 'Thank you',
  'kitne paise': 'How much?', 'کتنے پیسے': 'How much?',
  'qimat kya hai': 'What is the price?', 'قیمت کیا ہے': 'What is the price?',
  'aap kab aayen ge': 'When will you come?', 'آپ کب آئیں گے': 'When will you come?',
  'kab': 'When?', 'کب': 'When?',
  'theek hai': 'OK', 'ٹھیک ہے': 'OK',
  'ho gaya': 'Done', 'ہو گیا': 'Done',
  'kaam ho gaya hai': 'The work is done', 'کام ہو گیا ہے': 'The work is done',
  'aap kaise hain': 'How are you?', 'آپ کیسے ہیں': 'How are you?',
  'ji haan': 'Yes', 'جی ہاں': 'Yes',
  'nahi': 'No', 'نہیں': 'No',
  'main aa raha hoon': 'I am coming', 'میں آ رہا ہوں': 'I am coming',
  'main kal aaon ga': 'I will come tomorrow', 'میں کل آؤں گا': 'I will come tomorrow',
  'aap kahan hain': 'Where are you?', 'آپ کہاں ہیں': 'Where are you?',
  'kitna waqt lage ga': 'How long will it take?', 'کتنا وقت لگے گا': 'How long will it take?',
};

export interface DictionaryTranslation { translated: string; found: boolean }

/** Exact-phrase dictionary lookup. Normalises case/whitespace only. */
export function translateDictionary(text: string, target: TargetLang): DictionaryTranslation {
  const key = text.trim().toLowerCase().replace(/[\s_]+/g, ' ');
  const table = target === 'ur' ? EN_TO_UR : UR_TO_EN;
  const hit = table[key];
  if (hit) return { translated: hit, found: true };
  return { translated: text, found: false };
}
