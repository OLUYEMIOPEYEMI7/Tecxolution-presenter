const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const compression = require('compression');
const { Pool } = require('pg');
const cheerio = require('cheerio');
const sec = require('./lib/security');
const storage = require('./lib/storage');
const lyricsLib = require('./lib/lyrics');

const app = express();
app.set('trust proxy', 1); // Render terminates TLS in front of us — needed for real client IPs
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000, // notice a dead projector/control link within ~25s, not minutes
  pingTimeout: 15000,
  maxHttpBufferSize: 256 * 1024,
});

app.use(sec.securityHeaders);
app.use(compression());
app.use(express.json({ limit: '512kb' }));
app.use(sec.sameOriginWrites);

// Mutable data (custom songs, schedule, media metadata, saved state) lives in
// DATA_DIR when the database is unavailable; read-only datasets (hymnals) stay
// in ./data. Keeping them apart lets tests and local runs avoid touching the repo.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJsonFile(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic — a crash mid-write can't corrupt the file
}

// ---------------------------------------------------------------------------
// Persistent storage: if DATABASE_URL is set (Supabase Postgres), custom songs /
// announcements / uploaded media / the service schedule AND the live screen
// state survive redeploys and free-tier sleep. Without it, falls back to local
// JSON files + disk (fine for local dev, wiped on every Render redeploy).
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      // Supabase requires TLS; a local development database does not offer it.
      ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 6,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
      keepAlive: true,
    })
  : null;
