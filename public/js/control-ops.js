// Operations helpers for the control room: projector connection status, service
// mode lock, simple mode, backup reminder, activity log and the quick-start guide.
(function () {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  const say = (m) => { if (window.toast) window.toast(m); };

  // ---------------------------------------------------- projector connection
  const chip = $('out-chip');
  socket.on('outputs', (o) => {
    chip.hidden = false;
    if (o.projectors > 0) {
      chip.className = 'out-chip ok';
      chip.textContent = '🖥 Projector ✓' + (o.projectors > 1 ? ' ×' + o.projectors : '');
      chip.title = o.projectors + ' projector screen(s) and ' + o.stages + ' stage monitor(s) connected';
    } else {
      chip.className = 'out-chip warn';
      chip.textContent = '⚠ No projector';
      chip.title = 'Nothing is showing the church screen. Click "Open Projector" and put that window on the projector.';
    }
  });

  // ------------------------------------------------------------ service mode
  const lockBtn = $('lock-btn');
  const LOCKED_PANES = ['tab-media', 'tpl-box'];
  function applyLock(on) {
    document.body.classList.toggle('service-locked', on);
    LOCKED_PANES.forEach((id) => { const el = $(id); if (el) { if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); } });
    document.querySelectorAll('.add-song-row, .sched-controls, .settings-grid, [onclick*="clearSchedule"]').forEach((el) => { if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); });
    lockBtn.textContent = on ? '🔒 Locked' : '🔓 Lock';
    lockBtn.classList.toggle('danger', on);
    let banner = $('lock-banner');
    if (on && !banner) {
      banner = document.createElement('div');
      banner.id = 'lock-banner';
      banner.textContent = 'Service mode: display settings, media, templates and song/schedule editing are locked. Slides, Go Live, Back, Black, Clear, timer, alerts and Voice Detect still work.';
      $('livebar').insertAdjacentElement('afterend', banner);
    } else if (!on && banner) banner.remove();
    store.set('wp_service_lock', on ? '1' : '0');
  }
  lockBtn.addEventListener('click', () => {
    const on = !document.body.classList.contains('service-locked');
    if (!on && !confirm('Unlock settings and editing?')) return;
    applyLock(on);
    say(on ? 'Service mode on — editing is locked' : 'Service mode off');
  });
  // re-apply after the schedule list re-renders (new rows must stay locked)
  const origRender = window.renderSchedule;
  window.renderSchedule = function () { origRender(); if (document.body.classList.contains('service-locked')) applyLock(true); };
  if (store.get('wp_service_lock') === '1') applyLock(true);

  // ------------------------------------------------------------- simple mode
  function applySimple(on) {
    document.body.classList.toggle('simple-mode', on);
    $('simple-state').textContent = on ? 'on' : 'off';
    store.set('wp_simple', on ? '1' : '0');
    const active = document.querySelector('.tab-btn[aria-selected="true"]');
    if (on && active && /^(media|tools)$/.test(active.dataset.tab)) { const first = document.querySelector('.tab-btn'); if (first) first.click(); }
  }
  $('menu-simple').addEventListener('click', () => { applySimple(!document.body.classList.contains('simple-mode')); say('Simple mode ' + ($('simple-state').textContent)); });
  if (store.get('wp_simple') === '1') applySimple(true);

  // --------------------------------------------------------- backup reminder
  function ageText(ts) {
    const d = Math.floor((Date.now() - ts) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
  }
  function drawBackupAge() {
    const ts = Number(store.get('wp_last_backup')) || 0;
    $('backup-age').textContent = ts ? '(last: ' + ageText(ts) + ')' : '(never)';
  }
  $('menu-backup').addEventListener('click', () => { store.set('wp_last_backup', String(Date.now())); setTimeout(drawBackupAge, 300); });
  drawBackupAge();
  (function nudge() {
    const last = Number(store.get('wp_last_backup')) || 0;
    const shown = Number(store.get('wp_backup_nudge')) || 0;
    if (Date.now() - shown < 86400000) return;
    if (last && Date.now() - last < 7 * 86400000) return;
    setTimeout(() => {
      say(last ? 'It has been ' + ageText(last).replace(' ago', '') + ' since your last backup — menu ⋯ ▸ Download backup' : 'Tip: download a backup of your songs and schedule (menu ⋯ ▸ Download backup)');
      store.set('wp_backup_nudge', String(Date.now()));
    }, 4000);
  })();

  // ------------------------------------------------------------ activity log
  const list = $('activity-list');
  const fmt = (a) => `<div class="act-row"><span class="act-time">${new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><span class="act-who">${esc(a.who)}</span><span class="act-text">${esc(a.text)}</span></div>`;
  const esc = (t) => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };
  function loadActivity() {
    fetch('/api/activity').then((r) => r.json()).then((d) => {
      const items = (d.items || []).slice().reverse();
      list.innerHTML = items.length ? items.slice(0, 60).map(fmt).join('') : '<p style="color:#666; font-size:11px; margin:0;">Nothing yet.</p>';
    }).catch(() => {});
  }
  socket.on('activity-entry', (a) => {
    if (list.querySelector('p')) list.innerHTML = '';
    list.insertAdjacentHTML('afterbegin', fmt(a));
    while (list.children.length > 60) list.removeChild(list.lastChild);
  });
  loadActivity();

  // --------------------------------------------------------- quick start guide
  const STEPS = [
    ['1 · Find your song', 'Type in the search box (top) or on the left — a title, a hymn number, or even words from the lyrics. Press Ctrl+K to search everything.'],
    ['2 · Stage, then go live', 'Click a slide to stage it in Preview. Check it, then press GO LIVE. Double-click a slide to put it live straight away.'],
    ['3 · Scripture', 'Open the Scripture tab, type a reference like "John 3:16", then use ◀ ▶ or click verses to move around the chapter.'],
    ['4 · Fix mistakes fast', '↩ Back (or Ctrl+Z) puts the previous slide back, even after Clear all. B = black screen, L = logo, C = hide text, Esc = clear.'],
    ['5 · Get the screens right', 'Use "Open Projector" for the church screen — the green chip at the top shows it is connected. Open the Phone remote from the ⋯ menu for a volunteer\'s phone.'],
    ['6 · During the service', 'Turn on Service mode (top right) so settings and editing cannot be changed by accident. Simple mode (⋯ menu) hides the advanced tabs.'],
  ];
  let step = 0, overlay;
  function drawStep() {
    const [title, text] = STEPS[step];
    overlay.querySelector('.tour-title').textContent = title;
    overlay.querySelector('.tour-text').textContent = text;
    overlay.querySelector('.tour-count').textContent = (step + 1) + ' / ' + STEPS.length;
    overlay.querySelector('[data-t="back"]').disabled = step === 0;
    overlay.querySelector('[data-t="next"]').textContent = step === STEPS.length - 1 ? 'Done' : 'Next';
  }
  function closeGuide() { if (overlay) overlay.remove(); overlay = null; store.set('wp_tour_done', '1'); }
  function openGuide() {
    if (overlay) return;
    step = 0;
    overlay = document.createElement('div');
    overlay.className = 'tour-overlay';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', 'Quick start guide');
    overlay.innerHTML = '<div class="tour-card"><div class="tour-count"></div><h3 class="tour-title"></h3><p class="tour-text"></p><div class="tour-actions"><button class="secondary" data-t="skip">Skip</button><span style="flex:1"></span><button class="secondary" data-t="back">Back</button><button data-t="next">Next</button></div></div>';
    overlay.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      if (b.dataset.t === 'skip') closeGuide();
      else if (b.dataset.t === 'back') { step = Math.max(0, step - 1); drawStep(); }
      else if (step === STEPS.length - 1) closeGuide(); else { step++; drawStep(); }
    });
    document.body.appendChild(overlay);
    drawStep();
  }
  $('menu-guide').addEventListener('click', openGuide);
  if (store.get('wp_tour_done') !== '1') setTimeout(openGuide, 1200);
})();
