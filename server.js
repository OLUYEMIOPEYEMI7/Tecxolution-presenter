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

function loadSongs() {
  return JSON.parse(fs.readFileSync(songsPath, 'utf8'));
}

// Current live state, so a newly-opened display catches up instantly
let currentState = { type: 'blank' };

app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'views', 'control.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'views', 'display.html')));
app.get('/', (req, res) => res.redirect('/control'));

app.get('/api/songs', (req, res) => {
  res.json(loadSongs());
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
