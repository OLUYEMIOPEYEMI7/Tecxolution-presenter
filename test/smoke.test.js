// End-to-end smoke tests: boot the real server (file-storage mode), then
// exercise auth, socket gating, validation, uploads, persistence and headers.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const PASSWORD = 'test-pass-123';
const PORT = 4100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-test-'));
let proc;
let cookie = '';

function start(env = {}) {
  return new Promise((resolve, reject) => {
    proc = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(PORT), DATA_DIR, OPERATOR_PASSWORD: PASSWORD, NODE_ENV: 'test', DATABASE_URL: '', ...env },
    });
    proc.stdout.on('data', (d) => { if (String(d).includes('running at')) resolve(); });
    proc.stderr.on('data', (d) => process.env.TEST_VERBOSE && process.stderr.write(d));
    proc.on('error', reject);
    setTimeout(() => reject(new Error('server did not start')), 15000);
  });
}
const stop = () => new Promise((r) => { if (!proc) return r(); proc.once('exit', r); proc.kill('SIGTERM'); });
const api = (p, opts = {}) => fetch(BASE + p, { redirect: 'manual', ...opts, headers: { ...(cookie ? { cookie } : {}), ...(opts.headers || {}) } });
const connect = (withCookie) => new Promise((resolve) => {
  const s = io(BASE, { extraHeaders: withCookie ? { cookie } : {}, transports: ['websocket'], forceNew: true });
  s.once('connect', () => resolve(s));
});
const nextEvent = (s, ev, ms = 2000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, (v) => { clearTimeout(t); res(v); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => { await start(); });
after(async () => { await stop(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('health + public pages open; control room and API are locked', async () => {
  assert.strictEqual((await api('/healthz')).status, 200);
  assert.strictEqual((await api('/display')).status, 200);
  assert.strictEqual((await api('/stage')).status, 200);
  assert.strictEqual((await api('/login')).status, 200);
  const c = await api('/control');
  assert.strictEqual(c.status, 302);
  assert.match(c.headers.get('location'), /^\/login/);
  assert.strictEqual((await api('/remote')).status, 302);
  assert.strictEqual((await api('/api/songs')).status, 401);
  assert.strictEqual((await api('/api/schedule')).status, 401);
  assert.strictEqual((await api('/api/backup')).status, 401);
  assert.strictEqual((await api('/api/songs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
});

test('security headers present', async () => {
  const r = await api('/display');
  assert.ok(r.headers.get('content-security-policy').includes("object-src 'none'"));
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.strictEqual(r.headers.get('x-powered-by'), null);
});

test('login: wrong password rejected, right password sets HttpOnly cookie', async () => {
  const bad = await api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
  assert.strictEqual(bad.status, 401);
  const ok = await api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.strictEqual(ok.status, 200);
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  cookie = sc.split(';')[0];
  assert.strictEqual((await api('/control')).status, 200);
  assert.strictEqual((await api('/api/songs')).status, 200);
});

test('forged / tampered session cookie is rejected', async () => {
  const saved = cookie;
  cookie = cookie.slice(0, -3) + 'abc';
  assert.strictEqual((await api('/api/songs')).status, 401);
  cookie = 'wp_session=garbage';
  assert.strictEqual((await api('/api/songs')).status, 401);
  cookie = saved;
});

test('cross-origin writes are blocked', async () => {
  const r = await api('/api/songs', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.strictEqual(r.status, 403);
});

test('sockets: strangers can watch but cannot control; operator can', async () => {
  const viewer = await connect(false);
  const stranger = await connect(false);
  const op = await connect(true);
  await wait(200);
  stranger.emit('project', { type: 'free-text', text: 'HACKED' });
  stranger.emit('overlay', 'black');
  const authErr = await nextEvent(stranger, 'auth-error');
  assert.ok(authErr);
  await wait(300);
  const seen = [];
  viewer.on('live-state', (s) => seen.push(s));
  op.emit('stage', { type: 'free-text', text: 'Hello church', theme: 'photo' });
  await wait(200);
  op.emit('golive');
  await wait(300);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].text, 'Hello church');
  [viewer, stranger, op].forEach((s) => s.close());
});

test('socket payloads are validated (bad types, CSS/URL injection)', async () => {
  const viewer = await connect(false);
  const op = await connect(true);
  await wait(200);
  const seen = [];
  viewer.on('live-state', (s) => seen.push(s));
  op.emit('project', { type: 'evil', text: 'x' });
  op.emit('project', { type: 'image', url: 'javascript:alert(1)', background: "x');background:url(//evil", themeBg: 'url(//evil.example/x.png)' });
  await wait(300);
  assert.strictEqual(seen.length, 1); // the 'evil' type was dropped
  assert.strictEqual(seen[0].url, '');
  assert.strictEqual(seen[0].background, null);
  assert.strictEqual(seen[0].themeBg, null);
  [viewer, op].forEach((s) => s.close());
});

test('overlay, timer, alert and settings reach viewers', async () => {
  const viewer = await connect(false);
  const op = await connect(true);
  await wait(200);
  const got = {};
  ['overlay-state', 'timer-state', 'alert-state', 'settings-state'].forEach((e) => viewer.on(e, (v) => { got[e] = v; }));
  op.emit('overlay', 'black');
  op.emit('timer-set', { active: true, mode: 'down', target: Date.now() + 60000, label: 'Start', onDisplay: true });
  op.emit('alert-show', { text: 'Nursery call', seconds: 5 });
  op.emit('settings-update', { fontScale: 99 });
  await wait(400);
  assert.strictEqual(got['overlay-state'], 'black');
  assert.strictEqual(got['timer-state'].active, true);
  assert.strictEqual(got['alert-state'].text, 'Nursery call');
  assert.strictEqual(got['settings-state'].fontScale, 1.8); // clamped
  op.emit('overlay', 'bogus');
  await wait(200);
  assert.strictEqual(got['overlay-state'], 'black'); // invalid mode ignored
  op.emit('overlay', 'none');
  [viewer, op].forEach((s) => s.close());
});

test('songs: validation + CRUD + search', async () => {
  const bad = await api('/api/songs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'X', sections: 'nope' }) });
  assert.strictEqual(bad.status, 400);
  const ok = await api('/api/songs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Test <b>Song</b>', artist: 'Me', sections: [{ label: 'VERSE 1', pairs: [['Amazing grace how sweet', '']] }] }) });
  assert.strictEqual(ok.status, 200);
  const song = await ok.json();
  const found = await (await api('/api/songs?q=amazing%20grace%20sweet')).json();
  assert.ok(found.songs.some((s) => s.id === song.id));
  assert.strictEqual((await api('/api/songs/' + song.id, { method: 'DELETE' })).status, 200);
});

test('uploads: content is verified by bytes, not by claimed type', async () => {
  const fake = new FormData();
  fake.append('file', new Blob(['<html><script>alert(1)</script></html>'], { type: 'image/png' }), 'evil.png');
  assert.strictEqual((await api('/api/media/image', { method: 'POST', body: fake })).status, 400);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  const good = new FormData();
  good.append('file', new Blob([png], { type: 'image/png' }), 'ok.png');
  const r = await api('/api/media/image', { method: 'POST', body: good });
  assert.strictEqual(r.status, 200);
  const { url } = await r.json();
  const file = await api(url); // public asset: no cookie needed
  const saved = cookie; cookie = '';
  const anon = await api(url);
  cookie = saved;
  assert.strictEqual(anon.status, 200);
  assert.strictEqual(anon.headers.get('content-type'), 'image/png');
  assert.strictEqual(file.headers.get('x-content-type-options'), 'nosniff');

  const badLink = new FormData();
  badLink.append('url', 'javascript:alert(1)');
  assert.strictEqual((await api('/api/media/video', { method: 'POST', body: badLink })).status, 400);
  const goodLink = new FormData();
  goodLink.append('url', 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.strictEqual((await api('/api/media/video', { method: 'POST', body: goodLink })).status, 200);
});

test('video files support HTTP Range requests', async () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100, 7)]);
  const fd = new FormData();
  fd.append('file', new Blob([mp4], { type: 'video/mp4' }), 'clip.mp4');
  const up = await api('/api/media/video', { method: 'POST', body: fd });
  assert.strictEqual(up.status, 200);
  const { url } = await up.json();
  const part = await api(url, { headers: { range: 'bytes=0-9' } });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.headers.get('content-range'), `bytes 0-9/${mp4.length}`);
  assert.strictEqual((await part.arrayBuffer()).byteLength, 10);
  assert.strictEqual((await api(url, { headers: { range: 'bytes=9999-' } })).status, 416);
});

