// Livestream lower-third: shows what is on the projector as a caption bar over a
// transparent page, for streaming software. Only text slides are captioned.
const q = new URLSearchParams(location.search);
const root = document.documentElement;
root.dataset.pos = q.get('pos') === 'top' ? 'top' : 'bottom';
root.dataset.bar = q.get('bar') === '0' ? '0' : '1';
const sz = Number(q.get('size')); if (sz >= 0.5 && sz <= 3) root.style.setProperty('--s', sz);
const maxLines = Math.min(8, Math.max(1, parseInt(q.get('lines'), 10) || 4));
const socket = io();
const box = document.getElementById('lt'), refEl = document.getElementById('lt-ref'), textEl = document.getElementById('lt-text');
let live = { type: 'blank' }, overlay = 'none', build = null;

function draw() {
  let ref = '', text = '';
  if (overlay === 'none') {
    if (live.type === 'song') {
      const lines = (live.pairs || []).map(([a, b]) => (b ? a + ' ' + b : a));
      text = lines.slice(0, maxLines).join('\n');
    } else if (live.type === 'scripture') {
      ref = [live.reference, live.translation].filter(Boolean).join(' · ');
      text = live.text || '';
    } else if (live.type === 'free-text') {
      text = live.text || '';
    }
  }
  refEl.textContent = ref;
  textEl.textContent = text;
  box.classList.toggle('on', !!text);
}
socket.on('live-state', (s) => { live = s || { type: 'blank' }; draw(); });
socket.on('overlay-state', (m) => { overlay = m || 'none'; draw(); });
// Reload after an update so a streaming source never runs old code.
socket.on('build-id', (id) => { if (build === null) build = id; else if (id !== build) setTimeout(() => location.reload(), 500 + Math.random() * 3000); });
