// Live speech-to-text through Deepgram, proxied by this server so the API key
// never reaches a browser. One DeepgramSession per control-room socket.
//
// Audio in:  raw 16-bit little-endian PCM, mono, 16 kHz (the browser sends ~100 ms chunks).
// Events out: onStatus({state,message}) and onResult({text,final,speechFinal,confidence,alts}).
//
// Cost guards: the connection is closed after IDLE_MS without any recognised
// speech and after MAX_MS in total, so a forgotten tab cannot burn credit.
const WebSocket = require('ws');

const HOST = () => process.env.DEEPGRAM_HOST || 'api.deepgram.com';
const SCHEME = () => (process.env.DEEPGRAM_INSECURE === '1' ? 'ws' : 'wss');
const HTTP_SCHEME = () => (process.env.DEEPGRAM_INSECURE === '1' ? 'http' : 'https');
const IDLE_MS = () => Number(process.env.DEEPGRAM_IDLE_MS) || 10 * 60 * 1000;
const MAX_MS = () => Number(process.env.DEEPGRAM_MAX_MS) || 4 * 60 * 60 * 1000;

// Words worth boosting: every Bible book name.
const KEYTERMS = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth', 'Samuel', 'Kings', 'Chronicles',
  'Ezra', 'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs', 'Ecclesiastes', 'Song of Solomon', 'Isaiah', 'Jeremiah',
  'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos', 'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah',
  'Haggai', 'Zechariah', 'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', 'Corinthians', 'Galatians',
  'Ephesians', 'Philippians', 'Colossians', 'Thessalonians', 'Timothy', 'Titus', 'Philemon', 'Hebrews', 'James', 'Peter',
  'Jude', 'Revelation', 'chapter', 'verse',
];
const LANGS = new Set(['en', 'en-US', 'en-GB', 'en-AU', 'en-IN', 'en-NZ']);

function buildUrl(lang, withKeyterms) {
  const q = new URLSearchParams({
    model: 'nova-3',
    language: LANGS.has(lang) ? lang : 'en', // en-NG etc. -> plain English (covers accents)
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    endpointing: '250',
    utterance_end_ms: '1000',
  });
  if (withKeyterms) for (const k of KEYTERMS) q.append('keyterm', k);
  return `${SCHEME()}://${HOST()}/v1/listen?${q.toString()}`;
}

// Check a key against Deepgram. Returns 'ok' | 'rejected' | 'unreachable'.
async function checkKey(key) {
  try {
    const r = await fetch(`${HTTP_SCHEME()}://${HOST()}/v1/projects`, { headers: { Authorization: 'Token ' + key }, signal: AbortSignal.timeout(8000) });
    if (r.ok) return 'ok';
    if (r.status === 401 || r.status === 403) return 'rejected';
    return 'unreachable';
  } catch (e) {
    return 'unreachable';
  }
}

class DeepgramSession {
  constructor({ key, lang, onStatus, onResult, onClosed }) {
    this.key = key;
    this.lang = lang;
    this.onStatus = onStatus || (() => {});
    this.onResult = onResult || (() => {});
    this.onClosed = onClosed || (() => {});
    this.ws = null;
    this.queue = [];
    this.queued = 0;
    this.closed = false;
    this.lastAudioAt = Date.now();
    this.lastSpeechAt = Date.now();
    this.startedAt = Date.now();
    this.variant = 0; // 0 = with keyterm boosting, 1 = plain
    this.timer = setInterval(() => this._tick(), Math.min(5000, Math.max(200, IDLE_MS() / 2)));
    this._connect();
  }

  _connect() {
    if (this.closed) return;
    this.onStatus({ state: 'connecting', message: 'Connecting to Deepgram…' });
    const ws = new WebSocket(buildUrl(this.lang, this.variant === 0), { headers: { Authorization: 'Token ' + this.key }, handshakeTimeout: 8000 });
    this.ws = ws;
    ws.on('open', () => {
      if (this.closed || this.ws !== ws) return ws.close();
      this.onStatus({ state: 'ready', message: 'Deepgram connected' });
      for (const b of this.queue) ws.send(b);
      this.queue = []; this.queued = 0;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m.type !== 'Results' || !m.channel || !Array.isArray(m.channel.alternatives) || !m.channel.alternatives.length) return;
      const alts = m.channel.alternatives.map((a) => ({ text: String(a.transcript || ''), confidence: a.confidence }));
      const text = alts[0].text.trim();
      if (!text && !m.is_final) return;
      if (text) this.lastSpeechAt = Date.now();
      this.onResult({ text, final: !!m.is_final, speechFinal: !!m.speech_final, confidence: alts[0].confidence, alts: alts.slice(0, 3) });
    });
    ws.on('unexpected-response', (req, res) => {
      const code = res.statusCode;
      res.resume();
      if (this.ws !== ws) return;
      if (code === 400 && this.variant === 0) { this.variant = 1; return setImmediate(() => this._connect()); } // retry without keyterms
      const msg = code === 401 || code === 403 ? 'Deepgram rejected the API key — paste it again in Voice settings.'
        : code === 402 ? 'Your Deepgram credit has run out.'
        : code === 429 ? 'Deepgram is busy or the concurrency limit was reached — try again shortly.'
        : 'Deepgram refused the connection (HTTP ' + code + ').';
      this._end(code === 401 || code === 403 ? 'key' : code === 402 ? 'credit' : 'refused', msg);
    });
    ws.on('error', (e) => {
      if (this.ws !== ws || this.closed) return;
      if (this._failedOpen) return;
      this._failedOpen = true;
      this._end('network', 'Could not reach Deepgram (' + (e && e.code ? e.code : 'network error') + ') — check the internet connection.');
    });
    ws.on('close', () => {
      if (this.ws !== ws || this.closed) return;
      this._end('network', 'The Deepgram connection closed.');
    });
  }

  send(buf) {
    if (this.closed) return;
    this.lastAudioAt = Date.now();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.send(buf); return; }
    if (this.queued < 96000) { this.queue.push(buf); this.queued += buf.length; } // ~3 s while connecting
  }

  _tick() {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastSpeechAt > IDLE_MS()) return this._end('idle', 'Voice Detect stopped after ' + Math.round(IDLE_MS() / 60000) + ' minutes of silence to save Deepgram credit.');
    if (now - this.startedAt > MAX_MS()) return this._end('limit', 'Voice Detect stopped after the maximum session length — press Start to continue.');
    if (this.ws && this.ws.readyState === WebSocket.OPEN && now - this.lastAudioAt > 3000) {
      try { this.ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch (e) {}
    }
  }

  _end(reason, message) {
    if (this.closed) return;
    this.close();
    this.onClosed(reason, message);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    const ws = this.ws;
    if (ws) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) {}
      setTimeout(() => { try { ws.terminate(); } catch (e) {} }, 400);
    }
  }
}

module.exports = { DeepgramSession, checkKey, buildUrl, KEYTERMS };
