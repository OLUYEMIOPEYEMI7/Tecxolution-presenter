// Security primitives for the presenter: operator authentication (signed,
// HttpOnly session cookie — no extra dependencies), login rate limiting,
// security headers, same-origin checks, and strict validation of everything
// that can reach the projector screen.
const crypto = require('crypto');

const OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD || '';
// Optional second password for volunteers: can drive the show from a phone
// (next/prev, go live, black/logo, alerts) but cannot edit, upload or delete.
const REMOTE_PASSWORD = process.env.REMOTE_PASSWORD || '';
const IS_PROD = process.env.NODE_ENV === 'production';
// Fail closed in production: with no password configured nobody can operate
// the presenter (rather than leaving it open to the whole internet).
const AUTH_CONFIGURED = !!OPERATOR_PASSWORD;
const AUTH_ENABLED = AUTH_CONFIGURED || IS_PROD;

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('wp-session|' + (OPERATOR_PASSWORD || 'dev-only')).digest('hex');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'wp_session';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function sign(data) {
  return b64url(crypto.createHmac('sha256', SESSION_SECRET).update(data).digest());
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function issueToken(role) {
  const payload = b64url(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, r: role, n: crypto.randomBytes(8).toString('hex') }));
  return payload + '.' + sign(payload);
}

// Returns 'operator' | 'remote' for a valid, unexpired token, else null.
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { exp, r } = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof exp !== 'number' || exp <= Date.now()) return null;
    return r === 'remote' ? 'remote' : 'operator';
  } catch (e) {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function roleFromCookieHeader(header) {
  if (!AUTH_ENABLED) return 'operator'; // local development without a password
  if (!AUTH_CONFIGURED) return null; // production but unconfigured: locked
  return verifyToken(parseCookies(header)[COOKIE_NAME]);
}
const isOperatorFromCookieHeader = (header) => roleFromCookieHeader(header) === 'operator';

// Which role does this password grant? (null = wrong password)
function checkPassword(candidate) {
  if (!AUTH_CONFIGURED || typeof candidate !== 'string') return null;
  if (safeEqual(candidate, OPERATOR_PASSWORD)) return 'operator';
  if (REMOTE_PASSWORD && safeEqual(candidate, REMOTE_PASSWORD)) return 'remote';
  return null;
}

function setSessionCookie(res, role = 'operator') {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${issueToken(role)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${IS_PROD ? '; Secure' : ''}`
  );
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${IS_PROD ? '; Secure' : ''}`);
}

// Authenticated responses must never sit in a shared computer's browser cache.
function noStore(res) { res.setHeader('Cache-Control', 'no-store'); }

function deny(req, res, role) {
  const isApi = req.originalUrl.startsWith('/api/');
  if (role === 'remote') { // signed in, but as a volunteer: not allowed here
    if (isApi) return res.status(403).json({ error: 'Your sign-in is remote-only — ask the operator for this.' });
    return res.redirect('/remote');
  }
  if (isApi) return res.status(401).json({ error: 'Not signed in', login: '/login' });
  return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

// Express middleware: operator-only. API callers get 401/403 JSON, pages redirect.
function requireOperator(req, res, next) {
  const role = roleFromCookieHeader(req.headers.cookie);
  if (role === 'operator') { noStore(res); return next(); }
  return deny(req, res, role);
}
// Any signed-in role (operator or remote volunteer).
function requireAnyRole(req, res, next) {
  const role = roleFromCookieHeader(req.headers.cookie);
  if (role) { noStore(res); return next(); }
  return deny(req, res, null);
}

// ---- Login brute-force protection (per client IP, in memory) ----
const failures = new Map(); // ip -> { count, first }
const MAX_FAILS = 8;
const WINDOW_MS = 10 * 60 * 1000;
function loginBlocked(ip) {
  const f = failures.get(ip);
  if (!f) return 0;
  if (Date.now() - f.first > WINDOW_MS) { failures.delete(ip); return 0; }
  return f.count >= MAX_FAILS ? Math.ceil((WINDOW_MS - (Date.now() - f.first)) / 1000) : 0;
}
function recordLoginFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}
function clearLoginFailures(ip) { failures.delete(ip); }
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of failures) if (now - f.first > WINDOW_MS) failures.delete(ip);
}, 5 * 60 * 1000).unref();

// ---- Light-weight general rate limiter for expensive endpoints ----
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return res.status(429).json({ error: message || 'Too many requests — slow down a moment.' });
    next();
  };
}

// ---- Security headers ----
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com data:',
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com",
  "connect-src 'self' ws: wss: https://fonts.googleapis.com https://fonts.gstatic.com",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

// Blocks cross-site state-changing requests (defence-in-depth on top of SameSite=Lax).
function sameOriginWrites(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked' });
    } catch (e) {
      return res.status(403).json({ error: 'Bad origin' });
    }
  }
  next();
}

