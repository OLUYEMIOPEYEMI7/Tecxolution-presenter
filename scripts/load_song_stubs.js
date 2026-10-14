// One-time bulk loader: creates title-only song stubs for 300+ well-known
// Nigerian + global praise & worship songs. NO LYRICS are included — only
// song title + artist (facts, not copyrightable) plus a clear placeholder
// slide explaining why, and what to do about it. Real lyrics must be typed
// in later by the church using the ✎ Edit button, sourced from a licensed
// source the church controls (CCLI SongSelect, a hymnal they own, sheet
// music they've purchased, etc.) — this script deliberately does not and
// cannot supply copyrighted lyrics on their behalf.
const list = require('./song_list.json');

const BASE = process.argv[2] || 'http://localhost:4090';

const PLACEHOLDER = [
  '(Lyrics not yet added for this song.)',
  '',
  'To add them: get a CCLI SongSelect subscription (or use lyrics from a',
  'hymnal / sheet music your church already owns), then click the ✎ Edit',
  'button next to this song in the library and paste the lyrics in.',
];

async function main() {
  let ok = 0, failed = 0;
  for (const [title, artist] of list) {
    const sections = [{
      label: 'NOTE',
      background: null,
      pairs: PLACEHOLDER.map((line) => [line, '']),
    }];
    try {
      const res = await fetch(BASE + '/api/songs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, artist, sections }),
      });
      const data = await res.json();
      if (data.error) { console.error('FAIL', title, data.error); failed++; }
      else { ok++; }
    } catch (e) {
      console.error('FAIL', title, e.message);
      failed++;
    }
  }
  console.log(`Done. Created ${ok}, failed ${failed}, total attempted ${list.length}.`);
}

main();
