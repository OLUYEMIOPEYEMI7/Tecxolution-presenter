// Any 401 (session expired / signed out) sends the operator to the login page.
const _fetch = window.fetch.bind(window);
window.fetch = (...a) => _fetch(...a).then((r) => {
  if (r.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname);
  return r;
});

const socket = io();
let songs = [];
let activeSong = null;
let songSearchTerm = '';
let songSourceFilter = 'all';
let songSearchDebounce = null;
const MAX_RENDERED_SONGS = 150;

// Favourites (starred songs) live in this browser; allSongsIndex is the full
// lightweight catalogue, used for instant as-you-type title/number matching
// while the server does the slower lyric search.
let favs = new Set(JSON.parse(localStorage.getItem('wp_favs') || '[]'));
let allSongsIndex = [];
let needsLyrics = 0;
const HL_STOP = new Set(['my','the','a','an','is','of','to','in','on','for','and','that','this','with','at','by','from','as','it','be','we','you','your','he','his','him','she','her','they','them','our','us','i','am','are','was','were','will','shall','thy','thee','thou','o']);
// Escapes text and wraps the searched words in <mark> (escape per piece, so a
// query like "amp" can never corrupt an HTML entity).
function highlightTerms(text, term) {
  const words = [...new Set(String(term || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !HL_STOP.has(w)))];
  if (!words.length) return escapeHtmlLocal(text);
  const re = new RegExp('(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  return String(text).split(re).map((part, i) => (i % 2 ? '<mark>' + escapeHtmlLocal(part) + '</mark>' : escapeHtmlLocal(part))).join('');
}
function toggleFav(id) {
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  localStorage.setItem('wp_favs', JSON.stringify([...favs]));
  if (songSourceFilter === 'fav') reloadSongs(); else renderSongList();
}
function linesPerSlide() { return Number(localStorage.getItem('wp_lines_per_slide') || 0); }
// Re-splits long verses so projected slides stay readable (e.g. max 2 lines).
function rechunkSections(sections, n) {
  if (!n) return sections;
  const out = [];
  sections.forEach((sec) => {
    if (sec.pairs.length <= n) { out.push(sec); return; }
    const parts = Math.ceil(sec.pairs.length / n);
    for (let i = 0; i < parts; i++) {
      out.push({
        ...sec,
        label: `${sec.label} (${i + 1}/${parts})`,
        pairs: sec.pairs.slice(i * n, (i + 1) * n),
        finale: i === parts - 1 ? sec.finale : null,
      });
    }
  });
  return out;
}

const liveDot = document.getElementById('live-dot');
const liveText = document.getElementById('live-text');

const connBanner = document.getElementById('conn-banner');
socket.on('connect', () => {
  liveDot.classList.add('on');
  liveText.textContent = 'connected';
  connBanner.classList.remove('on');
  socket.emit('hello', 'control');
  window.syncServerTime(socket);
});
socket.on('disconnect', () => {
  liveDot.classList.remove('on');
  liveText.textContent = 'disconnected';
  connBanner.classList.add('on');
});
socket.on('auth-error', () => { location.href = '/login?next=/control'; });

function signOut() {
  fetch('/api/logout', { method: 'POST' }).finally(() => { location.href = '/login'; });
}

function reloadSongs() {
  const params = new URLSearchParams();
  if (songSearchTerm) params.set('q', songSearchTerm);
  if (songSourceFilter !== 'all' && songSourceFilter !== 'fav') params.set('source', songSourceFilter);
  const footer = document.getElementById('song-list-footer');
  if (songSearchTerm) footer.textContent = 'Searching…';
  return fetch('/api/songs?' + params.toString())
    .then((r) => r.json())
    .then((data) => {
      songs = data.songs;
      needsLyrics = data.needsLyrics || 0;
      if (!songSearchTerm && songSourceFilter === 'all') allSongsIndex = songs;
      if (songSourceFilter === 'fav') songs = songs.filter((x) => favs.has(x.id));
      renderSongList();
    });
}
reloadSongs();

document.getElementById('song-search').addEventListener('input', (e) => {
  const value = e.target.value;
  // Instant: match titles / artists / hymn numbers locally before the server's lyric search returns.
  const words = value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length && allSongsIndex.length) {
    songs = allSongsIndex.filter((x) => {
      if (songSourceFilter === 'fav' && !favs.has(x.id)) return false;
      if (songSourceFilter !== 'all' && songSourceFilter !== 'fav' && x.source !== songSourceFilter) return false;
      const hay = (x.title + ' ' + (x.artist || '') + ' ' + (x.hymnNumber || '')).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    renderSongList();
  }
  clearTimeout(songSearchDebounce);
  songSearchDebounce = setTimeout(() => {
    songSearchTerm = value.toLowerCase().trim();
    reloadSongs();
  }, 250); // debounce — searches lyric text server-side, not just title
});

document.getElementById('song-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.song-tab');
  if (!btn) return;
  document.querySelectorAll('.song-tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  songSourceFilter = btn.dataset.filter;
  reloadSongs();
});

const SOURCE_LABEL = { custom: 'MY SONG', hymn: 'HYMN', rccg: 'RCCG' };

function renderSongList() {
  const container = document.getElementById('song-list');
  const footer = document.getElementById('song-list-footer');
  container.innerHTML = '';

  const total = songs.length;
  const shown = songs.slice(0, MAX_RENDERED_SONGS);

  shown.forEach((song) => {
    const div = document.createElement('div');
    div.className = 'song-item';
    div.dataset.id = song.id;
    const badgeLabel = song.source === 'rccg' && song.hymnNumber ? `#${song.hymnNumber}` : SOURCE_LABEL[song.source] || '';
    const badge = `<span class="song-badge ${song.source}">${badgeLabel}</span>`;
    const delBtn = song.source === 'custom'
      ? `<span onclick="event.stopPropagation(); deleteSong('${song.id}')" style="float:right; color:#a3303c; font-size:12px; cursor:pointer;">✕</span>`
      : '';
    const editBtn = song.source === 'custom'
      ? `<span onclick="event.stopPropagation(); openEditSongModal('${song.id}')" style="float:right; color:#999; font-size:12px; cursor:pointer; margin-right:8px;" title="Edit title, artist, or lyrics">✎</span>`
      : '';
    const schedBtn = `<span onclick="event.stopPropagation(); addWholeSongToSchedule('${song.id}')" class="song-sched-btn" title="Add this whole song to Today's Schedule">+ Sched</span>`;
    const star = `<span class="fav-star ${favs.has(song.id) ? 'on' : ''}" onclick="event.stopPropagation(); toggleFav('${song.id}')" title="${favs.has(song.id) ? 'Remove from favourites' : 'Add to favourites'}" role="button" aria-label="Toggle favourite">${favs.has(song.id) ? '★' : '☆'}</span>`;
    const noLyr = song.hasLyrics === false ? '<span class="song-badge nolyrics" title="Title only — add the lyrics so it can be projected and searched">NO LYRICS</span>' : '';
    const snippet = song.snippet && songSearchTerm
      ? `<div class="song-snippet" title="Matching line in the lyrics">${song.snippet.label ? '<b>' + escapeHtmlLocal(song.snippet.label) + '</b> ' : ''}${highlightTerms(song.snippet.text, songSearchTerm)}</div>`
      : '';
    div.innerHTML = `<div class="song-title">${highlightTerms(song.title, songSearchTerm)}${badge}${noLyr}${star}${editBtn}${delBtn}</div><div class="song-artist">${highlightTerms(song.artist || '', songSearchTerm)}${schedBtn}</div>${snippet}`;
    div.onclick = () => selectSong(song);
    container.appendChild(div);
  });

  if (total === 0) {
    container.innerHTML = songSourceFilter === 'fav'
      ? '<p style="color:#666; font-size:13px;">No favourites yet — tap the ☆ on any song to pin it here.</p>'
      : songSourceFilter === 'nolyrics'
        ? '<p style="color:#6fcf97; font-size:13px;">Every song has lyrics. 🎉</p>'
        : '<p style="color:#666; font-size:13px;">No matches. Try another word — you can search titles, artists, hymn numbers and any words from the lyrics.</p>';
    footer.textContent = '';
  } else if (total > MAX_RENDERED_SONGS) {
    footer.textContent = `Showing ${MAX_RENDERED_SONGS} of ${total} — keep typing to narrow it down.`;
  } else {
    footer.textContent = `${total} song${total === 1 ? '' : 's'}`;
  }
  if (songSourceFilter === 'nolyrics') {
    footer.innerHTML += ' · <a href="#" onclick="showSongsNeedingLyrics(false); return false;">back to all songs</a>';
  } else if (needsLyrics > 0) {
    footer.innerHTML += ` · <a href="#" onclick="showSongsNeedingLyrics(true); return false;" title="Songs imported as titles only">${needsLyrics} need lyrics</a>`;
  }
}

function showSongsNeedingLyrics(on) {
  songSourceFilter = on ? 'nolyrics' : 'all';
  document.querySelectorAll('.song-tab').forEach((t) => t.classList.toggle('active', !on && t.dataset.filter === 'all'));
  reloadSongs();
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
      if (!full.sections || full.sections.length === 0) {
        activeSong = full;
        currentSongSections = [];
        scriptureChunks = [];
        currentSectionIndex = -1;
        currentDeckSlides = [];
        container.innerHTML = `<div class="slides-empty"><div style="font-size:15px; color:var(--text); margin-bottom:6px;">${escapeHtmlLocal(full.title)}</div>
          This song has no lyrics yet, so there is nothing to project or search.<br>
          <div style="margin-top:14px; display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
            <button onclick="openEditSongModal('${full.id}')">+ Add lyrics</button>
            <button class="secondary" onclick="openImportModal()">Import lyrics…</button>
          </div></div>`;
        if (window.showTab) window.showTab('slides');
        return;
      }
      full.sections = rechunkSections(full.sections, linesPerSlide());
      activeSong = full;
      currentSongSections = full.sections;
      scriptureChunks = [];
      currentSectionIndex = -1;
      currentDeckSlides = [];
      currentDeckIndex = -1;

      container.innerHTML = '';
      full.sections.forEach((section, idx) => {
        const div = document.createElement('div');
        div.className = 'slide-item slide-card';
        div.dataset.title = `${full.title} — ${section.label}`;
        const thumbLines = section.pairs.slice(0, 5).map((p) => escapeHtmlLocal(p[0]) + (p[1] ? ' <em>' + escapeHtmlLocal(p[1]) + '</em>' : '')).join('<br>');
        div.innerHTML = `
          <div class="thumb"><div class="thumb-text">${thumbLines}</div></div>
          <div class="card-meta">
            <span class="card-num">${idx + 1}</span>
            <span class="slide-label">${escapeHtmlLocal(section.label)}</span>
            <span class="sched-add" onclick="event.stopPropagation(); addSongSlideToSchedule('${full.id}', ${idx})" title="Add this slide to today's schedule">+ Sched</span>
          </div>`;
        div.onclick = () => {
          currentSectionIndex = idx;
          highlightActiveSlide();
          stageState(sectionToState(full, section));
        };
        div.ondblclick = () => {
          currentSectionIndex = idx;
          highlightActiveSlide();
          stageState(sectionToState(full, section));
          goLive(); // double-click: stage and go live in one motion
        };
        div.title = 'Click to stage · double-click to go live instantly';
        container.appendChild(div);
      });
      if (window.showTab) window.showTab('slides');
    })
    .catch(() => {
      container.innerHTML = '<p style="color:#a3303c; font-size:13px;">Error loading song.</p>';
    });
}

