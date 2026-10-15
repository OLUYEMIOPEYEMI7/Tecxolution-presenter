// Desktop settings, stored as JSON in the user's app-data folder. The cloud
// password is encrypted with the operating system's credential store (Windows
// DPAPI via Electron safeStorage) when available.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CLOUD_URL = 'https://tecxolution-presenter.onrender.com';
const word = () => crypto.randomBytes(5).toString('hex'); // 10 readable hex chars

function createSettings(file, safeStorage) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { data = {}; }
  const defaults = () => ({
    operatorPassword: crypto.randomBytes(18).toString('base64url'), // never typed — the app signs itself in
    remotePassword: word(),
    lanAccess: false,
    autoOpenProjector: true,
    cloud: { url: DEFAULT_CLOUD_URL, password: null, enc: null },
  });
  data = { ...defaults(), ...data, cloud: { ...defaults().cloud, ...(data.cloud || {}) } };

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  save();

  return {
    get: () => data,
    set(patch) { data = { ...data, ...patch }; save(); return data; },
    // ---- cloud credentials
    setCloud(url, password) {
      const clean = String(url || '').trim().replace(/\/+$/, '');
      let enc = 'plain', value = Buffer.from(password, 'utf8').toString('base64');
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        enc = 'safe';
        value = safeStorage.encryptString(password).toString('base64');
      }
      data.cloud = { url: clean, password: value, enc };
      save();
    },
    getCloud() {
      const c = data.cloud;
      if (!c || !c.url || !c.password) return null;
      try {
        const buf = Buffer.from(c.password, 'base64');
        const password = c.enc === 'safe' ? safeStorage.decryptString(buf) : buf.toString('utf8');
        return { url: c.url, password };
      } catch (e) {
        return null; // e.g. profile moved to another Windows account: ask for the password again
      }
    },
    clearCloud() { data.cloud = { url: data.cloud.url || DEFAULT_CLOUD_URL, password: null, enc: null }; save(); },
  };
}

module.exports = { createSettings, DEFAULT_CLOUD_URL };
