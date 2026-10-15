// The only bridge between the web UI and the desktop shell (context-isolated:
// the page cannot reach Node or Electron directly, only these functions).
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel, cb) => {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  info: () => invoke('app:info'),
  openProjector: () => invoke('projector:open'),
  closeProjector: () => invoke('projector:close'),
  displays: () => invoke('displays:get'),
  onDisplays: (cb) => subscribe('displays', cb),
  update: {
    check: () => invoke('update:check'),
    install: () => invoke('update:install'),
    status: () => invoke('update:status'),
    onStatus: (cb) => subscribe('update:status', cb),
  },
  sync: {
    status: () => invoke('sync:status'),
    run: () => invoke('sync:run'),
    saveCloud: (url, password) => invoke('sync:saveCloud', url, password),
    forgetCloud: () => invoke('sync:forgetCloud'),
    onStatus: (cb) => subscribe('sync:status', cb),
  },
  openDataFolder: () => invoke('app:openDataFolder'),
  phoneRemote: () => invoke('app:phoneRemote'),
});