// An idle pooled connection being dropped by Supabase must NEVER crash the
// process (an unhandled 'error' event on the pool does exactly that).
if (pool) pool.on('error', (e) => console.error('Postgres pool error (ignored, will reconnect):', e.message));

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
    CREATE TABLE IF NOT EXISTS wp_free_texts (
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
    ALTER TABLE wp_media ADD COLUMN IF NOT EXISTS storage_path TEXT;
    CREATE TABLE IF NOT EXISTS wp_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS wp_media_parent_idx ON wp_media (parent_id, slide_index);
    CREATE INDEX IF NOT EXISTS wp_media_kind_created_idx ON wp_media (kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS wp_schedule_idx_idx ON wp_schedule (idx);
    -- These tables are only ever touched by this server (direct Postgres
    -- connection). RLS with no policies keeps them closed to the public
    -- Supabase REST API / anon key.
    ALTER TABLE wp_custom_songs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wp_announcements ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wp_free_texts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wp_theme_images ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wp_media ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wp_schedule ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wp_state ENABLE ROW LEVEL SECURITY;
  `);
  console.log('Connected to persistent Postgres storage.');
}

// Uploads are checked by their actual bytes — the browser-supplied mimetype is
// trivially spoofed (an .html named .png would otherwise be served back).
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const looksLikeImage = (buf) => !!sniffImageMime(buf);
function sniffVideoMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (buf.slice(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return null;
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
  limits: { fileSize: 40 * 1024 * 1024 }, // 40MB — for longer clips, paste a link instead (keeps the 512MB free instance from running out of memory)
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
const mediaJsonPath = path.join(DATA_DIR, 'media.json');

function loadMediaJson() { return readJsonFile(mediaJsonPath, { items: [] }); }
function saveMediaJson(data) { writeJsonFile(mediaJsonPath, data); }

function newMediaId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Saves one media item (image/video/deck/deck-slide). `buffer` is optional
// (decks themselves hold no bytes, only their deck-slide children do).
async function saveMediaRow({ kind, parentId, slideIndex, title, mimetype, buffer, externalUrl }) {
  const id = newMediaId(kind);
  if (pool) {
    // Prefer Supabase Storage for the bytes (public CDN, doesn't bloat Postgres
    // or Render's memory). If Storage is down, fall back to keeping the bytes in
    // the database so uploads never fail because of it.
    let storagePath = null;
    let dbBuffer = buffer || null;
    if (buffer && storage.enabled && storage.supportedMime(mimetype)) {
      try {
        storagePath = storage.objectPath(id, mimetype);
        await storage.upload([{ path: storagePath, buffer, mimetype }]);
        dbBuffer = null;
      } catch (e) {
        console.error('Storage upload failed, keeping file in the database instead:', e.message);
        storagePath = null;
      }
    }
    try {
      await pool.query(
        `INSERT INTO wp_media (id, kind, parent_id, slide_index, title, mimetype, data, external_url, storage_path)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, kind, parentId || null, slideIndex ?? null, title || null, mimetype || null, dbBuffer, externalUrl || null, storagePath]
      );
    } catch (e) {
      if (storagePath) await storage.removePaths([storagePath]).catch(() => {});
      throw e;
    }
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
      SELECT m.id, m.kind, m.title, m.mimetype, m.external_url, m.storage_path,
        (SELECT count(*) FROM wp_media s WHERE s.parent_id = m.id) AS slide_count
      FROM wp_media m
      WHERE m.kind IN ('image','video','deck')
      ORDER BY m.created_at DESC
      LIMIT 100
    `);
    return rows.map((r) => ({
      id: r.id, kind: r.kind, title: r.title, mimetype: r.mimetype,
      url: r.storage_path ? storage.publicUrl(r.storage_path) : (r.kind === 'video' && r.external_url ? r.external_url : `/api/media/file/${r.id}`),
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
    const { rows } = await pool.query('SELECT mimetype, data, external_url, storage_path FROM wp_media WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    if (rows[0].storage_path) return { externalUrl: storage.publicUrl(rows[0].storage_path) }; // old links keep working
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
      'SELECT id, slide_index, storage_path FROM wp_media WHERE parent_id = $1 AND kind = $2 ORDER BY slide_index',
      [deckId, 'deck-slide']
    );
    return rows.map((r) => ({ id: r.id, url: r.storage_path ? storage.publicUrl(r.storage_path) : `/api/media/file/${r.id}` }));
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
    const { rows: stored } = await pool.query('SELECT storage_path FROM wp_media WHERE (id = $1 OR parent_id = $1) AND storage_path IS NOT NULL', [id]);
    if (rows[0].kind === 'deck') await pool.query('DELETE FROM wp_media WHERE parent_id = $1', [id]);
    const { rowCount } = await pool.query('DELETE FROM wp_media WHERE id = $1', [id]);
    if (stored.length) storage.removePaths(stored.map((r) => r.storage_path)).catch((e) => console.error('Storage cleanup failed:', e.message));
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
const schedulePath = path.join(DATA_DIR, 'schedule.json');
function loadScheduleJson() { return readJsonFile(schedulePath, { items: [] }); }
function saveScheduleJson(data) { writeJsonFile(schedulePath, data); }

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

const songsPath = path.join(DATA_DIR, 'songs.json');
const hymnsPath = path.join(__dirname, 'data', 'hymns.json');
const announcementsPath = path.join(DATA_DIR, 'announcements.json');
const freeTextsPath = path.join(DATA_DIR, 'free-texts.json');
const statePath = path.join(DATA_DIR, 'state.json');
const rccgHymnalPath = path.join(__dirname, 'data', 'rccg-hymnal.json');

// The two bundled hymnals never change at runtime — parse each once, not on
// every cache rebuild (the RCCG file alone is several MB of JSON).
let hymnsMemo = null;
let rccgMemo = null;
function loadHymns() { return hymnsMemo || (hymnsMemo = JSON.parse(fs.readFileSync(hymnsPath, 'utf8'))); }
function loadRccgHymnal() { return rccgMemo || (rccgMemo = JSON.parse(fs.readFileSync(rccgHymnalPath, 'utf8'))); }

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
  return readJsonFile(songsPath, { songs: [] }).songs;
}

async function addCustomSong(song) {
  if (pool) {
    await pool.query('INSERT INTO wp_custom_songs (id, title, artist, sections) VALUES ($1, $2, $3, $4)', [
      song.id, song.title, song.artist, JSON.stringify(song.sections),
    ]);
    return;
  }
  const data = readJsonFile(songsPath, { songs: [] });
  data.songs.push(song);
  writeJsonFile(songsPath, data);
}

async function deleteCustomSong(id) {
  if (pool) {
    const { rowCount } = await pool.query('DELETE FROM wp_custom_songs WHERE id = $1', [id]);
    return rowCount > 0;
  }
  const data = readJsonFile(songsPath, { songs: [] });
  const before = data.songs.length;
  data.songs = data.songs.filter((s) => s.id !== id);
  writeJsonFile(songsPath, data);
  return data.songs.length < before;
}

async function updateCustomSong(id, { title, artist, sections }) {
  if (pool) {
    const { rowCount } = await pool.query(
      'UPDATE wp_custom_songs SET title = $2, artist = $3, sections = $4 WHERE id = $1',
      [id, title, artist, JSON.stringify(sections)],
    );
    return rowCount > 0;
  }
  const data = readJsonFile(songsPath, { songs: [] });
  const song = data.songs.find((s) => s.id === id);
  if (!song) return false;
  song.title = title;
  song.artist = artist;
  song.sections = sections;
  writeJsonFile(songsPath, data);
  return true;
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
  return readJsonFile(announcementsPath, { announcements: [] }).announcements;
}

async function addAnnouncementItem(text) {
  const newItem = { id: 'ann-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text };
  if (pool) {
    await pool.query('INSERT INTO wp_announcements (id, text) VALUES ($1, $2)', [newItem.id, newItem.text]);
    return newItem;
  }
  const data = readJsonFile(announcementsPath, { announcements: [] });
  data.announcements.push(newItem);
  writeJsonFile(announcementsPath, data);
  return newItem;
}

async function deleteAnnouncementItem(id) {
  if (pool) {
    const { rowCount } = await pool.query('DELETE FROM wp_announcements WHERE id = $1', [id]);
    return rowCount > 0;
  }
  const data = readJsonFile(announcementsPath, { announcements: [] });
  const before = data.announcements.length;
  data.announcements = data.announcements.filter((a) => a.id !== id);
  writeJsonFile(announcementsPath, data);
  return data.announcements.length < before;
}

// ---- Free Text (persistent: reusable typed slides — a one-step alternative
// to building a whole "presentation" just to show a quick line of text) ----
async function loadFreeTextsList() {
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT id, text FROM wp_free_texts ORDER BY created_at');
      return rows;
    } catch (e) {
      console.error('DB read failed for free texts, falling back to local file:', e.message);
    }
  }
  return readJsonFile(freeTextsPath, { items: [] }).items;
}

async function addFreeTextItem(text) {
  const newItem = { id: 'ftx-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text };
  if (pool) {
    await pool.query('INSERT INTO wp_free_texts (id, text) VALUES ($1, $2)', [newItem.id, newItem.text]);
    return newItem;
  }
  const data = readJsonFile(freeTextsPath, { items: [] });
  data.items.push(newItem);
  writeJsonFile(freeTextsPath, data);
  return newItem;
}

async function deleteFreeTextItem(id) {
  if (pool) {
    const { rowCount } = await pool.query('DELETE FROM wp_free_texts WHERE id = $1', [id]);
    return rowCount > 0;
  }
  const data = readJsonFile(freeTextsPath, { items: [] });
  const before = data.items.length;
  data.items = data.items.filter((a) => a.id !== id);
  writeJsonFile(freeTextsPath, data);
  return data.items.length < before;
}

// ---- Theme images (persistent: stored as bytes in Postgres; falls back to disk) ----
async function saveThemeImage(buffer, mimetype, originalname) {
  const ext = (path.extname(originalname).toLowerCase().match(/^\.(jpe?g|png|gif|webp)$/) || ['.jpg'])[0];
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
  const custom = customRows.map((x) => ({ ...x, source: 'custom' }));
  const hymns = loadHymns().hymns.map((h) => ({ ...h, source: 'hymn' }));
  const rccg = loadRccgHymnal().hymns.map((h) => ({ ...h, source: 'rccg' }));
  // Index once per rebuild (not per keystroke): normalised title/artist/lyrics,
  // lyric lines for snippets, and whether the song really has lyrics.
  songCache = [...custom, ...hymns, ...rccg].map((x) => ({ ...x, ...lyricsLib.indexSong(x) }));
  return songCache;
}

async function getAllSongsFull() {
  return songCache || (await buildSongCache());
}

// ---------------------------------------------------------------------------
// Live output state. Preview and Live are two independent states broadcast on
// separate socket events so the Preview and Live iframes (both /display, same
// rendering code) stay perfectly proportional — Preview is a true miniature.
// Everything here is persisted (debounced) so a Render restart / free-tier
// sleep / redeploy comes back showing exactly what was on screen.
// ---------------------------------------------------------------------------
let liveState = { type: 'blank' };
let previewState = { type: 'blank' };
let tickerState = { active: false, text: '' };
let overlayMode = 'none'; // none | black | logo | clear  (hides output without losing the live slide)
let timerState = { active: false, mode: 'down', target: 0, label: '', onDisplay: false };
let settingsState = sec.cleanSettings({});
let alertState = { text: '', until: 0 };
let history = []; // recently shown items, newest first
let alertTimer = null;

function titleOf(st) {
  if (!st) return '';
  if (st._displayTitle) return st._displayTitle;
  if (st.type === 'scripture') return st.reference + (st.translation ? ' (' + st.translation + ')' : '');
  if (st.type === 'free-text') return (st.text || '').slice(0, 40);
  if (st.type === 'image') return 'Image';
  if (st.type === 'video') return 'Video';
  return st.type;
}
function pushHistory(st) {
  if (!st || st.type === 'blank') return;
  const key = JSON.stringify([st.type, st._displayTitle, st.reference, st.text, st.url, st.pairs]);
  history = history.filter((h) => h.key !== key);
  history.unshift({ key, title: titleOf(st), at: Date.now(), state: st });
  history = history.slice(0, 15);
}

let persistTimer = null;
function persistState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(flushState, 400);
}
async function flushState() {
  clearTimeout(persistTimer);
  const snapshot = { liveState, previewState, tickerState, overlayMode, timerState, settingsState, history };
  try {
    if (pool) {
      await pool.query(
        `INSERT INTO wp_state (key, value, updated_at) VALUES ('main', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(snapshot)]
      );
    } else {
      writeJsonFile(statePath, snapshot);
    }
  } catch (e) {
    console.error('Could not persist live state:', e.message);
  }
}
async function restoreState() {
  try {
    let snap = null;
    if (pool) {
      const { rows } = await pool.query("SELECT value FROM wp_state WHERE key = 'main'");
      snap = rows[0] && rows[0].value;
    } else {
      snap = readJsonFile(statePath, null);
    }
    if (!snap) return;
    liveState = sec.sanitizeState(snap.liveState) || liveState;
    previewState = sec.sanitizeState(snap.previewState) || previewState;
    if (snap.tickerState) tickerState = { active: !!snap.tickerState.active, text: sec.str(snap.tickerState.text, 600) };
    if (['none', 'black', 'logo', 'clear'].includes(snap.overlayMode)) overlayMode = snap.overlayMode;
    if (snap.timerState) timerState = cleanTimer(snap.timerState);
    if (snap.settingsState) settingsState = cleanSettings(snap.settingsState);
    if (Array.isArray(snap.history)) history = snap.history.filter((h) => h && h.state && sec.sanitizeState(h.state)).slice(0, 15);
    console.log('Restored last live screen state.');
  } catch (e) {
    console.error('Could not restore live state:', e.message);
  }
}

