// Worship Presenter — desktop shell.
// Runs the presenter server inside the app (so everything works with no
// internet), signs the operator in automatically, manages the projector window
// on the second screen, keeps itself up to date from GitHub Releases, and syncs
// with the online copy whenever a connection is available.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, screen, safeStorage, session, powerSaveBlocker, clipboard, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const netModule = require('net');
const { createSettings } = require('./settings');
const syncLib = require('../lib/sync');

const TEST = !!process.env.WP_TEST; // automated tests: no confirm dialogs
if (process.env.WP_USER_DATA) app.setPath('userData', process.env.WP_USER_DATA);
app.setAppUserModelId('com.tecxolution.worshippresenter');

if (!TEST && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let settings = null;
let server = null;          // the presenter server module
let serverInfo = null;      // { port, host }
let controlWin = null;
let projectorWin = null;
let quitting = false;
let flushed = false;
let syncState = { cloudToLocal: {}, localToCloud: {} };
let syncStatus = { state: 'idle', lastSyncAt: null, summary: null, message: '' };
let syncing = false;
let updateStatus = { state: 'idle', version: null, percent: 0, message: '' };
let autoUpdater = null;

const dataDir = () => path.join(app.getPath('userData'), 'data');
const localUrl = () => `http://127.0.0.1:${serverInfo.port}`;
const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
const send = (win, channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const sendAll = (channel, payload) => BrowserWindow.getAllWindows().forEach((w) => send(w, channel, payload));

// ------------------------------------------------------------------ server --
function getFreePort(preferred) {
  return new Promise((resolve) => {
    const probe = netModule.createServer();
    probe.once('error', () => {
      const any = netModule.createServer();
      any.listen(0, '127.0.0.1', () => { const p = any.address().port; any.close(() => resolve(p)); });
    });
    probe.listen(preferred, '127.0.0.1', () => probe.close(() => resolve(preferred)));
  });
}

async function startServer() {
  const s = settings.get();
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const port = await getFreePort(Number(process.env.WP_PORT) || 4000);
  Object.assign(process.env, {
    WP_DESKTOP: '1',
    PORT: String(port),
    BIND_HOST: s.lanAccess ? '0.0.0.0' : '127.0.0.1', // phones can only reach it when the operator turns that on
    DATA_DIR: dir,
    MEDIA_DIR: path.join(dir, 'media'),
    THEME_DIR: path.join(dir, 'themes'),
    OPERATOR_PASSWORD: s.operatorPassword,
    REMOTE_PASSWORD: s.lanAccess ? s.remotePassword : '',
  });
  delete process.env.DATABASE_URL; // the PC keeps its own local data and syncs through the cloud's API
  delete process.env.SUPABASE_URL;
  applyCloudEnv();
  server = require('../server.js');
  serverInfo = await server.ready;
}

// The server's PowerPoint fallback reads these at call time.
function applyCloudEnv() {
  const c = settings.getCloud();
  if (c) { process.env.CLOUD_URL = c.url; process.env.CLOUD_PASSWORD = c.password; }
  else { delete process.env.CLOUD_URL; delete process.env.CLOUD_PASSWORD; }
}

// Sign the operator in without a password prompt: log in against the local server
// and hand the session cookie to the browser window.
async function signInOperator() {
  const r = await fetch(localUrl() + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: settings.get().operatorPassword }),
  });
  if (!r.ok) throw new Error('Could not sign in to the local presenter (' + r.status + ')');
  const cookie = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0])[0] || '';
  const [name, ...rest] = cookie.split('=');
  await session.defaultSession.cookies.set({
    url: localUrl(), name, value: rest.join('='), path: '/', httpOnly: true, sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
  });
}

// ----------------------------------------------------------------- windows --
function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 1500, height: 940, minWidth: 980, minHeight: 640, show: false,
    backgroundColor: '#0a0a13', autoHideMenuBar: true, title: 'Worship Presenter', icon: iconPath,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  controlWin.loadURL(localUrl() + '/control');
  controlWin.once('ready-to-show', () => { controlWin.show(); if (!TEST) controlWin.maximize(); });
  controlWin.on('close', (e) => {
    if (quitting || TEST) return;
    const choice = dialog.showMessageBoxSync(controlWin, {
      type: 'question', buttons: ['Cancel', 'Quit'], defaultId: 0, cancelId: 0,
      title: 'Quit Worship Presenter?', message: 'Quit Worship Presenter?', detail: 'The projector screen will go dark.',
    });
    if (choice === 0) e.preventDefault(); else quitting = true;
  });
  controlWin.on('closed', () => { controlWin = null; if (projectorWin && !projectorWin.isDestroyed()) projectorWin.close(); });
}

