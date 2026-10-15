// Desktop-app extras for the control room: online/offline + sync status,
// cloud-sync settings, the update banner, and the Voice Detect note.
// In a normal browser this only shows an "Offline" chip when the connection drops.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (t) => escapeHtmlLocal(t == null ? '' : String(t));
  const desk = window.desktop;
  const chip = $('net-chip');

  const ago = (iso) => {
    if (!iso) return 'never';
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString();
  };

  // ------------------------------------------------------------ status chip
  let sync = null;
  function paintChip() {
    if (!navigator.onLine) {
      chip.hidden = false; chip.className = 'net-chip warn';
      chip.textContent = desk ? '⚠ Offline — everything still works' : '⚠ Offline';
      chip.title = 'No internet. Songs, scripture (KJV/WEB) and your saved media keep working; changes sync when you are back online.';
      return;
    }
    if (!desk) { chip.hidden = true; return; }
    chip.hidden = false;
    if (!sync || !sync.configured) { chip.className = 'net-chip'; chip.textContent = '☁ Set up cloud sync'; chip.title = 'Keep this PC and your online copy in step'; return; }
    if (sync.state === 'syncing') { chip.className = 'net-chip'; chip.textContent = '↻ Syncing…'; return; }
    if (sync.state === 'offline') { chip.className = 'net-chip warn'; chip.textContent = '☁ Cloud unreachable'; chip.title = sync.message || ''; return; }
    if (sync.state === 'error') { chip.className = 'net-chip bad'; chip.textContent = '☁ Sync problem'; chip.title = sync.message || ''; return; }
    chip.className = 'net-chip ok'; chip.textContent = '☁ Synced ' + ago(sync.lastSyncAt);
    chip.title = sync.message || 'Your PC and the online copy are in step.';
  }
  window.addEventListener('online', paintChip);
  window.addEventListener('offline', paintChip);
  chip.addEventListener('click', () => { if (desk && window.showTab) showTab('tools'); });
  setInterval(paintChip, 30000);
  paintChip();
  if (!desk) return;

  document.documentElement.classList.add('is-desktop');

  // ----------------------------------------------- Voice Detect: not in the app
  try {
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
    Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
  } catch (e) {}
  const vbtn = $('voice-start-btn');
  if (vbtn) {
    vbtn.disabled = true;
    const box = vbtn.closest('.scripture-box');
    const note = document.createElement('div');
    note.className = 'desktop-note';
    note.innerHTML = '<b>Voice Detect isn\'t available in the desktop app</b> — it needs Chrome\'s cloud speech service. To use it, choose <b>Tools ▸ Open control room in Chrome/Edge</b> in the app menu (press <kbd>Alt</kbd> to show the menu).';
    box.prepend(note);
  }

  // ------------------------------------------------ cloud box in the Tools tab
  const tools = $('tab-tools');
  const box = document.createElement('div');
  box.innerHTML = `
    <h2>☁ Cloud sync &amp; app</h2>
    <div class="scripture-box" id="cloud-box">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
        <div><b id="app-version">Worship Presenter</b><div class="sync-line" id="update-line" style="margin:2px 0 0;"></div></div>
        <button class="secondary" id="update-check">Check for updates</button>
      </div>
      <p class="hint" style="margin:12px 0 8px;">Works with or without internet. When online, this PC syncs songs, lyrics, saved texts and media with your online copy (both ways, nothing overwritten silently).</p>
      <label style="font-size:12px;color:var(--text-soft);font-weight:600;">Online copy address</label>
      <input type="text" id="cloud-url" placeholder="https://your-presenter.onrender.com" style="margin:6px 0 10px;" />
      <label style="font-size:12px;color:var(--text-soft);font-weight:600;">Its operator password</label>
      <input type="password" id="cloud-pass" placeholder="Saved encrypted on this PC — never shown again" autocomplete="off" style="margin-top:6px;" />
      <div class="row">
        <button id="cloud-save">Save &amp; sync</button>
        <button class="secondary" id="cloud-sync">Sync now</button>
        <button class="secondary" id="cloud-forget">Forget password</button>
        <button class="secondary" id="open-data">Open data folder</button>
      </div>
      <div class="sync-line" id="sync-line"></div>
    </div>`;
  tools.prepend(box);

  const line = $('sync-line');
  function paintSyncLine() {
    if (!sync) { line.textContent = ''; return; }
    const s = sync.summary;
    let t = sync.configured ? `Last sync: ${ago(sync.lastSyncAt)}.` : 'Not connected yet — enter the address and password above (one time).';
    if (s && sync.lastSyncAt) {
      const moved = s.songs.pulled + s.songs.pushed + s.songs.updatedLocal + s.songs.updatedCloud + s.texts.pulled + s.texts.pushed + s.media.pulled + s.media.pushed + s.schedule.pulled;
      t += moved ? ` Songs ↓${s.songs.pulled} ↑${s.songs.pushed}, updated ${s.songs.updatedLocal + s.songs.updatedCloud}; media ↓${s.media.pulled} ↑${s.media.pushed}.` : ' Everything was already up to date.';
    }
    if (sync.state === 'offline') t += ' (No connection — will retry automatically.)';
    if (sync.message) t += ' ' + sync.message;
    line.textContent = t;
  }
  function onSync(s) { sync = s; paintChip(); paintSyncLine(); if (s.url && !$('cloud-url').value) $('cloud-url').value = s.url; }
  desk.sync.status().then(onSync);
  desk.sync.onStatus(onSync);

  $('cloud-save').addEventListener('click', async () => {
    const btn = $('cloud-save'); btn.disabled = true; btn.textContent = 'Checking…';
    const r = await desk.sync.saveCloud($('cloud-url').value.trim(), $('cloud-pass').value);
    btn.disabled = false; btn.textContent = 'Save & sync';
    if (r.ok) { $('cloud-pass').value = ''; toast('Connected to the online copy — syncing now.', 'ok'); }
    else toast(r.error || 'Could not connect.', 'error');
  });
  $('cloud-sync').addEventListener('click', async () => {
    toast('Syncing…');
    const r = await desk.sync.run();
    if (r.ok) toast('Sync finished.', 'ok'); else if (!r.skipped || r.error) toast(r.error || 'Sync failed.', 'error');
  });
  $('cloud-forget').addEventListener('click', async () => { if (confirm('Forget the saved cloud password on this PC? (Your data stays.)')) { await desk.sync.forgetCloud(); toast('Cloud password forgotten.'); } });
  $('open-data').addEventListener('click', () => desk.openDataFolder());

  // ------------------------------------------------------------- app + updates
  desk.info().then((i) => { $('app-version').textContent = 'Worship Presenter v' + i.version; });
  const banner = $('update-banner');
  let dismissed = '';
  function paintUpdate(u) {
    const line = $('update-line');
    const text = { idle: '', checking: 'Checking for updates…', current: 'You have the latest version.', error: u.message ? 'Update check failed: ' + u.message : '', downloading: `Downloading version ${u.version || ''}…`, ready: `Version ${u.version} is ready.`, installing: 'Restarting…' }[u.state] || '';
    if (line) line.textContent = text;
    if (u.state === 'downloading') {
      banner.hidden = false;
      banner.innerHTML = `<div class="ub-title">Downloading update ${esc(u.version || '')}…</div><div class="ub-sub">You can keep working — nothing changes until you choose to restart.</div><progress max="100" value="${u.percent || 0}"></progress>`;
    } else if (u.state === 'ready' && dismissed !== u.version) {
      banner.hidden = false;
      banner.innerHTML = `<div class="ub-title">✓ Update ${esc(u.version)} is ready</div><div class="ub-sub">It installs automatically the next time you close the app. Restart now only if nothing is live.</div><div class="ub-actions"><button id="ub-now">Restart now</button><button class="secondary" id="ub-later">Later</button></div>`;
      $('ub-now').onclick = () => desk.update.install();
      $('ub-later').onclick = () => { dismissed = u.version; banner.hidden = true; };
    } else if (u.state === 'installing') {
      banner.hidden = false; banner.innerHTML = '<div class="ub-title">Restarting to finish the update…</div>';
    } else banner.hidden = true;
  }
  desk.update.status().then(paintUpdate);
  desk.update.onStatus(paintUpdate);
  $('update-check').addEventListener('click', async () => { toast('Checking for updates…'); const u = await desk.update.check(); paintUpdate(u); });

  // A projector/second screen was plugged in
  let hadSecond = null;
  desk.onDisplays((d) => {
    if (hadSecond === false && d.hasSecond && !d.projectorOpen) toast('Second screen detected — press F5 or click Open Projector to put the slides on it.', 'ok');
    hadSecond = d.hasSecond;
  });
  desk.displays().then((d) => { hadSecond = d.hasSecond; });
})();