function cleanTimer(t) {
  const target = Number(t && t.target);
  return {
    active: !!(t && t.active) && Number.isFinite(target) && target > 0,
    mode: t && t.mode === 'up' ? 'up' : 'down',
    target: Number.isFinite(target) ? target : 0,
    label: sec.str(t && t.label, 80),
    onDisplay: !!(t && t.onDisplay),
  };
}
const cleanSettings = sec.cleanSettings;

// ---------------------------------------------------------------------------
// Public pages & auth
// ---------------------------------------------------------------------------
app.get('/healthz', async (req, res) => {
  let db = 'none';
  if (pool) {
    try {
      await Promise.race([pool.query('SELECT 1'), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2500))]);
      db = 'up';
    } catch (e) { db = 'down'; }
  }
  res.set('Cache-Control', 'no-store');
  res.status(db === 'down' ? 503 : 200).json({ ok: db !== 'down', db, storage: storage.enabled ? 'supabase' : 'database', uptime: Math.round(process.uptime()), auth: sec.AUTH_ENABLED && sec.AUTH_CONFIGURED });
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));

app.post('/api/login', (req, res) => {
  const wait = sec.loginBlocked(req.ip);
  if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
  if (!sec.AUTH_CONFIGURED) {
    return res.status(sec.AUTH_ENABLED ? 503 : 200).json(
      sec.AUTH_ENABLED ? { error: 'OPERATOR_PASSWORD is not set on the server.' } : { ok: true }
    );
  }
  const role = sec.checkPassword(req.body && req.body.password);
  if (!role) {
    sec.recordLoginFailure(req.ip);
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  sec.clearLoginFailures(req.ip);
  sec.setSessionCookie(res, role);
  res.json({ ok: true, role });
});

app.post('/api/logout', (req, res) => {
  sec.clearSessionCookie(res);
  res.json({ ok: true });
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '1h',
    etag: true,
    setHeaders: (res, file) => {
      if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
      if (/\/images\/\d\d_|\/images\/brand\//.test(file)) res.setHeader('Cache-Control', 'public, max-age=604800');
    },
  })
);

// The projector (/display) and the confidence monitor (/stage) are view-only
// and need no sign-in. Everything that can CHANGE the screen requires the
// operator session: /control, /remote, every write API and every write socket event.
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'views', 'display.html')));
app.get('/stage', (req, res) => res.sendFile(path.join(__dirname, 'views', 'stage.html')));
app.get('/control', sec.requireOperator, (req, res) => res.sendFile(path.join(__dirname, 'views', 'control.html')));
app.get('/remote', sec.requireAnyRole, (req, res) => res.sendFile(path.join(__dirname, 'views', 'remote.html')));
app.get('/', (req, res) => res.redirect('/control'));

// Only the assets the projector itself must fetch stay public.
const PUBLIC_API = [/^\/api\/login$/, /^\/api\/media\/file\/[A-Za-z0-9_-]+$/, /^\/api\/theme-image\/[A-Za-z0-9_-]+$/];
app.use('/api', (req, res, next) => {
  const p = req.originalUrl.split('?')[0];
  if (PUBLIC_API.some((r) => r.test(p))) return next();
  // Remote (volunteer) sign-ins may only READ the schedule, for the phone remote.
  if (req.method === 'GET' && p === '/api/schedule') return sec.requireAnyRole(req, res, next);
  return sec.requireOperator(req, res, next);
});

app.get('/api/songs', async (req, res) => {
  try {
    // Lightweight metadata only — full lyrics are fetched on demand via /api/songs/:id.
    // ?q= searches title, artist, hymn number AND lyric text, best matches first,
    // each with the lyric line that matched.  ?source= custom|hymn|rccg|nolyrics.
    let all = await getAllSongsFull();
    const q = String(req.query.q || '').trim().slice(0, 200);
    const source = String(req.query.source || 'all');
    if (source === 'nolyrics') all = all.filter((x) => !x.hasLyrics);
    else if (source !== 'all') all = all.filter((x) => x.source === source);

    const results = lyricsLib.searchSongs(all, q);
    const needsLyrics = (await getAllSongsFull()).filter((x) => !x.hasLyrics).length;
    res.json({
      needsLyrics,
      songs: results.map(({ song: x, matchedIn, snippet }) => ({
        id: x.id,
        title: x.title,
        artist: x.artist || '',
        source: x.source,
        hymnNumber: x.hymnNumber || null,
        sectionCount: x.realSectionCount,
        hasLyrics: x.hasLyrics,
        matchedIn: q ? matchedIn : undefined,
        snippet: q && snippet ? snippet : undefined,
      })),
    });
  } catch (e) {
    console.error('Error in /api/songs:', e.message);
    res.status(500).json({ error: 'Could not load songs', songs: [] });
  }
});

