// Service templates + Back/Forward through live slides, end to end.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 5100 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-tpl-'));
let proc; let cookie = '';

before(async () => {
  await new Promise((resolve, reject) => {
    proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DATA_DIR, MEDIA_DIR: path.join(DATA_DIR, 'm'), THEME_DIR: path.join(DATA_DIR, 't'), BIND_HOST: '127.0.0.1', OPERATOR_PASSWORD: 'pw-123456', NODE_ENV: 'test', DATABASE_URL: '' } });
    proc.stdout.on('data', (d) => { if (String(d).includes('running at')) resolve(); });
    proc.on('error', reject); setTimeout(() => reject(new Error('no start')), 15000);
  });
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw-123456' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => new Promise((r) => { proc.once('exit', () => { fs.rmSync(DATA_DIR, { recursive: true, force: true }); r(); }); proc.kill('SIGTERM'); }));

const api = (p, method = 'GET', body) => fetch(BASE + p, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const sock = () => new Promise((res) => { const s = io(BASE, { extraHeaders: { cookie }, transports: ['websocket'], forceNew: true }); s.once('connect', () => { s.emit('hello', 'control'); res(s); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const next = (s, ev, ms = 2000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, (v) => { clearTimeout(t); res(v); }); });

test('service templates: save, load (replace/append), rename, delete', async () => {
  assert.strictEqual((await api('/api/templates', 'POST', { name: 'Sunday' })).status, 400); // empty schedule
  await api('/api/schedule', 'POST', { displayTitle: 'Welcome', stateType: 'free-text', text: 'Welcome!', style: { size: 150, color: '#ffcc00', align: 'left' } });
  await api('/api/schedule', 'POST', { displayTitle: 'John 3:16', stateType: 'scripture-ref', ref: 'John 3:16' });
  const saved = await (await api('/api/templates', 'POST', { name: 'Sunday 1st service' })).json();
  assert.strictEqual(saved.items[0].count, 2);
  // clear and load it back
  await api('/api/schedule', 'DELETE');
  assert.strictEqual((await (await api('/api/schedule')).json()).items.length, 0);
  const id = saved.items[0].id;
  const loaded = await (await api(`/api/templates/${id}/load`, 'POST', {})).json();
  assert.deepStrictEqual(loaded.items.map((i) => i.displayTitle), ['Welcome', 'John 3:16']);
  assert.strictEqual(loaded.items[0].style.size, 150); // styling survives
  // append adds to the end
  const appended = await (await api(`/api/templates/${id}/load`, 'POST', { mode: 'append' })).json();
  assert.strictEqual(appended.items.length, 4);
  // same name overwrites rather than duplicating
  const again = await (await api('/api/templates', 'POST', { name: 'sunday 1st SERVICE' })).json();
  assert.strictEqual(again.items.length, 1); assert.strictEqual(again.replaced, true); assert.strictEqual(again.items[0].count, 4);
  // rename + delete
  const ren = await (await api('/api/templates/' + id, 'PUT', { name: 'Midweek' })).json();
  assert.strictEqual(ren.items[0].name, 'Midweek');
  assert.strictEqual((await api('/api/templates/nope/load', 'POST', {})).status, 404);
  const del = await (await api('/api/templates/' + id, 'DELETE')).json();
  assert.strictEqual(del.items.length, 0);
});

test('templates are operator-only and included in backups', async () => {
  const anon = await fetch(BASE + '/api/templates');
  assert.ok([401, 302, 403].includes(anon.status));
  await api('/api/schedule', 'POST', { displayTitle: 'Note', stateType: 'free-text', text: 'x' });
  await api('/api/templates', 'POST', { name: 'Backup me' });
  const backup = await (await api('/api/backup')).json();
  assert.ok(backup.templates.some((t) => t.name === 'Backup me'));
});

test('Back / Forward through live slides, including undoing a Clear', async () => {
  const s = await sock();
  try {
  const stage = (text) => { s.emit('stage', { type: 'free-text', text }); return wait(80).then(() => s.emit('golive')); };
  await stage('A'); await wait(80); await stage('B'); await wait(80); await stage('C'); await wait(120);
  let live = null; s.on('live-state', (v) => { live = v; });
  let nav = null; s.on('live-nav', (v) => { nav = v; });
  s.emit('live-back'); await wait(150);
  assert.strictEqual(live.text, 'B'); assert.strictEqual(nav.canBack, true); assert.strictEqual(nav.canForward, true);
  s.emit('live-back'); await wait(150);
  assert.strictEqual(live.text, 'A');
  s.emit('live-forward'); await wait(150);
  assert.strictEqual(live.text, 'B');
  // new slide wipes the redo path
  await stage('D'); await wait(150);
  assert.strictEqual(nav.canForward, false);
  // accidental Clear can be undone
  s.emit('clear'); await wait(150);
  assert.strictEqual(live.type, 'blank');
  s.emit('live-back'); await wait(150);
  assert.strictEqual(live.text, 'D');
  } finally { s.close(); }
});
