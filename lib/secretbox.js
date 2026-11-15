// Small AES-256-GCM helper so a pasted API key is never stored in plain text.
// The encryption key is derived from a server secret (OPERATOR_PASSWORD, or
// SECRETBOX_KEY if set). If that secret changes, the stored key simply cannot be
// read any more and the operator pastes it again.
const crypto = require('crypto');

function derive(secret, salt) {
  return crypto.scryptSync(String(secret), salt, 32);
}
function encrypt(plain, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', derive(secret, salt), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return ['v1', salt, iv, tag, ct].map((p, i) => (i === 0 ? p : p.toString('base64url'))).join('.');
}
function decrypt(blob, secret) {
  try {
    const [v, s, i, t, c] = String(blob).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', derive(secret, Buffer.from(s, 'base64url')), Buffer.from(i, 'base64url'));
    d.setAuthTag(Buffer.from(t, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(c, 'base64url')), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}
module.exports = { encrypt, decrypt };