function otherDisplay() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().find((d) => d.id !== primary.id) || null;
}
const displayInfo = () => ({ count: screen.getAllDisplays().length, hasSecond: !!otherDisplay(), projectorOpen: !!(projectorWin && !projectorWin.isDestroyed()) });

function openProjector() {
  const target = otherDisplay();
  if (projectorWin && !projectorWin.isDestroyed()) {
    // Opened as a small window earlier, and a projector has been plugged in since: move it there.
    if (!(target && !projectorWin.isFullScreen())) { projectorWin.focus(); return { ...displayInfo(), already: true, onSecondScreen: projectorWin.isFullScreen() }; }
    projectorWin.removeAllListeners('closed');
    projectorWin.destroy();
    projectorWin = null;
  }
  const b = (target || screen.getPrimaryDisplay()).bounds;
  projectorWin = new BrowserWindow({
    x: target ? b.x : b.x + 80, y: target ? b.y : b.y + 80,
    width: target ? b.width : 960, height: target ? b.height : 540,
    frame: !target, backgroundColor: '#000000', show: false, autoHideMenuBar: true, skipTaskbar: !!target,
    title: 'Projector', icon: iconPath,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  projectorWin.loadURL(localUrl() + '/display?desktop=1');
  projectorWin.once('ready-to-show', () => {
    projectorWin.show();
    if (target) projectorWin.setFullScreen(true);
    sendAll('displays', displayInfo());
  });
  projectorWin.on('closed', () => { projectorWin = null; sendAll('displays', displayInfo()); });
  return { ...displayInfo(), already: false, onSecondScreen: !!target };
}
function closeProjector() { if (projectorWin && !projectorWin.isDestroyed()) projectorWin.close(); return displayInfo(); }

function openUtilityWindow(pathname) {
  const w = new BrowserWindow({ width: 1000, height: 640, backgroundColor: '#07070f', autoHideMenuBar: true, icon: iconPath, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  w.loadURL(localUrl() + pathname);
  return w;
}

// ------------------------------------------------------------------- sync ---
const syncFile = () => path.join(dataDir(), 'sync-state.json');
function loadSyncState() {
  try {
    const j = JSON.parse(fs.readFileSync(syncFile(), 'utf8'));
    syncState = j.state || syncState;
    syncStatus = { ...syncStatus, lastSyncAt: j.lastSyncAt || null, summary: j.summary || null };
  } catch (e) { /* first run */ }
}
function saveSyncState() {
  try { fs.writeFileSync(syncFile(), JSON.stringify({ state: syncState, lastSyncAt: syncStatus.lastSyncAt, summary: syncStatus.summary })); } catch (e) {}
}
function publicSyncStatus() {
  const c = settings.getCloud();
  return { configured: !!c, url: (c && c.url) || settings.get().cloud.url, online: net.isOnline(), ...syncStatus };
}
function pushSyncStatus() { sendAll('sync:status', publicSyncStatus()); }

async function doSync() {
  const cloud = settings.getCloud();
  if (!cloud) return { ok: false, skipped: true, error: 'Cloud sync is not set up yet.' };
  if (syncing) return { ok: false, skipped: true, error: 'A sync is already running.' };
  syncing = true;
  syncStatus = { ...syncStatus, state: 'syncing', message: 'Syncing…' };
  pushSyncStatus();
  let result;
  try {
    result = await syncLib.runSync({ local: { url: localUrl(), password: settings.get().operatorPassword }, cloud, state: syncState });
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  syncing = false;
  if (result.ok) syncStatus = { state: 'idle', lastSyncAt: result.at, summary: result, message: result.errors && result.errors.length ? `${result.errors.length} item(s) could not be synced` : '' };
  else syncStatus = { ...syncStatus, state: result.offline ? 'offline' : 'error', message: result.error || '', summary: syncStatus.summary };
  saveSyncState();
  pushSyncStatus();
  return result;
}

function scheduleSync() {
  setTimeout(() => { if (settings.getCloud()) doSync(); }, 6000);
  setInterval(() => { if (settings.getCloud() && net.isOnline()) doSync(); }, 10 * 60 * 1000);
}

// ---------------------------------------------------------------- updates ---
function setUpdate(patch) { updateStatus = { ...updateStatus, ...patch }; sendAll('update:status', updateStatus); }

function setupUpdater() {
  const fake = process.env.WP_TEST_UPDATE; // tests: pretend a new version was downloaded
  if (fake) {
    setTimeout(() => setUpdate({ state: 'downloading', version: fake, percent: 40 }), 800);
    setTimeout(() => setUpdate({ state: 'ready', version: fake, percent: 100 }), 1600);
    return;
  }
  if (!app.isPackaged) return; // updates only apply to the installed app
  try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // installs when the operator closes the app — never in the middle of a service
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => setUpdate({ state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => setUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'current', message: '' }));
  autoUpdater.on('update-downloaded', (i) => setUpdate({ state: 'ready', version: i.version, percent: 100 }));
  autoUpdater.on('error', (e) => setUpdate({ state: 'error', message: (e && e.message) || 'Update check failed' }));
  const check = () => { if (net.isOnline()) autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 15000);
  setInterval(check, 4 * 3600 * 1000);
}

// -------------------------------------------------------------- dialogs/IPC --
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

async function showPhoneRemote() {
  const s = settings.get();
  const links = lanAddresses().map((ip) => `http://${ip}:${serverInfo.port}/remote`);
  const on = s.lanAccess;
  const detail = on
    ? `Open this on a phone connected to the same Wi-Fi:\n\n${links.join('\n') || '(no network connection found)'}\n\nPassword: ${s.remotePassword}\n\nThe phone can go next/previous, go live, black/logo and send alerts — it cannot edit or delete anything. If Windows asks about the firewall, choose "Allow" for private networks.`
    : 'Phone remote is OFF, so nothing on your network can reach this app.\n\nTurning it on lets a phone on the same Wi-Fi drive the slides (next / previous / go live / black). The app restarts to apply the change.';
  const { response } = await dialog.showMessageBox(controlWin, {
    type: 'info', title: 'Phone remote', message: on ? 'Phone remote is ON' : 'Phone remote is OFF', detail,
    buttons: on ? ['Close', 'Copy link', 'Turn off'] : ['Close', 'Turn on'], defaultId: 0, cancelId: 0,
  });
  if (on && response === 1 && links[0]) clipboard.writeText(links[0]);
  if ((on && response === 2) || (!on && response === 1)) {
    settings.set({ lanAccess: !on });
    quitting = true; app.relaunch(); app.quit();
  }
}

async function showChromeHandoff() {
  const s = settings.get();
  const { response } = await dialog.showMessageBox(controlWin, {
    type: 'info', title: 'Open in your browser', message: 'Open the control room in Chrome / Edge',
    detail: `Voice Detect needs Chrome's speech recognition, which the desktop app does not include.\n\nYour browser will open the control room. Sign in with this operator password:\n\n${s.operatorPassword}\n\n(Keep the desktop app running — it is what serves the page.)`,
    buttons: ['Cancel', 'Copy password & open browser'], defaultId: 1, cancelId: 0,
  });
  if (response === 1) { clipboard.writeText(s.operatorPassword); shell.openExternal(localUrl() + '/login?next=/control'); }
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), dataDir: dataDir(), packaged: app.isPackaged, port: serverInfo.port, lan: settings.get().lanAccess, ...displayInfo() }));
  ipcMain.handle('projector:open', () => openProjector());
  ipcMain.handle('projector:close', () => closeProjector());
  ipcMain.handle('displays:get', () => displayInfo());
  ipcMain.handle('update:status', () => updateStatus);
  ipcMain.handle('update:check', async () => {
    if (!autoUpdater) { setUpdate({ state: 'current', message: app.isPackaged ? '' : 'Updates only apply to the installed app.' }); return updateStatus; }
    try { await autoUpdater.checkForUpdates(); } catch (e) { setUpdate({ state: 'error', message: e.message }); }
    return updateStatus;
  });
  ipcMain.handle('update:install', () => {
    if (process.env.WP_TEST_UPDATE) { setUpdate({ state: 'installing' }); return true; }
    if (autoUpdater && updateStatus.state === 'ready') { quitting = true; autoUpdater.quitAndInstall(false, true); return true; }
    return false;
  });
  ipcMain.handle('sync:status', () => publicSyncStatus());
  ipcMain.handle('sync:run', () => doSync());
  ipcMain.handle('sync:saveCloud', async (_e, url, password) => {
    if (!url || !password) return { ok: false, error: 'Enter the cloud address and its operator password.' };
    const t = await syncLib.testCloud({ url, password });
    if (!t.ok) return { ok: false, error: t.error };
    settings.setCloud(url, password);
    applyCloudEnv();
    pushSyncStatus();
    doSync();
    return { ok: true, version: t.version };
  });
  ipcMain.handle('sync:forgetCloud', () => { settings.clearCloud(); applyCloudEnv(); syncStatus = { ...syncStatus, state: 'idle', message: '' }; pushSyncStatus(); return true; });
  ipcMain.handle('app:openDataFolder', () => shell.openPath(dataDir()));
  ipcMain.handle('app:phoneRemote', () => showPhoneRemote());
}

