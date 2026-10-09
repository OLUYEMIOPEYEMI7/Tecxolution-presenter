const socket = io();
let songs = [];
let activeSong = null;
let songSearchTerm = '';
let songSourceFilter = 'all';
const MAX_RENDERED_SONGS = 150;

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
  songSearchTerm = e.target.value.toLowerCase().trim();
  renderSongList();
});

document.getElementById('song-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.song-tab');
  if (!btn) return;
  document.querySelectorAll('.song-tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  songSourceFilter = btn.dataset.filter;
  renderSongList();
});

const SOURCE_LABEL = { custom: 'MY SONG', hymn: 'HYMN', rccg: 'RCCG' };

function renderSongList() {
  const container = document.getElementById('song-list');
  const footer = document.getElementById('song-list-footer');
  container.innerHTML = '';

  let filtered = songs.filter((s) => songSourceFilter === 'all' || s.source === songSourceFilter);
  if (songSearchTerm) {
    filtered = filtered.filter(
      (s) =>
        s.title.toLowerCase().includes(songSearchTerm) ||
        (s.artist || '').toLowerCase().includes(songSearchTerm) ||
        (s.hymnNumber && String(s.hymnNumber).includes(songSearchTerm))
    );
  }

  const total = filtered.length;
  const shown = filtered.slice(0, MAX_RENDERED_SONGS);

  shown.forEach((song) => {
    const div = document.createElement('div');
    div.className = 'song-item';
    div.dataset.id = song.id;
    const badgeLabel = song.source === 'rccg' && song.hymnNumber ? `#${song.hymnNumber}` : SOURCE_LABEL[song.source] || '';
    const badge = `<span class="song-badge ${song.source}">${badgeLabel}</span>`;
    const delBtn = song.source === 'custom'
      ? `<span onclick="event.stopPropagation(); deleteSong('${song.id}')" style="float:right; color:#a3303c; font-size:12px; cursor:pointer;">✕</span>`
      : '';
    div.innerHTML = `<div class="song-title">${song.title}${badge}${delBtn}</div><div class="song-artist">${song.artist || ''}</div>`;
    div.onclick = () => selectSong(song);
    container.appendChild(div);
  });

  if (total === 0) {
    container.innerHTML = '<p style="color:#666; font-size:13px;">No matches. Try a different search or tab.</p>';
    footer.textContent = '';
  } else if (total > MAX_RENDERED_SONGS) {
    footer.textContent = `Showing ${MAX_RENDERED_SONGS} of ${total} — keep typing to narrow it down.`;
  } else {
    footer.textContent = `${total} song${total === 1 ? '' : 's'}`;
  }
}

function deleteSong(id) {
  if (!confirm('Delete this song?')) return;
  fetch('/api/songs/' + id, { method: 'DELETE' })
    .then((r) => r.json())
    .then(() => reloadSongs());
}

