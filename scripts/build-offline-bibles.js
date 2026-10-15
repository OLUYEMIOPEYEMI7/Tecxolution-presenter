#!/usr/bin/env node
// Builds the offline Bible texts shipped with the desktop app (public-domain
// King James Version and World English Bible) into data/bible/*.json:
//   { translation, books: { GEN: [ [v1, v2, ...] /* chapter 1 */, ... ], ... } }
//
// Usage:  node scripts/build-offline-bibles.js <kjv-package-dir> <world-english-bible-package-dir>
//   (both are plain npm tarballs:  npm pack kjv world-english-bible  and extract them)
// The generated files are committed, so the app build never needs this script.
const fs = require('fs');
const path = require('path');
const { BIBLE_BOOK_CODES, STRUCTURE } = require('../lib/bible');

const [kjvDir, webDir] = process.argv.slice(2);
if (!kjvDir || !webDir) { console.error('usage: build-offline-bibles.js <kjv-dir> <web-dir>'); process.exit(1); }
const outDir = path.join(__dirname, '..', 'data', 'bible');
fs.mkdirSync(outDir, { recursive: true });

const clean = (t) => t.replace(/\s+/g, ' ').trim();
const codeOf = (name) => {
  const key = name.toLowerCase().replace(/\s+/g, '');
  return BIBLE_BOOK_CODES[key] || (key === "solomon'ssong" ? 'SNG' : undefined); // the KJV package's name for Song of Solomon
};

function emptyBooks() {
  const books = {};
  STRUCTURE.forEach((b) => { books[codeOf(b.name)] = b.chapters.map(() => []); });
  return books;
}

// ---- KJV: { "Genesis 1:1": "text", ... } ('# ' = paragraph mark, [x] = italic supplied words)
const kjvVerses = JSON.parse(fs.readFileSync(path.join(kjvDir, 'json', 'verses-1769.json'), 'utf8'));
const kjv = emptyBooks();
for (const [ref, raw] of Object.entries(kjvVerses)) {
  const m = ref.match(/^(.+) (\d+):(\d+)$/);
  const code = codeOf(m[1]);
  if (!code) throw new Error('KJV: unknown book ' + m[1]);
  kjv[code][Number(m[2]) - 1][Number(m[3]) - 1] = clean(raw.replace(/^#\s*/, '').replace(/[\[\]]/g, ''));
}

// ---- WEB: one file per book; verse text spread across paragraph/line entries
const web = emptyBooks();
for (const file of fs.readdirSync(path.join(webDir, 'json'))) {
  const code = codeOf(file.replace(/\.json$/, ''));
  if (!code) throw new Error('WEB: unknown book file ' + file);
  const parts = {};
  for (const e of JSON.parse(fs.readFileSync(path.join(webDir, 'json', file), 'utf8'))) {
    if ((e.type === 'paragraph text' || e.type === 'line text') && e.chapterNumber && e.verseNumber) {
      const k = e.chapterNumber + ':' + e.verseNumber;
      parts[k] = (parts[k] || '') + ' ' + e.value;
    }
  }
  for (const [k, v] of Object.entries(parts)) {
    const [c, n] = k.split(':').map(Number);
    if (web[code][c - 1]) web[code][c - 1][n - 1] = clean(v);
  }
}

// ---- validate against the canonical chapter/verse structure, then write
function check(name, books) {
  let total = 0; const gaps = [];
  STRUCTURE.forEach((b) => {
    const code = codeOf(b.name);
    b.chapters.forEach((count, ci) => {
      for (let v = 0; v < count; v++) {
        if (books[code][ci][v]) total++; else gaps.push(`${b.name} ${ci + 1}:${v + 1}`);
      }
      books[code][ci] = Array.from(books[code][ci], (x) => x || ''); // dense arrays, no holes
    });
  });
  console.log(`${name}: ${total} verses, ${gaps.length} not present in this translation${gaps.length ? ' (e.g. ' + gaps.slice(0, 4).join(', ') + ')' : ''}`);
}
check('KJV', kjv);
check('WEB', web);
fs.writeFileSync(path.join(outDir, 'kjv.json'), JSON.stringify({ translation: 'King James Version', books: kjv }));
fs.writeFileSync(path.join(outDir, 'web.json'), JSON.stringify({ translation: 'World English Bible', books: web }));
console.log('wrote', fs.readdirSync(outDir).map((f) => f + ' ' + Math.round(fs.statSync(path.join(outDir, f)).size / 1024) + 'KB').join(', '));