// ---------------------------------------------------------------------------
// Validation: everything the operator sends ends up on a projector screen and
// in the database, so shape and size are enforced on the server — never just
// trusted from the browser.
// ---------------------------------------------------------------------------
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const SAFE_ASSET_PATH = /^\/(images|api)\/[A-Za-z0-9._\-\/]{1,200}$/;
const SAFE_URL = /^(https?:\/\/[^\s"'<>\\]{1,1900}|\/[A-Za-z0-9._\-\/%?=&]{1,300})$/;
const HEX = '#[0-9a-fA-F]{3,8}';
const GRADIENT_RE = new RegExp(`^linear-gradient\\(\\d{1,3}deg, ${HEX} \\d{1,3}%, ${HEX} \\d{1,3}%\\)$`);
const IMAGE_BG_RE = /^url\('(\/api\/theme-image\/[A-Za-z0-9._-]{1,80}|\/images\/custom-themes\/[A-Za-z0-9._-]{1,120})'\) center center \/ cover no-repeat$/;

const STATE_TYPES = new Set(['blank', 'song', 'scripture', 'free-text', 'image', 'video']);

function safeAssetPath(v) {
  return typeof v === 'string' && SAFE_ASSET_PATH.test(v) ? v : null;
}
function safeUrl(v) {
  return typeof v === 'string' && SAFE_URL.test(v) ? v : '';
}

function sanitizeState(p) {
  if (!p || typeof p !== 'object') return null;
  const type = STATE_TYPES.has(p.type) ? p.type : null;
  if (!type) return null;
  const out = { type };
  out.theme = /^[a-z0-9-]{1,80}$/i.test(p.theme || '') ? p.theme : 'photo';
  out.themeBg = typeof p.themeBg === 'string' && (GRADIENT_RE.test(p.themeBg) || IMAGE_BG_RE.test(p.themeBg)) ? p.themeBg : null;
  out.background = safeAssetPath(p.background);
  out.label = str(p.label, 120);
  out._displayTitle = str(p._displayTitle, 200);
  if (Array.isArray(p.next)) out.next = p.next.slice(0, 8).map((l) => str(l, 300));
  if (type === 'song') {
    out.pairs = (Array.isArray(p.pairs) ? p.pairs : []).slice(0, 40).map((pair) => [str(pair && pair[0], 500), str(pair && pair[1], 500)]);
    out.finale = p.finale ? str(p.finale, 300) : null;
  } else if (type === 'scripture') {
    out.reference = str(p.reference, 160);
    out.text = str(p.text, 6000);
    out.translation = str(p.translation, 120);
  } else if (type === 'free-text') {
    out.text = str(p.text, 6000);
  } else if (type === 'image') {
    out.url = safeUrl(p.url);
  } else if (type === 'video') {
    out.url = safeUrl(p.url);
    out.loop = !!p.loop;
    out.muted = !!p.muted;
  }
  return out;
}

function sanitizeSections(sections) {
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > 80) return null;
  const out = [];
  for (const s of sections) {
    if (!s || !Array.isArray(s.pairs) || s.pairs.length === 0 || s.pairs.length > 80) return null;
    out.push({
      label: str(s.label, 60) || 'VERSE',
      pairs: s.pairs.map((pr) => [str(pr && pr[0], 500), str(pr && pr[1], 500)]),
      finale: s.finale ? str(s.finale, 300) : undefined,
      background: safeAssetPath(s.background),
    });
  }
  return out;
}

const FONTS = ['sans', 'serif', 'display', 'mono'];
function cleanSettings(s) {
  const n = Number(s && s.fontScale);
  return {
    fontScale: Number.isFinite(n) ? Math.min(1.8, Math.max(0.6, n)) : 1,
    fontFamily: FONTS.includes(s && s.fontFamily) ? s.fontFamily : 'sans',
    align: s && s.align === 'left' ? 'left' : 'center',
    caps: !!(s && s.caps),
    shadow: [0, 1, 2].includes(Number(s && s.shadow)) ? Number(s.shadow) : 1,
    position: s && s.position === 'bottom' ? 'bottom' : 'middle',
    lineSpacing: Number.isFinite(Number(s && s.lineSpacing)) ? Math.min(1.8, Math.max(1.0, Number(s.lineSpacing))) : 1.32,
  };
}

module.exports = {
  cleanSettings,
  AUTH_ENABLED, AUTH_CONFIGURED, IS_PROD,
  isOperatorFromCookieHeader, roleFromCookieHeader, checkPassword, setSessionCookie, clearSessionCookie,
  requireOperator, requireAnyRole, loginBlocked, recordLoginFailure, clearLoginFailures,
  rateLimit, securityHeaders, sameOriginWrites,
  sanitizeState, sanitizeSections, safeUrl, str,
};
