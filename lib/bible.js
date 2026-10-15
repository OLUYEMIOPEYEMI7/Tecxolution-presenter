// Bible reference helpers: book codes/aliases, reference parsing, and the
// canonical book/chapter/verse-count structure (shared with the browser).
const fs = require('fs');
const path = require('path');

// Standard USFM/USX 3-letter book codes, in Bible order — bible.helloao.org
// uses these directly as path segments (GEN, EXO, ... JHN, ... REV).
const BIBLE_BOOK_CODES = {
  genesis: 'GEN', exodus: 'EXO', leviticus: 'LEV', numbers: 'NUM', deuteronomy: 'DEU',
  joshua: 'JOS', judges: 'JDG', ruth: 'RUT', '1samuel': '1SA', '2samuel': '2SA',
  '1kings': '1KI', '2kings': '2KI', '1chronicles': '1CH', '2chronicles': '2CH',
  ezra: 'EZR', nehemiah: 'NEH', esther: 'EST', job: 'JOB', psalm: 'PSA', psalms: 'PSA',
  proverbs: 'PRO', ecclesiastes: 'ECC', songofsolomon: 'SNG', song: 'SNG', isaiah: 'ISA',
  jeremiah: 'JER', lamentations: 'LAM', ezekiel: 'EZK', daniel: 'DAN', hosea: 'HOS',
  joel: 'JOL', amos: 'AMO', obadiah: 'OBA', jonah: 'JON', micah: 'MIC', nahum: 'NAM',
  habakkuk: 'HAB', zephaniah: 'ZEP', haggai: 'HAG', zechariah: 'ZEC', malachi: 'MAL',
  matthew: 'MAT', mark: 'MRK', luke: 'LUK', john: 'JHN', acts: 'ACT', romans: 'ROM',
  '1corinthians': '1CO', '2corinthians': '2CO', galatians: 'GAL', ephesians: 'EPH',
  philippians: 'PHP', colossians: 'COL', '1thessalonians': '1TH', '2thessalonians': '2TH',
  '1timothy': '1TI', '2timothy': '2TI', titus: 'TIT', philemon: 'PHM', hebrews: 'HEB',
  james: 'JAS', '1peter': '1PE', '2peter': '2PE', '1john': '1JN', '2john': '2JN',
  '3john': '3JN', jude: 'JUD', revelation: 'REV',
};

// Common abbreviations operators actually type ("Jn 3:16", "1 Cor 13:4", "Rom 8:28").
const BIBLE_BOOK_ALIASES = {
  gen: 'GEN', ge: 'GEN', exod: 'EXO', ex: 'EXO', lev: 'LEV', num: 'NUM', deut: 'DEU', dt: 'DEU',
  josh: 'JOS', judg: 'JDG', jdg: 'JDG', '1sam': '1SA', '2sam': '2SA', '1kgs': '1KI', '2kgs': '2KI',
  '1chr': '1CH', '2chr': '2CH', neh: 'NEH', est: 'EST', ps: 'PSA', psa: 'PSA', pslm: 'PSA', prov: 'PRO',
  pr: 'PRO', eccl: 'ECC', eccles: 'ECC', ecc: 'ECC', songofsongs: 'SNG', sos: 'SNG', isa: 'ISA', jer: 'JER',
  lam: 'LAM', ezek: 'EZK', eze: 'EZK', dan: 'DAN', hos: 'HOS', obad: 'OBA', mic: 'MIC', nah: 'NAM',
  hab: 'HAB', zeph: 'ZEP', hag: 'HAG', zech: 'ZEC', mal: 'MAL', matt: 'MAT', mt: 'MAT', mk: 'MRK',
  mar: 'MRK', lk: 'LUK', luk: 'LUK', jn: 'JHN', joh: 'JHN', act: 'ACT', rom: 'ROM', ro: 'ROM',
  '1cor': '1CO', '2cor': '2CO', gal: 'GAL', eph: 'EPH', phil: 'PHP', php: 'PHP', col: 'COL',
  '1thess': '1TH', '2thess': '2TH', '1thes': '1TH', '2thes': '2TH', '1tim': '1TI', '2tim': '2TI', tit: 'TIT',
  phlm: 'PHM', heb: 'HEB', jas: 'JAS', jam: 'JAS', '1pet': '1PE', '2pet': '2PE', '1jn': '1JN', '2jn': '2JN',
  '3jn': '3JN', rev: 'REV', rv: 'REV',
};

// Parses "John 3:16", "1 John 3:16-18", "Song of Solomon 2:1", "Psalm 23" (whole
// chapter) etc. into {bookCode, chapter, verseStart, verseEnd}. Null if unparseable.
function parseBibleReference(ref) {
  const m = ref.trim().match(/^((?:[1-3]\s*)?[A-Za-z][A-Za-z\s.]*?)\.?\s+(\d+)(?:\s*:\s*(\d+)(?:\s*-\s*(\d+))?)?$/);
  if (!m) return null;
  const bookKey = m[1].toLowerCase().replace(/[\s.]+/g, '');
  const bookCode = BIBLE_BOOK_CODES[bookKey] || BIBLE_BOOK_ALIASES[bookKey];
  if (!bookCode) return null;
  const chapter = parseInt(m[2], 10);
  const verseStart = m[3] ? parseInt(m[3], 10) : 1;
  const verseEnd = m[3] ? (m[4] ? parseInt(m[4], 10) : verseStart) : 999;
  if (chapter < 1 || chapter > 150 || verseEnd < verseStart) return null;
  return { bookCode, chapter, verseStart, verseEnd };
}

// Canonical structure comes from the same file the browser uses, so the server
// and the Browse/Navigator UI can never disagree about chapter/verse counts.
const STRUCTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'bible-structure.js'), 'utf8')
    .match(/const BIBLE_STRUCTURE = (\[[\s\S]*?\]);\s*$/m)[1]
);
const CODE_TO_BOOK = {};
STRUCTURE.forEach((b, i) => {
  const code = BIBLE_BOOK_CODES[b.name.toLowerCase().replace(/\s+/g, '')];
  if (code) CODE_TO_BOOK[code] = { name: b.name, index: i, chapters: b.chapters };
});

// What the navigator needs to know about a reference: canonical book name,
// chapter, and the verse range clamped to the real chapter length.
function scriptureMeta(ref) {
  const p = parseBibleReference(ref || '');
  if (!p) return null;
  const book = CODE_TO_BOOK[p.bookCode];
  if (!book || p.chapter > book.chapters.length) return null;
  const verseCount = book.chapters[p.chapter - 1];
  return {
    book: book.name,
    bookIndex: book.index,
    chapter: p.chapter,
    verseStart: Math.min(p.verseStart, verseCount),
    verseEnd: Math.min(p.verseEnd, verseCount),
    verseCount,
    whole: p.verseEnd === 999, // a bare chapter such as "Psalm 23"
  };
}

// What the congregation should read: "jn 3:16" -> "John 3:16", "gen 1" -> "Genesis 1".
function canonicalReference(meta) {
  if (!meta) return null;
  if (meta.whole) return `${meta.book} ${meta.chapter}`;
  return `${meta.book} ${meta.chapter}:${meta.verseStart}${meta.verseEnd > meta.verseStart ? '-' + meta.verseEnd : ''}`;
}

module.exports = {
  canonicalReference, BIBLE_BOOK_CODES, BIBLE_BOOK_ALIASES, parseBibleReference, scriptureMeta, STRUCTURE };