function highlightActiveSlide() {
  document.querySelectorAll('.slide-item').forEach((el, i) => el.classList.toggle('active', i === currentSectionIndex));
}

function sectionToState(song, section) {
  // "next" feeds the Stage Monitor and the phone remote (what's coming up).
  const idx = song.sections.indexOf(section);
  const upcoming = idx >= 0 ? song.sections[idx + 1] : null;
  return {
    type: 'song',
    label: section.label,
    pairs: section.pairs,
    finale: section.finale || null,
    background: section.background,
    next: upcoming ? [upcoming.label + ':', ...upcoming.pairs.slice(0, 3).map((p) => p[0])] : [],
    _displayTitle: `${song.title} — ${section.label}`,
  };
}

// ================= Preview / Live separation (server-authoritative, EasyWorship-style) =================
// Preview and Live are both rendered by the exact same /display page+CSS,
// just fed by different socket channels — this guarantees Preview is a true
// proportional miniature of Live, not an approximation.
let currentSongSections = [];
let currentSectionIndex = -1;
let currentTheme = localStorage.getItem('wp_theme') || 'photo';
let customThemes = JSON.parse(localStorage.getItem('wp_custom_themes') || '[]');
let lastStagedState = null;

function findCustomTheme(id) {
  return customThemes.find((t) => t.id === id);
}

function withTheme(state) {
  const custom = findCustomTheme(currentTheme);
  return { ...state, theme: currentTheme, themeBg: custom ? custom.css : null };
}

function stageState(state) {
  lastStagedState = state;
  socket.emit('stage', withTheme(state));
}

function goLive() {
  socket.emit('golive');
}

function renderCustomThemeSwatches() {
  const container = document.getElementById('custom-theme-swatches');
  container.innerHTML = customThemes.map((t) => `
    <div class="theme-swatch" data-theme="${t.id}" title="${escapeHtmlLocal(t.name)}" style="background:${t.css}; position:relative;">
      <span class="swatch-label">${escapeHtmlLocal(t.name).slice(0, 10)}</span>
      <span onclick="event.stopPropagation(); deleteCustomTheme('${t.id}')" style="position:absolute; top:2px; right:3px; font-size:9px; color:rgba(255,255,255,0.7); cursor:pointer;">✕</span>
    </div>
  `).join('');
  document.querySelectorAll('.theme-swatch').forEach((s) => s.classList.toggle('active', s.dataset.theme === currentTheme));
}
renderCustomThemeSwatches();

function deleteCustomTheme(id) {
  customThemes = customThemes.filter((t) => t.id !== id);
  localStorage.setItem('wp_custom_themes', JSON.stringify(customThemes));
  if (currentTheme === id) {
    currentTheme = 'photo';
    localStorage.setItem('wp_theme', currentTheme);
  }
  renderCustomThemeSwatches();
}

document.getElementById('theme-picker').addEventListener('click', (e) => {
  const swatch = e.target.closest('.theme-swatch');
  if (!swatch || swatch.id === 'add-theme-tile') return;
  currentTheme = swatch.dataset.theme;
  localStorage.setItem('wp_theme', currentTheme);
  document.querySelectorAll('.theme-swatch').forEach((s) => s.classList.toggle('active', s === swatch));
  if (lastStagedState) stageState(lastStagedState); // re-stage with the new theme so it's visible right away
});

// ---- Theme popover (so the picker never pushes Live out of view) ----
function toggleThemePopover(show) {
  const pop = document.getElementById('theme-popover');
  const shouldOpen = show !== undefined ? show : !pop.classList.contains('open');
  pop.classList.toggle('open', shouldOpen);
  if (!shouldOpen) openAddThemeForm(false);
}
document.addEventListener('click', (e) => {
  const pop = document.getElementById('theme-popover');
  if (pop.classList.contains('open') && !pop.contains(e.target) && !e.target.closest('.theme-toggle-btn')) {
    toggleThemePopover(false);
  }
});

// ---- Add a custom theme (name + 2-color gradient OR an uploaded image) ----
let themeMode = 'gradient';
let uploadedThemeImageUrl = null;

function openAddThemeForm(show = true) {
  document.getElementById('add-theme-form').style.display = show ? 'block' : 'none';
  if (show) setThemeMode('gradient');
}

function setThemeMode(mode) {
  themeMode = mode;
  document.querySelectorAll('.theme-mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  document.getElementById('theme-mode-gradient').style.display = mode === 'gradient' ? 'block' : 'none';
  document.getElementById('theme-mode-image').style.display = mode === 'image' ? 'block' : 'none';
}

document.getElementById('new-theme-image-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  uploadedThemeImageUrl = null;
  if (!file) return;
  const preview = document.getElementById('new-theme-image-preview');
  const reader = new FileReader();
  reader.onload = () => {
    preview.src = reader.result;
    preview.style.display = 'block';
  };
  reader.readAsDataURL(file);
});

