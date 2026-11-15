// Shared client plumbing for display / stage / control / remote:
//  - service worker (offline resilience)
//  - keep-alive ping so a free-tier Render instance doesn't fall asleep while
//    any screen is open
//  - server-clock sync (timers must agree across every screen)
//  - screen wake-lock for projector / monitor machines
(function () {
  if (!window.desktop && 'serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Only top-level pages ping (the control room embeds /display in iframes).
  if (window.self === window.top) {
    setInterval(() => { fetch('/healthz', { cache: 'no-store' }).catch(() => {}); }, 4 * 60 * 1000);
  }

  window.serverOffset = 0; // serverNow = Date.now() + serverOffset
  window.serverNow = () => Date.now() + window.serverOffset;
  window.syncServerTime = function (socket) {
    const t0 = Date.now();
    socket.emit('time-sync', (serverTime) => {
      const rtt = Date.now() - t0;
      window.serverOffset = serverTime + rtt / 2 - Date.now();
    });
  };

  window.formatClock = function (ms) {
    const neg = ms < 0;
    const total = Math.floor(Math.abs(ms) / 1000);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return (neg ? '-' : '') + (h ? h + ':' + mm : mm) + ':' + ss;
  };

  if (window.self === window.top && 'wakeLock' in navigator) {
    let lock = null;
    const acquire = () => navigator.wakeLock.request('screen').then((l) => { lock = l; }).catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') acquire(); });
    acquire();
  }
})();


// Reload-on-update: the server sends a fingerprint of the front-end files on
// every (re)connect. If it changes while this page is open, the page is stale.
// Projector / stage / remote reload themselves (a few seconds of jitter so they
// don't all hit the server together); the control room shows a banner instead
// so nothing the operator is typing is lost.
window.watchBuild = function (socket) {
  let known = null;
  socket.on('build-id', (id) => {
    if (known === null) { known = id; return; }
    if (id === known) return;
    if (location.pathname.indexOf('/control') === 0) {
      if (document.getElementById('update-banner')) return;
      const b = document.createElement('div');
      b.id = 'update-banner';
      b.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99999;background:#d4a437;color:#111;padding:10px 16px;border-radius:10px;font:600 13px Inter,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5);cursor:pointer';
      b.textContent = 'A new version is ready — click to refresh';
      b.onclick = () => location.reload();
      document.body.appendChild(b);
    } else {
      setTimeout(() => location.reload(), 500 + Math.random() * 3000);
    }
  });
};
