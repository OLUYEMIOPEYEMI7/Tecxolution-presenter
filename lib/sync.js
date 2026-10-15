// Cloud sync for the desktop app: keeps the PC's local copy and the online
// copy (Render + Supabase) in step. It talks to both servers over their normal
// authenticated HTTP APIs, so no database credentials ever live on the PC.
//
// Policy (deliberately conservative — nothing is ever silently overwritten):
//  * Songs: added on either side are copied to the other. If a song exists on
//    both and differs, the side that has real lyrics beats a title-only stub;
//    otherwise the newer edit (updatedAt) wins. Identical songs are left alone.
//  * Announcements / saved texts: union (matched by text).
//  * Media (images, videos, PowerPoint decks): copied both ways, never duplicated.
//  * Schedule: copied from the cloud only when the PC's schedule is empty.
//  * Deletions are NOT propagated (a deleted item can come back from the other side).
const { isPlaceholderSection } = require('./lyrics');

class Offline extends Error {}
class AuthFailed extends Error {}

function client(base, password) {
  base = base.replace(/\/+$/, '');
  let cookie = '';
  async function raw(url, opts = {}, timeout = 30000) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw new Offline(e.message || 'network error');
    }
  }
  async function login() {
    const r = await raw(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    if (r.status === 401 || r.status === 429) throw new AuthFailed(base + ': ' + ((await r.json().catch(() => ({}))).error || 'login refused'));
    if (!r.ok) throw new Offline(`${base}: login failed (${r.status})`);
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    cookie = set.map((c) => c.split(';')[0]).join('; ');
  }
  async function call(path, opts = {}, timeout) {
    const withCookie = () => ({ ...opts, headers: { ...(opts.headers || {}), cookie } });
    let r = await raw(base + path, withCookie(), timeout);
    if (r.status === 401) { await login(); r = await raw(base + path, withCookie(), timeout); }
    return r;
  }
  async function json(path, opts, timeout) {
    const r = await call(path, opts, timeout);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path}: ${body.error || r.status}`);
    return body;
  }
  const postJson = (path, body) => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // Fetch a media file: relative paths need the session, absolute (public CDN) URLs do not.
  async function bytes(url) {
    const r = url.startsWith('/') ? await call(url, {}, 120000) : await raw(url, {}, 120000);
    if (!r.ok) throw new Error(`download ${url}: ${r.status}`);
    return { data: Buffer.from(await r.arrayBuffer()), type: (r.headers.get('content-type') || 'application/octet-stream').split(';')[0] };
  }
  const abs = (url) => (url.startsWith('/') ? base + url : url);
  return { base, login, call, json, postJson, bytes, abs };
}

const hasLyrics = (s) => (s.sections || []).some((sec) => !isPlaceholderSection(sec));
const sameSong = (a, b) => JSON.stringify([a.title, a.artist || '', a.sections]) === JSON.stringify([b.title, b.artist || '', b.sections]);
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const backupShell = (extra) => ({ app: 'worship-presenter', version: 1, songs: [], announcements: [], freeTexts: [], ...extra });

async function syncSongsAndTexts(L, C, sum) {
  const [lb, cb] = await Promise.all([L.json('/api/backup'), C.json('/api/backup')]);
  const lm = new Map(lb.songs.map((s) => [s.id, s]));
  const cm = new Map(cb.songs.map((s) => [s.id, s]));
  const toLocal = [], toCloud = [];
  for (const id of new Set([...lm.keys(), ...cm.keys()])) {
    const l = lm.get(id), c = cm.get(id);
    if (l && !c) { toCloud.push(l); continue; }
    if (c && !l) { toLocal.push(c); continue; }
    if (sameSong(l, c)) continue;
    let winner = null;
    const lh = hasLyrics(l), ch = hasLyrics(c);
    if (lh && !ch) winner = 'local';
    else if (ch && !lh) winner = 'cloud';
    else {
      const tl = Date.parse(l.updatedAt) || 0, tc = Date.parse(c.updatedAt) || 0;
      if (tl > tc) winner = 'local'; else if (tc > tl) winner = 'cloud';
    }
    if (!winner) continue;
    const [src, dst, dstClient] = winner === 'local' ? [l, c, C] : [c, l, L];
    await dstClient.json('/api/songs/' + encodeURIComponent(id), {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: src.title, artist: src.artist || '', sections: src.sections, updatedAt: src.updatedAt }),
    });
    sum.songs[winner === 'local' ? 'updatedCloud' : 'updatedLocal']++;
    void dst;
  }
  for (const part of chunk(toLocal, 40)) await L.postJson('/api/restore', backupShell({ songs: part }));
  for (const part of chunk(toCloud, 40)) await C.postJson('/api/restore', backupShell({ songs: part }));
  sum.songs.pulled += toLocal.length;
  sum.songs.pushed += toCloud.length;

  // saved announcements + free texts: union by text (the restore endpoint de-duplicates)
  const lAnn = new Set(lb.announcements.map((a) => a.text)), cAnn = new Set(cb.announcements.map((a) => a.text));
  const lFt = new Set(lb.freeTexts.map((a) => a.text)), cFt = new Set(cb.freeTexts.map((a) => a.text));
  const annToLocal = cb.announcements.filter((a) => !lAnn.has(a.text)), annToCloud = lb.announcements.filter((a) => !cAnn.has(a.text));
  const ftToLocal = cb.freeTexts.filter((a) => !lFt.has(a.text)), ftToCloud = lb.freeTexts.filter((a) => !cFt.has(a.text));
  if (annToLocal.length || ftToLocal.length) await L.postJson('/api/restore', backupShell({ announcements: annToLocal, freeTexts: ftToLocal }));
  if (annToCloud.length || ftToCloud.length) await C.postJson('/api/restore', backupShell({ announcements: annToCloud, freeTexts: ftToCloud }));
  sum.texts.pulled += annToLocal.length + ftToLocal.length;
  sum.texts.pushed += annToCloud.length + ftToCloud.length;
  return { localSchedule: lb.schedule || [], cloudSchedule: cb.schedule || [] };
}

// ---- media -----------------------------------------------------------------
function form(fields, files) {
  const f = new FormData();
  Object.entries(fields).forEach(([k, v]) => v != null && f.append(k, v));
  files.forEach(({ field, data, type, name }) => f.append(field, new Blob([data], { type }), name));
  return f;
}

// Copies one media item from `from` to `to`; returns the new id on `to`.
async function copyMedia(item, from, to) {
  if (item.kind === 'deck') {
    const { slides } = await from.json('/api/media/deck/' + encodeURIComponent(item.id));
    const files = [];
    for (let i = 0; i < slides.length; i++) {
      const b = await from.bytes(slides[i].url);
      files.push({ field: 'files', data: b.data, type: b.type, name: `slide${String(i + 1).padStart(3, '0')}.png` });
    }
    const r = await to.call('/api/media/deck/import', { method: 'POST', body: form({ title: item.title }, files) }, 180000);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'deck import failed');
    return body.id;
  }
  if (item.kind === 'video' && item.external) {
    const r = await to.call('/api/media/video', { method: 'POST', body: form({ title: item.title, url: item.url }, []) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'video link failed');
    return body.id;
  }
  const b = await from.bytes(item.url);
  const ext = item.kind === 'video' ? 'mp4' : 'png';
  const r = await to.call(item.kind === 'video' ? '/api/media/video' : '/api/media/image', {
    method: 'POST', body: form({ title: item.title }, [{ field: 'file', data: b.data, type: b.type, name: `${(item.title || 'media').replace(/[^\w.-]+/g, '_')}.${ext}` }]),
  }, 180000);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'upload failed');
  return body.id;
}

async function syncMedia(L, C, state, sum) {
  state.cloudToLocal = state.cloudToLocal || {};
  state.localToCloud = state.localToCloud || {};
  const [lm, cm] = (await Promise.all([L.json('/api/media'), C.json('/api/media')])).map((x) => x.items || []);
  for (const c of cm) {
    if (state.cloudToLocal[c.id] || Object.values(state.localToCloud).includes(c.id)) continue;
    try {
      const localId = await copyMedia(c, C, L);
      state.cloudToLocal[c.id] = localId; state.localToCloud[localId] = c.id;
      sum.media.pulled++;
    } catch (e) { sum.errors.push(`download "${c.title}": ${e.message}`); }
  }
  for (const l of lm) {
    if (state.localToCloud[l.id] || Object.values(state.cloudToLocal).includes(l.id)) continue;
    try {
      const cloudId = await copyMedia(l, L, C);
      state.localToCloud[l.id] = cloudId; state.cloudToLocal[cloudId] = l.id;
      sum.media.pushed++;
    } catch (e) { sum.errors.push(`upload "${l.title}": ${e.message}`); }
  }
  return { cloudItems: cm };
}

// Cloud schedule rows reference cloud media ids; rewrite them to the local copies.
function remapScheduleItem(item, state, cloudItems) {
  const copy = { ...item };
  delete copy.id;
  if (item.stateType === 'media-deck') {
    const local = state.cloudToLocal[item.deckId];
    if (!local) return null;
    copy.deckId = local;
  } else if (item.stateType === 'media-image' || item.stateType === 'media-video') {
    const hit = cloudItems.find((c) => c.url === item.url || item.url === `/api/media/file/${c.id}`);
    const local = hit && state.cloudToLocal[hit.id];
    if (!local) return item.url && item.url.startsWith('http') ? copy : null; // external links work as-is
    copy.url = `/api/media/file/${local}`;
  }
  return copy;
}

// ---- entry point -----------------------------------------------------------
async function runSync({ local, cloud, state = {} }) {
  const L = client(local.url, local.password);
  const C = client(cloud.url, cloud.password);
  const sum = {
    ok: true,
    songs: { pulled: 0, pushed: 0, updatedLocal: 0, updatedCloud: 0 },
    texts: { pulled: 0, pushed: 0 },
    media: { pulled: 0, pushed: 0 },
    schedule: { pulled: 0 },
    errors: [],
  };
  try {
    await L.login();
    await C.login();
    const sched = await syncSongsAndTexts(L, C, sum);
    const { cloudItems } = await syncMedia(L, C, state, sum);
    if (!sched.localSchedule.length && sched.cloudSchedule.length) {
      for (const item of sched.cloudSchedule) {
        const body = remapScheduleItem(item, state, cloudItems);
        if (!body) { sum.errors.push(`schedule: skipped "${item.displayTitle}" (its media is not available locally)`); continue; }
        await L.postJson('/api/schedule', body);
        sum.schedule.pulled++;
      }
    }
  } catch (e) {
    if (e instanceof Offline) return { ...sum, ok: false, offline: true, error: 'No connection to the cloud copy: ' + e.message };
    if (e instanceof AuthFailed) return { ...sum, ok: false, authFailed: true, error: 'Sign-in refused — check the cloud address and password. (' + e.message + ')' };
    return { ...sum, ok: false, error: e.message };
  }
  sum.at = new Date().toISOString();
  return sum;
}

// Converts a PowerPoint deck using the cloud copy (which has LibreOffice): upload it,
// collect the slide images, then delete the temporary cloud deck again so it is
// not later synced back down as a duplicate.
async function convertViaCloud(cloud, buffer, ext) {
  const C = client(cloud.url, cloud.password);
  await C.login();
  const type = ext === '.ppt' ? 'application/vnd.ms-powerpoint' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const r = await C.call('/api/media/pptx', { method: 'POST', body: form({ title: 'temporary conversion' }, [{ field: 'file', data: buffer, type, name: 'deck' + ext }]) }, 240000);
  const deck = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(deck.error || 'the cloud could not convert it');
  try {
    const { slides } = await C.json('/api/media/deck/' + encodeURIComponent(deck.id));
    const out = [];
    for (const sl of slides) out.push((await C.bytes(sl.url)).data);
    return out;
  } finally {
    await C.call('/api/media/' + encodeURIComponent(deck.id), { method: 'DELETE' }).catch(() => {});
  }
}

// Quick reachability + credentials check (used by "Test connection").
async function testCloud(cloud) {
  try {
    const C = client(cloud.url, cloud.password);
    await C.login();
    const v = await C.json('/api/version').catch(() => ({}));
    return { ok: true, version: v.version || null };
  } catch (e) {
    if (e instanceof AuthFailed) return { ok: false, authFailed: true, error: 'Password refused by the cloud copy.' };
    return { ok: false, offline: e instanceof Offline, error: e.message };
  }
}

module.exports = { runSync, testCloud, convertViaCloud };
