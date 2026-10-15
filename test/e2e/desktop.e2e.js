// End-to-end test of the real desktop app (needs a display: on Linux run with xvfb-run).
//   npm run test:desktop
const { _electron: electron } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const REPO = path.join(__dirname, '..', '..');
let failures = 0;
const ok = (n, c, extra='') => { if (!c) failures++; console.log((c ? 'PASS' : 'FAIL') + ' - ' + n + (extra ? '  ['+extra+']' : '')); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  // ---- a stand-in "cloud" copy with some content
  const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cloud-'));
  const cloud = spawn('node', ['server.js'], { cwd: REPO, env: { ...process.env, PORT: '4950', DATA_DIR: cloudDir, MEDIA_DIR: cloudDir+'/m', THEME_DIR: cloudDir+'/t', BIND_HOST: '127.0.0.1', OPERATOR_PASSWORD: 'cloud-pass', NODE_ENV: 'test', DATABASE_URL: '', SUPABASE_URL: '' } });
  await new Promise(r => cloud.stdout.on('data', d => String(d).includes('running at') && r()));
  const lg = await fetch('http://127.0.0.1:4950/api/login', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({password:'cloud-pass'}) });
  const cookie = lg.headers.get('set-cookie').split(';')[0];
  const post = (p, b) => fetch('http://127.0.0.1:4950'+p, { method:'POST', headers:{'content-type':'application/json', cookie}, body: JSON.stringify(b) }).then(r=>r.json());
  await post('/api/songs', { title: 'Cloud Hymn', artist: 'Someone', sections: [{ label:'VERSE 1', pairs:[['A line only the cloud had','']] }] });
  await post('/api/songs', { title: 'Baruch Hashem Adonai (Live)', artist:'Dunsin Oyekan', sections: [{ label:'NOTE', pairs:[['(Lyrics not yet added for this song.)','']] }] });

  // ---- the desktop app, in a fresh user-data folder
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-userdata-'));
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [REPO, '--no-sandbox'],
    env: { ...process.env, WP_TEST: '1', WP_TEST_UPDATE: '9.9.9', WP_USER_DATA: userData, WP_PORT: '4960' },
  });
  const win = await app.firstWindow();
  const errs = [];
  win.on('pageerror', e => errs.push('pageerror: ' + e.message));
  win.on('console', m => { if (m.type()==='error' && !/fonts\.g|ERR_|Failed to load resource|favicon/.test(m.text())) errs.push('console: '+m.text()); });
  await win.waitForSelector('#tabbtn-slides', { timeout: 20000 });
  await wait(1200);

  ok('control room loads from the LOCAL server', /^http:\/\/127\.0\.0\.1:\d+\/control/.test(win.url()), win.url());
  ok('signed in automatically (no password prompt)', await win.locator('#tabbtn-slides').isVisible());
  ok('window.desktop bridge present', await win.evaluate(() => !!(window.desktop && window.desktop.isDesktop)));
  const info = await win.evaluate(() => window.desktop.info());
  ok('app version reported', /^\d+\.\d+\.\d+/.test(info.version), info.version);
  ok('data lives in the user-data folder', info.dataDir.startsWith(userData), info.dataDir);

  // ---- OFFLINE scripture (this sandbox has no route to the real Bible API anyway)
  await win.click('#tabbtn-scripture');
  await win.fill('#scripture-input', 'Genesis 1:1'); await win.keyboard.press('Enter'); await wait(900);
  const prev = win.frameLocator('iframe').nth(0);
  ok('KJV scripture works with no internet', /In the beginning/.test(await prev.locator('#stage-content').innerText()));
  ok('verse navigator appears', await win.locator('#verse-bar').isVisible());
  ok('chapter list is available offline (31 verses)', await win.locator('.verse-row').count() === 31);

  // ---- songs + hymnal are local
  await win.click('#tabbtn-slides');
  await win.fill('#song-search', 'name of the lord'); await wait(900);
  ok('lyric search works locally', await win.locator('.song-item').count() > 0);
  await win.fill('#song-search', '');

  // ---- update banner (simulated 9.9.9 download)
  await win.waitForSelector('#update-banner:not([hidden]) #ub-now', { timeout: 8000 });
  ok('update banner offers "Restart now" for 9.9.9', /9\.9\.9/.test(await win.locator('#update-banner').innerText()));
  await win.click('#ub-later'); await wait(200);
  ok('"Later" dismisses it', await win.locator('#update-banner').isHidden());

  // ---- projector window
  await win.evaluate(() => openDisplay()); await wait(2500);
  const wins = app.windows();
  const proj = wins.find(w => /\/display/.test(w.url()));
  ok('projector opens as its own window', !!proj && wins.length >= 2, wins.map(w=>w.url().replace(/^http:\/\/127.0.0.1:\d+/,'')).join(' | '));
  await win.click('#tabbtn-scripture'); await win.locator('button:has-text("GO LIVE")').click(); await wait(900);
  ok('GO LIVE reaches the projector window', proj && /In the beginning/.test(await proj.locator('#stage-content').innerText()));
  ok('projector has no fullscreen prompt', proj && await proj.locator('#fullscreen-prompt-btn').count() === 0);
  ok('projector hides the mouse cursor', proj && await proj.evaluate(() => document.documentElement.classList.contains('desktop-projector')));

  // ---- cloud sync through the real UI
  await win.click('#tabbtn-tools');
  ok('cloud box present in Tools', await win.locator('#cloud-box').isVisible());
  ok('Voice Detect disabled with an explanation', await win.locator('#voice-start-btn').isDisabled() && await win.locator('.desktop-note').count() === 1);
  await win.fill('#cloud-url', 'http://127.0.0.1:4950'); await win.fill('#cloud-pass', 'wrong');
  await win.click('#cloud-save'); await wait(1500);
  ok('a wrong cloud password is refused', !(await win.evaluate(() => window.desktop.sync.status())).configured);
  await win.fill('#cloud-pass', 'cloud-pass'); await win.click('#cloud-save');
  await win.waitForFunction(() => /Synced/.test(document.getElementById('net-chip').textContent), null, { timeout: 20000 });
  ok('chip shows "Synced"', true, await win.locator('#net-chip').innerText());
  const songs = await win.evaluate(() => fetch('/api/songs').then(r => r.json()).then(d => d.songs.filter(s => s.source === 'custom').map(s => s.title)));
  ok('cloud songs arrived on the PC', songs.includes('Cloud Hymn') && songs.includes('Baruch Hashem Adonai (Live)'), songs.join(', '));
  // ... then the PC fills in the stub (offline work) and syncs it back up
  const stubSong = await win.evaluate(() => fetch('/api/songs?q=baruch').then(r => r.json()).then(d => d.songs[0]));
  await win.evaluate((id) => fetch('/api/songs/' + id, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title:'Baruch Hashem Adonai (Live)', artist:'Dunsin Oyekan', sections:[{label:'VERSE 1', pairs:[['lyrics typed on the PC','']]}] }) }), stubSong.id);
  await win.evaluate(() => window.desktop.sync.run()); await wait(1500);
  const cloudSongs = await fetch('http://127.0.0.1:4950/api/backup', { headers:{ cookie } }).then(r=>r.json());
  const onCloud = cloudSongs.songs.find(s => s.title.startsWith('Baruch'));
  ok('lyrics typed on the PC reached the cloud copy', onCloud && onCloud.sections[0].pairs[0][0] === 'lyrics typed on the PC');
  const settingsRaw = fs.readFileSync(path.join(userData, 'desktop-settings.json'), 'utf8');
  ok('cloud password is not stored in plain text', !settingsRaw.includes('cloud-pass'));

  ok('no JavaScript errors in the control room', errs.length === 0, errs.join(' ; '));
  if (process.env.WP_SCREENSHOT) await win.screenshot({ path: process.env.WP_SCREENSHOT });

  // ---- quit: live state must be saved for the next launch
  await app.close();
  await wait(500);
  const st = JSON.parse(fs.readFileSync(path.join(userData, 'data', 'state.json'), 'utf8'));
  ok('live screen saved on quit', st.liveState && st.liveState.type === 'scripture' && /Genesis 1:1/.test(st.liveState.reference), st.liveState && st.liveState.reference);
  cloud.kill('SIGTERM');
  console.log(failures ? failures + ' check(s) FAILED' : 'All desktop checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
