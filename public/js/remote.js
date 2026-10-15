// Phone remote: drives the control room from any phone on the venue network
// (or anywhere — it's the same signed-in operator session). The control room
// owns slide navigation, so the remote sends commands to it.
const _fetch = window.fetch.bind(window);
window.fetch = (...a) => _fetch(...a).then((r) => { if (r.status === 401) location.href = '/login?next=/remote'; return r; });
const socket = io();
const $ = (id) => document.getElementById(id);
const esc = (t) => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };

socket.on('connect', () => { socket.emit('hello', 'remote'); $('rm-dot').classList.add('on'); $('rm-status').textContent = 'connected'; window.syncServerTime(socket); loadSchedule(); });
socket.on('disconnect', () => { $('rm-dot').classList.remove('on'); $('rm-status').textContent = 'reconnecting…'; });
socket.on('auth-error', () => { location.href = '/login?next=/remote'; });

function summary(st) {
  if (!st || st.type === 'blank') return '—';
  if (st.type === 'song') return (st.label ? st.label + '\n' : '') + (st.pairs || []).map((p) => p[0]).join('\n');
  if (st.type === 'scripture') return st.reference + '\n' + st.text;
  if (st.type === 'free-text') return st.text;
  return st.type === 'image' ? '[image / slide]' : '[video]';
}
socket.on('live-state', (st) => {
  $('rm-live').textContent = summary(st);
  const next = st && Array.isArray(st.next) ? st.next : [];
  $('rm-next').textContent = next.length ? next.join('\n') : '—';
});
socket.on('overlay-state', (m) => {
  ['black', 'logo', 'clear'].forEach((k) => $('ov-' + k).classList.toggle('active', m === k));
});
socket.on('history', (list) => {
  $('rm-hist').innerHTML = list.length ? list.slice(0, 8).map((h, i) => `<div class="rm-sched-item"><span>${esc(h.title)}</span><button data-hist="${i}">Stage</button></div>`).join('') : '<div class="rm-text dim">Nothing yet</div>';
  window._hist = list;
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.cmd) { socket.emit('remote-cmd', { cmd: b.dataset.cmd }); if (navigator.vibrate) navigator.vibrate(15); }
  else if (b.dataset.ov) { socket.emit('overlay', b.dataset.ov); if (navigator.vibrate) navigator.vibrate(15); }
  else if (b.dataset.sched) { socket.emit('remote-cmd', { cmd: 'schedule', id: b.dataset.sched, live: b.dataset.live === '1' }); if (navigator.vibrate) navigator.vibrate(15); }
  else if (b.dataset.hist) { const h = (window._hist || [])[+b.dataset.hist]; if (h) { socket.emit('stage', h.state); } }
});

$('rm-alert-send').addEventListener('click', () => { const t = $('rm-alert').value.trim(); if (t) socket.emit('alert-show', { text: t, seconds: 12 }); });
$('rm-alert-hide').addEventListener('click', () => socket.emit('alert-show', { text: '' }));

function loadSchedule() {
  fetch('/api/schedule').then((r) => r.json()).then((d) => {
    const items = d.items || [];
    $('rm-sched').innerHTML = items.length
      ? items.map((it, i) => `<div class="rm-sched-item"><span>${i + 1}. ${esc(it.displayTitle)}</span><span><button data-sched="${esc(it.id)}" data-live="0">Stage</button> <button class="live" data-sched="${esc(it.id)}" data-live="1">Live</button></span></div>`).join('')
      : '<div class="rm-text dim">Schedule is empty — build it in the control room.</div>';
  }).catch(() => {});
}
setInterval(loadSchedule, 30000);
