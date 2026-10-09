const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const customThemeImageDir = path.join(__dirname, 'public', 'images', 'custom-themes');
fs.mkdirSync(customThemeImageDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: customThemeImageDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, 'theme-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

const songsPath = path.join(__dirname, 'data', 'songs.json');
const hymnsPath = path.join(__dirname, 'data', 'hymns.json');
const announcementsPath = path.join(__dirname, 'data', 'announcements.json');

function loadSongs() {
  return JSON.parse(fs.readFileSync(songsPath, 'utf8'));
}

function saveSongs(data) {
  fs.writeFileSync(songsPath, JSON.stringify(data, null, 2));
}

function loadHymns() {
  return JSON.parse(fs.readFileSync(hymnsPath, 'utf8'));
}

function loadAnnouncements() {
  if (!fs.existsSync(announcementsPath)) return { announcements: [] };
  return JSON.parse(fs.readFileSync(announcementsPath, 'utf8'));
}

function saveAnnouncements(data) {
  fs.writeFileSync(announcementsPath, JSON.stringify(data, null, 2));
}

const rccgHymnalPath = path.join(__dirname, 'data', 'rccg-hymnal.json');
function loadRccgHymnal() {
  return JSON.parse(fs.readFileSync(rccgHymnalPath, 'utf8'));
}

function slugify(title) {
  return 'song-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-' + Date.now().toString(36);
}

// Builds the full merged song list (all sources) with their complete section
// data, plus a precomputed lowercase search blob (title+artist+number+all
// lyric lines) so keyword search doesn't re-scan structured JSON per request.
let songCache = null;
function buildSongCache() {
  const custom = loadSongs().songs.map((s) => ({ ...s, source: 'custom' }));
  const hymns = loadHymns().hymns.map((h) => ({ ...h, source: 'hymn' }));
  const rccg = loadRccgHymnal().hymns.map((h) => ({ ...h, source: 'rccg' }));
  const all = [...custom, ...hymns, ...rccg];
  songCache = all.map((s) => {
    const lyricText = s.sections.map((sec) => sec.pairs.map((p) => p.join(' ')).join(' ')).join(' ');
    const rawText = [s.title, s.artist, s.hymnNumber, lyricText].filter(Boolean).join(' ').toLowerCase();
    // Strip punctuation so "blessings, name" still matches a query typed as "blessings name"
    const searchText = rawText.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ');
    return { ...s, _searchText: searchText };
  });
  return songCache;
}

function getAllSongsFull() {
  return songCache || buildSongCache();
}

// Two independent states: liveState is what the audience sees, previewState
// is staged but not yet visible. They're broadcast on separate socket events
// so the Preview and Live iframes (both /display, same rendering code) stay
// perfectly proportional to each other — Preview is a true miniature of Live,
// not an approximation.
let liveState = { type: 'blank' };
let previewState = { type: 'blank' };
let tickerState = { active: false, text: '' };

app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'views', 'control.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'views', 'display.html')));
app.get('/', (req, res) => res.redirect('/control'));

app.get('/api/songs', (req, res) => {
  // Lightweight metadata only — full lyrics are fetched on demand via /api/songs/:id
  // so the browser doesn't have to download the entire ~3MB hymnal up front.
  // ?q= searches title, artist, hymn number AND full lyric text (keyword search).
  // ?source= filters to custom|hymn|rccg.
  let all = getAllSongsFull();
  const q = (req.query.q || '').trim().toLowerCase();
  const source = req.query.source || 'all';

  if (source !== 'all') all = all.filter((s) => s.source === source);
  if (q) {
    // Match every typed word somewhere in the song's text — forgiving of
    // word order, punctuation, and misremembered phrasing. Common stopwords
    // are ignored for scoring since they're too common to be discriminating.
    const STOPWORDS = new Set(['my','the','a','an','is','of','to','in','on','for','and','that','this','with','at','by','from','as','it','be','we','you','your','he','his','him','she','her','they','them','our','us','i','am','are','was','were','will','shall','thy','thee','thou','o']);
    const allWords = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const words = allWords.filter((w) => !STOPWORDS.has(w));
    const effectiveWords = words.length > 0 ? words : allWords; // if query is only stopwords, use them anyway

    let matched = all.filter((s) => effectiveWords.every((w) => s._searchText.includes(w)));
    if (matched.length === 0 && effectiveWords.length > 1) {
      // Nothing matched every word (e.g. one word misremembered) — fall back
      // to songs matching a clear majority of the words, ranked best-first.
      const threshold = Math.max(2, Math.ceil(effectiveWords.length * 0.6));
      matched = all
        .map((s) => ({ s, score: effectiveWords.filter((w) => s._searchText.includes(w)).length }))
        .filter((x) => x.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map((x) => x.s);
    }
    all = matched;
  }

  const light = all.map((s) => ({
    id: s.id,
    title: s.title,
    artist: s.artist || '',
    source: s.source,
    hymnNumber: s.hymnNumber || null,
    sectionCount: s.sections.length,
  }));
  res.json({ songs: light });
});

app.get('/api/songs/:id', (req, res) => {
  const song = getAllSongsFull().find((s) => s.id === req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found' });
  res.json(song);
});

// Add a new custom song
app.post('/api/songs', (req, res) => {
  const { title, artist, sections } = req.body;
  if (!title || !Array.isArray(sections) || sections.length === 0) {
    return res.status(400).json({ error: 'title and at least one section are required' });
  }
  const data = loadSongs();
  const newSong = {
    id: slugify(title),
    title,
    artist: artist || '',
    sections,
  };
  data.songs.push(newSong);
  saveSongs(data);
  songCache = null; // invalidate so the new song is searchable immediately
  res.json(newSong);
});

// Delete a custom song (hymns in the compendium cannot be deleted this way)
app.delete('/api/songs/:id', (req, res) => {
  const data = loadSongs();
  const before = data.songs.length;
  data.songs = data.songs.filter((s) => s.id !== req.params.id);
  if (data.songs.length === before) {
    return res.status(404).json({ error: 'Song not found (hymns cannot be deleted)' });
  }
  saveSongs(data);
  songCache = null; // invalidate
  res.json({ ok: true });
});

// Scripture lookup — proxies bible-api.com (free, no key required)
app.get('/api/scripture', (req, res) => {
  const ref = (req.query.ref || '').trim();
  if (!ref) return res.status(400).json({ error: 'Missing ref' });

  const url = `https://bible-api.com/${encodeURIComponent(ref)}`;
  https.get(url, (apiRes) => {
    let body = '';
    apiRes.on('data', (chunk) => (body += chunk));
    apiRes.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.error) return res.status(404).json({ error: data.error });
        res.json({
          reference: data.reference,
          text: data.text.trim().replace(/\n/g, ' ').replace(/\s+/g, ' '),
          translation: (data.translation_name || 'KJV'),
        });
      } catch (e) {
        res.status(502).json({ error: 'Could not parse scripture response' });
      }
    });
  }).on('error', (e) => res.status(502).json({ error: e.message }));
});

