// Built-in category aliases for the local AI provider.
//
// Source of truth is the live taxonomy: categories + category_keywords in
// the DB (seeded by db/0004_seed.sql — the 5 launch categories carry
// Roman Urdu / Urdu / English synonyms there). The service loads those
// rows at runtime and merges them over this table, so an admin adding a
// keyword in the DB takes effect without a code change.
//
// This table exists so the parser still works when the DB has no keyword
// rows for a category (the 8 non-launch categories have none in the seed)
// and so unit tests can run with no database at all. Slugs and ids are
// copied verbatim from db/0004_seed.sql.

export interface CategoryAlias {
  categoryId: string;
  slug: string;
  nameEn: string;
  /** Lower-cased match phrases, Roman Urdu / Urdu script / English. */
  aliases: string[];
}

const id = (n: number) => `00000000-0000-4000-8000-0000b000000${n.toString(16)}`;

export const BUILTIN_ALIASES: CategoryAlias[] = [
  { categoryId: id(1), slug: 'book-binding', nameEn: 'Book Binding', aliases: ['book binding', 'jild saazi', 'جلد سازی', 'book banding', 'jild bandi', 'kitab jild', 'kitabon ki jild', 'kitab', 'kitabein', 'kitaab', 'kitaabein', 'jild', 'binding', 'thesis binding', 'register binding', 'hard binding', 'soft binding'] },
  { categoryId: id(2), slug: 'ac-repair', nameEn: 'AC Repair', aliases: ['ac repair', 'ac theek karwana', 'ac gas', 'ایسی ٹھیک', 'ac service', 'ac kharab', 'ac', 'air conditioner', 'airconditioner', 'cooling', 'gas refill', 'ac lagwana', 'ac installation'] },
  { categoryId: id(3), slug: 'electrician', nameEn: 'Electrician', aliases: ['electrician', 'bijli wala', 'بجلی والا', 'bijli ka kaam', 'bijli theek', 'fan lagwana', 'bijli', 'wiring', 'switch board', 'ups', 'fan', 'light'] },
  { categoryId: id(4), slug: 'plumber', nameEn: 'Plumber', aliases: ['plumber', 'پلمبر', 'nalka band', 'nalka', 'pipe leakage', 'pani leakage', 'nalka wala', 'pipe', 'leakage', 'tap', 'motor', 'drainage', 'pani'] },
  { categoryId: id(5), slug: 'mobile-repair', nameEn: 'Mobile Repair', aliases: ['mobile repair', 'mobile theek', 'موبائل ٹھیک', 'mobile screen', 'mobile battery', 'mobile', 'phone repair', 'phone theek', 'screen replacement', 'battery replacement', 'charging port', 'software issue'] },
  { categoryId: id(6), slug: 'tailoring', nameEn: 'Tailoring', aliases: ['tailoring', 'darzi', 'درزی', 'tailor', 'silwana', 'kapde silwana', 'suit silwana', 'shalwar kameez', 'stitching'] },
  { categoryId: id(7), slug: 'carpentry', nameEn: 'Carpentry', aliases: ['carpentry', 'barhai', 'بڑھئی', 'carpenter', 'lakri ka kaam', 'furniture', 'door repair', 'wood work', 'almari'] },
  { categoryId: id(8), slug: 'painting', nameEn: 'Painting', aliases: ['painting', 'rang wala', 'رنگ سازی', 'painter', 'rang karwana', 'paint karwana', 'deewar rang', 'whitewash'] },
  { categoryId: id(9), slug: 'cleaning', nameEn: 'Cleaning', aliases: ['cleaning', 'safai', 'صفائی', 'cleaner', 'safai karwana', 'ghar ki safai', 'sofa cleaning', 'house cleaning'] },
  { categoryId: id(10), slug: 'tutoring', nameEn: 'Tutoring', aliases: ['tutoring', 'tuition', 'ٹیوشن', 'tutor', 'teacher', 'parhana', 'home tutor', 'maths tutor', 'english tutor'] },
  { categoryId: id(11), slug: 'printing', nameEn: 'Printing', aliases: ['printing', 'پرنٹنگ', 'print', 'photocopy', 'print karwana', 'banner', 'pamphlet', 'card printing'] },
  { categoryId: id(12), slug: 'car-mechanic', nameEn: 'Car Mechanic', aliases: ['car mechanic', 'کار مکینک', 'mechanic', 'gari theek', 'car repair', 'gari ka kaam', 'oil change', 'car service'] },
  { categoryId: id(13), slug: 'appliance-repair', nameEn: 'Appliance Repair', aliases: ['appliance repair', 'آلات مرمت', 'fridge repair', 'washing machine', 'fan repair', 'iron repair', 'appliance', 'freezer', 'geyser'] },
];
