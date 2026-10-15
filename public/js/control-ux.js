// Control-room UX layer: tabs, toasts, command palette, live bar, schedule
// flow (drag-reorder + auto-advance), typography settings, shortcuts.
// Loaded after control.js and builds on its globals.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (t) => escapeHtmlLocal(t == null ? '' : String(t));

  // ---------------------------------------------------------------- toasts
  function toast(msg, kind) {
    const el = document.createElement('div');
    const k = kind || (/fail|error|could not|not valid|too large|unsupported|incorrect/i.test(msg) ? 'error' : '');
    el.className = 'toast' + (k ? ' ' + k : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 260); }, k === 'error' ? 6000 : 3200);
  }
  window.toast = toast;
  window.alert = (m) => toast(String(m)); // non-blocking: a modal alert() mid-service is a hazard

  // ------------------------------------------------------------------ tabs
  function showTab(name) {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
    try { localStorage.setItem('wp_tab', name); } catch (e) {}
  }
  window.showTab = showTab;
  document.querySelector('.tab-bar').addEventListener('click', (e) => {
    const b = e.target.closest('.tab-btn');
    if (b) showTab(b.dataset.tab);
  });
  document.querySelector('.tab-bar').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const btns = [...document.querySelectorAll('.tab-btn')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.stopPropagation(); // arrows move between tabs here, not between slides
    const n = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
    n.focus(); showTab(n.dataset.tab); e.preventDefault();
  });

  // ------------------------------------------------------------------ menu
  const menu = $('menu'), menuBtn = $('menu-btn');
  const setMenu = (open) => { menu.classList.toggle('open', open); menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false'); };
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); setMenu(!menu.classList.contains('open')); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) setMenu(false); });
  menu.addEventListener('click', () => setMenu(false));

  // ------------------------------------------------------------- shortcuts
  window.openShortcuts = () => $('shortcuts').classList.add('open');
  window.closeShortcuts = () => $('shortcuts').classList.remove('open');
  $('menu-shortcuts').addEventListener('click', openShortcuts);
  $('shortcuts').addEventListener('click', (e) => { if (e.target.id === 'shortcuts') closeShortcuts(); });

  // -------------------------------------------------------------- live bar
  let liveSince = 0, liveType = 'blank', liveTitle = '', overlay = 'none';
  function titleOf(st) {
    if (!st || st.type === 'blank') return '';
    if (st._displayTitle) return st._displayTitle;
    if (st.type === 'scripture') return st.reference + (st.translation ? ' (' + st.translation + ')' : '');
    if (st.type === 'free-text') return (st.text || '').replace(/\s+/g, ' ').slice(0, 60);
    if (st.type === 'image') return 'Image / slide';
    if (st.type === 'video') return 'Video';
    return st.type;
  }
  function drawLiveBar() {
    const bar = $('livebar');
    const hidden = overlay !== 'none';
    let text = liveType === 'blank' ? 'Nothing on screen — standby logo showing' : liveTitle;
    if (overlay === 'black') text = '⬛ SCREEN IS BLACK  ·  ' + (liveType === 'blank' ? 'nothing queued' : 'slide kept: ' + liveTitle);
    else if (overlay === 'logo') text = 'Logo screen showing  ·  slide kept: ' + (liveTitle || '—');
    else if (overlay === 'clear') text = 'Text hidden  ·  ' + liveTitle;
    $('lb-title').textContent = text;
    bar.classList.toggle('is-live', liveType !== 'blank' && !hidden);
    bar.classList.toggle('is-black', overlay === 'black');
    document.title = liveType !== 'blank' && !hidden ? '● ' + liveTitle + ' — Worship Presenter' : 'Worship Presenter — Control Room';
    drawElapsed();
  }
  function drawElapsed() {
    const el = $('lb-elapsed');
    if (liveType === 'blank' || !liveSince) { el.textContent = ''; return; }
    const s = Math.floor((Date.now() - liveSince) / 1000);
    el.textContent = '· on screen ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  setInterval(drawElapsed, 1000);
  function markLiveCards() {
    document.querySelectorAll('#slide-list .slide-card').forEach((c) => {
      c.classList.toggle('is-live', liveType === 'song' && !!liveTitle && c.dataset.title === liveTitle);
    });
  }
  socket.on('live-state', (st) => {
    const t = titleOf(st);
    if (t !== liveTitle || (st && st.type) !== liveType) liveSince = Date.now();
    liveType = (st && st.type) || 'blank';
    liveTitle = t;
    drawLiveBar(); markLiveCards();
  });
  socket.on('overlay-state', (m) => { overlay = m || 'none'; drawLiveBar(); });
  new MutationObserver(markLiveCards).observe($('slide-list'), { childList: true });

  // ------------------------------------------------- schedule: flow + drag
  let currentSchedId = null;
  let fromSchedule = false;

  const origLoadSched = window.loadScheduleItem;
  window.loadScheduleItem = function (item, live) {
    currentSchedId = item.id || null;
    fromSchedule = true;
    try { return origLoadSched(item, live); } finally { fromSchedule = false; paintSchedule(); }
  };
  const origSelectSong = window.selectSong;
  window.selectSong = function (song) { if (!fromSchedule) { currentSchedId = null; paintSchedule(); } return origSelectSong(song); };
  const origStageScripture = window.stageScripture;
  window.stageScripture = function (live) { if (!fromSchedule) { currentSchedId = null; paintSchedule(); } return origStageScripture(live); };
  const origStageFree = window.stageFreeText;
  window.stageFreeText = function (live) { if (!fromSchedule) { currentSchedId = null; paintSchedule(); } return origStageFree(live); };

  const origPush = window.pushScheduleItem;
  window.pushScheduleItem = function (payload) {
    return origPush(payload).then((item) => { toast('Added to schedule: ' + payload.displayTitle, 'ok'); return item; });
  };

  function schedIndex() { return schedule.findIndex((s) => s.id === currentSchedId); }
  function atEnd() {
    if (scriptureChunks.length > 1) return scriptureChunkIndex >= scriptureChunks.length - 1;
    if (currentDeckSlides.length) return currentDeckIndex >= currentDeckSlides.length - 1;
    if (currentSongSections.length) return currentSectionIndex >= currentSongSections.length - 1;
    return true; // single-slide item (scripture verse, text, image)
  }
  function atStart() {
    if (scriptureChunks.length > 1) return scriptureChunkIndex <= 0;
    if (currentDeckSlides.length) return currentDeckIndex <= 0;
    if (currentSongSections.length) return currentSectionIndex <= 0;
    return true;
  }
  function advanceSchedule(dir) {
    const i = schedIndex();
    const next = schedule[i + dir];
    if (!next) { toast(dir > 0 ? 'End of the schedule' : 'Start of the schedule'); return; }
    loadScheduleItem(next, false);
    toast((dir > 0 ? 'Next up: ' : 'Back to: ') + next.displayTitle);
  }
  const origNext = window.nextSlide, origPrev = window.prevSlide;
  window.nextSlide = function () { if (currentSchedId && schedIndex() >= 0 && atEnd()) return advanceSchedule(1); return origNext(); };
  window.prevSlide = function () { if (currentSchedId && schedIndex() >= 0 && atStart()) return advanceSchedule(-1); return origPrev(); };

  function paintSchedule() {
    const idx = schedIndex();
    document.querySelectorAll('#schedule-list .schedule-item').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
      el.classList.toggle('done', idx >= 0 && i < idx);
    });
    const badge = $('sched-badge');
    if (badge) badge.textContent = schedule.length ? String(schedule.length) : '';
  }
  let dragFrom = -1;
  function enhanceSchedule() {
    document.querySelectorAll('#schedule-list .schedule-item').forEach((el, i) => {
      el.draggable = true;
      const grip = document.createElement('span');
      grip.className = 'sched-grip'; grip.textContent = '⋮⋮'; grip.title = 'Drag to reorder';
      el.prepend(grip);
      el.addEventListener('dragstart', (e) => { dragFrom = i; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch (x) {} });
      el.addEventListener('dragend', () => { el.classList.remove('dragging'); document.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before')); });
      el.addEventListener('dragover', (e) => { e.preventDefault(); document.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before')); el.classList.add('drop-before'); });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragFrom < 0 || dragFrom === i) return;
        const [moved] = schedule.splice(dragFrom, 1);
        schedule.splice(i > dragFrom ? i - 1 : i, 0, moved);
        dragFrom = -1;
        renderSchedule();
        fetch('/api/schedule/reorder', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: schedule.map((s) => s.id) }) });
      });
    });
    paintSchedule();
  }
  const origRender = window.renderSchedule;
  window.renderSchedule = function () { origRender(); enhanceSchedule(); };
  enhanceSchedule();

  // -------------------------------------------------- typography settings
  let settings = { fontScale: 1, fontFamily: 'sans', align: 'center', caps: false, shadow: 1, position: 'middle', lineSpacing: 1.32 };
  function sendSettings(patch) { settings = { ...settings, ...patch }; socket.emit('settings-update', patch); }
  socket.on('settings-state', (st) => {
    settings = { ...settings, ...st };
    $('set-font').value = settings.fontFamily;
    $('set-align').value = settings.align;
    $('set-position').value = settings.position;
    $('set-shadow').value = String(settings.shadow);
    $('set-caps').checked = !!settings.caps;
    $('line-spacing').value = Math.round(settings.lineSpacing * 100);
    $('line-spacing-val').textContent = Number(settings.lineSpacing).toFixed(2).replace(/0$/, '');
  });
  $('set-font').addEventListener('change', (e) => sendSettings({ fontFamily: e.target.value }));
  $('set-align').addEventListener('change', (e) => sendSettings({ align: e.target.value }));
  $('set-position').addEventListener('change', (e) => sendSettings({ position: e.target.value }));
  $('set-shadow').addEventListener('change', (e) => sendSettings({ shadow: Number(e.target.value) }));
  $('set-caps').addEventListener('change', (e) => sendSettings({ caps: e.target.checked }));
  let lsDebounce = null;
  $('line-spacing').addEventListener('input', (e) => {
    $('line-spacing-val').textContent = (e.target.value / 100).toFixed(2).replace(/0$/, '');
    clearTimeout(lsDebounce);
    lsDebounce = setTimeout(() => sendSettings({ lineSpacing: e.target.value / 100 }), 150);
  });
  $('lines-per-slide').value = String(linesPerSlide());
  $('lines-per-slide').addEventListener('change', (e) => {
    try { localStorage.setItem('wp_lines_per_slide', e.target.value); } catch (x) {}
    if (activeSong) { toast('Re-splitting the open song…'); selectSong({ id: activeSong.id }); }
  });

  // ------------------------------------------------------ command palette
  const pal = $('palette'), palInput = $('palette-input'), palResults = $('palette-results');
  let palItems = [], palSel = 0, palServerTimer = null, palSeq = 0;
  const SCRIPTURE_RE = /^\s*((?:[1-3]\s*)?[a-z][a-z.]*(?:\s+[a-z.]+)*)\s+(\d{1,3})(?:\s*[: ]\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?)?\s*$/i;

  const ACTIONS = [
    { label: 'Black screen', hint: 'B', run: () => toggleOverlay('black') },
    { label: 'Logo screen', hint: 'L', run: () => toggleOverlay('logo') },
    { label: 'Clear text', hint: 'C', run: () => toggleOverlay('clear') },
    { label: 'Clear everything', hint: 'Esc', run: () => clearStage() },
    { label: 'Open projector screen', hint: '', run: () => openDisplay() },
    { label: 'Open stage monitor', hint: '', run: () => window.open('/stage', '_blank') },
    { label: 'Open phone remote', hint: '', run: () => window.open('/remote', '_blank') },
    { label: 'Countdown 5 minutes', hint: 'timer', run: () => { $('timer-min').value = 5; startTimerMinutes(); } },
    { label: 'Countdown 10 minutes', hint: 'timer', run: () => { $('timer-min').value = 10; startTimerMinutes(); } },
    { label: 'Stop timer', hint: 'timer', run: () => stopTimer() },
    { label: 'Go to Schedule', hint: 'tab', run: () => showTab('schedule') },
    { label: 'Go to Scripture', hint: 'tab', run: () => { showTab('scripture'); setTimeout(() => $('scripture-input').focus(), 30); } },
    { label: 'Go to Media', hint: 'tab', run: () => showTab('media') },
    { label: 'Go to Text & Ticker', hint: 'tab', run: () => showTab('text') },
    { label: 'Go to Tools', hint: 'tab', run: () => showTab('tools') },
    { label: 'Keyboard shortcuts', hint: '?', run: () => openShortcuts() },
    { label: 'Download backup', hint: '', run: () => { location.href = '/api/backup'; } },
    { label: 'Sign out', hint: '', run: () => signOut() },
  ];

  function openPalette() { pal.classList.add('open'); palInput.value = ''; buildPalette(''); palInput.focus(); setTimeout(() => palInput.focus(), 30); }
  function closePalette() { pal.classList.remove('open'); }
  window.openPalette = openPalette;
  $('palette-open').addEventListener('click', openPalette);
  pal.addEventListener('mousedown', (e) => { if (e.target === pal) closePalette(); });

  function songMatches(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return allSongsIndex.filter((s) => {
      const hay = (s.title + ' ' + (s.artist || '') + ' ' + (s.hymnNumber || '')).toLowerCase();
      return words.every((w) => hay.includes(w));
    }).slice(0, 8);
  }

  function buildPalette(q, serverSongs) {
    const items = [];
    const m = q.match(SCRIPTURE_RE);
    if (m) {
      const ref = m[1].trim() + ' ' + m[2] + (m[3] ? ':' + m[3] + (m[4] ? '-' + m[4] : '') : '');
      items.push({ group: 'Scripture', main: 'Show ' + ref, sub: 'Enter = stage · Shift+Enter = live', run: (live) => { $('scripture-input').value = ref; stageScripture(live); } });
    }
    const srv = new Map((serverSongs || []).map((s) => [s.id, s]));
    const local = songMatches(q).map((s) => ({ ...s, snippet: srv.get(s.id) && srv.get(s.id).snippet }));
    const seen = new Set(local.map((s) => s.id));
    const lyric = (serverSongs || []).filter((s) => !seen.has(s.id)).slice(0, 6);
    local.concat(lyric).forEach((s, i) => items.push({
      group: i < local.length ? 'Songs' : 'Songs (found in lyrics)',
      main: (s.hymnNumber ? '#' + s.hymnNumber + '  ' : '') + s.title + (s.hasLyrics === false ? '  · no lyrics yet' : ''),
      sub: s.snippet ? '“' + s.snippet.text.slice(0, 70) + '”' : (s.artist || ''),
      run: (live) => { if (live) loadScheduleItem({ id: null, stateType: 'whole-song', songId: s.id }, true); else { selectSong(s); } },
    }));
    const ql = q.toLowerCase();
    schedule.filter((s) => ql && s.displayTitle.toLowerCase().includes(ql)).slice(0, 5).forEach((s) => items.push({
      group: 'Schedule', main: s.displayTitle, sub: 'in today\'s schedule', run: (live) => { showTab('schedule'); loadScheduleItem(s, live); },
    }));
    ACTIONS.filter((a) => !ql || a.label.toLowerCase().includes(ql)).slice(0, ql ? 6 : 8).forEach((a) => items.push({ group: 'Actions', main: a.label, sub: a.hint, run: a.run }));
    palItems = items; palSel = 0; renderPalette(q);
  }

  function renderPalette(q) {
    if (!palItems.length) { palResults.innerHTML = '<div class="pal-empty">No matches' + (q ? ' for “' + esc(q) + '”' : '') + '</div>'; return; }
    let html = '', last = '';
    palItems.forEach((it, i) => {
      if (it.group !== last) { html += `<div class="pal-group">${esc(it.group)}</div>`; last = it.group; }
      html += `<div class="pal-item${i === palSel ? ' sel' : ''}" role="option" data-i="${i}"><span class="pal-main">${esc(it.main)}</span><span class="pal-sub">${esc(it.sub)}</span></div>`;
    });
    palResults.innerHTML = html;
    const sel = palResults.querySelector('.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function runPalette(i, live) {
    const it = palItems[i];
    if (!it) return;
    closePalette();
    try { it.run(live); } catch (e) { toast('Could not do that: ' + e.message); }
  }
  palInput.addEventListener('input', () => {
    const q = palInput.value;
    buildPalette(q);
    clearTimeout(palServerTimer);
    if (q.trim().length >= 3) {
      const seq = ++palSeq;
      palServerTimer = setTimeout(() => {
        fetch('/api/songs?q=' + encodeURIComponent(q.trim())).then((r) => r.json()).then((d) => {
          if (seq === palSeq && palInput.value === q) buildPalette(q, d.songs);
        }).catch(() => {});
      }, 280);
    }
  });
  palInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { palSel = Math.min(palSel + 1, palItems.length - 1); renderPalette(palInput.value); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { palSel = Math.max(palSel - 1, 0); renderPalette(palInput.value); e.preventDefault(); }
    else if (e.key === 'Enter') { runPalette(palSel, e.shiftKey); e.preventDefault(); }
    else if (e.key === 'Escape') { closePalette(); e.preventDefault(); }
    e.stopPropagation(); // never let typing in the palette trigger show shortcuts
  });
  palResults.addEventListener('click', (e) => { const it = e.target.closest('.pal-item'); if (it) runPalette(Number(it.dataset.i), e.shiftKey); });

  // ------------------------------------------------------- global shortcuts
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (e.key === 'Escape') {
      if ($('shortcuts').classList.contains('open')) { closeShortcuts(); e.stopImmediatePropagation(); return; }
      if (menu.classList.contains('open')) { setMenu(false); e.stopImmediatePropagation(); return; }
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); openPalette(); }
    else if (e.key === '?') { e.preventDefault(); openShortcuts(); }
    else if ((e.key === ']' || e.key === '[') && window.scrNav && scrNav.active()) { e.preventDefault(); scrNav.step(e.key === ']' ? 1 : -1); }
    else if ((e.key === '}' || e.key === '{') && window.scrNav && scrNav.active()) { e.preventDefault(); scrNav.chapter(e.key === '}' ? 1 : -1); }
    else if (/^[1-9]$/.test(e.key)) {
      const card = document.querySelectorAll('#slide-list .slide-card')[Number(e.key) - 1];
      if (card) { card.click(); card.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
    }
  }, true);

  // restore the last used tab
  try { const t = localStorage.getItem('wp_tab'); if (t && $('tab-' + t)) showTab(t); } catch (e) {}
  drawLiveBar();
})();