// Upload an image to use as a custom theme background
app.post('/api/theme-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded (must be an image file, max 8MB)' });
  res.json({ url: '/images/custom-themes/' + req.file.filename });
});

// Saved announcements library (reusable text snippets — account numbers, notices, etc.)
app.get('/api/announcements', (req, res) => {
  res.json(loadAnnouncements());
});

app.post('/api/announcements', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  const data = loadAnnouncements();
  const newItem = { id: 'ann-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: text.trim() };
  data.announcements.push(newItem);
  saveAnnouncements(data);
  res.json(newItem);
});

app.delete('/api/announcements/:id', (req, res) => {
  const data = loadAnnouncements();
  const before = data.announcements.length;
  data.announcements = data.announcements.filter((a) => a.id !== req.params.id);
  if (data.announcements.length === before) return res.status(404).json({ error: 'Not found' });
  saveAnnouncements(data);
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  // Catch up any newly-connected display/control client on both channels
  socket.emit('live-state', liveState);
  socket.emit('preview-state', previewState);
  socket.emit('ticker-state', tickerState);

  // Stage content into Preview only — does not touch what the audience sees
  socket.on('stage', (payload) => {
    previewState = payload;
    io.emit('preview-state', previewState);
  });

  // Promote whatever is currently staged in Preview to Live
  socket.on('golive', () => {
    liveState = previewState;
    io.emit('live-state', liveState);
  });

  // Direct-to-live, bypassing Preview entirely (used by Voice Detect auto-project)
  socket.on('project', (payload) => {
    liveState = payload;
    io.emit('live-state', liveState);
  });

  socket.on('clear', () => {
    liveState = { type: 'blank' };
    io.emit('live-state', liveState);
  });

  // Scrolling ticker (lower-third banner) — independent of the main slide,
  // shown on Live (and Preview, for the operator to check it before airing).
  socket.on('ticker-update', (payload) => {
    tickerState = { active: !!payload.active, text: payload.text || '' };
    io.emit('ticker-state', tickerState);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Worship Presenter running at http://localhost:${PORT}`));
