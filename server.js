const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const { Pool } = require('pg');
const cheerio = require('cheerio');

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
    CREATE TABLE IF NOT EXISTS wp_media (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      parent_id TEXT,
      slide_index INT,
      title TEXT,
      mimetype TEXT,
      data BYTEA,
      external_url TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wp_schedule (
      id TEXT PRIMARY KEY,
      idx INT NOT NULL,
      display_title TEXT NOT NULL,
      state_type TEXT NOT NULL,
      payload JSONB,
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

// ---------------------------------------------------------------------------
// Media library: images, video clips/links, and PowerPoint decks (converted
// to a sequence of slide images server-side via LibreOffice + poppler, so
// they display like any other EasyWorship-style slide — no PowerPoint viewer
// needed on the projection screen). Persisted in Postgres (BYTEA) with a
// local-disk fallback for dev, same pattern as theme images above.
// ---------------------------------------------------------------------------
const { execFile } = require('child_process');
const os = require('os');

const uploadMediaImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
const uploadMediaVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // 60MB — for longer clips, paste a link instead
  fileFilter: (req, file, cb) => cb(null, /^video\//.test(file.mimetype)),
});
const uploadPptx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const ok = /\.(pptx|ppt)$/i.test(file.originalname) ||
      /presentationml|vnd\.ms-powerpoint/.test(file.mimetype);
    cb(null, ok);
  },
});

const mediaDiskDir = path.join(__dirname, 'public', 'images', 'media-library');
fs.mkdirSync(mediaDiskDir, { recursive: true });
const mediaJsonPath = path.join(__dirname, 'data', 'media.json');

function loadMediaJson() {
  if (!fs.existsSync(mediaJsonPath)) return { items: [] };
  return JSON.parse(fs.readFileSync(mediaJsonPath, 'utf8'));
}
function saveMediaJson(data) {
  fs.writeFileSync(mediaJsonPath, JSON.stringify(data, null, 2));
}

