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
  // common plural / mis-hearings from speech engines
  roman: 'Romans', galatian: 'Galatians', ephesian: 'Ephesians', efesians: 'Ephesians',
  filipians: 'Philippians', filippians: 'Philippians', philipians: 'Philippians', phillipians: 'Philippians', filipinos: 'Philippians', philippian: 'Philippians', colossian: 'Colossians', hebrew: 'Hebrews', proverb: 'Proverbs',
  lamentation: 'Lamentations', salm: 'Psalm', some: null, 'songs of solomon': 'Song of Solomon',
  'song of songs': 'Song of Solomon', canticles: 'Song of Solomon',
  '1 corinthian': '1 Corinthians', '2 corinthian': '2 Corinthians',
  '1 thessalonian': '1 Thessalonians', '2 thessalonian': '2 Thessalonians',
  '1 chronicle': '1 Chronicles', '2 chronicle': '2 Chronicles',
  '1 king': '1 Kings', '2 king': '2 Kings',
  'deuteronomy': 'Deuteronomy', 'ecclesiastes': 'Ecclesiastes',
};
delete BIBLE_BOOKS.some;

const NUM_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const TENS_WORDS = new Set(['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']);

// "first john" / "1st john" / "second corinthians" -> "1 john" / "2 corinthians"
const ORDINALS = { first: '1', '1st': '1', second: '2', '2nd': '2', third: '3', '3rd': '3' };
const ORDINAL_BOOKS = /^(samuel|kings|chronicles?|corinthians?|thessalonians?|timothy|peter|john)$/;

// Spoken-number homophones the speech engine often writes as words. Only
// applied inside the reference window (right after a book name / chapter /
// verse marker), never to ordinary speech.
const HOMOPHONES = { for: '4', fore: '4', to: '2', too: '2', won: '1', ate: '8', tree: '3', free: '3', sex: '6' };

// Words allowed between a book name and its numbers ("chapter 3 verse 16").
const FILLER = new Set(['chapter', 'chapters', 'verse', 'verses', 'versus', 'vs', 'and', 'the', 'colon', 'in']);

// Replace spoken number words with digits. Handles tens+ones ("twenty eight"),
// hundreds ("one hundred and nineteen", "a hundred and fifty") and keeps
// adjacent standalone numbers separate ("eight twenty eight" -> "8 28").
function normalizeSpokenNumbers(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const isNum = NUM_WORDS[tok] !== undefined;
    if ((isNum || (tok === 'a' && tokens[i + 1] === 'hundred')) && tokens[i + (tok === 'a' ? 1 : 1)] === 'hundred') {
      let value = (tok === 'a' ? 1 : NUM_WORDS[tok]) * 100;
      i += 2;
      if (tokens[i] === 'and') i += 1;
      if (NUM_WORDS[tokens[i]] !== undefined) {
        const t = tokens[i];
        if (TENS_WORDS.has(t)) {
          value += NUM_WORDS[t];
          i += 1;
          if (NUM_WORDS[tokens[i]] >= 1 && NUM_WORDS[tokens[i]] <= 9) { value += NUM_WORDS[tokens[i]]; i += 1; }
        } else {
          value += NUM_WORDS[t];
          i += 1;
        }
      }
      out.push(String(value));
      continue;
    }
    if (isNum) {
      let value = NUM_WORDS[tok];
      const next = tokens[i + 1];
      if (TENS_WORDS.has(tok) && next !== undefined && NUM_WORDS[next] >= 1 && NUM_WORDS[next] <= 9) {
        value += NUM_WORDS[next];
        i += 2;
      } else {
        i += 1;
      }
      out.push(String(value));
      continue;
    }
    out.push(tok);
    i += 1;
  }
  return out.join(' ');
}

