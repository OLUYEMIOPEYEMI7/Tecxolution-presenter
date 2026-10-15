// Scripture served from Bible texts bundled with the app (public domain King
// James Version and World English Bible): no internet, no external API, and
// instant. Other translations still come from the online services.
const fs = require('fs');
const path = require('path');
const { scriptureMeta, canonicalReference, parseBibleReference } = require('./bible');

const FILES = { kjv: 'kjv.json', web: 'web.json' };
const BOOK_CODE_BY_INDEX = require('./bible').STRUCTURE.map((b) => {
  const { BIBLE_BOOK_CODES } = require('./bible');
  return BIBLE_BOOK_CODES[b.name.toLowerCase().replace(/\s+/g, '')];
});
const cache = new Map();

function load(version) {
  if (!FILES[version]) return null;
  if (!cache.has(version)) {
    try { cache.set(version, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'bible', FILES[version]), 'utf8'))); }
    catch (e) { cache.set(version, null); }
  }
  return cache.get(version);
}

const available = (version) => !!load(version);

// -> null (not an offline translation / data missing) | { error, status } | { reference, text, translation, verses }
function lookup(version, ref) {
  const bible = load(version);
  if (!bible) return null;
  const meta = scriptureMeta(ref);
  if (!meta) return { error: 'Could not understand reference "' + ref + '" — try a format like "John 3:16" or "John 3:16-18"', status: 400 };
  // scriptureMeta clamps to the chapter length; a verse that doesn't exist must be an error, not a different verse
  if (parseBibleReference(ref).verseStart > meta.verseCount) return { error: 'Reference not found: ' + ref, status: 404 };
  const chapter = bible.books[BOOK_CODE_BY_INDEX[meta.bookIndex]][meta.chapter - 1] || [];
  const verses = [];
  for (let n = meta.verseStart; n <= meta.verseEnd; n++) if (chapter[n - 1]) verses.push({ n, text: chapter[n - 1] });
  if (!verses.length) return { error: 'Reference not found: ' + ref, status: 404 };
  return { reference: canonicalReference(meta), text: verses.map((v) => v.text).join(' '), translation: bible.translation, verses };
}

module.exports = { lookup, available };