function saveCustomTheme() {
  const name = document.getElementById('new-theme-name').value.trim();
  if (!name) {
    alert('Please give your theme a name.');
    return;
  }

  if (themeMode === 'image') {
    const fileInput = document.getElementById('new-theme-image-file');
    const file = fileInput.files[0];
    if (!file) {
      alert('Please choose an image file first.');
      return;
    }
    const formData = new FormData();
    formData.append('image', file);
    fetch('/api/theme-image', { method: 'POST', body: formData })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          alert('Upload failed: ' + data.error);
          return;
        }
        finishSavingTheme(name, `url('${data.url}') center center / cover no-repeat`);
        fileInput.value = '';
        document.getElementById('new-theme-image-preview').style.display = 'none';
      })
      .catch((e) => alert('Upload failed: ' + e.message));
  } else {
    const c1 = document.getElementById('new-theme-color1').value;
    const c2 = document.getElementById('new-theme-color2').value;
    finishSavingTheme(name, `linear-gradient(165deg, ${c1} 0%, ${c2} 100%)`);
  }
}

function finishSavingTheme(name, css) {
  const id = 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-' + Date.now().toString(36);
  customThemes.push({ id, name, css });
  localStorage.setItem('wp_custom_themes', JSON.stringify(customThemes));
  renderCustomThemeSwatches();
  openAddThemeForm(false);
  document.getElementById('new-theme-name').value = '';
  // Auto-select the just-created theme
  currentTheme = id;
  localStorage.setItem('wp_theme', currentTheme);
  renderCustomThemeSwatches();
  if (lastStagedState) stageState(lastStagedState);
}

function nextSlide() {
  if (scriptureChunks.length > 1) {
    if (scriptureChunkIndex < scriptureChunks.length - 1) { scriptureChunkIndex++; stageScriptureChunk(); }
    return;
  }
  if (currentDeckSlides.length) {
    if (currentDeckIndex < currentDeckSlides.length - 1) {
      currentDeckIndex++;
      highlightDeckSlide();
      stageState({ type: 'image', url: currentDeckSlides[currentDeckIndex].url });
    }
    return;
  }
  if (!currentSongSections.length) return;
  if (currentSectionIndex < currentSongSections.length - 1) {
    currentSectionIndex++;
    highlightActiveSlide();
    stageState(sectionToState(activeSong, currentSongSections[currentSectionIndex]));
  }
}

function prevSlide() {
  if (scriptureChunks.length > 1) {
    if (scriptureChunkIndex > 0) { scriptureChunkIndex--; stageScriptureChunk(); }
    return;
  }
  if (currentDeckSlides.length) {
    if (currentDeckIndex > 0) {
      currentDeckIndex--;
      highlightDeckSlide();
      stageState({ type: 'image', url: currentDeckSlides[currentDeckIndex].url });
    }
    return;
  }
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
  else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'b') { toggleOverlay('black'); e.preventDefault(); }
    else if (k === 'l') { toggleOverlay('logo'); e.preventDefault(); }
    else if (k === 'c') { toggleOverlay('clear'); e.preventDefault(); }
  }
});

function getSelectedBibleVersion() {
  const sel = document.getElementById('bible-version-select');
  return sel && sel.value ? sel.value : 'kjv';
}

function scriptureUrl(ref) {
  return '/api/scripture?ref=' + encodeURIComponent(ref) + '&version=' + encodeURIComponent(getSelectedBibleVersion());
}

fetch('/api/bible-versions')
  .then((r) => r.json())
  .then((data) => {
    const sel = document.getElementById('bible-version-select');
    sel.innerHTML = data.versions.map((v) => {
      const label = v.available ? v.name + (v.offline ? '  ✓ works offline' : '') : `${v.name} (not available — ${v.reason})`;
      return `<option value="${v.code}" ${v.available ? '' : 'disabled'}>${label}</option>`;
    }).join('');
    sel.value = 'kjv';
  });

// Long passages (a whole chapter, or a verse range) are split into several
// readable slides, navigated with the arrow keys — instead of shrinking
// everything to fit one unreadable screen.
var scriptureChunks = [];
let scriptureChunkIndex = -1;
const SCRIPTURE_CHUNK_CHARS = 330;

function buildScriptureChunks(ref, data) {
  const single = [{ reference: data.reference, text: data.text }];
  if (!Array.isArray(data.verses) || data.verses.length < 2) return single;
  const m = ref.match(/^(.+?)\s+(\d+)\s*(?::|$)/);
  const base = m ? m[1].replace(/\s+/g, ' ').trim() + ' ' + m[2] : data.reference;
  const groups = [];
  let cur = [];
  let len = 0;
  data.verses.forEach((v) => {
    if (cur.length && len + v.text.length > SCRIPTURE_CHUNK_CHARS) { groups.push(cur); cur = []; len = 0; }
    cur.push(v);
    len += v.text.length + 1;
  });
  if (cur.length) groups.push(cur);
  if (groups.length === 1) return single;
  return groups.map((g) => ({
    reference: `${base}:${g[0].n}${g.length > 1 ? '-' + g[g.length - 1].n : ''}`,
    text: g.map((v) => (g.length > 1 ? v.n + ' ' : '') + v.text).join(' '),
  }));
}

function stageScriptureChunk() {
  const c = scriptureChunks[scriptureChunkIndex];
  const nextC = scriptureChunks[scriptureChunkIndex + 1];
  stageState({
    type: 'scripture',
    reference: c.reference,
    text: c.text,
    translation: scriptureChunkTranslation,
    background: null,
    next: nextC ? [nextC.reference, nextC.text.slice(0, 140) + (nextC.text.length > 140 ? '…' : '')] : (window.scriptureNextHint || []),
    label: scriptureChunks.length > 1 ? `Part ${scriptureChunkIndex + 1} of ${scriptureChunks.length}` : '',
  });
}
let scriptureChunkTranslation = '';

function stageScriptureResult(ref, data, thenGoLive) {
  currentSongSections = []; scriptureChunks = [];
  currentDeckSlides = [];
  scriptureChunks = buildScriptureChunks(ref, data);
  scriptureChunkIndex = 0;
  scriptureChunkTranslation = data.translation;
  stageScriptureChunk();
  window.scriptureNextHint = [];
  if (thenGoLive) goLive();
  if (window.scrNavFromResult) window.scrNavFromResult(data);
  return scriptureChunks.length;
}

function stageScripture(thenGoLive) {
  const ref = document.getElementById('scripture-input').value.trim();
  if (!ref) return;
  const statusEl = document.getElementById('scripture-status');
  statusEl.textContent = 'Looking up…';
  fetch(scriptureUrl(ref))
    .then((r) => r.json())
    .then((data) => {
      if (data.error) {
        statusEl.textContent = 'Not found: ' + data.error;
        return;
      }
      const parts = stageScriptureResult(ref, data, thenGoLive);
      const extra = parts > 1 ? ` — ${parts} slides, use ← → to move through` : '';
      statusEl.textContent = (thenGoLive ? 'Live: ' : 'Staged: ') + data.reference + (thenGoLive ? '' : ' (click GO LIVE)') + extra;
    })
    .catch((e) => {
      statusEl.textContent = 'Error: ' + e.message;
    });
}

function quickRef(ref, thenGoLive) {
  document.getElementById('scripture-input').value = ref;
  stageScripture(thenGoLive);
}

// ================= Book name type-ahead (EasyWorship-style: type "G" -> Genesis) =================
// Shows suggestions only while the user is still typing the book name itself
// (no digits yet) — once a chapter number appears we assume the book is
// chosen and get out of the way.
const scriptureInputEl = document.getElementById('scripture-input');
const bookSuggestionsEl = document.getElementById('book-suggestions');
let bookSuggestionActive = -1;

function currentBookSuggestions(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return BIBLE_STRUCTURE.filter((b) => b.name.toLowerCase().startsWith(q)).slice(0, 8);
}

function renderBookSuggestions(list) {
  bookSuggestionActive = -1;
  if (list.length === 0) {
    bookSuggestionsEl.classList.remove('open');
    bookSuggestionsEl.innerHTML = '';
    return;
  }
  bookSuggestionsEl.innerHTML = list.map((b, i) => `
    <div class="book-suggestion-item" data-idx="${i}" onclick="pickBookSuggestion('${b.name.replace(/'/g, "\\'")}')">
      <span>${escapeHtmlLocal(b.name)}</span>
      <span class="testament-tag">${b.testament === 'OT' ? 'Old Testament' : 'New Testament'}</span>
    </div>
  `).join('');
  bookSuggestionsEl.classList.add('open');
}

