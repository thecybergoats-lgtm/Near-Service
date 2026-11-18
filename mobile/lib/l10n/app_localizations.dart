import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/constants.dart';

/// ARB-like localization maps for the three launch locales:
/// English (en), Urdu script (ur), Roman Urdu (ur-roman).
/// Urdu-script strings are the launch copy; a native reviewer should
/// re-check them before store submission (PRD p.26).
/// Usage: `ref.watch(localeProvider)` + `L.of(locale).t('post_request')`.
class L {
  L(this.locale);
  final String locale;

  static const Map<String, Map<String, String>> _strings = {
    'app_name': {
      'en': 'Near Service',
      'ur': 'نیئر سروس',
      'ur-roman': 'Near Service',
    },
    'post_request': {
      'en': 'Post a request',
      'ur': 'درخواست لگائیں',
      'ur-roman': 'Request lagayein',
    },
    'your_offer': {
      'en': 'Your offer (PKR)',
      'ur': 'آپ کی قیمت (روپے)',
      'ur-roman': 'Aap ki qeemat (PKR)',
    },
    'fair_price': {
      'en': 'Fair price range',
      'ur': 'مناسب قیمت کی حد',
      'ur-roman': 'Munasib qeemat ki range',
    },
    'offer_received': {
      'en': 'New offer received',
      'ur': 'نئی آفر موصول ہوئی',
      'ur-roman': 'Nayi offer aa gayi',
    },
    'accept': {
      'en': 'Accept',
      'ur': 'قبول کریں',
      'ur-roman': 'Qubool karein',
    },
    'counter': {
      'en': 'Counter-offer',
      'ur': 'جوابی قیمت دیں',
      'ur-roman': 'Jawabi qeemat dein',
    },
    'decline': {
      'en': 'Decline',
      'ur': 'مسترد کریں',
      'ur-roman': 'Mana karein',
    },
    'provider_coming': {
      'en': 'Provider is on the way',
      'ur': 'کاریگر آ رہا ہے',
      'ur-roman': 'Karigar aa raha hai',
    },
    'search_hint': {
      'en': 'Search a service — AC repair, book binding…',
      'ur': 'خدمت تلاش کریں — اے سی مرمت، کتاب کی جلد…',
      'ur-roman': 'Service dhoondhein — AC repair, book binding…',
    },
    'nearby_providers': {
      'en': 'Providers near you',
      'ur': 'آپ کے قریب کاریگر',
      'ur-roman': 'Aap ke qareeb karigar',
    },
    'no_providers': {
      'en': 'No one nearby yet. Join the waitlist and we will tell you when a provider joins.',
      'ur': 'ابھی کوئی قریب نہیں ہے۔ انتظار کی فہرست میں شامل ہوں، کاریگر آتے ہی بتائیں گے۔',
      'ur-roman': 'Abhi koi qareeb nahi hai. Waitlist mein shamil hon, karigar aate hi batayenge.',
    },
    'too_low': {
      'en': 'This price is below the fair range — few providers may accept.',
      'ur': 'یہ قیمت مناسب حد سے کم ہے — کم کاریگر قبول کریں گے۔',
      'ur-roman': 'Ye qeemat munasib range se kam hai — kam karigar qubool karenge.',
    },
    'too_high': {
      'en': 'This price is above the fair range — you could save money.',
      'ur': 'یہ قیمت مناسب حد سے زیادہ ہے — آپ بچت کر سکتے ہیں۔',
      'ur-roman': 'Ye qeemat munasib range se zyada hai — aap bachat kar sakte hain.',
    },
    'cash_payment': {
      'en': 'Pay in cash to the provider',
      'ur': 'کاریگر کو نقد ادا کریں',
      'ur-roman': 'Karigar ko cash ada karein',
    },
    'rate_provider': {
      'en': 'Rate your provider',
      'ur': 'کاریگر کو ریٹنگ دیں',
      'ur-roman': 'Karigar ko rating dein',
    },
    'sos': {
      'en': 'SOS — share my live location with trusted contacts',
      'ur': 'ایمرجنسی — میری لوکیشن بھیجیں',
      'ur-roman': 'SOS — meri live location bhejein',
    },
    'offline': {
      'en': 'You are offline. Showing saved data.',
      'ur': 'آپ آف لائن ہیں۔ محفوظ شدہ ڈیٹا دکھایا جا رہا ہے۔',
      'ur-roman': 'Aap offline hain. Saved data dikhaya ja raha hai.',
    },
    'demo_data': {
      'en': 'Demo data — connect to the API for live providers.',
      'ur': 'ڈیمو ڈیٹا — لائیو کاریگروں کے لیے API سے جڑیں۔',
      'ur-roman': 'Demo data — live karigaron ke liye API se jurein.',
    },
    'get_quotes': {
      'en': 'Get quotes (no price)',
      'ur': 'قیمتیں منگوائیں (بغیر قیمت)',
      'ur-roman': 'Quotes mangwayein (bina qeemat)',
    },
    // ---- Phase 2 ----
    'wallet': {
      'en': 'Wallet',
      'ur': 'والیٹ',
      'ur-roman': 'Wallet',
    },
    'wallet_balance': {
      'en': 'Wallet balance',
      'ur': 'والیٹ بیلنس',
      'ur-roman': 'Wallet balance',
    },
    'shared_wallet_note': {
      'en': 'One wallet for your whole account — this same balance is shared across your customer and provider profiles.',
      'ur': 'ایک ہی والیٹ آپ کے پورے اکاؤنٹ کے لیے ہے — یہی بیلنس آپ کی کسٹمر اور کاریگر دونوں پروفائلز میں مشترک ہے۔',
      'ur-roman': 'Ek hi wallet aap ke poore account ke liye hai — yehi balance aap ki customer aur karigar dono profiles mein shared hai.',
    },
    'escrow_held': {
      'en': 'Escrow held',
      'ur': 'ایسکرو میں رکھی رقم',
      'ur-roman': 'Escrow mein rakhi raqam',
    },
    'top_up': {
      'en': 'Top up',
      'ur': 'رقم شامل کریں',
      'ur-roman': 'Raqam shamil karein',
    },
    'sandbox_badge': {
      'en': 'SANDBOX — no real money moves',
      'ur': 'سینڈ باکس — اصل رقم نہیں چلتی',
      'ur-roman': 'SANDBOX — asli paisa nahi chalta',
    },
    'sandbox_topup_note': {
      'en': 'Sandbox top-up via JazzCash / Easypaisa. This is a test payment — no real money moves and no real charge is made.',
      'ur': 'جاز کیش / ایزی پیسہ سے سینڈ باکس ٹاپ اپ۔ یہ آزمائشی ادائیگی ہے — اصل رقم نہیں چلتی اور کوئی اصل چارج نہیں ہوتا۔',
      'ur-roman': 'JazzCash / Easypaisa se sandbox top-up. Ye test payment hai — asli paisa nahi chalta aur koi asli charge nahi hota.',
    },
    'transactions': {
      'en': 'Transactions',
      'ur': 'لین دین',
      'ur-roman': 'Transactions',
    },
    'no_transactions': {
      'en': 'No transactions yet. Top-ups, payments and credits will appear here.',
      'ur': 'ابھی کوئی لین دین نہیں ہے۔ ٹاپ اپ، ادائیگیاں اور کریڈٹ یہاں نظر آئیں گے۔',
      'ur-roman': 'Abhi koi transaction nahi hai. Top-up, payments aur credit yahan nazar aayenge.',
    },
    'commission_owed': {
      'en': 'Commission owed',
      'ur': 'واجب الادا کمیشن',
      'ur-roman': 'Commission dena hai',
    },
    'pay_with_wallet': {
      'en': 'Pay with wallet',
      'ur': 'والیٹ سے ادا کریں',
      'ur-roman': 'Wallet se ada karein',
    },
    'insufficient_balance': {
      'en': 'Wallet balance is not enough. Top up your wallet or pay in cash.',
      'ur': 'والیٹ بیلنس کافی نہیں ہے۔ والیٹ ٹاپ اپ کریں یا نقد ادا کریں۔',
      'ur-roman': 'Wallet balance kaafi nahi hai. Wallet top-up karein ya cash ada karein.',
    },
    'promo_code': {
      'en': 'Promo code',
      'ur': 'پرومو کوڈ',
      'ur-roman': 'Promo code',
    },
    'apply_promo': {
      'en': 'Apply',
      'ur': 'لگائیں',
      'ur-roman': 'Lagayein',
    },
    'promo_valid': {
      'en': 'Promo applied — you save',
      'ur': 'پرومو لگ گیا — آپ کی بچت',
      'ur-roman': 'Promo lag gaya — aap ki bachat',
    },
    'promo_invalid': {
      'en': 'This promo code is not valid for this job.',
      'ur': 'یہ پرومو کوڈ اس کام کے لیے درست نہیں ہے۔',
      'ur-roman': 'Ye promo code is kaam ke liye durust nahi hai.',
    },
    'first_job_discount': {
      'en': 'First job discount — try code FIRSTJOB at payment.',
      'ur': 'پہلے کام پر رعایت — ادائیگی پر کوڈ FIRSTJOB آزمائیں۔',
      'ur-roman': 'Pehle kaam par discount — payment par code FIRSTJOB azmayein.',
    },
    'referral_code': {
      'en': 'Your referral code',
      'ur': 'آپ کا ریفرل کوڈ',
      'ur-roman': 'Aap ka referral code',
    },
    'referred_friends': {
      'en': 'Friends joined',
      'ur': 'شامل ہونے والے دوست',
      'ur-roman': 'Shamil hone wale dost',
    },
    'referral_credit': {
      'en': 'Referral credit earned',
      'ur': 'ریفرل کریڈٹ',
      'ur-roman': 'Referral credit',
    },
    'claim_code': {
      'en': 'Have a referral code? Enter it here',
      'ur': 'ریفرل کوڈ ہے؟ یہاں لکھیں',
      'ur-roman': 'Referral code hai? Yahan likhein',
    },
    'claim': {
      'en': 'Claim',
      'ur': 'کلیم کریں',
      'ur-roman': 'Claim karein',
    },
    'my_jobs': {
      'en': 'My jobs',
      'ur': 'میرے کام',
      'ur-roman': 'Mere kaam',
    },
    'no_jobs_yet': {
      'en': 'No jobs yet. Your jobs will appear here with a Rebook button.',
      'ur': 'ابھی کوئی کام نہیں ہے۔ آپ کے کام یہاں ری بک بٹن کے ساتھ نظر آئیں گے۔',
      'ur-roman': 'Abhi koi kaam nahi hai. Aap ke kaam yahan Rebook button ke saath nazar aayenge.',
    },
    'rebook': {
      'en': 'Rebook',
      'ur': 'دوبارہ بک کریں',
      'ur-roman': 'Dobara book karein',
    },
    'track_live': {
      'en': 'Track live',
      'ur': 'لائیو ٹریک کریں',
      'ur-roman': 'Live track karein',
    },
    'provider_on_way': {
      'en': 'Provider is on the way',
      'ur': 'کاریگر راستے میں ہے',
      'ur-roman': 'Karigar raste mein hai',
    },
    'eta': {
      'en': 'ETA',
      'ur': 'پہنچنے کا وقت',
      'ur-roman': 'ETA',
    },
    'distance_away': {
      'en': 'away',
      'ur': 'دور',
      'ur-roman': 'door',
    },
    'live_location': {
      'en': 'Live location',
      'ur': 'لائیو لوکیشن',
      'ur-roman': 'Live location',
    },
    'location_updated': {
      'en': 'Location updated',
      'ur': 'لوکیشن اپڈیٹ ہوئی',
      'ur-roman': 'Location update hui',
    },
    'reschedule': {
      'en': 'Reschedule',
      'ur': 'وقت بدلیں',
      'ur-roman': 'Waqt badlein',
    },
    'reschedule_scope_note': {
      'en': 'If the work itself changes, the price must be renegotiated — rescheduling alone will not apply.',
      'ur': 'اگر کام بدل جائے تو قیمت دوبارہ طے ہوگی — صرف وقت بدلنے سے کام نہیں ہوگا۔',
      'ur-roman': 'Agar kaam badal jaye to qeemat dobara tay hogi — sirf waqt badalne se kaam nahi hoga.',
    },
    'schedule_when': {
      'en': 'When should it be done?',
      'ur': 'کب کروانا ہے؟',
      'ur-roman': 'Kab karwana hai?',
    },
    'schedule_now': {
      'en': 'Now',
      'ur': 'ابھی',
      'ur-roman': 'Abhi',
    },
    'schedule_today': {
      'en': 'Today',
      'ur': 'آج',
      'ur-roman': 'Aaj',
    },
    'schedule_pick': {
      'en': 'Pick date & time',
      'ur': 'تاریخ اور وقت منتخب کریں',
      'ur-roman': 'Tareekh aur waqt muntakhib karein',
    },
    'repeat_job': {
      'en': 'Repeat this job regularly',
      'ur': 'یہ کام باقاعدگی سے دہرائیں',
      'ur-roman': 'Ye kaam baqaidgi se dohrayein',
    },
    'repeat_weekly': {
      'en': 'Weekly',
      'ur': 'ہفتہ وار',
      'ur-roman': 'Hafta-war',
    },
    'repeat_monthly': {
      'en': 'Monthly',
      'ur': 'ماہانہ',
      'ur-roman': 'Mahana',
    },
    'disputes': {
      'en': 'Disputes',
      'ur': 'تنازعات',
      'ur-roman': 'Disputes',
    },
    'open_dispute': {
      'en': 'Open a dispute',
      'ur': 'تنازع کھولیں',
      'ur-roman': 'Dispute kholein',
    },
    'dispute_reason': {
      'en': 'What went wrong?',
      'ur': 'کیا مسئلہ ہوا؟',
      'ur-roman': 'Kya masla hua?',
    },
    'dispute_describe': {
      'en': 'Describe what happened',
      'ur': 'بتائیں کیا ہوا',
      'ur-roman': 'Batayein kya hua',
    },
    'add_evidence': {
      'en': 'Add evidence',
      'ur': 'ثبوت شامل کریں',
      'ur-roman': 'Saboot shamil karein',
    },
    'evidence_photo_note': {
      'en': 'Photo upload is not available in the app yet — your photo is recorded as a note for support, with the kind and description. Share the actual photo with support on chat.',
      'ur': 'ایپ میں ابھی فوٹو اپلوڈ نہیں ہے — آپ کی فوٹو سپورٹ کے لیے نوٹ کے طور پر درج ہو جاتی ہے۔ اصل فوٹو چیٹ پر سپورٹ کو بھیجیں۔',
      'ur-roman': 'App mein abhi photo upload nahi hai — aap ki photo support ke liye note ke tor par darj ho jati hai. Asli photo chat par support ko bhejein.',
    },
    'no_disputes': {
      'en': 'No disputes. If something goes wrong with a job, open one here.',
      'ur': 'کوئی تنازع نہیں ہے۔ کسی کام میں مسئلہ ہو تو یہاں سے کھولیں۔',
      'ur-roman': 'Koi dispute nahi hai. Kisi kaam mein masla ho to yahan se kholein.',
    },
    'resolution': {
      'en': 'Resolution',
      'ur': 'فیصلہ',
      'ur-roman': 'Faisla',
    },
    'try_again': {
      'en': 'Try again',
      'ur': 'دوبارہ کوشش کریں',
      'ur-roman': 'Dobara koshish karein',
    },
    'load_more': {
      'en': 'Load more',
      'ur': 'مزید دیکھیں',
      'ur-roman': 'Mazeed dekhein',
    },
    'earnings': {
      'en': 'Earnings',
      'ur': 'آمدنی',
      'ur-roman': 'Aamdani',
    },
    'sharing_location': {
      'en': 'Sharing your live location with the customer while you travel.',
      'ur': 'سفر کے دوران آپ کی لائیو لوکیشن کسٹمر کو دکھائی جا رہی ہے۔',
      'ur-roman': 'Safar ke dauran aap ki live location customer ko dikhayi ja rahi hai.',
    },
    // ---- Batch 2 ----
    'language': {
      'en': 'Language',
      'ur': 'زبان',
      'ur-roman': 'Language',
    },
    'dark_mode': {
      'en': 'Dark mode',
      'ur': 'ڈارک موڈ',
      'ur-roman': 'Dark mode',
    },
    'appearance': {
      'en': 'Appearance',
      'ur': 'ظاہری شکل',
      'ur-roman': 'Appearance',
    },
    'system_default': {
      'en': 'System default',
      'ur': 'سسٹم کی ترتیب',
      'ur-roman': 'System default',
    },
    'light': {
      'en': 'Light',
      'ur': 'روشن',
      'ur-roman': 'Light',
    },
    'dark': {
      'en': 'Dark',
      'ur': 'ڈارک',
      'ur-roman': 'Dark',
    },
    'live_support': {
      'en': 'Live Support',
      'ur': 'لائیو سپورٹ',
      'ur-roman': 'Live Support',
    },
    'support_will_reply': {
      'en': 'Support will reply soon — your ticket is open.',
      'ur': 'سپورٹ جلد جواب دے گی — آپ کی ٹکٹ کھلی ہوئی ہے۔',
      'ur-roman': 'Support jald jawab degi — aap ki ticket khuli hui hai.',
    },
    'favourites': {
      'en': 'Favourites',
      'ur': 'پسندیدہ',
      'ur-roman': 'Favourites',
    },
    'book_again': {
      'en': 'Book again',
      'ur': 'دوبارہ بک کریں',
      'ur-roman': 'Dobara book karein',
    },
    'confirm_completion': {
      'en': 'Confirm karo — kaam ho gaya',
      'ur': 'تصدیق کریں — کام ہو گیا',
      'ur-roman': 'Confirm karo — kaam ho gaya',
    },
    'payment_after_confirmation': {
      'en': 'Payment settles only after you confirm the work is done.',
      'ur': 'ادائیگی تب ہی ہوگی جب آپ کام مکمل ہونے کی تصدیق کریں گے۔',
      'ur-roman': 'Payment tab hi hogi jab aap kaam mukammal hone ki tasdeeq karenge.',
    },
    'payment_cash_after': {
      'en': 'Payment: kaam ke baad',
      'ur': 'ادائیگی: کام کے بعد',
      'ur-roman': 'Payment: kaam ke baad',
    },
    'payment_wallet_escrow': {
      'en': 'Wallet: pehle escrow mein, kaam ke baad provider ko',
      'ur': 'والیٹ: پہلے ایسکرو میں، کام کے بعد کاریگر کو',
      'ur-roman': 'Wallet: pehle escrow mein, kaam ke baad provider ko',
    },
    'provider_not_arrived': {
      'en': 'Provider nahi aaya? Report karo',
      'ur': 'کاریگر نہیں آیا؟ رپورٹ کریں',
      'ur-roman': 'Provider nahi aaya? Report karo',
    },
    'voice_search_hint': {
      'en': 'Tap the mic and say what you need, e.g. "AC repair".',
      'ur': 'مائیک دبائیں اور بتائیں کیا چاہیے، مثلاً "اے سی مرمت"۔',
      'ur-roman': 'Mic dabayein aur batayein kya chahiye, masalan "AC repair".',
    },
    'mic_denied': {
      'en': 'Microphone is off. Please type your search, or allow microphone access in settings.',
      'ur': 'مائیکروفون بند ہے۔ براہ کرم ٹائپ کر کے تلاش کریں، یا سیٹنگز میں مائیکروفون کی اجازت دیں۔',
      'ur-roman': 'Microphone off hai. Please type kar ke search karein, ya settings mein microphone ki ijazat dein.',
    },
    'deals': {
      'en': 'Deals',
      'ur': 'آفرز',
      'ur-roman': 'Deals',
    },
    'deals_of_the_day': {
      'en': 'Deals of the day',
      'ur': 'آج کی آفرز',
      'ur-roman': 'Aaj ki deals',
    },
    'ends_today': {
      'en': 'Ends today',
      'ur': 'آج ختم ہو رہی ہے',
      'ur-roman': 'Aaj khatam ho rahi hai',
    },
    // Batch 4 — three real-shop states (found / empty / degraded).
    'places_empty_mapped': {
      'en': 'No shops for this service are mapped on OpenStreetMap yet — showing app providers.',
      'ur': 'اوپن اسٹریٹ میپ پر اس سروس کی کوئی دکان درج نہیں ہے — ایپ کے کاریگر دکھائے جا رہے ہیں۔',
      'ur-roman': 'OSM mein is category ki koi dukaan mapped nahi hai — app providers dikhaye ja rahe hain.',
    },
    'places_degraded': {
      'en': 'Real-shop lookup is unavailable right now — showing app providers.',
      'ur': 'اصل دکانوں کی تلاش ابھی دستیاب نہیں ہے — ایپ کے کاریگر دکھائے جا رہے ہیں۔',
      'ur-roman': 'Real-shop lookup abhi available nahi hai — app providers dikhaye ja rahe hain.',
    },
    // Batch 4 — in-app OSRM routing.
    'route_failed': {
      'en': 'Could not find a route to this shop.',
      'ur': 'اس دکان تک راستہ نہیں مل سکا۔',
      'ur-roman': 'Is dukaan tak route nahi mil saka.',
    },
    'clear_route': {
      'en': 'Clear route',
      'ur': 'راستہ ہٹائیں',
      'ur-roman': 'Route hatayein',
    },
    'scan_qr_code': {
      'en': 'Scan a provider QR code',
      'ur': 'کاریگر کا کیو آر کوڈ اسکین کریں',
      'ur-roman': 'Provider ka QR code scan karein',
    },
  };

  String t(String key) =>
      _strings[key]?[locale] ?? _strings[key]?['en'] ?? key;

  static L of(String locale) => L(locale);
}

/// Current locale code ('ur' default — Urdu-first, PRD p.3).
final localeProvider = StateProvider<String>((ref) => 'ur');

Future<void> persistLocale(String locale) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(StorageKeys.language, locale);
}

Future<String> loadPersistedLocale() async {
  final prefs = await SharedPreferences.getInstance();
  return prefs.getString(StorageKeys.language) ?? 'ur';
}
