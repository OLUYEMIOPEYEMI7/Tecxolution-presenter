const test = require('node:test');
const assert = require('node:assert');
const { findScriptureReference } = require('../public/js/bible-books.js');

const ref = (t) => { const m = findScriptureReference(t); return m && m.reference; };

test('spoken references parse', () => {
  const cases = {
    'Genesis chapter one verse one': 'Genesis 1:1',
    'john three sixteen': 'John 3:16',
    'John 3:16': 'John 3:16',
    'Romans eight twenty eight': 'Romans 8:28',
    'psalm twenty three': 'Psalm 23',
    'psalm twenty three verse four': 'Psalm 23:4',
    'first john four eight': '1 John 4:8',
    'turn to first corinthians thirteen verse four': '1 Corinthians 13:4',
    'open to 2nd timothy 3 16': '2 Timothy 3:16',
    'two kings six': '2 Kings 6',
    'the book of Ephesians chapter 2 verse 8': 'Ephesians 2:8',
    'Efesians two eight': 'Ephesians 2:8',
    'psalm one hundred and nineteen verse 105': 'Psalm 119:105',
    'john 3 verse for': 'John 3:4',
    'as John said then Romans 12 2': 'Romans 12:2',
    'john 3 16 then john 4 1': 'John 4:1', // latest mention wins
    '1 john 5 and john 1': 'John 1',
    'he brews eleven verse one': 'Hebrews 11:1',
    'filipians four thirteen': 'Philippians 4:13',
    'galations five twenty two': 'Galatians 5:22',
    'habakuk two verse two': 'Habakkuk 2:2',
    'jeremia 29 11': 'Jeremiah 29:11',
  };
  for (const [said, want] of Object.entries(cases)) assert.strictEqual(ref(said), want, said);
});

test('ordinary sermon speech is not a reference', () => {
  for (const t of ['like John, who was baptizing for 40 days', 'mark my words 5 times', 'we have job to do', 'amos was a shepherd', 'the president said 5 things', 'matter 5 times', 'people 3 of them']) {
    assert.strictEqual(ref(t), null, t);
  }
});

// ---- VoiceDetector with a mock SpeechRecognition ----
class MockRec {
  constructor() { MockRec.last = this; }
  start() { MockRec.started = (MockRec.started || 0) + 1; }
  stop() { setTimeout(() => this.onend && this.onend(), 0); }
  abort() {}
}
const evt = (alts, isFinal) => ({ resultIndex: 0, results: [Object.assign(alts.map((t) => ({ transcript: t, confidence: 0.9 })), { isFinal })] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('detector fires on a stable INTERIM result, quickly, and waits for the verse', async () => {
  global.window = { SpeechRecognition: MockRec };
  const src = require('fs').readFileSync(require('path').join(__dirname, '../public/js/voice-detect.js'), 'utf8');
  const VoiceDetector = new Function('findScriptureReference', 'window', src + '; return VoiceDetector;')(findScriptureReference, global.window);
  const fired = []; const cand = [];
  const d = new VoiceDetector({ onReferenceDetected: (m) => fired.push([m.reference, Date.now()]), onCandidate: (m) => cand.push(m.reference) });
  d.start();
  const t0 = Date.now();
  // chapter only first, then verse arrives -> must NOT project "John 3" on its own
  MockRec.last.onresult(evt(['open to john 3'], false));
  await wait(80);
  MockRec.last.onresult(evt(['open to john 3 16'], false));
  await wait(450);
  assert.deepStrictEqual(fired.map((f) => f[0]), ['John 3:16']);
  assert.ok(fired[0][1] - t0 < 600, 'fired within 0.6s of the first interim');
  assert.deepStrictEqual(cand, ['John 3', 'John 3:16']);
  // final result fires immediately
  MockRec.last.onresult(evt(['romans eight twenty eight'], true));
  assert.strictEqual(fired[1][0], 'Romans 8:28');
  // misheard top guess: second alternative parses
  MockRec.last.onresult(evt(['turn to the word of the lord', 'psalm twenty three verse one'], true));
  assert.strictEqual(fired[2][0], 'Psalm 23:1');
  // restart is fast
  const before = MockRec.started;
  MockRec.last.onend();
  await wait(120);
  assert.ok(MockRec.started > before, 'session restarted within 120ms');
  d.stop();
});
