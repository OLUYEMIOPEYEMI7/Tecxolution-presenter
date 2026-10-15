// Stage / confidence monitor: what the worship team and speaker look at.
// Shows the current slide, the NEXT slide, a clock, the service timer and
// any alert — the thing every professional presentation system has.
const socket = io();
const $ = (id) => document.getElementById(id);
const esc = (t) => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };

socket.on('connect', () => { socket.emit('hello', 'stage'); window.syncServerTime(socket); $('sm-status').textContent = 'connected'; });
socket.on('disconnect', () => { $('sm-status').textContent = 'reconnecting…'; });

function linesOf(st) {
  if (!st) return '';
  if (st.type === 'song') {
    return (st.pairs || []).map(([a, b]) => `<div class="sm-line">${esc(a)}${b ? ' <em>' + esc(b) + '</em>' : ''}</div>`).join('') +
      (st.finale ? `<div class="sm-line" style="color:#f3cb6e">${esc(st.finale)}</div>` : '');
  }
  if (st.type === 'scripture') return `<div class="sm-ref">${esc(st.reference)} ${esc(st.translation ? '· ' + st.translation : '')}</div><div class="sm-line">${esc(st.text)}</div>`;
  if (st.type === 'free-text') return (st.text || '').split('\n').map((l) => `<div class="sm-line">${esc(l)}</div>`).join('');
  if (st.type === 'image') return '<div class="sm-line" style="color:#889">[ image / slide ]</div>';
  if (st.type === 'video') return '<div class="sm-line" style="color:#889">[ video playing ]</div>';
  return '';
}

socket.on('live-state', (st) => {
  $('sm-now').innerHTML = linesOf(st);
  $('sm-title').textContent = (st && st.label) || (st && st.type !== 'blank' ? st.type : 'Stage Monitor');
  const next = st && Array.isArray(st.next) ? st.next : [];
  $('sm-next').innerHTML = next.length ? next.map((l) => `<div class="sm-line">${esc(l)}</div>`).join('') : '<div class="sm-line" style="color:#445">—</div>';
});
socket.on('overlay-state', (m) => $('sm-black').classList.toggle('on', m === 'black'));

function tickClock() { $('sm-clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
setInterval(tickClock, 1000); tickClock();

let timer = { active: false };
function drawTimer() {
  const el = $('sm-timer');
  if (!timer.active) { el.textContent = ''; return; }
  const diff = timer.mode === 'up' ? serverNow() - timer.target : timer.target - serverNow();
  el.textContent = (timer.label ? timer.label + '  ' : '') + window.formatClock(Math.max(0, diff));
  el.classList.toggle('done', timer.mode === 'down' && diff <= 0);
}
socket.on('timer-state', (t) => { timer = t || { active: false }; drawTimer(); });
setInterval(drawTimer, 250);

let hideAlert = null;
socket.on('alert-state', (a) => {
  clearTimeout(hideAlert);
  const el = $('sm-alert');
  if (!a || !a.text || a.until <= serverNow()) { el.classList.remove('on'); return; }
  el.textContent = a.text; el.classList.add('on');
  hideAlert = setTimeout(() => el.classList.remove('on'), Math.max(500, a.until - serverNow()));
});
