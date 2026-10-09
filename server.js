const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const songsPath = path.join(__dirname, 'data', 'songs.json');
const hymnsPath = path.join(__dirname, 'data', 'hymns.json');

function loadSongs() {
  return JSON.parse(fs.readFileSync(songsPath, 'utf8'));
}

function saveSongs(data) {
  fs.writeFileSync(songsPath, JSON.stringify(data, null, 2));
}

function loadHymns() {
  return JSON.parse(fs.readFileSync(hymnsPath, 'utf8'));
}

const rccgHymnalPath = path.join(__dirname, 'data', 'rccg-hymnal.json');
function loadRccgHymnal() {
  return JSON.parse(fs.readFileSync(rccgHymnalPath, 'utf8'));
}

function slugify(title) {
  return 'song-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-' + Date.now().toString(36);
}

// Builds the full merged song list (all sources) with their complete section data.
function getAllSongsFull() {
  const custom = loadSongs().songs.map((s) => ({ ...s, source: 'custom' }));
  const hymns = loadHymns().hymns.map((h) => ({ ...h, source: 'hymn' }));
  const rccg = loadRccgHymnal().hymns.map((h) => ({ ...h, source: 'rccg' }));
  return [...custom, ...hymns, ...rccg];
}

// Two independent states: liveState is what the audience sees, previewState
// is staged but not yet visible. They're broadcast on separate socket events
// so the Preview and Live iframes (both /display, same rendering code) stay
// perfectly proportional to each other — Preview is a true miniature of Live,
// not an approximation.
let liveState = { type: 'blank' };
let previewState = { type: 'blank' };

app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'views', 'control.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'views', 'display.html')));
app.get('/', (req, res) => res.redirect('/control'));

app.get('/api/songs', (req, res) => {
  // Lightweight metadata only — full lyrics are fetched on demand via /api/songs/:id
  // so the browser doesn't have to download the entire ~3MB hymnal up front.
  const all = getAllSongsFull();
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

io.on('connection', (socket) => {
  // Catch up any newly-connected display/control client on both channels
  socket.emit('live-state', liveState);
  socket.emit('preview-state', previewState);

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
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Worship Presenter running at http://localhost:${PORT}`));
