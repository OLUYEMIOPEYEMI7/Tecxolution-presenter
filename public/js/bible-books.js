// Bible book names (as recognized by bible-api.com) + common spoken aliases,
// and a small English number-word parser for spoken chapter/verse numbers.

const BIBLE_BOOKS = {
  genesis: 'Genesis', gen: 'Genesis',
  exodus: 'Exodus', exod: 'Exodus', ex: 'Exodus',
  leviticus: 'Leviticus', lev: 'Leviticus',
  numbers: 'Numbers', num: 'Numbers',
  deuteronomy: 'Deuteronomy', deut: 'Deuteronomy',
  joshua: 'Joshua', josh: 'Joshua',
  judges: 'Judges', judg: 'Judges',
  ruth: 'Ruth',
  'first samuel': '1 Samuel', '1 samuel': '1 Samuel', '1st samuel': '1 Samuel',
  'second samuel': '2 Samuel', '2 samuel': '2 Samuel', '2nd samuel': '2 Samuel',
  'first kings': '1 Kings', '1 kings': '1 Kings', '1st kings': '1 Kings',
  'second kings': '2 Kings', '2 kings': '2 Kings', '2nd kings': '2 Kings',
  'first chronicles': '1 Chronicles', '1 chronicles': '1 Chronicles',
  'second chronicles': '2 Chronicles', '2 chronicles': '2 Chronicles',
  ezra: 'Ezra',
  nehemiah: 'Nehemiah', neh: 'Nehemiah',
  esther: 'Esther',
  job: 'Job',
  psalm: 'Psalm', psalms: 'Psalm', ps: 'Psalm',
  proverbs: 'Proverbs', prov: 'Proverbs',
  ecclesiastes: 'Ecclesiastes', eccl: 'Ecclesiastes',
  'song of solomon': 'Song of Solomon', 'song of songs': 'Song of Solomon',
  isaiah: 'Isaiah', isa: 'Isaiah',
  jeremiah: 'Jeremiah', jer: 'Jeremiah',
  lamentations: 'Lamentations', lam: 'Lamentations',
  ezekiel: 'Ezekiel', ezek: 'Ezekiel',
  daniel: 'Daniel', dan: 'Daniel',
  hosea: 'Hosea', hos: 'Hosea',
  joel: 'Joel',
  amos: 'Amos',
  obadiah: 'Obadiah', obad: 'Obadiah',
  jonah: 'Jonah',
  micah: 'Micah', mic: 'Micah',
  nahum: 'Nahum',
  habakkuk: 'Habakkuk', hab: 'Habakkuk',
  zephaniah: 'Zephaniah', zeph: 'Zephaniah',
  haggai: 'Haggai', hag: 'Haggai',
  zechariah: 'Zechariah', zech: 'Zechariah',
  malachi: 'Malachi', mal: 'Malachi',
  matthew: 'Matthew', matt: 'Matthew',
  mark: 'Mark',
  luke: 'Luke',
  john: 'John', jn: 'John',
  acts: 'Acts',
  romans: 'Romans', rom: 'Romans',
  'first corinthians': '1 Corinthians', '1 corinthians': '1 Corinthians',
  'second corinthians': '2 Corinthians', '2 corinthians': '2 Corinthians',
  galatians: 'Galatians', gal: 'Galatians',
  ephesians: 'Ephesians', eph: 'Ephesians',
  philippians: 'Philippians', phil: 'Philippians',
  colossians: 'Colossians', col: 'Colossians',
  'first thessalonians': '1 Thessalonians', '1 thessalonians': '1 Thessalonians',
  'second thessalonians': '2 Thessalonians', '2 thessalonians': '2 Thessalonians',
  'first timothy': '1 Timothy', '1 timothy': '1 Timothy',
  'second timothy': '2 Timothy', '2 timothy': '2 Timothy',
  titus: 'Titus',
  philemon: 'Philemon',
  hebrews: 'Hebrews', heb: 'Hebrews',
  james: 'James',
  'first peter': '1 Peter', '1 peter': '1 Peter',
  'second peter': '2 Peter', '2 peter': '2 Peter',
  'first john': '1 John', '1 john': '1 John',
  'second john': '2 John', '2 john': '2 John',
  'third john': '3 John', '3 john': '3 John',
  jude: 'Jude',
  revelation: 'Revelation', revelations: 'Revelation', rev: 'Revelation',
};

// Longest-alias-first list for matching multi-word book names before single words
const BOOK_ALIASES = Object.keys(BIBLE_BOOKS).sort((a, b) => b.length - a.length);

const NUM_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const TENS_WORDS = new Set(['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']);

// Replace spoken number words with digits. Only merges a tens-word with a
// following ones-word into one compound number (e.g. "twenty" + "eight" -> 28),
// per standard English number grammar — adjacent standalone numbers like
// "one one" (chapter 1, verse 1) or "eight twenty eight" (chapter 8, verse 28)
// are correctly kept as separate numbers instead of being summed together.
function normalizeSpokenNumbers(text) {
  const tokens = text.split(/\s+/);
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (NUM_WORDS[tok] !== undefined) {
      let value = NUM_WORDS[tok];
      const next = tokens[i + 1];
      if (TENS_WORDS.has(tok) && next !== undefined && NUM_WORDS[next] >= 1 && NUM_WORDS[next] <= 9) {
        value += NUM_WORDS[next];
        out.push(String(value));
        i += 2;
        continue;
      }
      out.push(String(value));
      i += 1;
    } else {
      out.push(tok);
      i += 1;
    }
  }
  return out.join(' ');
}

/**
 * Scan a transcript for a spoken scripture reference and return the best match found,
 * or null. Handles forms like:
 *   "genesis 1 1", "genesis chapter 1 verse 1", "genesis 1 verse 1",
 *   "john 3 16", "psalm 23 1", "genesis 1" (chapter only)
 */
function findScriptureReference(rawText) {
  const text = normalizeSpokenNumbers(rawText.toLowerCase().replace(/[.,!?]/g, ' '));

  for (const alias of BOOK_ALIASES) {
    const idx = text.lastIndexOf(alias);
    if (idx === -1) continue;

    // Make sure it's a whole-word match
    const before = text[idx - 1];
    const after = text[idx + alias.length];
    if (before && /[a-z]/.test(before)) continue;
    if (after && /[a-z]/.test(after)) continue;

    const rest = text.slice(idx + alias.length);
    // Strip connector words like "chapter", "verse", "and", ":"
    const cleaned = rest.replace(/\b(chapter|verse|and|the)\b/g, ' ').replace(/:/g, ' ');
    const nums = cleaned.match(/\d+/g);
    if (!nums || nums.length === 0) continue;

    const book = BIBLE_BOOKS[alias];
    const chapter = parseInt(nums[0], 10);
    if (!chapter || chapter < 1 || chapter > 176) continue;

    if (nums.length >= 2) {
      const verse = parseInt(nums[1], 10);
      if (verse >= 1 && verse <= 176) {
        return { reference: `${book} ${chapter}:${verse}`, book, chapter, verse };
      }
    }
    return { reference: `${book} ${chapter}`, book, chapter, verse: null };
  }
  return null;
}

if (typeof module !== 'undefined') {
  module.exports = { findScriptureReference, BIBLE_BOOKS };
}
