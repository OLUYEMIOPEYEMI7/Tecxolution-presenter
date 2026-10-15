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
