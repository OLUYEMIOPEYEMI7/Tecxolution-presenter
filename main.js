const { app, BrowserWindow, screen } = require('electron');

// Offline Edition: always force local-file storage, never touch any
// cloud database, regardless of what's in the environment.
delete process.env.DATABASE_URL;
process.env.PORT = process.env.PORT || '4000';

// Starts the existing Express + Socket.io server in-process (server.js
// calls server.listen() itself when required — same file used for the
// cloud deploy, unmodified start-up behavior).
require('./server.js');

let controlWin;

function openDisplayOnSecondScreen() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const target = displays.find((d) => d.id !== primary.id) || primary;
  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    title: 'Worship Presenter — Projection Screen',
  });
  win.loadURL(`http://localhost:${process.env.PORT}/display`);
  return win;
}

function createWindows() {
  controlWin = new BrowserWindow({
    width: 1440,
    height: 900,
    autoHideMenuBar: true,
    title: 'Worship Presenter — Control Room (Offline Edition)',
  });
  controlWin.loadURL(`http://localhost:${process.env.PORT}/control`);

  // Intercept the existing "Open Projection Screen" button's window.open()
  // call and hand it off to native Electron screen placement instead of the
  // browser's Window Management permission prompt — no dialog, no dragging,
  // works the moment a second monitor/projector is connected.
  controlWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('/display')) {
      openDisplayOnSecondScreen();
      return { action: 'deny' }; // we already opened our own positioned window
    }
    return { action: 'allow' };
  });
}

app.whenReady().then(() => {
  // Give the Express server a brief moment to finish binding the port.
  setTimeout(createWindows, 400);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