function buildMenu() {
  const run = (js) => controlWin && controlWin.webContents.executeJavaScript(js).catch(() => {});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open projector on second screen', accelerator: 'F5', click: () => openProjector() },
      { label: 'Close projector', click: () => closeProjector() },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'Alt+F4', click: () => { if (controlWin) controlWin.close(); else app.quit(); } },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Reload control room', accelerator: 'Ctrl+R', click: () => controlWin && controlWin.reload() },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { label: 'Tools', submenu: [
      { label: 'Phone remote…', click: () => showPhoneRemote() },
      { label: 'Sync with cloud now', click: () => doSync() },
      { label: 'Open stage monitor', click: () => openUtilityWindow('/stage') },
      { type: 'separator' },
      { label: 'Open data folder', click: () => shell.openPath(dataDir()) },
      { label: 'Open control room in Chrome/Edge (for Voice Detect)…', click: () => showChromeHandoff() },
    ] },
    { label: 'Help', submenu: [
      { label: 'Keyboard shortcuts', click: () => run('window.openShortcuts && openShortcuts()') },
      { label: 'Check for updates', click: async () => { if (autoUpdater) autoUpdater.checkForUpdates().catch(() => {}); else dialog.showMessageBox(controlWin, { type: 'info', message: 'Updates are checked automatically once the app is installed.' }); } },
      { type: 'separator' },
      { label: `About Worship Presenter ${app.getVersion()}`, click: () => dialog.showMessageBox(controlWin, { type: 'info', title: 'About', message: `Worship Presenter ${app.getVersion()}`, detail: `RCCG Youth Province 9 · Peculiar Voices\n\nYour data is saved on this PC in:\n${dataDir()}\n\nWorks with or without internet. When online it syncs with your cloud copy and updates itself.` }) },
    ] },
  ]));
}