app.get('/api/songs/:id', async (req, res) => {
  try {
    const all = await getAllSongsFull();
    const song = all.find((x) => x.id === req.params.id);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    // Strip search-index fields; a title-only stub returns NO sections so the
    // editor starts blank (instead of loading the placeholder note as lyrics).
    const { _t, _a, _l, _lines, _all, realSectionCount, ...clean } = song;
    if (!song.hasLyrics) clean.sections = [];
    res.json(clean);
  } catch (e) {
    console.error('Error in /api/songs/:id:', e.message);
    res.status(500).json({ error: 'Could not load song' });
  }
});

// Add a new custom song
app.post('/api/songs', async (req, res) => {
  const title = sec.str(req.body.title, 200).trim();
  const clean = sec.sanitizeSections(req.body.sections);
  if (!title || !clean) {
    return res.status(400).json({ error: 'title and at least one section are required' });
  }
  const newSong = {
    id: slugify(title),
    title,
    artist: sec.str(req.body.artist, 200),
    sections: clean,
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

// Edit a custom song in place (title, artist, and/or lyrics) — e.g. filling
// in real lyrics later for a song that was added as a title-only stub.
app.put('/api/songs/:id', async (req, res) => {
  const title = sec.str(req.body.title, 200).trim();
  const sections = sec.sanitizeSections(req.body.sections);
  if (!title || !sections) {
    return res.status(400).json({ error: 'title and at least one section are required' });
  }
  try {
    const updated = await updateCustomSong(req.params.id, { title, artist: sec.str(req.body.artist, 200), sections });
    if (!updated) return res.status(404).json({ error: 'Song not found (hymns cannot be edited this way)' });
    songCache = null; // invalidate
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not update song: ' + e.message });
  }
});

// Bulk lyric import: paste or upload lyrics from a source the church is
// licensed to use (CCLI SongSelect, a hymnal, sheet music). Lyrics for an
// existing title-only song fill that song in; new titles are created; songs that
// already have lyrics are never overwritten.
app.post('/api/songs/import', async (req, res) => {
  const items = Array.isArray(req.body && req.body.songs) ? req.body.songs.slice(0, 300) : [];
  if (!items.length) return res.status(400).json({ error: 'No songs to import' });
  const results = [];
  try {
    const existing = (await loadCustomSongs()).map((x) => ({ ...x, ...lyricsLib.indexSong(x) }));
    for (const it of items) {
      const title = sec.str(it && it.title, 200).trim();
      const artist = sec.str(it && it.artist, 200).trim();
      const sections = sec.sanitizeSections(lyricsLib.parseLyrics(sec.str(it && it.lyrics, 30000)));
      if (!title) { results.push({ title: '(untitled)', result: 'skipped', reason: 'no title' }); continue; }
      if (!sections) { results.push({ title, result: 'skipped', reason: 'no lyrics found' }); continue; }
      const key = lyricsLib.normalizeTitle(title);
      const match = existing.find((x) => lyricsLib.normalizeTitle(x.title) === key);
      if (match && match.hasLyrics) { results.push({ title, result: 'skipped', reason: 'already has lyrics' }); continue; }
      if (match) {
        await updateCustomSong(match.id, { title: match.title, artist: artist || match.artist || '', sections });
        match.hasLyrics = true;
        results.push({ title: match.title, result: 'updated' });
      } else {
        const song = { id: slugify(title), title, artist, sections };
        await addCustomSong(song);
        existing.push({ ...song, ...lyricsLib.indexSong(song) });
        results.push({ title, result: 'created' });
      }
    }
    songCache = null;
    const count = (r) => results.filter((x) => x.result === r).length;
    res.json({ created: count('created'), updated: count('updated'), skipped: count('skipped'), results });
  } catch (e) {
    songCache = null;
    res.status(500).json({ error: 'Import failed: ' + e.message, results });
  }
});

// Scripture lookup. Three sources:
//  - bible.helloao.org for free public-domain translations (kjv, web, asv,
//    etc.) — a CDN-backed static-JSON API, no key, no rate limit. (Switched
//    from bible-api.com after it started returning 403 Forbidden to Render's
//    cloud IP range — worked fine from a residential/dev IP, blocked in
//    production; this one is confirmed to work from Render's Docker env.)
//  - api.nlt.to for NLT — Tyndale's own API, explicitly free for non-commercial
//    / ministry use (works anonymously, no key required, within fair limits).
//  - api.scripture.api.bible for NIV / AMP / MSG — needs a registered API key
//    (API_BIBLE_KEY env var) that the user obtains themselves.
//
// PERFORMANCE: this used to hit the external API fresh on EVERY single
// lookup — typed, voice-detected, or re-displaying the same verse twice in
// a service — which is why scripture (and Voice Detect, which calls this
// same endpoint) could feel slow to appear. Bible text for a given
// reference+version never changes, so results are cached in memory for the
// life of the server: the first lookup of a verse pays the network cost,
// every repeat of it (extremely common — a preacher re-quoting a verse, or
// multiple slides from the same passage) is instant. A shared keep-alive
// HTTPS agent also avoids a fresh TCP+TLS handshake on every still-uncached
// lookup, and a hard 6s timeout means a slow/unreachable upstream API fails
// fast with a clear error instead of leaving the operator staring at
// "Looking up…" with no feedback.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const SCRIPTURE_REQUEST_TIMEOUT_MS = 6000;
const scriptureCache = new Map(); // key: `${version}|${ref.toLowerCase()}` -> response JSON
const SCRIPTURE_CACHE_MAX = 1000;

function cachedScriptureGet(url, headers, cacheKey, res, parseBody) {
  const req = https.get(url, { agent: keepAliveAgent, headers, timeout: SCRIPTURE_REQUEST_TIMEOUT_MS }, (apiRes) => {
    let body = '';
    apiRes.on('data', (chunk) => (body += chunk));
    apiRes.on('end', () => {
      let data;
      try {
        data = parseBody(body, apiRes);
      } catch (e) {
        return res.status(502).json({ error: 'Could not parse scripture response: ' + e.message });
      }
      if (data && !data.error) {
        if (scriptureCache.size >= SCRIPTURE_CACHE_MAX) {
          scriptureCache.delete(scriptureCache.keys().next().value); // drop oldest
        }
        scriptureCache.set(cacheKey, data);
      }
      const httpStatus = data && data.error ? (data.status || 404) : 200;
      if (data && data.status) delete data.status; // internal-only, not part of the API contract
      res.status(httpStatus).json(data);
    });
  });
  req.on('timeout', () => {
    req.destroy();
    res.status(504).json({ error: 'Bible lookup timed out — the upstream service may be slow or your internet connection unstable. Try again.' });
  });
  req.on('error', (e) => res.status(502).json({ error: e.message }));
}
const API_BIBLE_IDS = {
  niv: '78a9f6124f344018-01',
  amp: 'a81b73293d3080c9-01',
  msg: '6f11a7de016f942e-01',
};

// bible.helloao.org translation IDs for each free public-domain version code.
const HELLOAO_TRANSLATIONS = {
  kjv: { id: 'eng_kjv', name: 'King James Version' },
  web: { id: 'eng_web', name: 'World English Bible' },
  webbe: { id: 'eng_webpb', name: 'World English Bible (British)' },
  asv: { id: 'eng_asv', name: 'American Standard Version' },
  bbe: { id: 'eng_bbe', name: 'Bible in Basic English' },
  darby: { id: 'eng_dby', name: 'Darby Bible' },
  ylt: { id: 'eng_ylt', name: "Young's Literal Translation" },
};

const { BIBLE_BOOK_CODES, BIBLE_BOOK_ALIASES, parseBibleReference, scriptureMeta, canonicalReference } = require('./lib/bible');

function fetchHelloAoScripture(ref, version, cacheKey, res) {
  const t = HELLOAO_TRANSLATIONS[version];
  const parsed = parseBibleReference(ref);
  if (!parsed) return res.status(400).json({ error: 'Could not understand reference "' + ref + '" — try a format like "John 3:16" or "John 3:16-18"' });
  const url = `https://bible.helloao.org/api/${t.id}/${parsed.bookCode}/${parsed.chapter}.json`;
  cachedScriptureGet(url, {}, cacheKey, res, (body) => {
    const data = JSON.parse(body);
    const content = (data.chapter && data.chapter.content) || [];
    const verses = content.filter((item) => item.type === 'verse' && item.number >= parsed.verseStart && item.number <= parsed.verseEnd);
    if (verses.length === 0) return { error: 'Reference not found: ' + ref, status: 404 };
    const clean = (v) => v.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join(' ')
      .replace(/¶\s*/g, '') // KJV paragraph markers — not part of the verse text
      .replace(/\s+/g, ' ')
      .trim();
    // Per-verse array lets the control room split long passages across several
    // slides instead of shrinking a whole chapter into unreadable text.
    const versesOut = verses.map((v) => ({ n: v.number, text: clean(v) }));
    return { reference: ref, text: versesOut.map((v) => v.text).join(' '), translation: t.name, verses: versesOut };
  });
}

app.get('/api/scripture', async (req, res) => {
  const ref = (req.query.ref || '').trim();
  const version = (req.query.version || 'kjv').trim().toLowerCase();
  if (!ref || ref.length > 80) return res.status(400).json({ error: 'Missing or invalid ref' });

  // Every successful response also carries canonical book/chapter/verse info so
  // the control room can offer next/previous verse and chapter navigation.
  const meta = scriptureMeta(ref);
  if (meta) {
    const send = res.json.bind(res);
    // Always show the proper book name on screen ("jn 3:16" -> "John 3:16").
    res.json = (data) => send(data && !data.error ? { ...data, ...meta, reference: canonicalReference(meta) } : data);
  }

  const cacheKey = version + '|' + ref.toLowerCase();
  const cached = scriptureCache.get(cacheKey);
  if (cached) return res.json(cached); // instant — no network round trip

  if (version === 'nlt') {
    return fetchNltScripture(ref, cacheKey, res);
  }
  if (API_BIBLE_IDS[version]) {
    return fetchApiBibleScripture(ref, version, cacheKey, res);
  }
  if (HELLOAO_TRANSLATIONS[version]) {
    return fetchHelloAoScripture(ref, version, cacheKey, res);
  }
  return res.status(400).json({ error: 'Unknown Bible version: ' + version });
});

// API.Bible — used for NIV, AMP, MSG under the user's own free, registered
// non-commercial/ministry API key.
const API_BIBLE_NAMES = { niv: 'New International Version', amp: 'Amplified Bible', msg: 'The Message' };
function fetchApiBibleScripture(ref, version, cacheKey, res) {
  const key = process.env.API_BIBLE_KEY;
  if (!key) return res.status(400).json({ error: 'API_BIBLE_KEY not configured on the server' });
  const bibleId = API_BIBLE_IDS[version];
  const url = `https://api.scripture.api.bible/v1/bibles/${bibleId}/search?query=${encodeURIComponent(ref)}`;
  cachedScriptureGet(url, { 'api-key': key }, cacheKey, res, (body) => {
    const data = JSON.parse(body);
    const passage = data.data && data.data.passages && data.data.passages[0];
    if (!passage) return { error: 'Reference not found', status: 404 };
    const text = passage.content
      .replace(/<span[^>]*class="v"[^>]*>[\d-]+<\/span>/g, '') // strip inline verse-number markers (incl. ranges like "1-3")
      .replace(/<[^>]+>/g, ' ') // strip remaining HTML tags
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1') // tidy stray space before punctuation left by stripped tags
      .trim();
    return { reference: passage.reference, text, translation: API_BIBLE_NAMES[version] || version.toUpperCase() };
  });
}

// NLT.TO API — HTML response, parsed with cheerio. Free anonymous key "TEST"
// works for light/sporadic lookups (50 verses/request, 500/day); set
// NLT_API_KEY env var with your own free-registered key for higher limits.
function fetchNltScripture(ref, cacheKey, res) {
  const key = process.env.NLT_API_KEY || 'TEST';
  const url = `https://api.nlt.to/api/passages?ref=${encodeURIComponent(ref)}&version=NLT&key=${encodeURIComponent(key)}`;
  cachedScriptureGet(url, {}, cacheKey, res, (body) => {
    const $ = cheerio.load(body);
    const header = $('.bk_ch_vs_header').first().text().trim(); // e.g. "John 3:16, NLT"
    if (!header) return { error: 'Reference not found', status: 404 };
    const reference = header.replace(/,\s*NLT$/i, '');
    // Strip the header, verse-number markers, and footnotes before
    // extracting plain text (verse numbers would otherwise run into the
    // next verse's text with no space on multi-verse ranges).
    $('.bk_ch_vs_header, .tn, .a-tn, .vn').remove();
    const text = $('#bibletext').text().trim().replace(/\s+/g, ' ');
    if (!text) return { error: 'Reference not found', status: 404 };
    return { reference, text, translation: 'New Living Translation' };
  });
}

// List of Bible versions the app can look up. Free/public-domain ones work
// immediately via bible.helloao.org. Copyrighted ones (NIV/NLT/ESV/MSG/NKJV/AMP)
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
  if (!looksLikeImage(req.file.buffer)) return res.status(400).json({ error: 'That file is not a valid JPG/PNG/GIF/WebP image' });
  try {
    const url = await saveThemeImage(req.file.buffer, sniffImageMime(req.file.buffer), req.file.originalname);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: 'Could not save image: ' + e.message });
  }
});