function pickBookSuggestion(bookName) {
  scriptureInputEl.value = bookName + ' ';
  bookSuggestionsEl.classList.remove('open');
  scriptureInputEl.focus();
}

scriptureInputEl.addEventListener('input', () => {
  const val = scriptureInputEl.value;
  // Only stop suggesting once the typed text no longer matches the start of
  // ANY book name — not simply "a digit appeared". Several real book names
  // legitimately start with a digit (1 Samuel, 2 Kings, 1 Thessalonians,
  // 3 John, etc.), so checking for a bare digit broke autocomplete for all
  // of them. Once the operator types past the book name into the chapter
  // number (e.g. "1 Samuel 1"), no book name starts with that text anymore
  // and suggestions correctly disappear on their own.
  const suggestions = currentBookSuggestions(val);
  if (suggestions.length === 0) {
    bookSuggestionsEl.classList.remove('open');
    return;
  }
  renderBookSuggestions(suggestions);
});

scriptureInputEl.addEventListener('keydown', (e) => {
  const items = bookSuggestionsEl.querySelectorAll('.book-suggestion-item');
  if (!bookSuggestionsEl.classList.contains('open') || items.length === 0) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    bookSuggestionActive = Math.min(bookSuggestionActive + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('active', i === bookSuggestionActive));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    bookSuggestionActive = Math.max(bookSuggestionActive - 1, 0);
    items.forEach((el, i) => el.classList.toggle('active', i === bookSuggestionActive));
  } else if (e.key === 'Enter' && bookSuggestionActive >= 0) {
    e.preventDefault();
    e.stopImmediatePropagation(); // picking a book name is not a complete ref — don't also try to stage it
    items[bookSuggestionActive].click();
  } else if (e.key === 'Escape') {
    bookSuggestionsEl.classList.remove('open');
  }
});

document.addEventListener('click', (e) => {
  if (!bookSuggestionsEl.contains(e.target) && e.target !== scriptureInputEl) {
    bookSuggestionsEl.classList.remove('open');
  }
});

// ================= Old/New Testament quick dropdowns =================
// Click "Old Testament ▾" / "New Testament ▾" to drop down the full book
// list for that half of the Bible — an alternative to typing, for anyone
// who'd rather browse than type the first letter.
function renderTestamentDropdown(testament) {
  const el = document.getElementById('testament-dropdown-' + testament);
  const books = BIBLE_STRUCTURE.filter((b) => b.testament === testament);
  el.innerHTML = books.map((b) =>
    `<div class="testament-dropdown-item" onclick="pickTestamentBook('${b.name.replace(/'/g, "\\'")}', '${testament}')">${escapeHtmlLocal(b.name)}</div>`
  ).join('');
}
renderTestamentDropdown('OT');
renderTestamentDropdown('NT');

function toggleTestamentDropdown(testament) {
  const el = document.getElementById('testament-dropdown-' + testament);
  const other = testament === 'OT' ? 'NT' : 'OT';
  document.getElementById('testament-dropdown-' + other).classList.remove('open');
  el.classList.toggle('open');
}

function pickTestamentBook(bookName, testament) {
  scriptureInputEl.value = bookName + ' ';
  document.getElementById('testament-dropdown-' + testament).classList.remove('open');
  scriptureInputEl.focus();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.testament-dropdown-wrap')) {
    document.getElementById('testament-dropdown-OT').classList.remove('open');
    document.getElementById('testament-dropdown-NT').classList.remove('open');
  }
});

// ================= Bible Browser modal (Book -> Chapter -> Verse, click-through) =================
let bibleBrowserBook = null;
let bibleBrowserChapter = null;

function openBibleBrowser() {
  document.getElementById('bible-browser-modal').classList.add('open');
  document.getElementById('bible-browser-search').value = '';
  showBibleBrowserStep('books');
  renderBibleBrowserBookLists('');
  setTimeout(() => document.getElementById('bible-browser-search').focus(), 50);
}

function closeBibleBrowser() {
  document.getElementById('bible-browser-modal').classList.remove('open');
}

function showBibleBrowserStep(step) {
  document.getElementById('bible-browser-step-books').style.display = step === 'books' ? '' : 'none';
  document.getElementById('bible-browser-step-chapters').style.display = step === 'chapters' ? '' : 'none';
  document.getElementById('bible-browser-step-verses').style.display = step === 'verses' ? '' : 'none';
  renderBibleBrowserCrumbs(step);
}

