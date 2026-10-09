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

function slugify(title) {
  return 'song-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-' + Date.now().toString(36);
}

// Current live state, so a newly-opened display catches up instantly
let currentState = { type: 'blank' };

app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'views', 'control.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'views', 'display.html')));
app.get('/', (req, res) => res.redirect('/control'));

app.get('/api/songs', (req, res) => {
  const custom = loadSongs().songs.map((s) => ({ ...s, source: 'custom' }));
  const hymns = loadHymns().hymns.map((h) => ({ ...h, source: 'hymn' }));
  res.json({ songs: [...custom, ...hymns] });
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
  // Catch up any newly-connected display/control client
  socket.emit('state', currentState);

  socket.on('project', (payload) => {
    currentState = payload;
    io.emit('state', currentState);
  });

  socket.on('clear', () => {
    currentState = { type: 'blank' };
    io.emit('state', currentState);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Worship Presenter running at http://localhost:${PORT}`));
