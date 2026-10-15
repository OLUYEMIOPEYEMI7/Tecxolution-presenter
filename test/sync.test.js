// Sync tests: two real servers ("cloud" and "desktop", each with its own data
// folder) are synchronised through lib/sync.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSync, testCloud } = require('../lib/sync');

const base = 4300 + Math.floor(Math.random() * 300);
const servers = {};
const PNG = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, n)]);

function start(name, port, password) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wp-sync-${name}-`));
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(port), DATA_DIR: dir, MEDIA_DIR: path.join(dir, 'media'), THEME_DIR: path.join(dir, 'themes'), BIND_HOST: '127.0.0.1', OPERATOR_PASSWORD: password, NODE_ENV: 'test', DATABASE_URL: '', SUPABASE_URL: '' },
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
const json = async (s, p, o) => (await api(s, p, o)).json();
const send = (s, p, method, body) => json(s, p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const stub = (title, artist) => ({ title, artist, sections: [{ label: 'NOTE', pairs: [['(Lyrics not yet added for this song.)', '']] }] });
const lyr = (title, line, artist = '') => ({ title, artist, sections: [{ label: 'VERSE 1', pairs: [[line, '']] }] });
const upImage = (s, n, title) => {
  const f = new FormData(); f.append('title', title); f.append('file', new Blob([PNG(n)], { type: 'image/png' }), title + '.png');
  return json(s, '/api/media/image', { method: 'POST', body: f });
};
const upDeck = (s, title, ns) => {
  const f = new FormData(); f.append('title', title); ns.forEach((n) => f.append('files', new Blob([PNG(n)], { type: 'image/png' }), `s${n}.png`));
  return json(s, '/api/media/deck/import', { method: 'POST', body: f });
};
const cfg = () => ({ local: { url: servers.desktop.url, password: servers.desktop.password }, cloud: { url: servers.cloud.url, password: servers.cloud.password } });
const state = {};

before(async () => {
  await start('cloud', base, 'cloud-pass');
  await start('desktop', base + 1, 'desktop-pass');
  await login(servers.cloud); await login(servers.desktop);
});
after(async () => {
  for (const s of Object.values(servers)) { s.proc.kill('SIGTERM'); }
  await new Promise((r) => setTimeout(r, 400));
  for (const s of Object.values(servers)) fs.rmSync(s.dir, { recursive: true, force: true });
});

test('a first sync copies everything the PC is missing, both ways', async () => {
  const C = servers.cloud, D = servers.desktop;
  // cloud: a title-only stub, a song with lyrics, saved texts, an image, a 2-slide deck, a schedule using them
  const cloudStub = await send(C, '/api/songs', 'POST', stub('Baruch Hashem Adonai (Live)', 'Dunsin Oyekan'));
  const cloudOnly = await send(C, '/api/songs', 'POST', lyr('Cloud Only Song', 'sung in the cloud'));
  await send(C, '/api/announcements', 'POST', { text: 'Cloud notice' });
  await send(C, '/api/free-texts', 'POST', { text: 'Cloud welcome' });
  const cImg = await upImage(C, 11, 'Cloud Image');
  const cDeck = await upDeck(C, 'Cloud Deck', [21, 22]);
  await send(C, '/api/schedule', 'POST', { displayTitle: 'Cloud song', stateType: 'whole-song', songId: cloudOnly.id });
  await send(C, '/api/schedule', 'POST', { displayTitle: 'Cloud deck', stateType: 'media-deck', deckId: cDeck.id });
  await send(C, '/api/schedule', 'POST', { displayTitle: 'Cloud image', stateType: 'media-image', url: cImg.url });
  // desktop: the SAME stub (so it exists on both sides) that the operator then filled in offline, plus a local-only song, text, image, deck
  const shared = (await send(D, '/api/restore', 'POST', { app: 'worship-presenter', songs: [{ ...cloudStub, ...stub('Baruch Hashem Adonai (Live)', 'Dunsin Oyekan') }] }));
  assert.strictEqual(shared.added.songs, 1);
  await send(D, '/api/songs/' + cloudStub.id, 'PUT', { title: 'Baruch Hashem Adonai (Live)', artist: 'Dunsin Oyekan', sections: [{ label: 'VERSE 1', pairs: [['local lyrics typed on the PC', '']] }] });
  const localOnly = await send(D, '/api/songs', 'POST', lyr('Local Only Song', 'sung on the pc'));
  await send(D, '/api/announcements', 'POST', { text: 'Local notice' });
  await upImage(D, 12, 'Local Image');
  await upDeck(D, 'Local Deck', [31]);

  const r = await runSync({ ...cfg(), state });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.songs.pulled, 1, 'cloud-only song pulled to the PC');
  assert.strictEqual(r.songs.pushed, 1, 'PC-only song pushed to the cloud');
  assert.strictEqual(r.songs.updatedCloud, 1, 'the filled-in stub replaced the cloud stub');
  assert.deepStrictEqual([r.media.pulled, r.media.pushed], [2, 2]);
  assert.strictEqual(r.schedule.pulled, 3);

  const dBackup = await json(D, '/api/backup'), cBackup = await json(C, '/api/backup');
  const titles = (b) => b.songs.map((s) => s.title).sort();
  assert.deepStrictEqual(titles(dBackup), titles(cBackup), 'same songs on both sides');
  assert.ok(titles(dBackup).includes('Cloud Only Song') && titles(dBackup).includes('Local Only Song'));
  const stubOnCloud = cBackup.songs.find((s) => s.id === cloudStub.id);
  assert.strictEqual(stubOnCloud.sections[0].pairs[0][0], 'local lyrics typed on the PC');
  assert.deepStrictEqual(dBackup.announcements.map((a) => a.text).sort(), ['Cloud notice', 'Local notice']);
  assert.deepStrictEqual(cBackup.announcements.map((a) => a.text).sort(), ['Cloud notice', 'Local notice']);
  assert.strictEqual(dBackup.freeTexts.length, 1);

  // media arrived intact on the PC
  const dm = (await json(D, '/api/media')).items;
  assert.deepStrictEqual(dm.map((m) => m.title).sort(), ['Cloud Deck', 'Cloud Image', 'Local Deck', 'Local Image']);
  const img = dm.find((m) => m.title === 'Cloud Image');
  assert.ok(Buffer.from(await (await api(D, img.url)).arrayBuffer()).equals(PNG(11)));
  const deck = dm.find((m) => m.title === 'Cloud Deck');
  const slides = (await json(D, '/api/media/deck/' + deck.id)).slides;
  assert.strictEqual(slides.length, 2);
  assert.ok(Buffer.from(await (await api(D, slides[1].url)).arrayBuffer()).equals(PNG(22)), 'slides in order');
  const cm = (await json(C, '/api/media')).items;
  assert.deepStrictEqual(cm.map((m) => m.title).sort(), ['Cloud Deck', 'Cloud Image', 'Local Deck', 'Local Image']);

  // schedule pulled with media ids remapped to the PC's own copies
  const sched = (await json(D, '/api/schedule')).items;
  assert.deepStrictEqual(sched.map((i) => i.displayTitle), ['Cloud song', 'Cloud deck', 'Cloud image']);
  assert.strictEqual(sched[1].deckId, deck.id, 'deck reference points at the local deck');
  assert.strictEqual(sched[2].url, `/api/media/file/${img.id}`);
  assert.ok(localOnly.id);
});

test('running sync again changes nothing (no duplicates)', async () => {
  const r = await runSync({ ...cfg(), state });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([r.songs.pulled, r.songs.pushed, r.songs.updatedLocal, r.songs.updatedCloud], [0, 0, 0, 0]);
  assert.deepStrictEqual([r.texts.pulled, r.texts.pushed, r.media.pulled, r.media.pushed, r.schedule.pulled], [0, 0, 0, 0, 0]);
  assert.strictEqual((await json(servers.desktop, '/api/media')).items.length, 4);
  assert.strictEqual((await json(servers.desktop, '/api/schedule')).items.length, 3);
});

test('when both sides have lyrics, the newer edit wins', async () => {
  const C = servers.cloud, D = servers.desktop;
  const song = await send(C, '/api/songs', 'POST', lyr('Conflict Song', 'original'));
  await runSync({ ...cfg(), state });
  await send(C, '/api/songs/' + song.id, 'PUT', { title: 'Conflict Song', sections: lyr('x', 'edited on cloud').sections, updatedAt: '2026-01-01T00:00:00.000Z' });
  await send(D, '/api/songs/' + song.id, 'PUT', { title: 'Conflict Song', sections: lyr('x', 'edited on pc later').sections, updatedAt: '2026-02-01T00:00:00.000Z' });
  const r = await runSync({ ...cfg(), state });
  assert.strictEqual(r.songs.updatedCloud, 1);
  const onCloud = (await json(C, '/api/backup')).songs.find((s) => s.id === song.id);
  assert.strictEqual(onCloud.sections[0].pairs[0][0], 'edited on pc later');
  assert.strictEqual((await runSync({ ...cfg(), state })).songs.updatedCloud, 0, 'settled — no ping-pong');
});

test('wrong cloud password and unreachable cloud are reported clearly, not as crashes', async () => {
  const bad = await runSync({ local: cfg().local, cloud: { url: servers.cloud.url, password: 'nope' }, state: {} });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.authFailed, true);
  assert.deepStrictEqual(await testCloud({ url: servers.cloud.url, password: 'nope' }), { ok: false, authFailed: true, error: 'Password refused by the cloud copy.' });
  const good = await testCloud({ url: servers.cloud.url, password: servers.cloud.password });
  assert.strictEqual(good.ok, true);
  const off = await runSync({ local: cfg().local, cloud: { url: 'http://127.0.0.1:1', password: 'x' }, state: {} });
  assert.deepStrictEqual([off.ok, off.offline], [false, true]);
});
