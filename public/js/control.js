const socket = io();
let songs = [];
let activeSong = null;
let songSearchTerm = '';

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

function reloadSongs() {
  return fetch('/api/songs')
    .then((r) => r.json())
    .then((data) => {
      songs = data.songs;
      renderSongList();
    });
}
reloadSongs();

document.getElementById('song-search').addEventListener('input', (e) => {
  songSearchTerm = e.target.value.toLowerCase();
  renderSongList();
});

function renderSongList() {
  const container = document.getElementById('song-list');
  container.innerHTML = '';
  const filtered = songs.filter(
    (s) => s.title.toLowerCase().includes(songSearchTerm) || (s.artist || '').toLowerCase().includes(songSearchTerm)
  );
  filtered.forEach((song) => {
    const div = document.createElement('div');
    div.className = 'song-item';
    const badge = song.source === 'hymn'
      ? '<span style="font-size:10px; color:#8a8aa0; border:1px solid #444; border-radius:4px; padding:1px 5px; margin-left:6px;">HYMN</span>'
      : '<span style="font-size:10px; color:var(--gold); border:1px solid var(--deep-gold); border-radius:4px; padding:1px 5px; margin-left:6px;">MY SONG</span>';
    const delBtn = song.source === 'custom'
      ? `<span onclick="event.stopPropagation(); deleteSong('${song.id}')" style="float:right; color:#a3303c; font-size:12px; cursor:pointer;">✕</span>`
      : '';
    div.innerHTML = `<div class="song-title">${song.title}${badge}${delBtn}</div><div class="song-artist">${song.artist || ''}</div>`;
    div.onclick = () => selectSong(song);
    container.appendChild(div);
  });
  if (filtered.length === 0) {
    container.innerHTML = '<p style="color:#666; font-size:13px;">No matches.</p>';
  }
}

function deleteSong(id) {
  if (!confirm('Delete this song?')) return;
  fetch('/api/songs/' + id, { method: 'DELETE' })
    .then((r) => r.json())
    .then(() => reloadSongs());
}