// Serve a theme image stored in Postgres (disk-stored ones are served as
// static files from /images/custom-themes/ instead)
app.get('/api/theme-image/:id', async (req, res) => {
  if (!pool) return res.status(404).end();
  res.set('X-Content-Type-Options', 'nosniff');
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

// Saved free-text library (reusable typed slides — "Please silence your
// phones", "Welcome to Province 9", etc. — type once, reuse every service).
app.get('/api/free-texts', async (req, res) => {
  res.json({ items: await loadFreeTextsList() });
});

app.post('/api/free-texts', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const newItem = await addFreeTextItem(text.trim());
    res.json(newItem);
  } catch (e) {
    res.status(500).json({ error: 'Could not save: ' + e.message });
  }
});

app.delete('/api/free-texts/:id', async (req, res) => {
  try {
    const deleted = await deleteFreeTextItem(req.params.id);
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
    const data = file.data;
    res.set('Content-Type', file.mimetype || 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Accept-Ranges', 'bytes');
    // HTTP Range support: required for video seeking and for Safari/iOS to
    // play uploaded video at all.
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && data.length) {
      let start = range[1] ? parseInt(range[1], 10) : data.length - parseInt(range[2] || '0', 10);
      let end = range[1] && range[2] ? parseInt(range[2], 10) : data.length - 1;
      end = Math.min(end, data.length - 1);
      if (!(start >= 0) || start > end) {
        res.set('Content-Range', `bytes */${data.length}`);
        return res.status(416).end();
      }
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${data.length}`);
      res.set('Content-Length', String(end - start + 1));
      return res.end(data.subarray(start, end + 1));
    }
    res.send(data);
  } catch (e) {
    res.status(500).end();
  }
});

app.post('/api/media/image', uploadMediaImage.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded (must be an image file, max 15MB)' });
  const imgMime = sniffImageMime(req.file.buffer);
  if (!imgMime) return res.status(400).json({ error: 'That file is not a valid JPG/PNG/GIF/WebP image' });
  try {
    const title = sec.str((req.body.title || req.file.originalname || 'Image').trim(), 200);
    const id = await saveMediaRow({ kind: 'image', title, mimetype: imgMime, buffer: req.file.buffer });
    res.json({ id, kind: 'image', title, url: `/api/media/file/${id}` });
  } catch (e) {
    res.status(500).json({ error: 'Could not save image: ' + e.message });
  }
});

// Video: either an uploaded clip (field "file") or a pasted link (body.url —
// YouTube/Vimeo/direct .mp4 etc.), so a long clip doesn't have to be uploaded
// at all — just linked, EasyWorship-style "media from web" equivalent.
app.post('/api/media/video', uploadMediaVideo.single('file'), async (req, res) => {
  const title = sec.str((req.body.title || (req.file && req.file.originalname) || 'Video').trim(), 200);
  try {
    if (req.file) {
      const vidMime = sniffVideoMime(req.file.buffer);
      if (!vidMime) return res.status(400).json({ error: 'Unsupported video — please use an MP4 or WebM file (or paste a link)' });
      const id = await saveMediaRow({ kind: 'video', title, mimetype: vidMime, buffer: req.file.buffer });
      res.json({ id, kind: 'video', title, url: `/api/media/file/${id}` });
    } else if (req.body.url && req.body.url.trim()) {
      const link = req.body.url.trim();
      // Only real web links — never javascript:, data:, file: etc.
      if (!/^https?:\/\/[^\s"'<>\\]{4,1900}$/i.test(link)) return res.status(400).json({ error: 'That does not look like a valid http(s) video link' });
      const id = await saveMediaRow({ kind: 'video', title, externalUrl: link });
      res.json({ id, kind: 'video', title, url: link, external: true });
    } else {
      res.status(400).json({ error: 'Provide a video file (max 40MB) or a video link' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Could not save video: ' + e.message });
  }
});

// PowerPoint upload: converts every slide to a PNG (via LibreOffice + poppler)
// and stores them as a "deck" so the presenter can click through it exactly
// like a song's slides — no PowerPoint software needed on the display machine.
// LibreOffice is heavy (hundreds of MB of RAM). On the small Render instance two
// simultaneous conversions can get the whole presenter OOM-killed mid-service,
// so conversions run strictly one at a time; extra uploads wait their turn.
let pptxQueue = Promise.resolve();
function runExclusive(fn) {
  const run = pptxQueue.then(fn, fn);
  pptxQueue = run.catch(() => {});
  return run;
}
app.post('/api/media/pptx', uploadPptx.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PowerPoint file uploaded (.ppt/.pptx, max 50MB)' });
  // .pptx is a zip (PK..); legacy .ppt is an OLE2 container (D0 CF 11 E0)
  const head = req.file.buffer.subarray(0, 4);
  const okMagic = head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  if (!okMagic) return res.status(400).json({ error: 'That file is not a valid PowerPoint presentation' });
  let deckId = null;
  try {
    const title = sec.str((req.body.title || req.file.originalname.replace(/\.(pptx|ppt)$/i, '')).trim(), 200);
    const ext = /\.ppt$/i.test(req.file.originalname) ? '.ppt' : '.pptx';
    const slideBuffers = await runExclusive(() => convertDeckToSlideImages(req.file.buffer, ext));
    deckId = await saveMediaRow({ kind: 'deck', title, mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    const slideIds = new Array(slideBuffers.length);
    let nextSlide = 0;
    const saveWorker = async () => { // 4 at a time — each slide is a Storage upload
      while (nextSlide < slideBuffers.length) {
        const i = nextSlide++;
        slideIds[i] = await saveMediaRow({ kind: 'deck-slide', parentId: deckId, slideIndex: i, mimetype: 'image/png', buffer: slideBuffers[i] });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, slideBuffers.length) }, saveWorker));
    const slides = slideIds.map((slideId) => ({ id: slideId, url: `/api/media/file/${slideId}` }));
    res.json({ id: deckId, kind: 'deck', title, slideCount: slides.length, slides });
  } catch (e) {
    console.error('PPTX conversion error:', e.message);
    if (deckId) await deleteMediaItem(deckId).catch(() => {}); // never leave a half-saved deck behind
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
  const TYPES = ['song', 'whole-song', 'scripture-ref', 'media-image', 'media-video', 'media-deck', 'free-text'];
  if (!displayTitle || !TYPES.includes(stateType)) return res.status(400).json({ error: 'displayTitle and a valid stateType are required' });
  // Only whitelisted fields are stored — never an arbitrary client blob.
  const item_ = { displayTitle: sec.str(displayTitle, 200), stateType };
  if (stateType === 'song') {
    item_.state = sec.sanitizeState(req.body.state);
    if (!item_.state) return res.status(400).json({ error: 'invalid slide' });
  }
  if (stateType === 'whole-song') item_.songId = sec.str(req.body.songId, 200);
  if (stateType === 'scripture-ref') item_.ref = sec.str(req.body.ref, 80);
  if (stateType === 'media-image' || stateType === 'media-video') item_.url = sec.safeUrl(req.body.url);
  if (stateType === 'media-deck') item_.deckId = sec.str(req.body.deckId, 100);
  if (stateType === 'free-text') item_.text = sec.str(req.body.text, 6000);
  try {
    const item = await addScheduleRow(item_);
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

// ---------------------------------------------------------------------------
// Realtime. Anyone may WATCH (projector, confidence monitor). Only a signed-in
// operator socket may CHANGE anything — every write event is gated and its
// payload validated, so a stranger who finds the URL can't take over the screen.
// ---------------------------------------------------------------------------
io.use((socket, next) => {
  socket.data.role = sec.roleFromCookieHeader(socket.handshake.headers.cookie); // 'operator' | 'remote' | null
  socket.data.operator = socket.data.role === 'operator';
  next();
});

io.on('connection', (socket) => {
  // Catch up any newly-connected client on every channel (also what makes a
  // reconnect after a Wi-Fi blip or server restart instantly correct).
  socket.emit('server-time', Date.now());
  socket.emit('live-state', liveState);
  socket.emit('preview-state', previewState);
  socket.emit('ticker-state', tickerState);
  socket.emit('overlay-state', overlayMode);
  socket.emit('timer-state', timerState);
  socket.emit('settings-state', settingsState);
  socket.emit('alert-state', alertState.until > Date.now() ? alertState : { text: '', until: 0 });
  socket.emit('whoami', { operator: socket.data.operator, role: socket.data.role });
  if (socket.data.role) socket.emit('history', history.map(({ title, at, state }) => ({ title, at, state })));

  socket.on('hello', (role) => {
    if (socket.data.operator && role === 'control') socket.join('controllers');
    if (socket.data.role && role === 'remote') socket.join('remotes');
  });
  socket.on('time-sync', (ack) => { if (typeof ack === 'function') ack(Date.now()); });

  // Wrap every write handler: operator-only, and never let a bad payload throw.
  // Volunteers (role "remote") get only the live-show verbs, never editing.
  const REMOTE_OK = new Set(['stage', 'golive', 'clear', 'overlay', 'alert-show', 'remote-cmd']);
  const guard = (fn, name) => (...args) => {
    const allowed = socket.data.operator || (socket.data.role === 'remote' && REMOTE_OK.has(name));
    if (!allowed) return socket.emit('auth-error', socket.data.role ? 'Not permitted for a remote sign-in' : 'Sign in required');
    try { fn(...args); } catch (e) { console.error('socket handler error:', e.message); }
  };

  // Stage content into Preview only — does not touch what the audience sees
  socket.on('stage', guard((payload) => {
    const st = sec.sanitizeState(payload);
    if (!st) return;
    previewState = st;
    io.emit('preview-state', previewState);
    persistState();
  }, 'stage'));

  // Promote whatever is currently staged in Preview to Live
  socket.on('golive', guard(() => {
    liveState = previewState;
    pushHistory(liveState);
    io.emit('live-state', liveState);
    io.to('controllers').to('remotes').emit('history', history.map(({ title, at, state }) => ({ title, at, state })));
    persistState();
  }, 'golive'));

  // Direct-to-live, bypassing Preview entirely (used by Voice Detect auto-project)
  socket.on('project', guard((payload) => {
    const st = sec.sanitizeState(payload);
    if (!st) return;
    liveState = st;
    pushHistory(liveState);
    io.emit('live-state', liveState);
    io.to('controllers').to('remotes').emit('history', history.map(({ title, at, state }) => ({ title, at, state })));
    persistState();
  }, 'project'));

  socket.on('clear', guard(() => {
    liveState = { type: 'blank' };
    overlayMode = 'none';
    io.emit('live-state', liveState);
    io.emit('overlay-state', overlayMode);
    persistState();
  }, 'clear'));

  // Black / Logo / Clear-text — hides the output WITHOUT losing the live slide,
  // so a single key brings it straight back (core EasyWorship/ProPresenter behaviour).
  socket.on('overlay', guard((mode) => {
    if (!['none', 'black', 'logo', 'clear'].includes(mode)) return;
    overlayMode = mode;
    io.emit('overlay-state', overlayMode);
    persistState();
  }, 'overlay'));

  // Scrolling ticker (lower-third banner) — independent of the main slide.
  socket.on('ticker-update', guard((payload) => {
    tickerState = { active: !!(payload && payload.active), text: sec.str(payload && payload.text, 600) };
    io.emit('ticker-state', tickerState);
    persistState();
  }, 'ticker-update'));

  // Service countdown / sermon timer (server-clock based so every screen agrees).
  socket.on('timer-set', guard((payload) => {
    timerState = cleanTimer(payload);
    io.emit('timer-state', timerState);
    persistState();
  }, 'timer-set'));

  // Temporary on-screen alert (nursery call, "please move your car", ...)
  socket.on('alert-show', guard((payload) => {
    const text = sec.str(payload && payload.text, 200).trim();
    clearTimeout(alertTimer);
    if (!text) {
      alertState = { text: '', until: 0 };
    } else {
      const seconds = Math.min(120, Math.max(3, Number(payload.seconds) || 12));
      alertState = { text, until: Date.now() + seconds * 1000 };
      alertTimer = setTimeout(() => {
        alertState = { text: '', until: 0 };
        io.emit('alert-state', alertState);
      }, seconds * 1000);
    }
    io.emit('alert-state', alertState);
  }, 'alert-show'));

  socket.on('settings-update', guard((payload) => {
    settingsState = cleanSettings({ ...settingsState, ...payload });
    io.emit('settings-state', settingsState);
    persistState();
  }, 'settings-update'));

  // Phone remote -> control room: the control room owns slide navigation, so
  // the remote simply asks it to act (next / prev / golive / black / schedule item ...).
  socket.on('remote-cmd', guard((cmd) => {
    if (!cmd || typeof cmd !== 'object') return;
    const clean = { cmd: sec.str(cmd.cmd, 20), id: sec.str(cmd.id, 100), live: !!cmd.live };
    io.to('controllers').emit('remote-cmd', clean);
  }, 'remote-cmd'));
});

// ---------------------------------------------------------------------------
// Backup / restore of everything the operator creates (songs, schedule,
// announcements, free texts) — one JSON file, downloadable any time.
// ---------------------------------------------------------------------------
app.get('/api/backup', async (req, res) => {
  try {
    const backup = {
      app: 'worship-presenter',
      version: 1,
      exportedAt: new Date().toISOString(),
      songs: await loadCustomSongs(),
      announcements: await loadAnnouncementsList(),
      freeTexts: await loadFreeTextsList(),
      schedule: await loadScheduleList(),
    };
    res.set('Content-Disposition', `attachment; filename="presenter-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(backup);
  } catch (e) {
    res.status(500).json({ error: 'Could not build backup: ' + e.message });
  }
});

// Merge-restore: adds anything missing, never overwrites or deletes existing data.
app.post('/api/restore', async (req, res) => {
  const b = req.body || {};
  if (b.app !== 'worship-presenter') return res.status(400).json({ error: 'Not a presenter backup file' });
  let added = { songs: 0, announcements: 0, freeTexts: 0 };
  try {
    const existingSongs = new Set((await loadCustomSongs()).map((s) => s.id));
    for (const s of (Array.isArray(b.songs) ? b.songs : []).slice(0, 2000)) {
      const sections = sec.sanitizeSections(s && s.sections);
      const title = sec.str(s && s.title, 200).trim();
      const id = sec.str(s && s.id, 200);
      if (!sections || !title || !id || existingSongs.has(id)) continue;
      await addCustomSong({ id, title, artist: sec.str(s.artist, 200), sections });
      added.songs++;
    }
    const existingAnn = new Set((await loadAnnouncementsList()).map((a) => a.text));
    for (const a of (Array.isArray(b.announcements) ? b.announcements : []).slice(0, 500)) {
      const text = sec.str(a && a.text, 600).trim();
      if (text && !existingAnn.has(text)) { await addAnnouncementItem(text); added.announcements++; }
    }
    const existingFt = new Set((await loadFreeTextsList()).map((a) => a.text));
    for (const f of (Array.isArray(b.freeTexts) ? b.freeTexts : []).slice(0, 500)) {
      const text = sec.str(f && f.text, 6000).trim();
      if (text && !existingFt.has(text)) { await addFreeTextItem(text); added.freeTexts++; }
    }
    songCache = null;
    res.json({ ok: true, added });
  } catch (e) {
    res.status(500).json({ error: 'Restore failed: ' + e.message });
  }
});

// ---------------------------------------------------------------------------
// Errors: always JSON for the API (never an HTML stack trace), with friendly
// messages for the upload failures operators actually hit.
// ---------------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That file is too large.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request.' });
  console.error('Unhandled error:', err && err.message);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message));