function renderBibleBrowserCrumbs(step) {
  const el = document.getElementById('bible-browser-crumbs');
  if (step === 'books') {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  let html = `<span onclick="showBibleBrowserStep('books')">Books</span>`;
  if (step === 'chapters' || step === 'verses') html += ` › ${bibleBrowserBook}`;
  if (step === 'verses') html += ` <span onclick="backToBibleChapters()">› Chapter ${bibleBrowserChapter}</span>`;
  el.innerHTML = html;
}

function backToBibleChapters() {
  showBibleBrowserStep('chapters');
}

function renderBibleBrowserBookLists(filter) {
  const q = filter.trim().toLowerCase();
  const matches = (testament) => BIBLE_STRUCTURE.filter((b) =>
    b.testament === testament && (!q || b.name.toLowerCase().includes(q))
  );
  const renderList = (books) => books.map((b) =>
    `<div class="bible-book-item" onclick="selectBibleBrowserBook('${b.name.replace(/'/g, "\\'")}')">${escapeHtmlLocal(b.name)}</div>`
  ).join('') || '<p style="color:#666; font-size:12px;">No matching books.</p>';
  document.getElementById('bible-books-ot').innerHTML = renderList(matches('OT'));
  document.getElementById('bible-books-nt').innerHTML = renderList(matches('NT'));
}

document.getElementById('bible-browser-search').addEventListener('input', (e) => {
  renderBibleBrowserBookLists(e.target.value);
});

function selectBibleBrowserBook(bookName) {
  bibleBrowserBook = bookName;
  const book = BIBLE_STRUCTURE.find((b) => b.name === bookName);
  if (!book) return;
  document.getElementById('bible-browser-title').textContent = bookName + ' — choose a chapter';
  document.getElementById('bible-chapter-grid').innerHTML = book.chapters.map((_, i) =>
    `<div class="bible-number-btn" onclick="selectBibleBrowserChapter(${i + 1})">${i + 1}</div>`
  ).join('');
  showBibleBrowserStep('chapters');
}

function selectBibleBrowserChapter(num) {
  bibleBrowserChapter = num;
  const book = BIBLE_STRUCTURE.find((b) => b.name === bibleBrowserBook);
  if (!book) return;
  const verseCount = book.chapters[num - 1];
  document.getElementById('bible-browser-title').textContent = `${bibleBrowserBook} ${num} — choose a verse`;
  document.getElementById('bible-verse-grid').innerHTML = Array.from({ length: verseCount }, (_, i) =>
    `<div class="bible-number-btn" onclick="selectBibleBrowserVerse(${i + 1})" ondblclick="selectBibleBrowserVerse(${i + 1}, true)">${i + 1}</div>`
  ).join('');
  showBibleBrowserStep('verses');
}

function selectBibleBrowserVerse(num, thenGoLive) {
  const ref = `${bibleBrowserBook} ${bibleBrowserChapter}:${num}`;
  scriptureInputEl.value = ref;
  stageScripture(thenGoLive);
  closeBibleBrowser();
}

// ================= Free Text (type-and-go-live, no presentation needed) =================
function stageFreeText(thenGoLive) {
  const text = document.getElementById('free-text-input').value.trim();
  if (!text) return;
  currentSongSections = []; scriptureChunks = [];
  stageState({ type: 'free-text', text, background: null });
  if (thenGoLive) goLive();
}

function addFreeTextToSchedule() {
  const text = document.getElementById('free-text-input').value.trim();
  if (!text) return;
  pushScheduleItem({
    displayTitle: '✍ ' + (text.length > 40 ? text.slice(0, 40) + '…' : text),
    stateType: 'free-text',
    text,
  });
}

function saveFreeText() {
  const text = document.getElementById('free-text-input').value.trim();
  if (!text) {
    alert('Type something first, then Save.');
    return;
  }
  fetch('/api/free-texts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
    .then((r) => r.json())
    .then(() => loadFreeTextsList());
}

function loadFreeTextsList() {
  fetch('/api/free-texts')
    .then((r) => r.json())
    .then((data) => renderFreeTextsList(data.items || []));
}
loadFreeTextsList();

function renderFreeTextsList(list) {
  const container = document.getElementById('free-texts-list');
  if (list.length === 0) {
    container.innerHTML = '<p style="color:#666; font-size:11px; margin:0;">No saved texts yet — type one above and click "+ Save" to reuse it every service.</p>';
    return;
  }
  container.innerHTML = list.map((item) => `
    <span class="announcement-chip" onclick="loadFreeTextIntoBox('${item.id}')" title="Click to load into the box above">
      ${escapeHtmlLocal(item.text.slice(0, 28))}${item.text.length > 28 ? '…' : ''}
      <span onclick="event.stopPropagation(); deleteFreeText('${item.id}')" style="margin-left:6px; color:#a3303c;">✕</span>
    </span>
  `).join('');
  window._freeTextsCache = list;
}

function loadFreeTextIntoBox(id) {
  const item = (window._freeTextsCache || []).find((a) => a.id === id);
  if (!item) return;
  document.getElementById('free-text-input').value = item.text;
}

function deleteFreeText(id) {
  fetch('/api/free-texts/' + id, { method: 'DELETE' }).then(() => loadFreeTextsList());
}

function clearStage() {
  socket.emit('clear');
  document.querySelectorAll('.slide-item, .song-item').forEach((el) => el.classList.remove('active'));
}

async function openDisplay() {
  // Desktop app: the shell puts the projector on the second screen itself.
  if (window.desktop) {
    const r = await window.desktop.openProjector();
    if (window.toast) window.toast(r.already ? 'Projector is already open.' : r.onSecondScreen ? 'Projector opened on the second screen.' : 'Only one screen found — projector opened in a window. Connect the projector, then press F5 to move it.', 'ok');
    return;
  }
  // Modern Chrome/Edge: ask which monitors are connected, then open the
  // projection screen positioned exactly on the non-primary one and
  // full-screened automatically — no manual dragging needed. Race against
  // a timeout so a slow/ignored permission prompt can't leave the click
  // looking like it did nothing.
  // "menubar=no,toolbar=no,location=no,status=no" strips the browser's own
  // chrome from the popup immediately (no address bar / tabs / toolbar) —
  // even before fullscreen succeeds, nothing but the stage is visible.
  if (window.isSecureContext && 'getScreenDetails' in window) {
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('screen-details-timeout')), 4000)
      );
      const details = await Promise.race([window.getScreenDetails(), timeout]);
      const target = details.screens.find((s) => s !== details.currentScreen) || details.currentScreen;
      const features =
        `left=${target.availLeft},top=${target.availTop},` +
        `width=${target.availWidth},height=${target.availHeight},` +
        `menubar=no,toolbar=no,location=no,status=no,scrollbars=no`;
      window.open('/display?launch=1', '_blank', features);
      return;
    } catch (e) {
      console.warn('Screen placement unavailable, falling back:', e);
    }
  }
  // Fallback (Firefox/Safari, permission declined, or the prompt was
  // ignored): open a chrome-less window and tell the operator to do the
  // one-time drag + fullscreen themselves (display.js also shows a
  // same-window "tap to fullscreen" button so one click is all it takes).
  window.open('/display', '_blank', 'menubar=no,toolbar=no,location=no,status=no,scrollbars=no');
  alert(
    'Drag this new window onto the projector screen, then click the ' +
    '"Enter Fullscreen" button that appears on it (or press F11). ' +
    'You only need to do this once per service.'
  );
}

// Pressing Enter stages the reference; pressing Enter again with the exact
// same text already staged sends it straight to Live — a fast "type once,
// hit Enter twice" workflow without needing to reach for the mouse.
let lastEnterStagedRef = null;
document.getElementById('scripture-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  // If a book-name suggestion dropdown is open, that handler (registered
  // above) already consumes this Enter to pick the suggestion — don't also
  // try to stage/go-live on the same keypress.
  if (bookSuggestionsEl.classList.contains('open') && bookSuggestionActive >= 0) return;
  e.stopPropagation();
  const val = scriptureInputEl.value.trim();
  if (val && val === lastEnterStagedRef) {
    goLive();
  } else {
    stageScripture();
    lastEnterStagedRef = val;
  }
});
scriptureInputEl.addEventListener('input', () => { lastEnterStagedRef = null; });

// ================= Schedule (service run-list, persisted server-side) =================
let schedule = [];

function reloadSchedule() {
  return fetch('/api/schedule')
    .then((r) => r.json())
    .then((data) => { schedule = data.items || []; renderSchedule(); })
    .catch(() => {});
}
reloadSchedule();

function renderSchedule() {
  const container = document.getElementById('schedule-list');
  if (schedule.length === 0) {
    container.innerHTML = '<p style="color:#666; font-size:12px; margin:0;">Empty — click "+ Sched" on a song, scripture, or media item to build your service order.</p>';
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
        <span onclick="event.stopPropagation(); removeScheduleItem('${item.id}')">✕</span>
      </span>`;
    div.onclick = () => loadScheduleItem(item);
    div.ondblclick = () => loadScheduleItem(item, true); // double-click: stage and go live in one motion
    div.title = 'Click to stage · double-click to go live instantly';
    container.appendChild(div);
  });
}

function pushScheduleItem(payload) {
  return fetch('/api/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json())
    .then((item) => { schedule.push(item); renderSchedule(); return item; });
}

function addSongSlideToSchedule(songId, sectionIdx) {
  const song = activeSong && activeSong.id === songId ? activeSong : null;
  if (!song) return;
  const section = song.sections[sectionIdx];
  pushScheduleItem({
    displayTitle: `${song.title} — ${section.label}`,
    stateType: 'song',
    state: sectionToState(song, section),
  });
}

// Adds the ENTIRE song (all its verses/chorus) to the schedule as one row —
// clicking it in the schedule loads the full slide list ready to click through,
// rather than forcing the operator to add each verse one at a time.
function addWholeSongToSchedule(songId) {
  const song = songs.find((s) => s.id === songId);
  if (!song) return;
  const label = song.hymnNumber ? `${song.title} (#${song.hymnNumber})` : song.title;
  pushScheduleItem({
    displayTitle: label + (song.artist ? ' — ' + song.artist : ''),
    stateType: 'whole-song',
    songId: song.id,
  });
}

function addScriptureToSchedule() {
  const ref = document.getElementById('scripture-input').value.trim();
  if (!ref) return;
  pushScheduleItem({ displayTitle: 'Scripture: ' + ref, stateType: 'scripture-ref', ref });
}

// Adds a single image or video media item to the schedule.
function addMediaToSchedule(item) {
  return pushScheduleItem({
    displayTitle: (item.kind === 'image' ? '🖼 ' : '🎬 ') + item.title,
    stateType: item.kind === 'image' ? 'media-image' : 'media-video',
    url: item.url,
  });
}

// Adds a whole PowerPoint deck to the schedule as one row — clicking it loads
// every slide into the Slides panel for click-through, same pattern as
// "whole-song" above.
function addDeckToSchedule(item) {
  return pushScheduleItem({
    displayTitle: `📊 ${item.title} (${item.slideCount} slides)`,
    stateType: 'media-deck',
    deckId: item.id,
  });
}

function loadScheduleItem(item, thenGoLive) {
  if (item.stateType === 'song') {
    currentSongSections = []; scriptureChunks = [];
    currentDeckSlides = [];
    stageState(item.state);
    if (thenGoLive) goLive();
  } else if (item.stateType === 'whole-song') {
    // Load the whole song into the Slides panel (same as clicking it in the
    // library) and auto-stage its first slide so the operator can start
    // clicking through or just hit GO LIVE right away.
    currentDeckSlides = [];
    document.querySelectorAll('.schedule-item').forEach((el) => el.classList.remove('active'));
    selectSong({ id: item.songId });
    const waitForLoad = setInterval(() => {
      if (activeSong && activeSong.id === item.songId && currentSongSections.length > 0) {
        clearInterval(waitForLoad);
        currentSectionIndex = 0;
        highlightActiveSlide();
        stageState(sectionToState(activeSong, currentSongSections[0]));
        if (thenGoLive) goLive();
      }
    }, 100);
    setTimeout(() => clearInterval(waitForLoad), 5000); // safety timeout
  } else if (item.stateType === 'scripture-ref') {
    const statusEl = document.getElementById('scripture-status');
    statusEl.textContent = 'Looking up… ' + item.ref;
    fetch(scriptureUrl(item.ref))
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          statusEl.textContent = 'Not found: ' + item.ref;
          return;
        }
        statusEl.textContent = 'Staged: ' + data.reference;
        stageScriptureResult(item.ref, data, thenGoLive);
      });
  } else if (item.stateType === 'media-image') {
    currentSongSections = []; scriptureChunks = [];
    currentDeckSlides = [];
    stageState({ type: 'image', url: item.url });
    if (thenGoLive) goLive();
  } else if (item.stateType === 'free-text') {
    currentSongSections = []; scriptureChunks = [];
    currentDeckSlides = [];
    document.getElementById('free-text-input').value = item.text || '';
    stageState({ type: 'free-text', text: item.text, background: null });
    if (thenGoLive) goLive();
  } else if (item.stateType === 'media-video') {
    currentSongSections = []; scriptureChunks = [];
    currentDeckSlides = [];
    stageState({ type: 'video', url: item.url });
    if (thenGoLive) goLive();
  } else if (item.stateType === 'media-deck') {
    currentSongSections = []; scriptureChunks = [];
    document.querySelectorAll('.schedule-item').forEach((el) => el.classList.remove('active'));
    loadDeckIntoSlidePanel(item.deckId, thenGoLive);
  }
}