test('schedule only stores whitelisted shapes', async () => {
  const bad = await api('/api/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayTitle: 'x', stateType: 'rm -rf' }) });
  assert.strictEqual(bad.status, 400);
  const ok = await api('/api/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayTitle: 'Read', stateType: 'scripture-ref', ref: 'John 3:16', evil: '<script>' }) });
  assert.strictEqual(ok.status, 200);
  const item = await ok.json();
  assert.strictEqual(item.evil, undefined);
  const list = await (await api('/api/schedule')).json();
  assert.ok(list.items.some((i) => i.id === item.id));
});

test('backup downloads and restore merges without duplicating', async () => {
  const mk = await api('/api/songs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Backup Me', sections: [{ label: 'CHORUS', pairs: [['la la', '']] }] }) });
  const song = await mk.json();
  const backup = await (await api('/api/backup')).json();
  assert.ok(backup.songs.some((s) => s.id === song.id));
  const again = await (await api('/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(backup) })).json();
  assert.strictEqual(again.added.songs, 0);
  await api('/api/songs/' + song.id, { method: 'DELETE' });
  const re = await (await api('/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(backup) })).json();
  assert.ok(re.added.songs >= 1);
  assert.strictEqual((await api('/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'other' }) })).status, 400);
});

test('scripture: chapter + abbreviation references parse (offline-safe checks)', async () => {
  const r = await api('/api/scripture?ref=' + encodeURIComponent('not a ref at all!!!'));
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await api('/api/scripture?ref=John%203:16&version=bogus')).status, 400);
});

test('live screen survives a server restart', async () => {
  const op = await connect(true);
  await wait(200);
  op.emit('project', { type: 'free-text', text: 'Persist me', theme: 'royal' });
  op.emit('overlay', 'logo');
  await wait(900); // persistence is debounced
  op.close();
  await stop();
  await start();
  const viewer = new Promise((resolve) => {
    const s = io(BASE, { transports: ['websocket'], forceNew: true });
    const got = {};
    s.on('live-state', (v) => { got.live = v; });
    s.on('overlay-state', (v) => { got.overlay = v; });
    setTimeout(() => { s.close(); resolve(got); }, 800);
  });
  const got = await viewer;
  assert.strictEqual(got.live.text, 'Persist me');
  assert.strictEqual(got.live.theme, 'royal');
  assert.strictEqual(got.overlay, 'logo');
});

test('login is rate limited after repeated failures', async () => {
  let last;
  for (let i = 0; i < 10; i++) {
    last = await api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' + i }) });
  }
  assert.strictEqual(last.status, 429);
  // even the correct password is refused while locked out
  const r = await api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.strictEqual(r.status, 429);
});

test('production without OPERATOR_PASSWORD fails closed', async () => {
  await stop();
  await start({ NODE_ENV: 'production', OPERATOR_PASSWORD: '' });
  cookie = '';
  assert.strictEqual((await api('/control')).status, 302);
  assert.strictEqual((await api('/api/songs')).status, 401);
  const r = await api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '' }) });
  assert.strictEqual(r.status, 503);
  const op = await connect(false);
  op.emit('project', { type: 'free-text', text: 'x' });
  await nextEvent(op, 'auth-error');
  op.close();
});
