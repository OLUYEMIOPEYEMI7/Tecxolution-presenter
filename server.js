const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------------------------------------------------------------------------
// Persistent storage: if DATABASE_URL is set (shared Render Postgres reused
// from the Academy project), custom songs / announcements / uploaded theme
// images survive redeploys. Without it, falls back to local JSON files + disk
// (fine for local dev, but wiped on every Render redeploy).
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

async function initDb() {
  if (!pool) {
    console.log('No DATABASE_URL set — using local file storage (not persistent across redeploys).');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wp_custom_songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT,
      sections JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wp_announcements (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wp_theme_images (
      id TEXT PRIMARY KEY,
      filename TEXT,
      mimetype TEXT,
      data BYTEA,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('Connected to persistent Postgres storage.');
}

const customThemeImageDir = path.join(__dirname, 'public', 'images', 'custom-themes');
fs.mkdirSync(customThemeImageDir, { recursive: true });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

const songsPath = path.join(__dirname, 'data', 'songs.json');
const hymnsPath = path.join(__dirname, 'data', 'hymns.json');
const announcementsPath = path.join(__dirname, 'data', 'announcements.json');
const rccgHymnalPath = path.join(__dirname, 'data', 'rccg-hymnal.json');

function loadHymns() {
  return JSON.parse(fs.readFileSync(hymnsPath, 'utf8'));
}

function loadRccgHymnal() {
  return JSON.parse(fs.readFileSync(rccgHymnalPath, 'utf8'));
}

function slugify(title) {
  return 'song-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-' + Date.now().toString(36);
}

// ---- Custom songs (persistent) ----
async function loadCustomSongs() {
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT id, title, artist, sections FROM wp_custom_songs ORDER BY created_at');
      return rows;
    } catch (e) {
      console.error('DB read failed for custom songs, falling back to local file:', e.message);
      // fall through to file fallback below
    }
  }
  if (!fs.existsSync(songsPath)) return [];
  const data = JSON.parse(fs.readFileSync(songsPath, 'utf8'));
  return data.songs;
}

async function addCustomSong(song) {
  if (pool) {
    await pool.query('INSERT INTO wp_custom_songs (id, title, artist, sections) VALUES ($1, $2, $3, $4)', [
      song.id, song.title, song.artist, JSON.stringify(song.sections),
    ]);
    return;
  }
  const data = JSON.parse(fs.readFileSync(songsPath, 'utf8'));
  data.songs.push(song);
  fs.writeFileSync(songsPath, JSON.stringify(data, null, 2));
}

async function deleteCustomSong(id) {
  if (pool) {
    const { rowCount } = await pool.query('DELETE FROM wp_custom_songs WHERE id = $1', [id]);
    return rowCount > 0;
  }
  const data = JSON.parse(fs.readFileSync(songsPath, 'utf8'));
  const before = data.songs.length;
  data.songs = data.songs.filter((s) => s.id !== id);
  fs.writeFileSync(songsPath, JSON.stringify(data, null, 2));
  return data.songs.length < before;
}

// ---- Announcements (persistent) ----
async function loadAnnouncementsList() {
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT id, text FROM wp_announcements ORDER BY created_at');
      return rows;
    } catch (e) {
      console.error('DB read failed for announcements, falling back to local file:', e.message);
    }
  }
  if (!fs.existsSync(announcementsPath)) return [];
  return JSON.parse(fs.readFileSync(announcementsPath, 'utf8')).announcements;
}

async function addAnnouncementItem(text) {
  const newItem = { id: 'ann-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text };
  if (pool) {
    await pool.query('INSERT INTO wp_announcements (id, text) VALUES ($1, $2)', [newItem.id, newItem.text]);
    return newItem;
  }
  const data = fs.existsSync(announcementsPath) ? JSON.parse(fs.readFileSync(announcementsPath, 'utf8')) : { announcements: [] };
  data.announcements.push(newItem);
  fs.writeFileSync(announcementsPath, JSON.stringify(data, null, 2));
  return newItem;
}

async function deleteAnnouncementItem(id) {
  if (pool) {
    const { rowCount } = await pool.query('DELETE FROM wp_announcements WHERE id = $1', [id]);
    return rowCount > 0;
  }
  const data = fs.existsSync(announcementsPath) ? JSON.parse(fs.readFileSync(announcementsPath, 'utf8')) : { announcements: [] };
  const before = data.announcements.length;
  data.announcements = data.announcements.filter((a) => a.id !== id);
  fs.writeFileSync(announcementsPath, JSON.stringify(data, null, 2));
  return data.announcements.length < before;
}

// ---- Theme images (persistent: stored as bytes in Postgres; falls back to disk) ----
async function saveThemeImage(buffer, mimetype, originalname) {
  const ext = path.extname(originalname) || '.jpg';
  const id = 'theme-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  if (pool) {
    await pool.query('INSERT INTO wp_theme_images (id, filename, mimetype, data) VALUES ($1, $2, $3, $4)', [
      id, id + ext, mimetype, buffer,
    ]);
    return '/api/theme-image/' + id;
  }
  const filename = id + ext;
  fs.writeFileSync(path.join(customThemeImageDir, filename), buffer);
  return '/images/custom-themes/' + filename;
}