function moveScheduleItem(idx, dir) {
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= schedule.length) return;
  [schedule[idx], schedule[newIdx]] = [schedule[newIdx], schedule[idx]];
  renderSchedule();
  fetch('/api/schedule/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: schedule.map((s) => s.id) }),
  });
}

function removeScheduleItem(id) {
  schedule = schedule.filter((s) => s.id !== id);
  renderSchedule();
  fetch('/api/schedule/' + id, { method: 'DELETE' });
}

function clearSchedule() {
  if (!confirm('Clear the whole schedule?')) return;
  schedule = [];
  renderSchedule();
  fetch('/api/schedule', { method: 'DELETE' });
}

// ================= Media library (images, video, PowerPoint decks) =================
let currentDeckSlides = [];
let currentDeckIndex = -1;

document.getElementById('media-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-media-tab]');
  if (!btn) return;
  document.querySelectorAll('#media-tabs .song-tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  ['image', 'video', 'pptx', 'deck'].forEach((tab) => {
    document.getElementById('media-tab-' + tab).style.display = tab === btn.dataset.mediaTab ? 'block' : 'none';
  });
});

function setMediaStatus(text) {
  document.getElementById('media-status').textContent = text;
}

function uploadMediaImage() {
  const fileInput = document.getElementById('media-image-file');
  const file = fileInput.files[0];
  if (!file) { alert('Choose an image file first.'); return; }
  const title = document.getElementById('media-image-title').value.trim();
  const formData = new FormData();
  formData.append('file', file);
  if (title) formData.append('title', title);
  setMediaStatus('Uploading…');
  fetch('/api/media/image', { method: 'POST', body: formData })
    .then((r) => r.json())
    .then((data) => {
      if (data.error) { setMediaStatus('Failed: ' + data.error); return; }
      setMediaStatus('Uploaded "' + data.title + '".');
      fileInput.value = '';
      document.getElementById('media-image-title').value = '';
      reloadMediaLibrary();
    })
    .catch((e) => setMediaStatus('Upload failed: ' + e.message));
}

function uploadMediaVideo() {
  const fileInput = document.getElementById('media-video-file');
  const file = fileInput.files[0];
  const url = document.getElementById('media-video-url').value.trim();
  const title = document.getElementById('media-video-title').value.trim();
  if (!file && !url) { alert('Choose a video file or paste a video link.'); return; }
  const formData = new FormData();
  if (file) formData.append('file', file);
  if (url) formData.append('url', url);
  if (title) formData.append('title', title);
  setMediaStatus('Adding video…');
  fetch('/api/media/video', { method: 'POST', body: formData })
    .then((r) => r.json())
    .then((data) => {
      if (data.error) { setMediaStatus('Failed: ' + data.error); return; }
      setMediaStatus('Added "' + data.title + '".');
      fileInput.value = '';
      document.getElementById('media-video-url').value = '';
      document.getElementById('media-video-title').value = '';
      reloadMediaLibrary();
    })
    .catch((e) => setMediaStatus('Failed: ' + e.message));
}

function uploadMediaPptx() {
  const fileInput = document.getElementById('media-pptx-file');
  const file = fileInput.files[0];
  if (!file) { alert('Choose a .ppt or .pptx file first.'); return; }
  const title = document.getElementById('media-pptx-title').value.trim();
  const formData = new FormData();
  formData.append('file', file);
  if (title) formData.append('title', title);
  setMediaStatus('Uploading and converting slides — this can take a little while…');
  fetch('/api/media/pptx', { method: 'POST', body: formData })
    .then((r) => r.json())
    .then((data) => {
      if (data.error) { setMediaStatus('Failed: ' + data.error); return; }
      setMediaStatus(`Converted "${data.title}" — ${data.slideCount} slides. Added to schedule.`);
      fileInput.value = '';
      document.getElementById('media-pptx-title').value = '';
      reloadMediaLibrary();
      addDeckToSchedule(data); // the whole point of "upload this for the schedule" — one step, not two
    })
    .catch((e) => setMediaStatus('Failed: ' + e.message));
}

// Several pictures -> one deck, in natural file-name order (slide2 before slide10).
function uploadMediaDeckImages() {
  const input = document.getElementById('media-deck-files');
  const files = [...input.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) { alert('Choose the slide pictures first.'); return; }
  const title = document.getElementById('media-deck-title').value.trim() || 'Deck of ' + files.length + ' slides';
  const formData = new FormData();
  formData.append('title', title);
  files.forEach((f) => formData.append('files', f));
  setMediaStatus(`Uploading ${files.length} slides…`);
  fetch('/api/media/deck/import', { method: 'POST', body: formData })
    .then((r) => r.json())
    .then((data) => {
      if (data.error) { setMediaStatus('Failed: ' + data.error); return; }
      setMediaStatus(`Created "${data.title}" — ${data.slideCount} slides. Added to schedule.`);
      input.value = '';
      document.getElementById('media-deck-title').value = '';
      reloadMediaLibrary();
      addDeckToSchedule(data);
    })
    .catch((e) => setMediaStatus('Failed: ' + e.message));
}

function reloadMediaLibrary() {
  return fetch('/api/media')
    .then((r) => r.json())
    .then((data) => renderMediaLibrary(data.items || []));
}
reloadMediaLibrary();

function renderMediaLibrary(items) {
  const container = document.getElementById('media-library');
  if (items.length === 0) {
    container.innerHTML = '<p style="color:#666; font-size:11px; margin:0;">No media uploaded yet.</p>';
    return;
  }
  const ICON = { image: '🖼', video: '🎬', deck: '📊' };
  container.innerHTML = items.map((item) => `
    <div style="display:flex; align-items:center; justify-content:space-between; background:#0b0b1a; border:1px solid #2a2a44; border-radius:6px; padding:6px 8px; font-size:12px;">
      <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${ICON[item.kind] || ''} ${escapeHtmlLocal(item.title || 'Untitled')}${item.kind === 'deck' ? ` (${item.slideCount} slides)` : ''}</span>
      <span style="display:flex; gap:6px; flex-shrink:0; margin-left:8px;">
        <span onclick='mediaLibAction("${item.id}", "sched")' class="song-sched-btn" title="Add to schedule">+ Sched</span>
        <span onclick='mediaLibAction("${item.id}", "del")' style="color:#a3303c; font-size:12px; cursor:pointer;" title="Delete">✕</span>
      </span>
    </div>
  `).join('');
  window._mediaLibItems = items;
}

