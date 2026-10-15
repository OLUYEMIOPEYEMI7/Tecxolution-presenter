// Storage migration tests: a real local Postgres + a mock of the Supabase Edge
// Function and public bucket. Skipped automatically when TEST_DATABASE_URL is unset.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');

const DB = process.env.TEST_DATABASE_URL;
const skip = !DB && 'set TEST_DATABASE_URL to a local Postgres to run';
const SECRET = 'mock-secret';
const PORT = 4700 + Math.floor(Math.random() * 200);
const MOCK_PORT = PORT + 300;
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 5)]);

let pool, proc, mock, cookie = '';
const objects = new Map();
let failSign = false;

function startMock() {
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
      if (url.pathname === '/functions/v1/presenter-storage') {
        if (req.headers['x-presenter-secret'] !== SECRET) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
        if (failSign) { res.writeHead(500); return res.end('{"error":"boom"}'); }
        const { action, paths } = JSON.parse(body.toString());
        res.setHeader('content-type', 'application/json');
        if (action === 'sign') return res.end(JSON.stringify({ urls: paths.map((p) => ({ path: p, signedUrl: `http://127.0.0.1:${MOCK_PORT}/storage/v1/object/upload/sign/presenter-media/${p}?token=t`, token: 't' })) }));
        if (action === 'delete') { paths.forEach((p) => objects.delete(p)); return res.end('{"ok":true}'); }
        return res.end('{"ok":true}');
      }
      const up = url.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/presenter-media\/(.+)$/);
      if (up && req.method === 'PUT') {
        // minimal multipart parse: the part with an empty field name is the file
        const ct = req.headers['content-type'];
        const boundary = '--' + /boundary=(.+)$/.exec(ct)[1];
        const text = body.toString('latin1');
        const parts = text.split(boundary).slice(1, -1);
        const filePart = parts.find((p) => /name=""/.test(p));
        const start = filePart.indexOf('\r\n\r\n') + 4;
        const data = Buffer.from(filePart.slice(start, filePart.length - 2), 'latin1');
        objects.set(up[1], data);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"Key":"ok"}');
      }
      const pub = url.pathname.match(/^\/storage\/v1\/object\/public\/presenter-media\/(.+)$/);
      if (pub && objects.has(pub[1])) {
        const data = objects.get(pub[1]);
        res.writeHead(200, { 'content-length': data.length, 'content-type': 'image/png' });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      res.writeHead(404); res.end('{}');
    });
  }).listen(MOCK_PORT);
}

function startServer() {
  return new Promise((resolve, reject) => {
    proc = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(PORT), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'wp-st-')), OPERATOR_PASSWORD: 'pw', NODE_ENV: 'test', DATABASE_URL: DB, SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`, PRESENTER_STORAGE_SECRET: SECRET },
    });
    let log = '';
    proc.stdout.on('data', (d) => { log += d; if (String(d).includes('running at')) resolve(); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.logs = () => log;
    setTimeout(() => reject(new Error('server did not start')), 15000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, o = {}) => fetch(BASE + p, { redirect: 'manual', ...o, headers: { cookie, ...(o.headers || {}) } });
const upload = async (buf, name = 'a.png', type = 'image/png') => {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  return api('/api/media/image', { method: 'POST', body: fd });
};

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: DB });
  await pool.query('DROP TABLE IF EXISTS wp_media');
  await pool.query(`CREATE TABLE wp_media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_id TEXT, slide_index INT, title TEXT, mimetype TEXT, data BYTEA, external_url TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
  // a "legacy" file that still lives in Postgres, to be migrated at boot
  await pool.query(`INSERT INTO wp_media (id, kind, title, mimetype, data) VALUES ('image-legacy1','image','Legacy','image/png',$1)`, [PNG]);
  startMock();
  await startServer();
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  if (skip) return;
  proc.kill('SIGTERM');
  mock.close();
  await wait(300);
  await pool.end();
});

test('healthz reports supabase storage', { skip }, async () => {
  const h = await (await api('/healthz')).json();
  assert.strictEqual(h.storage, 'supabase');
  assert.strictEqual(h.db, 'up');
});

test('new uploads go to Storage, not Postgres', { skip }, async () => {
  const r = await upload(PNG);
  assert.strictEqual(r.status, 200);
  const { id } = await r.json();
  const { rows } = await pool.query('SELECT storage_path, data FROM wp_media WHERE id=$1', [id]);
  assert.ok(rows[0].storage_path.startsWith('media/'));
  assert.strictEqual(rows[0].data, null);
  assert.ok(objects.get(rows[0].storage_path).equals(PNG), 'object bytes identical');
  const list = await (await api('/api/media')).json();
  const item = list.items.find((i) => i.id === id);
  assert.strictEqual(item.url, `http://127.0.0.1:${MOCK_PORT}/storage/v1/object/public/presenter-media/${rows[0].storage_path}`);
  // old-style link still works (302 to the public object)
  const old = await fetch(`${BASE}/api/media/file/${id}`, { redirect: 'manual' });
  assert.strictEqual(old.status, 302);
  assert.strictEqual(old.headers.get('location'), item.url);
});

test('legacy database files are migrated and verified at boot', { skip }, async () => {
  await wait(7000); // migration starts ~5s after boot
  const { rows } = await pool.query("SELECT storage_path, data FROM wp_media WHERE id='image-legacy1'");
  assert.ok(rows[0].storage_path, 'storage_path set');
  assert.strictEqual(rows[0].data, null, 'database copy dropped only after verification');
  assert.ok(objects.get(rows[0].storage_path).equals(PNG));
  assert.match(proc.logs(), /Media migration finished: 1 moved, 0 left/);
});

test('if Storage is down, uploads fall back to the database', { skip }, async () => {
  failSign = true;
  const r = await upload(PNG, 'b.png');
  failSign = false;
  assert.strictEqual(r.status, 200);
  const { id } = await r.json();
  const { rows } = await pool.query('SELECT storage_path, data FROM wp_media WHERE id=$1', [id]);
  assert.strictEqual(rows[0].storage_path, null);
  assert.ok(Buffer.compare(rows[0].data, PNG) === 0);
  const served = await api(`/api/media/file/${id}`);
  assert.strictEqual(served.status, 200);
  assert.strictEqual((await served.arrayBuffer()).byteLength, PNG.length);
});

test('deleting media also removes the Storage object', { skip }, async () => {
  const { id } = await (await upload(PNG, 'c.png')).json();
  const { rows } = await pool.query('SELECT storage_path FROM wp_media WHERE id=$1', [id]);
  const p = rows[0].storage_path;
  assert.ok(objects.has(p));
  assert.strictEqual((await api('/api/media/' + id, { method: 'DELETE' })).status, 200);
  await wait(300);
  assert.strictEqual(objects.has(p), false);
});

test('gateway rejects a wrong secret', { skip }, async () => {
  const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/functions/v1/presenter-storage`, { method: 'POST', headers: { 'x-presenter-secret': 'nope' }, body: '{}' });
  assert.strictEqual(r.status, 401);
});
