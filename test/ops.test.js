// Activity log, projector connection tracking and the livestream lower-third page.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 5600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-ops-'));
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sock = (withCookie, role) => new Promise((res) => { const s = io(BASE, { extraHeaders: withCookie ? { cookie } : {}, transports: ['websocket'], forceNew: true }); s.once('connect', () => { s.emit('hello', role); res(s); }); });

test('lower-third page is public and served', async () => {
  const r = await fetch(BASE + '/lower');
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /lower\.js/);
});

test('activity log records live actions, operator-only', async () => {
  assert.notStrictEqual((await fetch(BASE + '/api/activity')).status, 200);
  const s = await sock(true, 'control');
  try {
    s.emit('stage', { type: 'free-text', text: 'Hello church' }); await wait(80);
    s.emit('golive'); await wait(80);
    s.emit('clear'); await wait(200);
    const d = await (await fetch(BASE + '/api/activity', { headers: { cookie } })).json();
    const texts = d.items.map((i) => i.text);
    assert.ok(texts.some((t) => t === 'Went live: Hello church'), texts.join('|'));
    assert.ok(texts.includes('Cleared the screen'));
    assert.strictEqual(d.items[0].who, 'Operator');
  } finally { s.close(); }
});

test('operator is told how many projectors are connected', async () => {
  const ctl = await sock(true, 'control');
  try {
    let last = null; ctl.on('outputs', (o) => { last = o; });
    await wait(150);
    assert.strictEqual(last.projectors, 0);
    const d1 = await sock(false, 'display'); await wait(150);
    assert.strictEqual(last.projectors, 1);
    const preview = await sock(false, 'preview'); await wait(150);
    assert.strictEqual(last.projectors, 1); // the preview iframe is not a projector
    d1.close(); await wait(200);
    assert.strictEqual(last.projectors, 0);
    preview.close();
  } finally { ctl.close(); }
});