function mediaLibAction(id, action) {
  const item = (window._mediaLibItems || []).find((i) => i.id === id);
  if (!item) return;
  if (action === 'sched') {
    if (item.kind === 'deck') addDeckToSchedule(item);
    else addMediaToSchedule(item);
  } else if (action === 'del') {
    if (!confirm('Delete "' + item.title + '" from the media library?')) return;
    fetch('/api/media/' + id, { method: 'DELETE' }).then(() => reloadMediaLibrary());
  }
}

// Loads a PowerPoint deck's slides into the Slides panel for click-through,
// exactly like clicking a song does — Enter/arrow keys and double-click all
// work the same way once a deck is loaded.
function loadDeckIntoSlidePanel(deckId, thenGoLive) {
  const container = document.getElementById('slide-list');
  container.innerHTML = '<p style="color:#666; font-size:13px;">Loading slides…</p>';
  fetch('/api/media/deck/' + deckId)
    .then((r) => r.json())
    .then((data) => {
      if (data.error) {
        container.innerHTML = '<p style="color:#a3303c; font-size:13px;">Could not load this deck.</p>';
        return;
      }
      currentDeckSlides = data.slides;
      currentDeckIndex = 0;
      container.innerHTML = '';
      data.slides.forEach((slide, idx) => {
        const div = document.createElement('div');
        div.className = 'slide-item slide-card';
        div.dataset.title = 'Slide ' + (idx + 1);
        div.innerHTML = `<div class="thumb"><img loading="lazy" alt=""></div><div class="card-meta"><span class="card-num">${idx + 1}</span><span class="slide-label">Slide ${idx + 1} of ${data.slides.length}</span></div>`;
        div.querySelector('img').src = slide.url;
        div.onclick = () => { currentDeckIndex = idx; highlightDeckSlide(); stageState({ type: 'image', url: slide.url }); };
        div.ondblclick = () => { currentDeckIndex = idx; highlightDeckSlide(); stageState({ type: 'image', url: slide.url }); goLive(); };
        div.title = 'Click to stage · double-click to go live instantly';
        container.appendChild(div);
      });
      if (window.showTab) window.showTab('slides');
      highlightDeckSlide();
      stageState({ type: 'image', url: data.slides[0].url });
      if (thenGoLive) goLive();
    })
    .catch(() => { container.innerHTML = '<p style="color:#a3303c; font-size:13px;">Error loading deck.</p>'; });
}

function highlightDeckSlide() {
  document.querySelectorAll('.slide-item').forEach((el, i) => el.classList.toggle('active', i === currentDeckIndex));
}

// ================= Voice Detect (Phase 2) =================
let pendingSuggestion = null;

function projectScriptureByRef(ref) {
  const statusEl = document.getElementById('scripture-status');
  statusEl.textContent = 'Looking up… ' + ref;
  return fetch(scriptureUrl(ref))
    .then((r) => r.json())
    .then((data) => {
      if (data.error) {
        statusEl.textContent = 'Not found: ' + ref;
        return false;
      }
      statusEl.textContent = 'Projected: ' + data.reference;
      if (window.scrNavFromResult) window.scrNavFromResult(data);
      socket.emit('project', withTheme({
        type: 'scripture',
        reference: data.reference,
        text: data.text,
        translation: data.translation,
        background: null,
      }));
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
      return `<span class="preview-slide-chip"><span class="chip-num">${i + 1}</span><span class="chip-label">${escapeHtmlLocal(s.label)}</span><span class="chip-text">${escapeHtmlLocal(firstLine).slice(0, 36)}${firstLine.length > 36 ? '…' : ''}</span></span>`;
    }).join('');
}

function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

let editingSongId = null;

function openAddSongModal() {
  editingSongId = null;
  document.getElementById('add-song-modal-title').textContent = 'Add Your Own Song';
  document.getElementById('add-song-modal').classList.add('open');
  document.getElementById('new-song-title').value = '';
  document.getElementById('new-song-artist').value = '';
  document.getElementById('new-song-lyrics').value = '';
  document.getElementById('add-song-status').textContent = '';
  renderLyricsPreview();
}

// Reverses parseLyricsIntoSections() so an existing song's sections can be
// loaded back into the plain-text textarea for editing.
function sectionsToLyricsText(sections) {
  return sections.map((s) => {
    const isPlainVerseLabel = /^VERSE \d+$/.test(s.label);
    const lines = s.pairs.map((p) => p[0]).join('\n');
    return isPlainVerseLabel ? lines : s.label + '\n' + lines;
  }).join('\n\n');
}

function openEditSongModal(id) {
  fetch('/api/songs/' + id)
    .then((r) => r.json())
    .then((song) => {
      if (song.error) {
        alert('Could not load that song: ' + song.error);
        return;
      }
      editingSongId = id;
      document.getElementById('add-song-modal-title').textContent = 'Edit Song';
      document.getElementById('add-song-modal').classList.add('open');
      document.getElementById('new-song-title').value = song.title || '';
      document.getElementById('new-song-artist').value = song.artist || '';
      document.getElementById('new-song-lyrics').value = sectionsToLyricsText(song.sections || []);
      document.getElementById('add-song-status').textContent = '';
      renderLyricsPreview();
    })
    .catch((e) => alert('Could not load that song: ' + e.message));
}