// One-time (idempotent) move of media bytes that still live in Postgres into
// Supabase Storage. A file's database copy is only dropped after the object has
// been uploaded AND confirmed readable from the public bucket with the right size.
async function migrateMediaToStorage() {
  if (!pool || !storage.enabled) return;
  const { rows } = await pool.query(
    'SELECT id, mimetype FROM wp_media WHERE data IS NOT NULL AND storage_path IS NULL ORDER BY created_at LIMIT 1000'
  );
  const todo = rows.filter((r) => storage.supportedMime(r.mimetype));
  if (!todo.length) return;
  console.log(`Migrating ${todo.length} media file(s) from the database to Supabase Storage...`);
  let moved = 0;
  let failed = 0;
  for (const row of todo) {
    try {
      const { rows: [full] } = await pool.query('SELECT data FROM wp_media WHERE id = $1', [row.id]);
      if (!full || !full.data) continue;
      const p = storage.objectPath(row.id, row.mimetype);
      await storage.upload([{ path: p, buffer: full.data, mimetype: row.mimetype }]);
      if (!(await storage.verify(p, full.data.length))) {
        await storage.removePaths([p]).catch(() => {});
        throw new Error('uploaded object could not be verified');
      }
      await pool.query('UPDATE wp_media SET storage_path = $2, data = NULL WHERE id = $1 AND storage_path IS NULL', [row.id, p]);
      moved++;
    } catch (e) {
      failed++;
      console.error(`Media migration failed for ${row.id} (left in the database):`, e.message);
    }
  }
  console.log(`Media migration finished: ${moved} moved, ${failed} left in the database.`);
}

// ---------------------------------------------------------------------------
// Boot + graceful shutdown (Render sends SIGTERM on every deploy: save the
// current screen state first so the next instance resumes exactly where we were).
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 4000;
function listen() {
  server.listen(PORT, () => {
    console.log(`Worship Presenter running at http://localhost:${PORT}`);
    if (!sec.AUTH_CONFIGURED) {
      console.warn(sec.IS_PROD
        ? 'WARNING: OPERATOR_PASSWORD is not set — the control room is LOCKED until you set it.'
        : 'Note: OPERATOR_PASSWORD not set — control room is open (development mode only).');
    }
  });
}
initDb()
  .catch((e) => console.error('DB init failed, continuing with file fallback:', e.message))
  .then(restoreState)
  .then(listen)
  .then(() => setTimeout(() => migrateMediaToStorage().catch((e) => console.error('Media migration error:', e.message)), 5000));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(signal + ' received — saving state and shutting down.');
  try { await flushState(); } catch (e) {}
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server };
