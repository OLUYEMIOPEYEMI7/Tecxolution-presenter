// Song search + lyric parsing, kept free of Express so it can be tested directly.
//
// Search works like a worship-software library search: type any words from the
// title, artist, hymn number OR the lyrics themselves ("blessed", "name of the
// Lord") and the best matches come first, each with the lyric line that matched.

const STOPWORDS = new Set(['my','the','a','an','is','of','to','in','on','for','and','that','this','with','at','by','from','as','it','be','we','you','your','he','his','him','she','her','they','them','our','us','i','am','are','was','were','will','shall','thy','thee','thou','o']);

const norm = (t) => String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Title-only imports carry a "(Lyrics not yet added...)" NOTE card. It must
// never count as lyrics: it would otherwise match searches like "song" or "add".
function isPlaceholderSection(sec) {
  return !!(sec && sec.label === 'NOTE' && sec.pairs && sec.pairs[0] && /lyrics not yet added/i.test(String(sec.pairs[0][0] || '')));
}

// Everything the search needs, computed once per song (not once per keystroke).
function indexSong(s) {
  const real = (s.sections || []).filter((sec) => !isPlaceholderSection(sec));
  const lines = [];
  real.forEach((sec) => (sec.pairs || []).forEach((p) => {
    const text = [p[0], p[1]].filter(Boolean).join(' ').trim();
    if (text) lines.push({ label: sec.label || '', text, n: norm(text) });
  }));
  const t = norm(s.title);
  const a = norm(s.artist);
  const l = lines.map((x) => x.n).join(' ');
  return {
    hasLyrics: lines.length > 0,
    realSectionCount: real.length,
    _t: t, _a: a, _l: l, _lines: lines,
    _all: [t, a, norm(s.hymnNumber), l].join(' '),
  };
}

function snippetFor(s, qn, words) {
  const lines = s._lines;
  if (!lines.length) return null;
  let best = lines.findIndex((x) => x.n.includes(qn));
  if (best < 0) {
    let bestCount = 0;
    lines.forEach((x, i) => {
      const c = words.filter((w) => x.n.includes(w)).length;
      if (c > bestCount) { bestCount = c; best = i; }
    });
    if (bestCount === 0) return null;
  }
  let text = lines[best].text;
  if (text.length < 28 && lines[best + 1]) text += ' / ' + lines[best + 1].text; // very short line: add context
  return { label: lines[best].label, text: text.slice(0, 160) };
}

// Returns [{ song, score, matchedIn, snippet }] best-first.
function searchSongs(all, query) {
  const qn = norm(query);
  const words = qn.split(' ').filter(Boolean);
  const sig = words.filter((w) => !STOPWORDS.has(w));
  const eff = sig.length ? sig : words;
  if (!qn) return all.map((song) => ({ song, score: 0, matchedIn: null, snippet: null }));

  const scored = [];
  for (const song of all) {
    let score = 0;
    let matchedIn = null;
    if (/^\d+$/.test(qn) && String(song.hymnNumber || '') === qn) { score = 1000; matchedIn = 'number'; }
    else {
      if (song._t === qn) score = 900;
      else if (song._t.startsWith(qn)) score = 750;
      else if ((' ' + song._t + ' ').includes(' ' + qn + ' ')) score = 650;
      else if (song._t.includes(qn)) score = 600;
      if (score) matchedIn = 'title';
      if (song._a.includes(qn) && score < 300) { score = 300; matchedIn = 'artist'; }
      if (qn.length >= 3 && song._l.includes(qn) && score < 500) { score = 500; matchedIn = 'lyrics'; } // exact phrase in the lyrics
      if (!score && eff.every((w) => song._all.includes(w))) {
        const inTitle = eff.filter((w) => song._t.includes(w)).length;
        score = 200 + inTitle * 30;
        matchedIn = inTitle ? 'title' : (eff.every((w) => song._a.includes(w)) ? 'artist' : 'lyrics');
      }
    }
    if (score) scored.push({ song, score, matchedIn });
  }

  // Nothing matched every word (one word misremembered): fall back to songs
  // matching a clear majority of the words, best first.
  if (!scored.length && eff.length > 1) {
    const threshold = Math.max(2, Math.ceil(eff.length * 0.6));
    for (const song of all) {
      const c = eff.filter((w) => song._all.includes(w)).length;
      if (c >= threshold) scored.push({ song, score: 50 + c, matchedIn: 'lyrics' });
    }
  }

  scored.sort((x, y) => y.score - x.score || x.song.title.localeCompare(y.song.title));
  return scored.map((r, i) => ({
    ...r,
    snippet: i < 80 && (r.matchedIn === 'lyrics' || r.matchedIn === 'title' || r.matchedIn === 'artist') ? snippetFor(r.song, qn, eff) : null,
  }));
}

// ---- pasted lyrics -> slide sections (blank line = new slide) ----
const LABEL_RE = /^(chorus|refrain|bridge|intro|outro|pre-?chorus|tag|vamp|verse)\b.*:?$/i;
function parseLyrics(raw) {
  const blocks = String(raw || '').replace(/\r/g, '').split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
  let verse = 0;
  const out = [];
  for (const block of blocks) {
    let lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    let label = null;
    const first = lines[0] || '';
    if (LABEL_RE.test(first) && first.split(/\s+/).length <= 3) {
      label = first.replace(/:$/, '').toUpperCase();
      const n = /^VERSE\s*(\d+)/.exec(label);
      if (n) verse = Math.max(verse, Number(n[1])); // keep numbering consistent after an explicit "Verse 2"
      lines = lines.slice(1);
    }
    if (!lines.length) continue;
    if (!label) { verse++; label = `VERSE ${verse}`; }
    out.push({ label: label.slice(0, 60), pairs: lines.slice(0, 80).map((l) => [l.slice(0, 500), '']), background: null });
  }
  return out.slice(0, 80);
}

// "Baruch Hashem Adonai (Live)" and "baruch hashem adonai" are the same song.
function normalizeTitle(t) {
  return norm(String(t || '').replace(/\((live|official[^)]*|audio|video|lyric[^)]*|reprise|acoustic)\)/gi, ' '));
}

module.exports = { STOPWORDS, norm, isPlaceholderSection, indexSong, searchSongs, parseLyrics, normalizeTitle };