function closeAddSongModal() {
  document.getElementById('add-song-modal').classList.remove('open');
  editingSongId = null;
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
  const isEditing = !!editingSongId;
  const url = isEditing ? '/api/songs/' + editingSongId : '/api/songs';
  const method = isEditing ? 'PUT' : 'POST';
  fetch(url, {
    method,
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

// ================= Announcements / Scrolling Ticker =================
let tickerActive = false;

function toggleTicker() {
  tickerActive = !tickerActive;
  updateTickerBtn();
  sendTickerUpdate();
}

function updateTickerBtn() {
  const btn = document.getElementById('ticker-toggle-btn');
  btn.textContent = tickerActive ? '■ Stop Scrolling' : '▶ Start Scrolling';
  btn.classList.toggle('danger', tickerActive);
}

function sendTickerUpdate() {
  const text = document.getElementById('ticker-input').value.trim();
  socket.emit('ticker-update', { active: tickerActive && !!text, text });
}

// Update the live ticker text as the operator edits it, without needing to
// stop/restart scrolling (debounced so it doesn't spam on every keystroke).
let tickerEditDebounce = null;
document.getElementById('ticker-input').addEventListener('input', () => {
  if (!tickerActive) return;
  clearTimeout(tickerEditDebounce);
  tickerEditDebounce = setTimeout(sendTickerUpdate, 400);
});

function saveAnnouncement() {
  const text = document.getElementById('ticker-input').value.trim();
  if (!text) {
    alert('Type a message first, then Save.');
    return;
  }
  fetch('/api/announcements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
    .then((r) => r.json())
    .then(() => loadAnnouncementsList());
}

function loadAnnouncementsList() {
  fetch('/api/announcements')
    .then((r) => r.json())
    .then((data) => renderAnnouncementsList(data.announcements || []));
}
loadAnnouncementsList();

function renderAnnouncementsList(list) {
  const container = document.getElementById('announcements-list');
  if (list.length === 0) {
    container.innerHTML = '<p style="color:#666; font-size:11px; margin:0;">No saved announcements yet — type one above and click "+ Save".</p>';
    return;
  }
  container.innerHTML = list.map((a) => `
    <span class="announcement-chip" onclick="loadAnnouncementIntoTicker('${a.id}')" title="Click to load into the ticker box">
      ${escapeHtmlLocal(a.text.slice(0, 28))}${a.text.length > 28 ? '…' : ''}
      <span onclick="event.stopPropagation(); deleteAnnouncement('${a.id}')" style="margin-left:6px; color:#a3303c;">✕</span>
    </span>
  `).join('');
  window._announcementsCache = list;
}

function loadAnnouncementIntoTicker(id) {
  const item = (window._announcementsCache || []).find((a) => a.id === id);
  if (!item) return;
  document.getElementById('ticker-input').value = item.text;
  if (tickerActive) sendTickerUpdate();
}

function deleteAnnouncement(id) {
  fetch('/api/announcements/' + id, { method: 'DELETE' })
    .then((r) => r.json())
    .then(() => loadAnnouncementsList());
}


// ================= Output overlays: Black / Logo / Clear text =================
// Hide the screen instantly WITHOUT losing the live slide — press again to bring
// the same slide straight back. (B / L / C keys, also on the phone remote.)
let currentOverlay = 'none';
function toggleOverlay(mode) {
  socket.emit('overlay', currentOverlay === mode ? 'none' : mode);
}
socket.on('overlay-state', (mode) => {
  currentOverlay = mode || 'none';
  ['black', 'logo', 'clear'].forEach((m) => {
    const b = document.getElementById('ov-' + m);
    if (b) b.classList.toggle('active', currentOverlay === m);
  });
});

// ================= Timer (countdown / stopwatch) & alerts =================
function sendTimer(t) { socket.emit('timer-set', t); }
function timerCommon() {
  return {
    label: document.getElementById('timer-label').value.trim(),
    onDisplay: document.getElementById('timer-on-display').checked,
  };
}
function startTimerAt() {
  const v = document.getElementById('timer-at').value;
  if (!v) { alert('Pick a time first (e.g. when the service starts).'); return; }
  const [h, m] = v.split(':').map(Number);
  const target = new Date();
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
  sendTimer({ active: true, mode: 'down', target: serverNow() + (target.getTime() - Date.now()), ...timerCommon() });
}
function startTimerMinutes() {
  const mins = Math.max(1, Math.min(600, Number(document.getElementById('timer-min').value) || 10));
  sendTimer({ active: true, mode: 'down', target: serverNow() + mins * 60000, ...timerCommon() });
}
function startStopwatch() { sendTimer({ active: true, mode: 'up', target: serverNow(), ...timerCommon() }); }
function stopTimer() { sendTimer({ active: false, target: 0 }); }

let ctlTimer = { active: false };
socket.on('timer-state', (t) => { ctlTimer = t || { active: false }; drawCtlTimer(); });
function drawCtlTimer() {
  const el = document.getElementById('timer-status');
  if (!el) return;
  if (!ctlTimer.active) { el.textContent = 'No timer running'; return; }
  const diff = ctlTimer.mode === 'up' ? serverNow() - ctlTimer.target : ctlTimer.target - serverNow();
  el.textContent = (ctlTimer.mode === 'up' ? 'Stopwatch ' : 'Countdown ') + window.formatClock(Math.max(0, diff)) +
    (ctlTimer.onDisplay ? ' · showing on projector' : ' · stage monitor only');
}
setInterval(drawCtlTimer, 500);

function showAlert() {
  const text = document.getElementById('alert-text').value.trim();
  if (!text) return;
  socket.emit('alert-show', { text, seconds: Number(document.getElementById('alert-sec').value) || 12 });
}
function hideAlert() { socket.emit('alert-show', { text: '' }); }

// ================= Recently shown =================
socket.on('history', (list) => {
  const el = document.getElementById('history-list');
  window._history = list || [];
  if (!window._history.length) return;
  el.innerHTML = '';
  window._history.forEach((h) => {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `<span>${escapeHtmlLocal(h.title)}</span><span style="color:#666">${new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
    div.title = 'Click to stage · double-click to go live';
    div.onclick = () => { currentSongSections = []; scriptureChunks = []; stageState(h.state); };
    div.ondblclick = () => { currentSongSections = []; scriptureChunks = []; stageState(h.state); goLive(); };
    el.appendChild(div);
  });
});

// ================= Text size =================
const fontScaleEl = document.getElementById('font-scale');
let fontScaleDebounce = null;
fontScaleEl.addEventListener('input', () => {
  document.getElementById('font-scale-val').textContent = fontScaleEl.value + '%';
  clearTimeout(fontScaleDebounce);
  fontScaleDebounce = setTimeout(() => socket.emit('settings-update', { fontScale: Number(fontScaleEl.value) / 100 }), 150);
});
socket.on('settings-state', (st) => {
  const pct = Math.round(((st && st.fontScale) || 1) * 100);
  fontScaleEl.value = pct;
  document.getElementById('font-scale-val').textContent = pct + '%';
});

// ================= Phone remote commands =================
socket.on('remote-cmd', (c) => {
  if (c.cmd === 'next') nextSlide();
  else if (c.cmd === 'prev') prevSlide();
  else if (c.cmd === 'golive') goLive();
  else if (c.cmd === 'clear') clearStage();
  else if (c.cmd === 'schedule') {
    const item = schedule.find((s) => s.id === c.id);
    if (item) loadScheduleItem(item, c.live);
  }
});

// ================= Restore from backup =================
document.getElementById('restore-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  file.text().then((txt) => {
    let body;
    try { body = JSON.parse(txt); } catch (x) { alert('That is not a valid backup file.'); return; }
    return fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { alert('Restore failed: ' + d.error); return; }
        alert(`Restored: ${d.added.songs} songs, ${d.added.announcements} announcements, ${d.added.freeTexts} saved texts added (existing data was left untouched).`);
        reloadSongs(); loadAnnouncementsList(); loadFreeTextsList();
      });
  });
});


// ================= Import lyrics (paste or upload text files) =================
function openImportModal() {
  document.getElementById('import-modal').classList.add('open');
  document.getElementById('import-results').innerHTML = '';
  updateImportPreview();
}
function closeImportModal() { document.getElementById('import-modal').classList.remove('open'); }

// "### Title | Artist" starts each song; everything until the next ### is its lyrics.
function parseImportText(raw) {
  const songs = [];
  String(raw || '').replace(/\r/g, '').split(/^###[ \t]*/m).slice(1).forEach((block) => {
    const nl = block.indexOf('\n');
    const head = (nl < 0 ? block : block.slice(0, nl)).trim();
    const lyrics = nl < 0 ? '' : block.slice(nl + 1).trim();
    const [title, ...rest] = head.split('|');
    if (title && title.trim()) songs.push({ title: title.trim(), artist: rest.join('|').trim(), lyrics });
  });
  return songs;
}
function updateImportPreview() {
  const songs = parseImportText(document.getElementById('import-text').value);
  const withLyrics = songs.filter((x) => x.lyrics.length > 0).length;
  document.getElementById('import-preview').textContent = songs.length
    ? `${songs.length} song${songs.length === 1 ? '' : 's'} found (${withLyrics} with lyrics).`
    : 'Nothing to import yet — paste lyrics below or choose .txt files.';
}
document.getElementById('import-text').addEventListener('input', updateImportPreview);

// Each chosen .txt file becomes one song; "Artist - Title.txt" names are split.
document.getElementById('import-files').addEventListener('change', async (e) => {
  const box = document.getElementById('import-text');
  for (const file of [...e.target.files]) {
    const text = await file.text();
    if (/^\s*###/.test(text)) { box.value += (box.value ? '\n\n' : '') + text.trim(); continue; }
    const base = file.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
    const m = base.match(/^(.+?)\s+-\s+(.+)$/);
    const title = m ? m[2] : base;
    const artist = m ? m[1] : '';
    box.value += (box.value ? '\n\n' : '') + `### ${title}${artist ? ' | ' + artist : ''}\n${text.trim()}`;
  }
  e.target.value = '';
  updateImportPreview();
});

function submitImport() {
  const songs = parseImportText(document.getElementById('import-text').value).filter((x) => x.lyrics);
  if (!songs.length) { alert('Nothing to import yet — each song needs a "### Title | Artist" line followed by its lyrics.'); return; }
  const btn = document.getElementById('import-go');
  btn.disabled = true; btn.textContent = 'Importing…';
  fetch('/api/songs/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ songs }) })
    .then((r) => r.json())
    .then((d) => {
      if (d.error) { alert('Import failed: ' + d.error); return; }
      document.getElementById('import-results').innerHTML =
        `<div style="margin:10px 0; font-weight:700; color:var(--text);">${d.created} added · ${d.updated} filled in · ${d.skipped} skipped</div>` +
        d.results.map((r) => `<div class="import-row ${r.result}"><span>${escapeHtmlLocal(r.title)}</span><span>${r.result}${r.reason ? ' — ' + escapeHtmlLocal(r.reason) : ''}</span></div>`).join('');
      if (d.created + d.updated) document.getElementById('import-text').value = '';
      updateImportPreview();
      reloadSongs();
      if (window.toast) window.toast(`Imported: ${d.created} added, ${d.updated} filled in`, 'ok');
    })
    .catch((e) => alert('Import failed: ' + e.message))
    .finally(() => { btn.disabled = false; btn.textContent = 'Import'; });
}