function selectSong(song) {
  activeSong = song;
  currentSongSections = song.sections;
  currentSectionIndex = -1;
  document.querySelectorAll('.song-item').forEach((el) => el.classList.remove('active'));
  renderSongList();
  [...document.querySelectorAll('.song-item')].find((el, i) => songs[i].id === song.id)?.classList.add('active');

  const container = document.getElementById('slide-list');
  container.innerHTML = '';
  song.sections.forEach((section, idx) => {
    const div = document.createElement('div');
    div.className = 'slide-item';
    const previewText = section.pairs.map((p) => p[0]).join(' ').slice(0, 70);
    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div style="flex:1;"><div class="slide-label">${section.label}</div><div class="slide-preview">${previewText}…</div></div>
        <span onclick="event.stopPropagation(); addSongSlideToSchedule('${song.id}', ${idx})" style="font-size:10px; color:#888; border:1px solid #444; border-radius:4px; padding:2px 6px; margin-left:8px; white-space:nowrap;">+ Sched</span>
      </div>`;
    div.onclick = () => {
      currentSectionIndex = idx;
      highlightActiveSlide();
      loadIntoPreview(sectionToState(song, section));
    };
    container.appendChild(div);
  });
}

function highlightActiveSlide() {
  document.querySelectorAll('.slide-item').forEach((el, i) => el.classList.toggle('active', i === currentSectionIndex));
}

function sectionToState(song, section) {
  return {
    type: 'song',
    label: section.label,
    pairs: section.pairs,
    finale: section.finale || null,
    background: section.background,
    _displayTitle: `${song.title} — ${section.label}`,
  };
}

// ================= Preview / Live separation (EasyWorship-style) =================
let previewState = null;
let currentSongSections = [];
let currentSectionIndex = -1;

function loadIntoPreview(state) {
  previewState = state;
  renderStage(state, 'preview-stage', 'preview-stage-bg', 'preview-stage-content', 'preview-stage-label');
}

function renderStage(state, stageId, bgId, contentId, labelId) {
  const stage = document.getElementById(stageId);
  const bg = document.getElementById(bgId);
  const content = document.getElementById(contentId);
  const label = document.getElementById(labelId);

  stage.className = 'stage ' + (state && state.type ? state.type : 'blank');
  if (state && state.background) {
    bg.style.backgroundImage = `url('${state.background}')`;
    bg.style.opacity = 1;
  } else {
    bg.style.opacity = 0;
  }

  if (!state) {
    content.innerHTML = '';
    label.textContent = '';
    return;
  }

  if (state.type === 'song') {
    let html = '';
    (state.pairs || []).forEach(([call, response]) => {
      html += `<div class="lyric-line">${escapeHtmlLocal(call)}`;
      if (response) html += ` <span class="response">${escapeHtmlLocal(response)}</span>`;
      html += `</div>`;
    });
    if (state.finale) html += `<div class="finale-banner">${escapeHtmlLocal(state.finale)}</div>`;
    content.innerHTML = html;
    label.textContent = state.label || '';
  } else if (state.type === 'scripture') {
    content.innerHTML = `
      <div class="scripture-ref">${escapeHtmlLocal(state.reference || '')}</div>
      <div class="scripture-text">${escapeHtmlLocal(state.text || '')}</div>
      <div class="scripture-translation">${escapeHtmlLocal(state.translation || '')}</div>`;
    label.textContent = '';
  } else {
    content.innerHTML = '';
    label.textContent = '';
  }
}

function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function goLive() {
  if (!previewState) return;
  socket.emit('project', previewState);
}

function nextSlide() {
  if (!currentSongSections.length) return;
  if (currentSectionIndex < currentSongSections.length - 1) {
    currentSectionIndex++;
    highlightActiveSlide();
    loadIntoPreview(sectionToState(activeSong, currentSongSections[currentSectionIndex]));
  }
}

function prevSlide() {
  if (!currentSongSections.length) return;
  if (currentSectionIndex > 0) {
    currentSectionIndex--;
    highlightActiveSlide();
    loadIntoPreview(sectionToState(activeSong, currentSongSections[currentSectionIndex]));
  }
}

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (e.key === 'ArrowRight') { nextSlide(); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { prevSlide(); e.preventDefault(); }
  else if (e.key === 'Enter' || e.key === ' ') { goLive(); e.preventDefault(); }
  else if (e.key === 'Escape') { clearStage(); e.preventDefault(); }
});

function stageScripture() {
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
      statusEl.textContent = 'Staged: ' + data.reference + ' (click GO LIVE)';
      currentSongSections = [];
      loadIntoPreview({
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
  stageScripture();
}

function clearStage() {
  socket.emit('clear');
  document.querySelectorAll('.slide-item, .song-item').forEach((el) => el.classList.remove('active'));
}

function openDisplay() {
  window.open('/display', '_blank', 'fullscreen=yes');
}

document.getElementById('scripture-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { stageScripture(); e.stopPropagation(); }
});

// ================= Schedule (service run-list) =================
let schedule = JSON.parse(localStorage.getItem('wp_schedule') || '[]');

function saveScheduleToStorage() {
  localStorage.setItem('wp_schedule', JSON.stringify(schedule));
}

function renderSchedule() {
  const container = document.getElementById('schedule-list');
  if (schedule.length === 0) {
    container.innerHTML = '<p style="color:#666; font-size:12px; margin:0;">Empty — click "+ Schedule" on any slide/scripture to build your service order.</p>';
    return;
  }
  container.innerHTML = '';
  schedule.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = 'schedule-item';
    div.innerHTML = `
      <span class="sched-text">${idx + 1}. ${escapeHtmlLocal(item.displayTitle)}</span>
      <span class="sched-controls">
        <span onclick="event.stopPropagation(); moveScheduleItem(${idx}, -1)">↑</span>
        <span onclick="event.stopPropagation(); moveScheduleItem(${idx}, 1)">↓</span>
        <span onclick="event.stopPropagation(); removeScheduleItem(${idx})">✕</span>
      </span>`;
    div.onclick = () => loadScheduleItem(item);
    container.appendChild(div);
  });
}
renderSchedule();

function addSongSlideToSchedule(songId, sectionIdx) {
  const song = songs.find((s) => s.id === songId);
  if (!song) return;
  const section = song.sections[sectionIdx];
  schedule.push({
    displayTitle: `${song.title} — ${section.label}`,
    stateType: 'song',
    state: sectionToState(song, section),
  });
  saveScheduleToStorage();
  renderSchedule();
}

function addScriptureToSchedule() {
  const ref = document.getElementById('scripture-input').value.trim();
  if (!ref) return;
  schedule.push({ displayTitle: 'Scripture: ' + ref, stateType: 'scripture-ref', ref });
  saveScheduleToStorage();
  renderSchedule();
}

function loadScheduleItem(item) {
  if (item.stateType === 'song') {
    currentSongSections = [];
    loadIntoPreview(item.state);
  } else if (item.stateType === 'scripture-ref') {
    const statusEl = document.getElementById('scripture-status');
    statusEl.textContent = 'Looking up… ' + item.ref;
    fetch('/api/scripture?ref=' + encodeURIComponent(item.ref))
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          statusEl.textContent = 'Not found: ' + item.ref;
          return;
        }
        statusEl.textContent = 'Staged: ' + data.reference;
        currentSongSections = [];
        loadIntoPreview({ type: 'scripture', reference: data.reference, text: data.text, translation: data.translation, background: null });
      });
  }
}

function moveScheduleItem(idx, dir) {
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= schedule.length) return;
  [schedule[idx], schedule[newIdx]] = [schedule[newIdx], schedule[idx]];
  saveScheduleToStorage();
  renderSchedule();
}

function removeScheduleItem(idx) {
  schedule.splice(idx, 1);
  saveScheduleToStorage();
  renderSchedule();
}

function clearSchedule() {
  if (!confirm('Clear the whole schedule?')) return;
  schedule = [];
  saveScheduleToStorage();
  renderSchedule();
}

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

// ================= Add Song Modal =================
let sectionCount = 0;

function openAddSongModal() {
  document.getElementById('add-song-modal').style.display = 'flex';
  document.getElementById('new-song-title').value = '';
  document.getElementById('new-song-artist').value = '';
  document.getElementById('new-song-sections').innerHTML = '';
  document.getElementById('add-song-status').textContent = '';
  sectionCount = 0;
  addSectionField();
}

function closeAddSongModal() {
  document.getElementById('add-song-modal').style.display = 'none';
}

function addSectionField() {
  sectionCount++;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'background:#0b0b1a; border:1px solid #2a2a44; border-radius:8px; padding:12px; margin-bottom:10px;';
  wrap.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
      <input type="text" placeholder="Section label (e.g. VERSE 1, CHORUS)" class="section-label" style="flex:1; padding:6px; border-radius:6px; border:1px solid #333; background:#16162a; color:#fff; font-size:12px;" />
      <span class="remove-section-btn" style="color:#a3303c; cursor:pointer; margin-left:8px;">✕ remove</span>
    </div>
    <textarea placeholder="One lyric line per line. Optionally add a response after a | e.g.&#10;Do you feel the world is broken? | We do." class="section-lyrics" rows="4" style="width:100%; padding:6px; border-radius:6px; border:1px solid #333; background:#16162a; color:#fff; font-size:12px; font-family:inherit;"></textarea>
    <input type="text" placeholder="Optional finale banner (e.g. HE IS.)" class="section-finale" style="width:100%; padding:6px; margin-top:6px; border-radius:6px; border:1px solid #333; background:#16162a; color:#fff; font-size:12px;" />
  `;
  wrap.querySelector('.remove-section-btn').onclick = () => wrap.remove();
  document.getElementById('new-song-sections').appendChild(wrap);
}

function submitNewSong() {
  const title = document.getElementById('new-song-title').value.trim();
  const artist = document.getElementById('new-song-artist').value.trim();
  const statusEl = document.getElementById('add-song-status');

  if (!title) {
    statusEl.textContent = 'Please enter a title.';
    return;
  }

  const sectionEls = [...document.querySelectorAll('#new-song-sections > div')];
  const sections = sectionEls.map((el) => {
    const label = el.querySelector('.section-label').value.trim() || 'SECTION';
    const lyricsRaw = el.querySelector('.section-lyrics').value.trim();
    const finale = el.querySelector('.section-finale').value.trim();
    const pairs = lyricsRaw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const parts = line.split('|');
        const call = parts[0].trim();
        const response = parts[1] ? parts[1].trim() : '';
        return [call, response];
      });
    const section = { label, pairs, background: null };
    if (finale) section.finale = finale;
    return section;
  }).filter((s) => s.pairs.length > 0);

  if (sections.length === 0) {
    statusEl.textContent = 'Add at least one section with lyrics.';
    return;
  }

  statusEl.textContent = 'Saving…';
  fetch('/api/songs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, artist, sections }),
  })
    .then((r) => r.json())
    .then((data) => {
      if (data.error) {
        statusEl.textContent = 'Error: ' + data.error;
        return;
      }
      statusEl.textContent = 'Saved!';
      reloadSongs();
      setTimeout(closeAddSongModal, 500);
    })
    .catch((e) => {
      statusEl.textContent = 'Error: ' + e.message;
    });
}