function prepareSpeech(rawText) {
  let text = rawText.toLowerCase()
    .replace(/(\d)\s*:\s*(\d)/g, '$1 $2')       // "3:16" -> "3 16"
    .replace(/[.,!?;"()]/g, ' ')
    .replace(/:/g, ' ')
    .replace(/\b(?:the\s+)?book\s+of\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const toks = text.split(' ');
  for (let k = 0; k < toks.length - 1; k++) {
    if (ORDINALS[toks[k]] && ORDINAL_BOOKS.test(toks[k + 1])) toks[k] = ORDINALS[toks[k]];
  }
  text = toks.join(' ');
  // "one john" / "two kings" etc: leading number word directly before a numbered book
  text = text.replace(/\b(one|two|three)\s+(samuel|kings|chronicles?|corinthians?|thessalonians?|timothy|peter|john)\b/g,
    (m, n, b) => ({ one: '1', two: '2', three: '3' }[n]) + ' ' + b);
  return normalizeSpokenNumbers(text);
}

/**
 * Scan a transcript for a spoken scripture reference and return the LATEST one
 * found, or null. Handles forms like:
 *   "genesis 1 1", "genesis chapter 1 verse 1", "john 3 16",
 *   "psalm one nineteen verse one oh five", "romans eight twenty eight",
 *   "first john four eight", "genesis 1" (chapter only)
 *
 * Deliberately narrow: numbers must come immediately after the book name
 * (only "chapter/verse/and/the" may sit between), so ordinary sermon speech
 * like "like John, who was baptizing for 40 days" never becomes "John 40".
 * Returns { reference, book, chapter, verse, hasVerse, pos } — pos is where in
 * the cleaned text the book name starts, so callers can tell "new" matches
 * from ones already handled.
 */
// ---- fuzzy book-name matching (speech engines mishear / split names) ----
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
const FUZZY_ALIASES = Object.keys(BIBLE_BOOKS).filter((a) => /^[a-z]{5,}$/.test(a));
// Returns { alias, len } for a near-miss at tokens[t], or null. Tries the
// token alone and joined with the next one ("he brews" -> hebrews).
function fuzzyBook(tokens, t) {
  const tries = [[tokens[t], 1]];
  if (tokens[t + 1] && /^[a-z]+$/.test(tokens[t + 1])) tries.push([tokens[t] + tokens[t + 1], 2]);
  for (const [w, len] of tries) {
    if (!/^[a-z]{5,}$/.test(w)) continue;
    const limit = w.length >= 8 ? 2 : 1;
    let bestA = null, bestD = 99, tie = false;
    for (const a of FUZZY_ALIASES) {
      if (Math.abs(a.length - w.length) > limit) continue;
      const d = editDistance(w, a);
      if (d < bestD) { bestD = d; bestA = a; tie = false; }
      else if (d === bestD && BIBLE_BOOKS[a] !== BIBLE_BOOKS[bestA]) tie = true;
    }
    if (bestA && bestD <= limit && !tie) return { alias: bestA, len };
  }
  return null;
}

function findScriptureReference(rawText) {
  const text = prepareSpeech(rawText);
  const tokens = text.split(' ');
  let best = null;

  for (let t = 0; t < tokens.length; t++) {
    // try longest alias (up to 4 words) starting at token t
    let alias = null;
    let len = 0;
    for (let n = Math.min(4, tokens.length - t); n >= 1; n--) {
      const cand = tokens.slice(t, t + n).join(' ');
      if (BIBLE_BOOKS[cand]) { alias = cand; len = n; break; }
    }
    if (!alias) {
      const fz = fuzzyBook(tokens, t);
      if (!fz) continue;
      alias = fz.alias; len = fz.len;
    }

    const nums = [];
    let k = t + len;
    let sawVerseWord = false;
    while (k < tokens.length && nums.length < 2) {
      const w = tokens[k];
      if (/^\d+$/.test(w)) { nums.push(parseInt(w, 10)); k++; continue; }
      if (FILLER.has(w)) { if (/^(verse|verses|versus|vs)$/.test(w)) sawVerseWord = true; k++; continue; }
      if (w === 'oh' || w === 'o') { // "one oh five" -> 105 is rare; treat "oh N" as 0N
        const nx = tokens[k + 1];
        if (nums.length && /^\d$/.test(nx || '')) { nums[nums.length - 1] = nums[nums.length - 1] * 10 + parseInt(nx, 10); k += 2; continue; }
      }
      if (HOMOPHONES[w] && (nums.length > 0 || sawVerseWord || tokens[k - 1] === 'chapter')) {
        nums.push(parseInt(HOMOPHONES[w], 10)); k++; continue;
      }
      break;
    }
    if (!nums.length) continue;
    const chapter = nums[0];
    if (!chapter || chapter < 1 || chapter > 176) continue;
    const book = BIBLE_BOOKS[alias];
    let match;
    if (nums.length >= 2 && nums[1] >= 1 && nums[1] <= 176) {
      match = { reference: `${book} ${chapter}:${nums[1]}`, book, chapter, verse: nums[1], hasVerse: true, pos: t };
    } else {
      match = { reference: `${book} ${chapter}`, book, chapter, verse: null, hasVerse: false, pos: t };
    }
    best = match; // later mentions override earlier ones
    t = k - 1; // skip tokens this match consumed
  }
  return best;
}

if (typeof module !== 'undefined') {
  module.exports = { findScriptureReference, fuzzyBook, BIBLE_BOOKS, normalizeSpokenNumbers, prepareSpeech };
}
