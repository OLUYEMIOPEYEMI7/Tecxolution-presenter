// Deepgram voice engine, tested against a local mock of Deepgram's live API:
// key handling (encrypted at rest, never returned), streaming, keyterm fallback,
// error mapping and the idle cost-guard.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { WebSocketServer } = require('ws');

const GOOD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PORT = 5900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-dg-'));
let proc, mock, mockPort, cookie = '';
const seen = { urls: [], auth: [], bytes: 0, keepalive: 0, closeStream: 0 };
const mockCfg = { rejectKeyterm: false, status: 0 };

before(async () => {
  mock = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/projects')) {
      if (req.headers.authorization === 'Token ' + GOOD) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"projects":[]}'); }
      res.writeHead(401); return res.end('{}');
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  mock.on('upgrade', (req, socket, head) => {
    seen.urls.push(req.url); seen.auth.push(req.headers.authorization);
    if (mockCfg.status) { socket.write(`HTTP/1.1 ${mockCfg.status} X\r\nConnection: close\r\n\r\n`); return socket.destroy(); }
    if (mockCfg.rejectKeyterm && req.url.includes('keyterm=')) { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let first = true;
      ws.on('message', (data, isBinary) => {
        if (!isBinary) { const m = JSON.parse(data.toString()); if (m.type === 'KeepAlive') seen.keepalive++; if (m.type === 'CloseStream') seen.closeStream++; return; }
        seen.bytes += data.length;
        if (first) {
          first = false;
          const res = (t, fin) => ws.send(JSON.stringify({ type: 'Results', is_final: fin, speech_final: fin, channel: { alternatives: [{ transcript: t, confidence: 0.97 }, { transcript: t + ' alt', confidence: 0.5 }] } }));
          res('open to john', false);
          setTimeout(() => res('open to john three sixteen', true), 60);
        }
      });
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockPort = mock.address().port;
  await new Promise((resolve, reject) => {
    proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DATA_DIR, MEDIA_DIR: path.join(DATA_DIR, 'm'), THEME_DIR: path.join(DATA_DIR, 't'), BIND_HOST: '127.0.0.1', OPERATOR_PASSWORD: 'pw-123456', NODE_ENV: 'test', DATABASE_URL: '', DEEPGRAM_API_KEY: '', DEEPGRAM_HOST: '127.0.0.1:' + mockPort, DEEPGRAM_INSECURE: '1' } });
    proc.stdout.on('data', (d) => { if (String(d).includes('running at')) resolve(); });
    proc.on('error', reject); setTimeout(() => reject(new Error('no start')), 15000);
  });
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw-123456' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await new Promise((r) => { proc.once('exit', r); proc.kill('SIGTERM'); });
  mock.close(); mock.closeAllConnections && mock.closeAllConnections();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
const api = (p, method = 'GET', body) => fetch(BASE + p, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sock = (withCookie = true) => new Promise((res) => { const s = io(BASE, { extraHeaders: withCookie ? { cookie } : {}, transports: ['websocket'], forceNew: true }); s.once('connect', () => { s.emit('hello', 'control'); res(s); }); });
const collect = (s) => { const st = { status: [], results: [] }; s.on('dg-status', (v) => st.status.push(v)); s.on('dg-result', (v) => st.results.push(v)); return st; };
const pcm = () => Buffer.alloc(3200, 1);

test('key handling: validated, encrypted at rest, never returned', async () => {
  assert.strictEqual((await (await api('/api/voice/status')).json()).configured, false);
  assert.strictEqual((await api('/api/voice/key', 'POST', { key: 'short' })).status, 400);
  const bad = await api('/api/voice/key', 'POST', { key: 'x'.repeat(40) });
  assert.strictEqual(bad.status, 400); // mock answers 401
  const ok = await (await api('/api/voice/key', 'POST', { key: GOOD })).json();
  assert.strictEqual(ok.configured, true); assert.strictEqual(ok.last4, GOOD.slice(-4));
  assert.ok(!JSON.stringify(ok).includes(GOOD));
  const status = JSON.stringify(await (await api('/api/voice/status')).json());
  assert.ok(!status.includes(GOOD));
  const onDisk = fs.readFileSync(path.join(DATA_DIR, 'voice-key.json'), 'utf8');
  assert.ok(!onDisk.includes(GOOD), 'key must be encrypted on disk');
  assert.strictEqual((await fetch(BASE + '/api/voice/status')).status === 200, false); // operator only
});

test('streams audio to Deepgram and returns interim + final transcripts', async () => {
  const s = await sock(); const c = collect(s);
  try {
    s.emit('dg-start', { lang: 'en-NG' });
    await wait(400);
    assert.ok(c.status.some((x) => x.state === 'ready'), JSON.stringify(c.status));
    s.emit('dg-audio', pcm()); await wait(400);
    assert.strictEqual(c.results[0].final, false); assert.strictEqual(c.results[0].text, 'open to john');
    const fin = c.results.find((r) => r.final);
    assert.strictEqual(fin.text, 'open to john three sixteen'); assert.strictEqual(fin.alts.length, 2);
    const url = seen.urls[seen.urls.length - 1];
    assert.match(url, /model=nova-3/); assert.match(url, /encoding=linear16/); assert.match(url, /sample_rate=16000/); assert.match(url, /interim_results=true/);
    assert.match(url, /language=en(&|$)/); assert.match(url, /keyterm=Hebrews/);
    assert.strictEqual(seen.auth[seen.auth.length - 1], 'Token ' + GOOD);
    assert.ok(seen.bytes >= 3200);
    s.emit('dg-stop'); await wait(500);
    assert.ok(seen.closeStream >= 1);
  } finally { s.close(); }
});

test('falls back to a plain request when Deepgram rejects keyterms', async () => {
  mockCfg.rejectKeyterm = true;
  const s = await sock(); const c = collect(s);
  try {
    const before = seen.urls.length;
    s.emit('dg-start', {}); await wait(600);
    assert.ok(c.status.some((x) => x.state === 'ready'), JSON.stringify(c.status));
    assert.strictEqual(seen.urls.length - before, 2);
    assert.ok(!seen.urls[seen.urls.length - 1].includes('keyterm='));
  } finally { mockCfg.rejectKeyterm = false; s.close(); }
});

test('Deepgram errors become clear messages and end the session', async () => {
  for (const [code, reason] of [[401, 'key'], [402, 'credit']]) {
    mockCfg.status = code;
    const s = await sock(); const c = collect(s);
    try { s.emit('dg-start', {}); await wait(500); const closed = c.status.find((x) => x.state === 'closed'); assert.ok(closed, JSON.stringify(c.status)); assert.strictEqual(closed.reason, reason); assert.ok(closed.message.length > 10); }
    finally { mockCfg.status = 0; s.close(); }
  }
});

test('audio from a non-operator socket is ignored; no session without a key', async () => {
  const anon = await sock(false); const c = collect(anon);
  try { anon.emit('dg-start', {}); await wait(300); assert.ok(!c.status.some((x) => x.state === 'ready')); } finally { anon.close(); }
  await api('/api/voice/key', 'DELETE');
  assert.strictEqual((await (await api('/api/voice/status')).json()).configured, false);
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'voice-key.json')));
  const s = await sock(); const c2 = collect(s);
  try { s.emit('dg-start', {}); await wait(300); assert.strictEqual(c2.status[0].reason, 'nokey'); } finally { s.close(); }
});

test('idle guard closes the session to save credit', async () => {
  process.env.DEEPGRAM_HOST = '127.0.0.1:' + mockPort; process.env.DEEPGRAM_INSECURE = '1'; process.env.DEEPGRAM_IDLE_MS = '1200';
  delete require.cache[require.resolve('../lib/deepgram')];
  const { DeepgramSession } = require('../lib/deepgram');
  const closed = await new Promise((resolve) => {
    new DeepgramSession({ key: GOOD, lang: 'en', onClosed: (reason) => resolve(reason) });
    setTimeout(() => resolve('timeout'), 6000);
  });
  assert.strictEqual(closed, 'idle');
  delete process.env.DEEPGRAM_IDLE_MS;
});