// ----------------------------------------------------------------- startup ---
function lockDownWebContents() {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e, url) => {
      if (serverInfo && url.startsWith(localUrl())) return;
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (serverInfo && u.origin === localUrl()) {
          if (u.pathname.startsWith('/display')) setImmediate(openProjector);
          else if (u.pathname.startsWith('/stage') || u.pathname.startsWith('/remote')) setImmediate(() => openUtilityWindow(u.pathname));
        } else if (/^https?:$/.test(u.protocol)) shell.openExternal(url);
      } catch (e) { /* ignore malformed */ }
      return { action: 'deny' };
    });
  });
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(['fullscreen', 'window-management', 'clipboard-sanitized-write', 'media'].includes(permission) && wc.getURL().startsWith('http://127.0.0.1')));
}

app.whenReady().then(async () => {
  try {
    settings = createSettings(path.join(app.getPath('userData'), 'desktop-settings.json'), safeStorage);
    lockDownWebContents();
    await startServer();
    await signInOperator();
    loadSyncState();
    registerIpc();
    buildMenu();
    createControlWindow();
    powerSaveBlocker.start('prevent-display-sleep'); // the projector must never sleep mid-service
    setupUpdater();
    scheduleSync();
    screen.on('display-added', () => sendAll('displays', displayInfo()));
    screen.on('display-removed', () => sendAll('displays', displayInfo()));
    if (settings.get().autoOpenProjector && otherDisplay() && !TEST) setTimeout(openProjector, 1500);
    if (process.env.WP_TEST) console.log('WP_READY ' + serverInfo.port);
  } catch (e) {
    dialog.showErrorBox('Worship Presenter could not start', String((e && e.stack) || e));
    app.exit(1);
  }
});

app.on('second-instance', () => { if (controlWin) { if (controlWin.isMinimized()) controlWin.restore(); controlWin.focus(); } });
app.on('window-all-closed', () => { quitting = true; app.quit(); });
// Save the live screen state before exiting so the next launch resumes exactly here.
app.on('before-quit', (e) => {
  quitting = true;
  if (flushed || !server) return;
  e.preventDefault();
  flushed = true;
  Promise.resolve(server.flush()).catch(() => {}).finally(() => app.quit());
});
