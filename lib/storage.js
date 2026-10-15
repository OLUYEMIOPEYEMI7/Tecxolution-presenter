// Supabase Storage for projected media (images, video, PowerPoint slide images).
//
// The presenter server holds no Supabase service-role key. Instead it asks the
// "presenter-storage" Edge Function (protected by a shared secret) for
// short-lived signed upload URLs / deletions, uploads the bytes straight to
// Storage, and the projector then loads media directly from the public bucket
// CDN (cached, Range-capable) instead of streaming it out of Postgres.
const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SECRET = process.env.PRESENTER_STORAGE_SECRET || '';
const BUCKET = 'presenter-media';
const FN_URL = process.env.STORAGE_FN_URL || `${SUPABASE_URL}/functions/v1/presenter-storage`;
const PUBLIC_BASE = (process.env.STORAGE_PUBLIC_BASE || `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}`).replace(/\/+$/, '');
const enabled = !!(SUPABASE_URL && SECRET);

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm',
};
const supportedMime = (m) => !!EXT[m];

// Unguessable object names: random suffix, never derived from user input.
function objectPath(id, mimetype) {
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'media';
  return `media/${safeId}-${crypto.randomBytes(8).toString('hex')}.${EXT[mimetype] || 'bin'}`;
}
const publicUrl = (p) => `${PUBLIC_BASE}/${p}`;

async function callFn(action, paths) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-presenter-secret': SECRET },
    body: JSON.stringify({ action, paths }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`storage gateway ${res.status}: ${body.error || 'error'}`);
  return body;
}

async function removePaths(paths) {
  if (!enabled || !paths.length) return;
  for (let i = 0; i < paths.length; i += 100) await callFn('delete', paths.slice(i, i + 100));
}

// Upload [{ path, buffer, mimetype }] — all signed in one round trip, uploaded
// with limited concurrency. If any upload fails, the ones already stored are
// removed so nothing is orphaned, and the error is thrown to the caller.
async function upload(items, concurrency = 4) {
  if (!items.length) return;
  const { urls } = await callFn('sign', items.map((i) => i.path));
  const byPath = new Map(urls.map((u) => [u.path, u]));
  const done = [];
  let next = 0;
  let failure = null;
  async function worker() {
    while (!failure && next < items.length) {
      const item = items[next++];
      try {
        const signed = byPath.get(item.path);
        if (!signed) throw new Error('no signed url for ' + item.path);
        const form = new FormData(); // same body shape the official client sends
        form.append('cacheControl', '31536000');
        form.append('', new Blob([item.buffer], { type: item.mimetype }));
        const res = await fetch(signed.signedUrl, { method: 'PUT', body: form, headers: { 'x-upsert': 'false' }, signal: AbortSignal.timeout(120000) });
        if (!res.ok) throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
        done.push(item.path);
      } catch (e) {
        failure = e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failure) {
    await removePaths(done).catch(() => {});
    throw failure;
  }
}

// Confirms an object is really readable from the public bucket with the
// expected size — used before the database copy of a file is ever dropped.
async function verify(p, expectedBytes) {
  const res = await fetch(publicUrl(p), { method: 'HEAD', signal: AbortSignal.timeout(20000) });
  if (!res.ok) return false;
  const len = Number(res.headers.get('content-length'));
  return !Number.isFinite(len) || len === 0 ? true : len === expectedBytes;
}

module.exports = { enabled, objectPath, publicUrl, supportedMime, upload, removePaths, verify, callFn };
