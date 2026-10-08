const socket = io();
let songs = [];
let activeSong = null;

const liveDot = document.getElementById('live-dot');
const liveText = document.getElementById('live-text');

socket.on('connect', () => {
  liveDot.classList.add('on');
  liveText.textContent = 'connected';
});
socket.on('disconnect', () => {
  liveDot.classList.remove('on');
  liveText.textContent = 'disconnected';
});

fetch('/api/songs')
  .then((r) => r.json())
  .then((data) => {
    songs = data.songs;
    renderSongList();
  });

function renderSongList() {
  const container = document.getElementById('song-list');
  container.innerHTML = '';
  songs.forEach((song) => {
    const div = document.createElement('div');
    div.className = 'song-item';
    div.innerHTML = `<div class="song-title">${song.title}</div><div class="song-artist">${song.artist}</div>`;
    div.onclick = () => selectSong(song);
    container.appendChild(div);
  });
}

function selectSong(song) {
  activeSong = song;
  document.querySelectorAll('.song-item').forEach((el) => el.classList.remove('active'));
  renderSongList();
  [...document.querySelectorAll('.song-item')].find((el, i) => songs[i].id === song.id)?.classList.add('active');

  const container = document.getElementById('slide-list');
  container.innerHTML = '';
  song.sections.forEach((section, idx) => {
    const div = document.createElement('div');
    div.className = 'slide-item';
    const previewText = section.pairs.map((p) => p[0]).join(' ').slice(0, 70);
    div.innerHTML = `<div class="slide-label">${section.label}</div><div class="slide-preview">${previewText}…</div>`;
    div.onclick = () => {
      document.querySelectorAll('.slide-item').forEach((el) => el.classList.remove('active'));
      div.classList.add('active');
      projectSong(song, section);
    };
    container.appendChild(div);
  });
}

function projectSong(song, section) {
  socket.emit('project', {
    type: 'song',
    label: section.label,
    pairs: section.pairs,
    finale: section.finale || null,
    background: section.background,
  });
}

function lookupScripture() {
  const ref = document.getElementById('scripture-input').value.trim();
  if (!ref) return;
  const statusEl = document.getElementById('scripture-status');
  statusEl.textContent = 'Looking up…';
  fetch('/api/scripture?ref=' + encodeURIComponent(ref))
    .then((r) => r.json())
    .then((data) => {
      if (data.error) {
        statusEl.textContent = 'Not found: ' + data.error;
        return;
      }
      statusEl.textContent = 'Projected: ' + data.reference;
      socket.emit('project', {
        type: 'scripture',
        reference: data.reference,
        text: data.text,
        translation: data.translation,
        background: null,
      });
    })
    .catch((e) => {
      statusEl.textContent = 'Error: ' + e.message;
    });
}

function quickRef(ref) {
  document.getElementById('scripture-input').value = ref;
  lookupScripture();
}

function clearStage() {
  socket.emit('clear');
  document.querySelectorAll('.slide-item, .song-item').forEach((el) => el.classList.remove('active'));
}

function openDisplay() {
  window.open('/display', '_blank', 'fullscreen=yes');
}

document.getElementById('scripture-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') lookupScripture();
});

// ================= Voice Detect (Phase 2) =================
let pendingSuggestion = null;

function projectScriptureByRef(ref) {
  const statusEl = document.getElementById('scripture-status');
  statusEl.textContent = 'Looking up… ' + ref;
  return fetch('/api/scripture?ref=' + encodeURIComponent(ref))
    .then((r) => r.json())
    .then((data) => {
      if (data.error) {
        statusEl.textContent = 'Not found: ' + ref;
        return false;
      }
      statusEl.textContent = 'Projected: ' + data.reference;
      socket.emit('project', {
        type: 'scripture',
        reference: data.reference,
        text: data.text,
        translation: data.translation,
        background: null,
      });
      return true;
    })
    .catch(() => {
      statusEl.textContent = 'Error looking up ' + ref;
      return false;
    });
}

const voiceLogEl = document.getElementById('voice-log');
function addVoiceLog(text) {
  const line = document.createElement('div');
  line.textContent = new Date().toLocaleTimeString() + ' — ' + text;
  voiceLogEl.prepend(line);
  while (voiceLogEl.children.length > 8) voiceLogEl.removeChild(voiceLogEl.lastChild);
}

const voiceDetector = new VoiceDetector({
  onTranscript: (text) => {
    document.getElementById('voice-transcript').textContent = text;
  },
  onStatus: (status) => {
    document.getElementById('voice-status').textContent = status;
  },
  onReferenceDetected: (match) => {
    const autoEngage = document.getElementById('auto-engage').checked;
    if (autoEngage) {
      addVoiceLog('Detected & projected: ' + match.reference);
      projectScriptureByRef(match.reference);
    } else {
      pendingSuggestion = match;
      document.getElementById('voice-suggestion').style.display = 'block';
      document.getElementById('voice-suggestion-ref').textContent = 'Heard: ' + match.reference;
      addVoiceLog('Detected (awaiting confirm): ' + match.reference);
    }
  },
});

function toggleVoiceDetect() {
  const btn = document.getElementById('voice-start-btn');
  if (voiceDetector.listening) {
    voiceDetector.stop();
    btn.textContent = 'Start Listening';
    btn.classList.remove('danger');
  } else {
    voiceDetector.start();
    btn.textContent = 'Stop Listening';
    btn.classList.add('danger');
  }
}

function confirmVoiceSuggestion() {
  if (!pendingSuggestion) return;
  projectScriptureByRef(pendingSuggestion.reference);
  addVoiceLog('Confirmed: ' + pendingSuggestion.reference);
  pendingSuggestion = null;
  document.getElementById('voice-suggestion').style.display = 'none';
}
