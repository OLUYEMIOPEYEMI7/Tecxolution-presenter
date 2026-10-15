// PowerPoint conversion chain. The "cloud" server gets fake soffice/pdftoppm
// tools (so the real conversion code path runs); the "desktop" server has none,
// so it must fall back to the cloud — and clean the temporary cloud deck up.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const base = 4700 + Math.floor(Math.random() * 200);
const servers = {};
const FAKE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fakebin-'));

function writeFakeTools() {
  fs.writeFileSync(path.join(FAKE_BIN, 'soffice'), `#!/bin/bash
outdir=""; file=""
while [ $# -gt 0 ]; do case "$1" in --outdir) outdir="$2"; shift 2;; --convert-to) shift 2;; -*) shift;; *) file="$1"; shift;; esac; done
b=$(basename "$file"); b="\${b%.*}"
echo "%PDF-1.4 fake" > "$outdir/$b.pdf"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(FAKE_BIN, 'pdftoppm'), `#!/bin/bash
prefix="\${@: -1}"
for n in 1 2 3; do
  printf '\\x89PNG\\r\\n\\x1a\\n' > "$prefix-$n.png"; head -c 64 /dev/zero | tr '\\0' "$n" >> "$prefix-$n.png"
done
`, { mode: 0o755 });
}

function start(name, port, password, extraEnv = {}, extraPath = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wp-pptx-${name}-`));
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PATH: extraPath + process.env.PATH, PORT: String(port), DATA_DIR: dir, MEDIA_DIR: path.join(dir, 'm'), THEME_DIR: path.join(dir, 't'), BIND_HOST: '127.0.0.1', OPERATOR_PASSWORD: password, NODE_ENV: 'test', DATABASE_URL: '', SUPABASE_URL: '', ...extraEnv },
    });
    proc.stdout.on('data', (d) => { if (String(d).includes('running at')) resolve(); });
    setTimeout(() => reject(new Error(name + ' did not start')), 15000);
    servers[name] = { proc, dir, url: `http://127.0.0.1:${port}`, password, cookie: '' };
  });
}
async function login(s) {
  const r = await fetch(s.url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: s.password }) });
  s.cookie = r.headers.get('set-cookie').split(';')[0];
}
const api = (s, p, o = {}) => fetch(s.url + p, { ...o, headers: { cookie: s.cookie, ...(o.headers || {}) } });
const PPTX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 1)]);
const upload = (s, title) => {
  const f = new FormData(); f.append('title', title); f.append('file', new Blob([PPTX]), 'Sermon.pptx');
  return api(s, '/api/media/pptx', { method: 'POST', body: f });
};

before(async () => {
  writeFakeTools();
  await start('cloud', base, 'cloud-pass', {}, FAKE_BIN + ':');
  await start('desktop', base + 1, 'desk-pass', { CLOUD_URL: `http://127.0.0.1:${base}`, CLOUD_PASSWORD: 'cloud-pass' });
  await start('offline', base + 2, 'off-pass');
  for (const s of Object.values(servers)) await login(s);
});
after(async () => {
  for (const s of Object.values(servers)) s.proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  for (const s of Object.values(servers)) fs.rmSync(s.dir, { recursive: true, force: true });
  fs.rmSync(FAKE_BIN, { recursive: true, force: true });
});

test('a server with LibreOffice converts the deck itself', async () => {
  const r = await upload(servers.cloud, 'On the cloud');
  assert.strictEqual(r.status, 200);
  const deck = await r.json();
  assert.strictEqual(deck.slideCount, 3);
  await api(servers.cloud, '/api/media/' + deck.id, { method: 'DELETE' });
});

test('a desktop with no converter falls back to the cloud and leaves no temporary deck behind', async () => {
  const r = await upload(servers.desktop, 'Sunday sermon');
  assert.strictEqual(r.status, 200, await r.clone().text());
  const deck = await r.json();
  assert.strictEqual(deck.slideCount, 3);
  assert.strictEqual(deck.title, 'Sunday sermon');
  const local = (await (await api(servers.desktop, '/api/media')).json()).items;
  assert.deepStrictEqual(local.map((m) => m.title), ['Sunday sermon']);
  const slides = (await (await api(servers.desktop, '/api/media/deck/' + deck.id)).json()).slides;
  assert.strictEqual(slides.length, 3);
  const second = Buffer.from(await (await api(servers.desktop, slides[1].url)).arrayBuffer());
  assert.strictEqual(second[second.length - 1], '2'.charCodeAt(0), 'slides arrive in order');
  const cloud = (await (await api(servers.cloud, '/api/media')).json()).items;
  assert.deepStrictEqual(cloud, [], 'the temporary cloud deck was deleted');
});

test('with no converter and no cloud, the user gets a helpful message (and a PNG-export route)', async () => {
  const r = await upload(servers.offline, 'Nope');
  assert.strictEqual(r.status, 500);
  const msg = (await r.json()).error;
  assert.match(msg, /can't convert PowerPoint/);
  assert.match(msg, /Slide images/);
  assert.deepStrictEqual((await (await api(servers.offline, '/api/media')).json()).items, [], 'nothing half-saved');
});
