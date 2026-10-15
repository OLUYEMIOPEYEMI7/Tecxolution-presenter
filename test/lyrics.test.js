const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../lib/lyrics');
const B = require('../lib/bible');

const mk = (id, title, artist, lines, extra = {}) => {
  const s = { id, title, artist, sections: [{ label: 'VERSE 1', pairs: lines.map((l) => [l, '']) }], ...extra };
  return { ...s, ...L.indexSong(s) };
};
const stub = (() => {
  const s = { id: 'stub', title: 'Baruch Hashem Adonai (Live)', artist: 'Dunsin Oyekan, Theophilus Sunday', sections: [{ label: 'NOTE', pairs: [['(Lyrics not yet added for this song.)', ''], ['To add them: get a CCLI SongSelect subscription', '']] }] };
  return { ...s, ...L.indexSong(s) };
})();
const songs = [
  mk('a', 'Blessed Assurance', 'Fanny Crosby', ['Blessed assurance, Jesus is mine', 'O what a foretaste of glory divine'], { hymnNumber: '12' }),
  mk('b', 'Great Is Thy Faithfulness', 'Thomas Chisholm', ['Morning by morning new mercies I see']),
  mk('c', 'Bless the Lord', 'Anon', ['Bless the name of the Lord forever']),
  mk('d', 'Total Praise', 'Richard Smallwood', ['Blessed be the name of the Lord,', 'whose name is above every name']),
  stub,
];
const titles = (q) => L.searchSongs(songs, q).map((r) => r.song.title);

test('a keyword finds songs by their lyrics, not just titles', () => {
  const r = titles('blessed');
  assert.ok(r.includes('Blessed Assurance') && r.includes('Total Praise'));
  assert.ok(!r.includes('Great Is Thy Faithfulness'));
});

test('a phrase from the lyrics finds the song, with the matching line as a snippet', () => {
  const r = L.searchSongs(songs, 'name of the lord');
  assert.deepStrictEqual(r.map((x) => x.song.id).sort(), ['c', 'd']);
  assert.match(r.find((x) => x.song.id === 'd').snippet.text, /name of the Lord/i);
  assert.strictEqual(r[0].matchedIn, 'lyrics');
});

test('title matches outrank lyric matches; exact hymn number wins', () => {
  assert.strictEqual(titles('bless the lord')[0], 'Bless the Lord');
  assert.strictEqual(titles('12')[0], 'Blessed Assurance');
});

test('words may be given in any order and punctuation is ignored', () => {
  assert.ok(titles('lord, name above').includes('Total Praise'));
  assert.ok(titles('FORETASTE glory').includes('Blessed Assurance'));
});

test('a title-only stub is found by title/artist but its placeholder text never matches', () => {
  assert.strictEqual(stub.hasLyrics, false);
  assert.ok(titles('baruch hashem').includes('Baruch Hashem Adonai (Live)'));
  assert.ok(titles('dunsin').includes('Baruch Hashem Adonai (Live)'));
  assert.deepStrictEqual(titles('lyrics'), []);
  assert.deepStrictEqual(titles('ccli songselect'), []);
});

test('one misremembered word still finds the song (majority fallback)', () => {
  assert.ok(titles('morning mercies faithful xyzzy').includes('Great Is Thy Faithfulness'));
});

test('parseLyrics splits on blank lines, labels sections and keeps numbering consistent', () => {
  const s = L.parseLyrics('Verse 1\nline a\nline b\n\nChorus\nc1\n\nplain verse\nx');
  assert.deepStrictEqual(s.map((x) => x.label), ['VERSE 1', 'CHORUS', 'VERSE 2']);
  assert.deepStrictEqual(L.parseLyrics('   \n\n  '), []);
});

test('title normalisation treats "(Live)" variants as the same song', () => {
  assert.strictEqual(L.normalizeTitle('Baruch Hashem Adonai (Live)'), L.normalizeTitle('baruch hashem adonai'));
});

test('bible: references are shown with the proper book name', () => {
  assert.strictEqual(B.canonicalReference(B.scriptureMeta('jn 3:16')), 'John 3:16');
  assert.strictEqual(B.canonicalReference(B.scriptureMeta('gen 1')), 'Genesis 1');
  assert.strictEqual(B.canonicalReference(B.scriptureMeta('1 cor 13:4-7')), '1 Corinthians 13:4-7');
  assert.strictEqual(B.canonicalReference(B.scriptureMeta('Ps 23:1-6')), 'Psalm 23:1-6');
});

test('bible: abbreviations, chapters and canonical metadata', () => {
  assert.deepStrictEqual(B.scriptureMeta('Gen 1:1'), { book: 'Genesis', bookIndex: 0, chapter: 1, verseStart: 1, verseEnd: 1, verseCount: 31, whole: false });
  assert.strictEqual(B.scriptureMeta('jn 3:16-18').book, 'John');
  assert.strictEqual(B.scriptureMeta('Psalm 119').verseEnd, 176);
  assert.strictEqual(B.scriptureMeta('1 cor 13:4').book, '1 Corinthians');
  assert.strictEqual(B.scriptureMeta('Genesis 99:1'), null);
  assert.strictEqual(B.scriptureMeta('nonsense 1:1'), null);
  assert.strictEqual(B.STRUCTURE.length, 66);
});