function newMediaId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Saves one media item (image/video/deck/deck-slide). `buffer` is optional
// (decks themselves hold no bytes, only their deck-slide children do).
async function saveMediaRow({ kind, parentId, slideIndex, title, mimetype, buffer, externalUrl }) {
  const id = newMediaId(kind);
  if (pool) {
    await pool.query(
      `INSERT INTO wp_media (id, kind, parent_id, slide_index, title, mimetype, data, external_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, kind, parentId || null, slideIndex ?? null, title || null, mimetype || null, buffer || null, externalUrl || null]
    );
    return id;
  }
  // Disk fallback
  const data = loadMediaJson();
  let diskFilename = null;
  if (buffer) {
    const ext = mimetype && mimetype.includes('png') ? '.png' : (mimetype && mimetype.split('/')[1] ? '.' + mimetype.split('/')[1] : '.bin');
    diskFilename = id + ext;
    fs.writeFileSync(path.join(mediaDiskDir, diskFilename), buffer);
  }
  data.items.push({ id, kind, parentId: parentId || null, slideIndex: slideIndex ?? null, title: title || null, mimetype: mimetype || null, diskFilename, externalUrl: externalUrl || null, createdAt: Date.now() });
  saveMediaJson(data);
  return id;
}

async function listMediaLibrary() {
  if (pool) {
    const { rows } = await pool.query(`
      SELECT m.id, m.kind, m.title, m.mimetype, m.external_url,
        (SELECT count(*) FROM wp_media s WHERE s.parent_id = m.id) AS slide_count
      FROM wp_media m
      WHERE m.kind IN ('image','video','deck')
      ORDER BY m.created_at DESC
      LIMIT 100
    `);
    return rows.map((r) => ({
      id: r.id, kind: r.kind, title: r.title, mimetype: r.mimetype,
      url: r.kind === 'video' && r.external_url ? r.external_url : `/api/media/file/${r.id}`,
      external: !!(r.kind === 'video' && r.external_url),
      slideCount: Number(r.slide_count) || 0,
    }));
  }
  const data = loadMediaJson();
  const topLevel = data.items.filter((i) => ['image', 'video', 'deck'].includes(i.kind)).sort((a, b) => b.createdAt - a.createdAt);
  return topLevel.map((i) => ({
    id: i.id, kind: i.kind, title: i.title, mimetype: i.mimetype,
    url: i.kind === 'video' && i.externalUrl ? i.externalUrl : `/api/media/file/${i.id}`,
    external: !!(i.kind === 'video' && i.externalUrl),
    slideCount: data.items.filter((s) => s.parentId === i.id).length,
  }));
}

async function getMediaFile(id) {
  if (pool) {
    const { rows } = await pool.query('SELECT mimetype, data, external_url FROM wp_media WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    return { mimetype: rows[0].mimetype, data: rows[0].data, externalUrl: rows[0].external_url };
  }
  const data = loadMediaJson();
  const item = data.items.find((i) => i.id === id);
  if (!item) return null;
  if (item.externalUrl) return { externalUrl: item.externalUrl };
  if (!item.diskFilename) return null;
  return { mimetype: item.mimetype, data: fs.readFileSync(path.join(mediaDiskDir, item.diskFilename)) };
}

async function getDeckSlides(deckId) {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT id, slide_index FROM wp_media WHERE parent_id = $1 AND kind = $2 ORDER BY slide_index',
      [deckId, 'deck-slide']
    );
    return rows.map((r) => ({ id: r.id, url: `/api/media/file/${r.id}` }));
  }
  const data = loadMediaJson();
  return data.items
    .filter((i) => i.parentId === deckId && i.kind === 'deck-slide')
    .sort((a, b) => a.slideIndex - b.slideIndex)
    .map((i) => ({ id: i.id, url: `/api/media/file/${i.id}` }));
}

async function deleteMediaItem(id) {
  if (pool) {
    const { rows } = await pool.query('SELECT kind FROM wp_media WHERE id = $1', [id]);
    if (rows.length === 0) return false;
    if (rows[0].kind === 'deck') await pool.query('DELETE FROM wp_media WHERE parent_id = $1', [id]);
    const { rowCount } = await pool.query('DELETE FROM wp_media WHERE id = $1', [id]);
    return rowCount > 0;
  }
  const data = loadMediaJson();
  const item = data.items.find((i) => i.id === id);
  if (!item) return false;
  const toDelete = data.items.filter((i) => i.id === id || i.parentId === id);
  toDelete.forEach((i) => { if (i.diskFilename) { try { fs.unlinkSync(path.join(mediaDiskDir, i.diskFilename)); } catch (e) {} } });
  data.items = data.items.filter((i) => i.id !== id && i.parentId !== id);
  saveMediaJson(data);
  return true;
}

// Converts an uploaded .pptx/.ppt buffer into one PNG image per slide via
// LibreOffice (headless, pptx→pdf) then poppler's pdftoppm (pdf→PNGs).
// Some PPTX files (e.g. exported by AI slide-deck tools) produce
// OOXML that LibreOffice's importer rejects outright even though it's a
// perfectly valid zip — re-saving once through python-pptx normalizes the
// XML and reliably fixes this before handing it to LibreOffice.
// Requires: soffice (LibreOffice), pdftoppm (poppler-utils), and python3
// with the "pptx" package — NOT available on Render's native Node runtime;
// this only works where those binaries are installed (e.g. a Docker deploy).
function convertDeckToSlideImages(buffer, originalExt) {
  return new Promise((resolve, reject) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-'));
    const srcPath = path.join(workDir, 'input' + originalExt);
    const normalizedPath = path.join(workDir, 'normalized.pptx');
    fs.writeFileSync(srcPath, buffer);

    const normalizeScript = `
import sys
from pptx import Presentation
prs = Presentation(sys.argv[1])
prs.save(sys.argv[2])
`;
    const normalizeScriptPath = path.join(workDir, 'normalize.py');
    fs.writeFileSync(normalizeScriptPath, normalizeScript);

    execFile('python3', [normalizeScriptPath, srcPath, normalizedPath], { timeout: 30000 }, (normErr) => {
      // If normalization isn't available or fails, fall back to the raw
      // upload — some files will still convert fine without it.
      const convertSrc = (!normErr && fs.existsSync(normalizedPath)) ? normalizedPath : srcPath;
      execFile('soffice', ['--headless', '--norestore', '-env:UserInstallation=file://' + path.join(workDir, 'lo_profile'), '--convert-to', 'pdf', '--outdir', workDir, convertSrc], { timeout: 90000 }, (err) => {
        if (err) { cleanup(); return reject(new Error('PowerPoint conversion failed: ' + err.message)); }
        const pdfPath = path.join(workDir, path.basename(convertSrc, path.extname(convertSrc)) + '.pdf');
        if (!fs.existsSync(pdfPath)) { cleanup(); return reject(new Error('Conversion produced no PDF')); }
        const slidePrefix = path.join(workDir, 'slide');
        execFile('pdftoppm', ['-png', '-r', '110', pdfPath, slidePrefix], { timeout: 90000 }, (err2) => {
          if (err2) { cleanup(); return reject(new Error('Slide image export failed: ' + err2.message)); }
          try {
            const files = fs.readdirSync(workDir)
              .filter((f) => f.startsWith('slide') && f.endsWith('.png'))
              .sort((a, b) => {
                const na = parseInt(a.match(/(\d+)/)[1], 10);
                const nb = parseInt(b.match(/(\d+)/)[1], 10);
                return na - nb;
              });
            if (files.length === 0) { cleanup(); return reject(new Error('No slides were produced')); }
            const buffers = files.map((f) => fs.readFileSync(path.join(workDir, f)));
            cleanup();
            resolve(buffers);
          } catch (e) {
            cleanup();
            reject(e);
          }
        });
      });
    });
    function cleanup() {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
    }
  });
}

// ---- Schedule (persisted server-side so it's shared across every device/
// browser that opens the control room, and so it can be built ahead of time
// — e.g. the night before a service — not just from the operator's own machine) ----
const schedulePath = path.join(__dirname, 'data', 'schedule.json');
function loadScheduleJson() {
  if (!fs.existsSync(schedulePath)) return { items: [] };
  return JSON.parse(fs.readFileSync(schedulePath, 'utf8'));
}
function saveScheduleJson(data) {
  fs.writeFileSync(schedulePath, JSON.stringify(data, null, 2));
}

async function loadScheduleList() {
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT id, display_title, state_type, payload FROM wp_schedule ORDER BY idx');
      return rows.map((r) => ({ id: r.id, displayTitle: r.display_title, stateType: r.state_type, ...r.payload }));
    } catch (e) {
      console.error('DB read failed for schedule, falling back to local file:', e.message);
    }
  }
  return loadScheduleJson().items;
}

async function addScheduleRow({ displayTitle, stateType, ...payload }) {
  const id = newMediaId('sched');
  if (pool) {
    const { rows } = await pool.query('SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM wp_schedule');
    const idx = rows[0].next;
    await pool.query('INSERT INTO wp_schedule (id, idx, display_title, state_type, payload) VALUES ($1,$2,$3,$4,$5)', [
      id, idx, displayTitle, stateType, JSON.stringify(payload),
    ]);
    return { id, displayTitle, stateType, ...payload };
  }
  const data = loadScheduleJson();
  const item = { id, displayTitle, stateType, ...payload };
  data.items.push(item);
  saveScheduleJson(data);
  return item;
}

async function removeScheduleRow(id) {
  if (pool) {
    const { rowCount } = await pool.query('DELETE FROM wp_schedule WHERE id = $1', [id]);
    return rowCount > 0;
  }
  const data = loadScheduleJson();
  const before = data.items.length;
  data.items = data.items.filter((i) => i.id !== id);
  saveScheduleJson(data);
  return data.items.length < before;
}

async function clearScheduleRows() {
  if (pool) { await pool.query('DELETE FROM wp_schedule'); return; }
  saveScheduleJson({ items: [] });
}

async function reorderScheduleRows(orderedIds) {
  if (pool) {
    await Promise.all(orderedIds.map((id, idx) => pool.query('UPDATE wp_schedule SET idx = $1 WHERE id = $2', [idx, id])));
    return;
  }
  const data = loadScheduleJson();
  const byId = Object.fromEntries(data.items.map((i) => [i.id, i]));
  data.items = orderedIds.map((id) => byId[id]).filter(Boolean);
  saveScheduleJson(data);
}

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

// Scripture lookup. Three sources:
//  - bible-api.com for free public-domain translations (kjv, web, asv, etc.)
//  - api.nlt.to for NLT — Tyndale's own API, explicitly free for non-commercial
//    / ministry use (works anonymously, no key required, within fair limits).
//  - api.scripture.api.bible for NIV / AMP / MSG — needs a registered API key
//    (API_BIBLE_KEY env var) that the user obtains themselves.
const API_BIBLE_IDS = {
  niv: '78a9f6124f344018-01',
  amp: 'a81b73293d3080c9-01',
  msg: '6f11a7de016f942e-01',
};

app.get('/api/scripture', async (req, res) => {
  const ref = (req.query.ref || '').trim();
  const version = (req.query.version || 'kjv').trim().toLowerCase();
  if (!ref) return res.status(400).json({ error: 'Missing ref' });

  if (version === 'nlt') {
    return fetchNltScripture(ref, res);
  }
  if (API_BIBLE_IDS[version]) {
    return fetchApiBibleScripture(ref, version, res);
  }

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

// API.Bible — used for NIV, AMP, MSG under the user's own free, registered
// non-commercial/ministry API key.
const API_BIBLE_NAMES = { niv: 'New International Version', amp: 'Amplified Bible', msg: 'The Message' };
function fetchApiBibleScripture(ref, version, res) {
  const key = process.env.API_BIBLE_KEY;
  if (!key) return res.status(400).json({ error: 'API_BIBLE_KEY not configured on the server' });
  const bibleId = API_BIBLE_IDS[version];
  const url = `https://api.scripture.api.bible/v1/bibles/${bibleId}/search?query=${encodeURIComponent(ref)}`;
  https.get(url, { headers: { 'api-key': key } }, (apiRes) => {
    let body = '';
    apiRes.on('data', (chunk) => (body += chunk));
    apiRes.on('end', () => {
      try {
        const data = JSON.parse(body);
        const passage = data.data && data.data.passages && data.data.passages[0];
        if (!passage) return res.status(404).json({ error: 'Reference not found' });
        const text = passage.content
          .replace(/<span[^>]*class="v"[^>]*>[\d-]+<\/span>/g, '') // strip inline verse-number markers (incl. ranges like "1-3")
          .replace(/<[^>]+>/g, ' ') // strip remaining HTML tags
          .replace(/\s+/g, ' ')
          .replace(/\s+([,.;:!?])/g, '$1') // tidy stray space before punctuation left by stripped tags
          .trim();
        res.json({ reference: passage.reference, text, translation: API_BIBLE_NAMES[version] || version.toUpperCase() });
      } catch (e) {
        res.status(502).json({ error: 'Could not parse API.Bible response' });
      }
    });
  }).on('error', (e) => res.status(502).json({ error: e.message }));
}

// NLT.TO API — HTML response, parsed with cheerio. Free anonymous key "TEST"
// works for light/sporadic lookups (50 verses/request, 500/day); set
// NLT_API_KEY env var with your own free-registered key for higher limits.
function fetchNltScripture(ref, res) {
  const key = process.env.NLT_API_KEY || 'TEST';
  const url = `https://api.nlt.to/api/passages?ref=${encodeURIComponent(ref)}&version=NLT&key=${encodeURIComponent(key)}`;
  https.get(url, (apiRes) => {
    let body = '';
    apiRes.on('data', (chunk) => (body += chunk));
    apiRes.on('end', () => {
      try {
        const $ = cheerio.load(body);
        const header = $('.bk_ch_vs_header').first().text().trim(); // e.g. "John 3:16, NLT"
        if (!header) return res.status(404).json({ error: 'Reference not found' });
        const reference = header.replace(/,\s*NLT$/i, '');
        // Strip the header, verse-number markers, and footnotes before
        // extracting plain text (verse numbers would otherwise run into the
        // next verse's text with no space on multi-verse ranges).
        $('.bk_ch_vs_header, .tn, .a-tn, .vn').remove();
        const text = $('#bibletext').text().trim().replace(/\s+/g, ' ');
        if (!text) return res.status(404).json({ error: 'Reference not found' });
        res.json({ reference, text, translation: 'New Living Translation' });
      } catch (e) {
        res.status(502).json({ error: 'Could not parse NLT response' });
      }
    });
  }).on('error', (e) => res.status(502).json({ error: e.message }));
}

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
      { code: 'nlt', name: 'New Living Translation', available: true },
      { code: 'niv', name: 'New International Version', available: !!process.env.API_BIBLE_KEY, reason: 'Registered, but API_BIBLE_KEY not set on the server yet' },
      { code: 'amp', name: 'Amplified Bible', available: !!process.env.API_BIBLE_KEY, reason: 'Registered, but API_BIBLE_KEY not set on the server yet' },
      { code: 'msg', name: 'The Message', available: !!process.env.API_BIBLE_KEY, reason: 'Registered, but API_BIBLE_KEY not set on the server yet' },
      { code: 'nkjv', name: 'New King James Version', available: false, reason: 'Copyrighted — requires a paid API.Bible license' },
      { code: 'esv', name: 'English Standard Version', available: false, reason: 'Free for churches via api.esv.org, but needs your own registered API key (not configured yet)' },
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

// ---------------------------------------------------------------------------
// Media library API — images, videos (uploaded clip or pasted link), and
// PowerPoint decks (converted to a sequence of slide images on upload).
// ---------------------------------------------------------------------------
app.get('/api/media', async (req, res) => {
  try {
    res.json({ items: await listMediaLibrary() });
  } catch (e) {
    res.status(500).json({ error: 'Could not load media library: ' + e.message });
  }
});

app.get('/api/media/deck/:id', async (req, res) => {
  try {
    const slides = await getDeckSlides(req.params.id);
    if (slides.length === 0) return res.status(404).json({ error: 'Deck not found or empty' });
    res.json({ id: req.params.id, slides });
  } catch (e) {
    res.status(500).json({ error: 'Could not load deck: ' + e.message });
  }
});

app.get('/api/media/file/:id', async (req, res) => {
  try {
    const file = await getMediaFile(req.params.id);
    if (!file) return res.status(404).end();
    if (file.externalUrl) return res.redirect(file.externalUrl);
    res.set('Content-Type', file.mimetype || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(file.data);
  } catch (e) {
    res.status(500).end();
  }
});

app.post('/api/media/image', uploadMediaImage.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded (must be an image file, max 15MB)' });
  try {
    const title = (req.body.title || req.file.originalname || 'Image').trim();
    const id = await saveMediaRow({ kind: 'image', title, mimetype: req.file.mimetype, buffer: req.file.buffer });
    res.json({ id, kind: 'image', title, url: `/api/media/file/${id}` });
  } catch (e) {
    res.status(500).json({ error: 'Could not save image: ' + e.message });
  }
});

// Video: either an uploaded clip (field "file") or a pasted link (body.url —
// YouTube/Vimeo/direct .mp4 etc.), so a long clip doesn't have to be uploaded
// at all — just linked, EasyWorship-style "media from web" equivalent.
app.post('/api/media/video', uploadMediaVideo.single('file'), async (req, res) => {
  const title = (req.body.title || (req.file && req.file.originalname) || 'Video').trim();
  try {
    if (req.file) {
      const id = await saveMediaRow({ kind: 'video', title, mimetype: req.file.mimetype, buffer: req.file.buffer });
      res.json({ id, kind: 'video', title, url: `/api/media/file/${id}` });
    } else if (req.body.url && req.body.url.trim()) {
      const id = await saveMediaRow({ kind: 'video', title, externalUrl: req.body.url.trim() });
      res.json({ id, kind: 'video', title, url: req.body.url.trim(), external: true });
    } else {
      res.status(400).json({ error: 'Provide a video file (max 60MB) or a video link' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Could not save video: ' + e.message });
  }
});

// PowerPoint upload: converts every slide to a PNG (via LibreOffice + poppler)
// and stores them as a "deck" so the presenter can click through it exactly
// like a song's slides — no PowerPoint software needed on the display machine.
app.post('/api/media/pptx', uploadPptx.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PowerPoint file uploaded (.ppt/.pptx, max 50MB)' });
  try {
    const title = (req.body.title || req.file.originalname.replace(/\.(pptx|ppt)$/i, '')).trim();
    const ext = /\.ppt$/i.test(req.file.originalname) ? '.ppt' : '.pptx';
    const slideBuffers = await convertDeckToSlideImages(req.file.buffer, ext);
    const deckId = await saveMediaRow({ kind: 'deck', title, mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    const slides = [];
    for (let i = 0; i < slideBuffers.length; i++) {
      const slideId = await saveMediaRow({ kind: 'deck-slide', parentId: deckId, slideIndex: i, mimetype: 'image/png', buffer: slideBuffers[i] });
      slides.push({ id: slideId, url: `/api/media/file/${slideId}` });
    }
    res.json({ id: deckId, kind: 'deck', title, slideCount: slides.length, slides });
  } catch (e) {
    console.error('PPTX conversion error:', e.message);
    res.status(500).json({ error: e.message || 'Could not convert PowerPoint file' });
  }
});

app.delete('/api/media/:id', async (req, res) => {
  try {
    const deleted = await deleteMediaItem(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete: ' + e.message });
  }
});

// ---------------------------------------------------------------------------
// Schedule API — the service run-list. Persisted server-side (not just in
// the operator's browser localStorage) so it can be built ahead of time from
// any device and is ready the moment the control room is opened.
// ---------------------------------------------------------------------------
app.get('/api/schedule', async (req, res) => {
  try {
    res.json({ items: await loadScheduleList() });
  } catch (e) {
    res.status(500).json({ error: 'Could not load schedule: ' + e.message });
  }
});

app.post('/api/schedule', async (req, res) => {
  const { displayTitle, stateType } = req.body;
  if (!displayTitle || !stateType) return res.status(400).json({ error: 'displayTitle and stateType are required' });
  try {
    const item = await addScheduleRow(req.body);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: 'Could not add to schedule: ' + e.message });
  }
});

app.put('/api/schedule/reorder', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  try {
    await reorderScheduleRows(ids);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not reorder: ' + e.message });
  }
});

app.delete('/api/schedule/:id', async (req, res) => {
  try {
    const deleted = await removeScheduleRow(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not remove: ' + e.message });
  }
});

app.delete('/api/schedule', async (req, res) => {
  try {
    await clearScheduleRows();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not clear schedule: ' + e.message });
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