// Builds the full merged song list (all sources) with their complete section
// data, plus a precomputed lowercase search blob (title+artist+number+all
// lyric lines) so keyword search doesn't re-scan structured JSON per request.
let songCache = null;
async function buildSongCache() {
  const customRows = await loadCustomSongs();
  const custom = customRows.map((s) => ({ ...s, source: 'custom' }));
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

async function getAllSongsFull() {
  return songCache || (await buildSongCache());
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

app.get('/api/songs', async (req, res) => {
  try {
  // Lightweight metadata only — full lyrics are fetched on demand via /api/songs/:id
  // so the browser doesn't have to download the entire ~3MB hymnal up front.
  // ?q= searches title, artist, hymn number AND full lyric text (keyword search).
  // ?source= filters to custom|hymn|rccg.
  let all = await getAllSongsFull();
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
  } catch (e) {
    console.error('Error in /api/songs:', e.message);
    res.status(500).json({ error: 'Could not load songs', songs: [] });
  }
});

app.get('/api/songs/:id', async (req, res) => {
  try {
    const all = await getAllSongsFull();
    const song = all.find((s) => s.id === req.params.id);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    res.json(song);
  } catch (e) {
    console.error('Error in /api/songs/:id:', e.message);
    res.status(500).json({ error: 'Could not load song' });
  }
});

// Add a new custom song
app.post('/api/songs', async (req, res) => {
  const { title, artist, sections } = req.body;
  if (!title || !Array.isArray(sections) || sections.length === 0) {
    return res.status(400).json({ error: 'title and at least one section are required' });
  }
  const newSong = {
    id: slugify(title),
    title,
    artist: artist || '',
    sections,
  };
  try {
    await addCustomSong(newSong);
    songCache = null; // invalidate so the new song is searchable immediately
    res.json(newSong);
  } catch (e) {
    res.status(500).json({ error: 'Could not save song: ' + e.message });
  }
});

// Delete a custom song (hymns in the compendium cannot be deleted this way)
app.delete('/api/songs/:id', async (req, res) => {
  try {
    const deleted = await deleteCustomSong(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Song not found (hymns cannot be deleted)' });
    songCache = null; // invalidate
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete song: ' + e.message });
  }
});

// Scripture lookup — proxies bible-api.com (free, public-domain translations;
// no key required). Supported: kjv, web (default), asv, bbe, darby, ylt, etc.
app.get('/api/scripture', (req, res) => {
  const ref = (req.query.ref || '').trim();
  const version = (req.query.version || 'kjv').trim().toLowerCase();
  if (!ref) return res.status(400).json({ error: 'Missing ref' });

  const url = `https://bible-api.com/${encodeURIComponent(ref)}?translation=${encodeURIComponent(version)}`;
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
          translation: (data.translation_name || version.toUpperCase()),
        });
      } catch (e) {
        res.status(502).json({ error: 'Could not parse scripture response' });
      }
    });
  }).on('error', (e) => res.status(502).json({ error: e.message }));
});

// List of Bible versions the app can look up. Free/public-domain ones work
// immediately via bible-api.com. Copyrighted ones (NIV/NLT/ESV/MSG/NKJV/AMP)
// are NOT fetchable through any free, no-key API and are listed here only to
// show their status honestly in the UI.
app.get('/api/bible-versions', (req, res) => {
  res.json({
    versions: [
      { code: 'kjv', name: 'King James Version', available: true },
      { code: 'web', name: 'World English Bible', available: true },
      { code: 'webbe', name: 'World English Bible (British)', available: true },
      { code: 'asv', name: 'American Standard Version', available: true },
      { code: 'bbe', name: 'Bible in Basic English', available: true },
      { code: 'darby', name: 'Darby Bible', available: true },
      { code: 'ylt', name: "Young's Literal Translation (NT only)", available: true },
      { code: 'nkjv', name: 'New King James Version', available: false, reason: 'Copyrighted — requires a paid API.Bible license' },
      { code: 'niv', name: 'New International Version', available: false, reason: 'Copyrighted — requires a paid API.Bible license' },
      { code: 'nlt', name: 'New Living Translation', available: false, reason: 'Copyrighted — requires a paid API.Bible license' },
      { code: 'esv', name: 'English Standard Version', available: false, reason: 'Free for churches via api.esv.org, but needs your own registered API key (not configured yet)' },
      { code: 'msg', name: 'The Message', available: false, reason: 'Copyrighted — requires a paid API.Bible license' },
      { code: 'amp', name: 'Amplified Bible', available: false, reason: 'Copyrighted — requires a paid API.Bible license' },
    ],
  });
});

// Upload an image to use as a custom theme background
app.post('/api/theme-image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded (must be an image file, max 8MB)' });
  try {
    const url = await saveThemeImage(req.file.buffer, req.file.mimetype, req.file.originalname);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: 'Could not save image: ' + e.message });
  }
});

// Serve a theme image stored in Postgres (disk-stored ones are served as
// static files from /images/custom-themes/ instead)
app.get('/api/theme-image/:id', async (req, res) => {
  if (!pool) return res.status(404).end();
  try {
    const { rows } = await pool.query('SELECT mimetype, data FROM wp_theme_images WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).end();
    res.set('Content-Type', rows[0].mimetype || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(rows[0].data);
  } catch (e) {
    res.status(500).end();
  }
});

// Saved announcements library (reusable text snippets — account numbers, notices, etc.)
app.get('/api/announcements', async (req, res) => {
  res.json({ announcements: await loadAnnouncementsList() });
});

app.post('/api/announcements', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const newItem = await addAnnouncementItem(text.trim());
    res.json(newItem);
  } catch (e) {
    res.status(500).json({ error: 'Could not save: ' + e.message });
  }
});

app.delete('/api/announcements/:id', async (req, res) => {
  try {
    const deleted = await deleteAnnouncementItem(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete: ' + e.message });
  }
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
initDb()
  .then(() => {
    server.listen(PORT, () => console.log(`Worship Presenter running at http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error('DB init failed, starting anyway with file fallback:', e.message);
    server.listen(PORT, () => console.log(`Worship Presenter running at http://localhost:${PORT}`));
  });