function selectSong(song) {
  const container = document.getElementById('slide-list');
  container.innerHTML = '<p style="color:#666; font-size:13px;">Loading…</p>';
  document.querySelectorAll('.song-item').forEach((el) => el.classList.toggle('active', el.dataset.id === song.id));

  // Full lyrics are fetched on demand — the browse list only carries metadata
  // so it stays fast even with 800+ hymns loaded.
  fetch('/api/songs/' + encodeURIComponent(song.id))
    .then((r) => r.json())
    .then((full) => {
      if (full.error) {
        container.innerHTML = '<p style="color:#a3303c; font-size:13px;">Could not load this song.</p>';
        return;
      }
      activeSong = full;
      currentSongSections = full.sections;
      currentSectionIndex = -1;

      container.innerHTML = '';
      full.sections.forEach((section, idx) => {
        const div = document.createElement('div');
        div.className = 'slide-item';
        const previewText = section.pairs.map((p) => p[0]).join(' ').slice(0, 70);
        div.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div style="flex:1;"><div class="slide-label">${section.label}</div><div class="slide-preview">${previewText}…</div></div>
            <span onclick="event.stopPropagation(); addSongSlideToSchedule('${full.id}', ${idx})" style="font-size:10px; color:#888; border:1px solid #444; border-radius:4px; padding:2px 6px; margin-left:8px; white-space:nowrap;">+ Sched</span>
          </div>`;
        div.onclick = () => {
          currentSectionIndex = idx;
          highlightActiveSlide();
          stageState(sectionToState(full, section));
        };
        container.appendChild(div);
      });
    })
    .catch(() => {
      container.innerHTML = '<p style="color:#a3303c; font-size:13px;">Error loading song.</p>';
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

// ================= Preview / Live separation (server-authoritative, EasyWorship-style) =================
// Preview and Live are both rendered by the exact same /display page+CSS,
// just fed by different socket channels — this guarantees Preview is a true
// proportional miniature of Live, not an approximation.
let currentSongSections = [];
let currentSectionIndex = -1;

function stageState(state) {
  socket.emit('stage', state);
}

function goLive() {
  socket.emit('golive');
}

function nextSlide() {
  if (!currentSongSections.length) return;
  if (currentSectionIndex < currentSongSections.length - 1) {
    currentSectionIndex++;
    highlightActiveSlide();
    stageState(sectionToState(activeSong, currentSongSections[currentSectionIndex]));
  }
}

function prevSlide() {
  if (!currentSongSections.length) return;
  if (currentSectionIndex > 0) {
    currentSectionIndex--;
    highlightActiveSlide();
    stageState(sectionToState(activeSong, currentSongSections[currentSectionIndex]));
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
      stageState({
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
  const song = activeSong && activeSong.id === songId ? activeSong : null;
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
    stageState(item.state);
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
        stageState({ type: 'scripture', reference: data.reference, text: data.text, translation: data.translation, background: null });
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

// ================= Add Song Modal (simplified: paste lyrics, auto-split) =================
const LABEL_KEYWORDS = [
  { re: /^chorus\b/i, label: 'CHORUS' },
  { re: /^refrain\b/i, label: 'REFRAIN' },
  { re: /^bridge\b/i, label: 'BRIDGE' },
  { re: /^intro\b/i, label: 'INTRO' },
  { re: /^outro\b/i, label: 'OUTRO' },
  { re: /^verse\s*\d*/i, label: null }, // null = use the matched text itself, uppercased
];

// Splits pasted lyrics on blank lines into slide sections, auto-labeling
// VERSE/CHORUS/etc. when the first line names it, else numbering plainly.
function parseLyricsIntoSections(raw) {
  const blocks = raw.split(/\n\s*\n+/).map((b) => b.trim()).filter((b) => b.length > 0);
  let verseCount = 0;
  return blocks.map((block) => {
    let lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    let label = null;

    const firstLine = lines[0] || '';
    const firstLineIsLabel = /^(chorus|refrain|bridge|intro|outro|verse)\b.*:?$/i.test(firstLine) && firstLine.split(/\s+/).length <= 3;
    if (firstLineIsLabel) {
      label = firstLine.replace(/:$/, '').toUpperCase();
      lines = lines.slice(1);
    }
    if (!label) {
      verseCount++;
      label = `VERSE ${verseCount}`;
    }
    const pairs = lines.map((l) => [l, '']);
    return { label, pairs, background: null };
  }).filter((s) => s.pairs.length > 0);
}

function renderLyricsPreview() {
  const raw = document.getElementById('new-song-lyrics').value;
  const preview = document.getElementById('lyrics-preview');
  if (!raw.trim()) {
    preview.innerHTML = '<span class="lyrics-preview-empty">Start typing above — a live preview of your slides appears here.</span>';
    return;
  }
  const sections = parseLyricsIntoSections(raw);
  if (sections.length === 0) {
    preview.innerHTML = '<span class="lyrics-preview-empty">Keep typing…</span>';
    return;
  }
  preview.innerHTML = `<div style="font-size:11px; color:#777; margin-bottom:8px;">${sections.length} slide${sections.length === 1 ? '' : 's'} will be created:</div>` +
    sections.map((s, i) => {
      const firstLine = (s.pairs[0] && s.pairs[0][0]) || '';
      return `<span class="preview-slide-chip"><span class="chip-num">${i + 1}</span><span class="chip-label">${s.label}</span><span class="chip-text">${escapeHtmlLocal(firstLine).slice(0, 36)}${firstLine.length > 36 ? '…' : ''}</span></span>`;
    }).join('');
}

function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function openAddSongModal() {
  document.getElementById('add-song-modal').classList.add('open');
  document.getElementById('new-song-title').value = '';
  document.getElementById('new-song-artist').value = '';
  document.getElementById('new-song-lyrics').value = '';
  document.getElementById('add-song-status').textContent = '';
  renderLyricsPreview();
}

function closeAddSongModal() {
  document.getElementById('add-song-modal').classList.remove('open');
}

document.getElementById('new-song-lyrics').addEventListener('input', renderLyricsPreview);

function submitNewSong() {
  const title = document.getElementById('new-song-title').value.trim();
  const artist = document.getElementById('new-song-artist').value.trim();
  const lyricsRaw = document.getElementById('new-song-lyrics').value;
  const statusEl = document.getElementById('add-song-status');

  if (!title) {
    statusEl.textContent = 'Please enter a song title.';
    return;
  }
  const sections = parseLyricsIntoSections(lyricsRaw);
  if (sections.length === 0) {
    statusEl.textContent = 'Please paste the song lyrics first.';
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
      statusEl.textContent = 'Saved! ✓';
      reloadSongs();
      setTimeout(closeAddSongModal, 600);
    })
    .catch((e) => {
      statusEl.textContent = 'Error: ' + e.message;
    });
}
