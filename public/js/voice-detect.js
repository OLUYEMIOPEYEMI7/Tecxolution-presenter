// Live voice detection: listens continuously via the browser's SpeechRecognition
// API, scans the running transcript for spoken scripture references, and fires
// a callback when one is confidently found (with debounce so the same verse
// isn't re-triggered every few seconds while the preacher keeps talking about it).
//
// IMPORTANT: Chrome's built-in speech recognition is cloud-based (it streams
// audio to Google's servers for transcription) — it needs a working internet
// connection the whole time it's listening, not just when the page loads.
// On a shaky venue connection it can silently stop producing results without
// any error ever firing, which used to look exactly like "the mic is on but
// nothing happens." The watchdog below detects that stall and recovers
// automatically instead of leaving the operator staring at "Listening…"
// with no feedback.

class VoiceDetector {
  constructor({ onTranscript, onReferenceDetected, onStatus, onCandidate, onStopped, lang, socket }) {
    this.onTranscript = onTranscript || (() => {});
    this.onReferenceDetected = onReferenceDetected || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onCandidate = onCandidate || (() => {}); // fires the moment a reference is first heard (before it is confirmed stable)
    this.onStopped = onStopped || (() => {}); // the engine stopped by itself (key problem, idle, ...)
    this.socket = socket || null;
    this.engine = 'browser'; // 'browser' (free, Chrome/Edge) | 'deepgram' (premium, via the server)
    this.dg = { mic: null, attempts: 0 };
    this.lang = lang || 'en-US';
    this.recognition = null;
    this.listening = false;
    this.lastFiredRef = null;
    this.lastFiredAt = 0;
    this.cooldownMs = 5000; // don't re-fire the same reference within 5s
    this.verseHoldMs = 150; // a reference WITH a verse fires once it has been stable this long
    this.chapterHoldMs = 750; // chapter-only ("John 3") waits for a possible verse to follow
    this.rollingBuffer = '';
    this.pending = null; // { match, timer }
    this.lastResultAt = 0;
    this.watchdogTimer = null;
    this.watchdogStallMs = 12000; // no speech events in 12s while "listening" -> assume stalled
    this.restartAttempts = 0;
    if (this.socket) this._bindDeepgramEvents();
  }

  setLanguage(lang) {
    this.lang = lang || 'en-US';
    if (this.listening && this.engine === 'deepgram') { this.socket.emit('dg-start', { lang: this.lang }); return; }
    if (this.listening) { // apply immediately
      try { this.recognition.abort(); } catch (e) {}
    }
  }

  isSupported() {
    if (this.engine === 'deepgram') return !!(this.socket && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start() {
    if (!this.isSupported()) {
      this.onStatus(this.engine === 'deepgram' ? 'The microphone is not available in this browser.' : 'Speech recognition is not supported in this browser. Use Chrome, or switch to the Deepgram engine.');
      return;
    }
    if (this.engine === 'deepgram') { this._startDeepgram(); return; }
    this.restartAttempts = 0;
    this._startRecognitionSession();
    this._startWatchdog();
  }

  _startRecognitionSession() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 3; // lets us pick the alternative that parses as a reference
    this.recognition.lang = this.lang;
    // Chrome 139+: bias the recogniser toward Bible book names (ignored elsewhere).
    try {
      if (window.SpeechRecognitionPhrase && 'phrases' in this.recognition) {
        const books = Array.from(new Set(Object.values(BIBLE_BOOKS)));
        this.recognition.phrases = books.map((b) => new window.SpeechRecognitionPhrase(b, 6));
      }
    } catch (e) {}

    this.recognition.onresult = (event) => {
      this.lastResultAt = Date.now();
      this.restartAttempts = 0;
      let interim = '';
      let finalChunk = '';
      let sawFinal = false;
      const altTexts = []; // alternatives of the newest result, best first
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = res[0].transcript;
        if (res.isFinal) {
          finalChunk += transcript + ' ';
          sawFinal = true;
        } else {
          interim += transcript;
        }
        if (i === event.results.length - 1) {
          for (let j = 0; j < res.length; j++) altTexts.push({ text: res[j].transcript, confidence: res[j].confidence });
        }
      }
      this._ingest({ interim, finalChunk, sawFinal, altTexts });
    };

    this.recognition.onspeechstart = () => {
      this.lastResultAt = Date.now();
      if (this.listening && !this.pending) this.onStatus('Hearing speech…');
    };

    this.recognition.onerror = (event) => {
      // "no-speech" fires routinely during normal pauses — not a real error,
      // onend will restart it. Only surface genuinely actionable problems.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.onStatus('Microphone access was blocked — check the browser\'s mic permission for this site.');
        this.listening = false;
      } else if (event.error === 'audio-capture') {
        this.onStatus('No microphone found — check it is connected and not in use by another app.');
        this.listening = false;
      } else if (event.error === 'network') {
        this.onStatus('Network hiccup — voice detection needs internet, reconnecting…');
      }
      // other errors (no-speech, aborted) are routine; say nothing, just let onend restart.
    };

    this.recognition.onend = () => {
      if (this.listening) {
        // Browsers auto-stop after a pause or a network error; restart
        // straight away so there is (almost) no gap where a reference
        // could be missed.
        setTimeout(() => {
          if (!this.listening) return;
          try {
            this._startRecognitionSession();
          } catch (e) {
            // Transient — the watchdog will catch a real stall.
          }
        }, 40);
      }
    };

    try {
      this.recognition.start();
      this.listening = true;
      this.lastResultAt = Date.now();
      this.onStatus('Listening…');
    } catch (e) {
      this.onStatus('Could not start mic: ' + e.message);
    }
  }

  // Detects the "Listening… but actually dead" failure mode: the session
  // claims to be running but hasn't produced a single result (interim or
  // final) in a while — almost always a dropped network connection to the
  // cloud speech service. Force a full restart rather than waiting forever.
  _startWatchdog() {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (!this.listening) return;
      const silentFor = Date.now() - this.lastResultAt;
      if (silentFor > this.watchdogStallMs) {
        this.restartAttempts++;
        this.onStatus(
          `No response for ${Math.round(silentFor / 1000)}s — restarting ` +
          `(check your internet connection if this keeps happening)…`
        );
        try { this.recognition.stop(); } catch (e) {}
        try { this.recognition.abort(); } catch (e) {}
        this.lastResultAt = Date.now(); // avoid repeatedly firing while the restart settles
        setTimeout(() => {
          if (this.listening) {
            try { this._startRecognitionSession(); } catch (e) {}
          }
        }, 500);
      }
    }, 5000);
  }

  stop() {
    if (this.engine === 'deepgram') { this._stopDeepgram(true); this.onStatus('Stopped'); return; }
    this.listening = false;
    clearInterval(this.watchdogTimer);
    this._clearPending();
    if (this.recognition) this.recognition.stop();
    this.onStatus('Stopped');
  }

  // Shared by both engines: feed one recognition update into the reference finder.
  _ingest({ interim, finalChunk, sawFinal, altTexts }) {
    if (finalChunk) {
      this.rollingBuffer = (this.rollingBuffer + ' ' + finalChunk).split(/\s+/).slice(-40).join(' ');
    }
    this.onTranscript((this.rollingBuffer + ' ' + interim).trim());
    const full = this.rollingBuffer + ' ' + interim;
    let hit = this._match(full, altTexts[0] ? altTexts[0].confidence : null);
    // The engine's top guess may mishear a book/number; try its other guesses.
    for (let j = 1; j < altTexts.length && !hit; j++) hit = this._match(altTexts[j].text, altTexts[j].confidence);
    this._consider(hit, sawFinal);
    if (this.listening && !this.pending) this.onStatus('Listening — hearing you clearly');
  }

  // ------------------------------------------------ Deepgram engine (premium)
  _bindDeepgramEvents() {
    const sk = this.socket;
    sk.on('dg-result', (r) => {
      if (this.engine !== 'deepgram' || !this.listening) return;
      this.lastResultAt = Date.now();
      this.dg.attempts = 0;
      this._ingest({
        interim: r.final ? '' : r.text,
        finalChunk: r.final ? r.text + ' ' : '',
        sawFinal: !!r.final,
        altTexts: (r.alts && r.alts.length ? r.alts : [{ text: r.text, confidence: r.confidence }]),
      });
    });
    sk.on('dg-status', (st) => {
      if (this.engine !== 'deepgram' || !this.listening) return;
      if (st.state === 'connecting') this.onStatus('Connecting to Deepgram…');
      else if (st.state === 'ready') { this.dg.attempts = 0; this.onStatus('Listening — Deepgram ready'); }
      else if (st.state === 'closed' || st.state === 'error') {
        if (st.reason === 'network' && this.dg.attempts < 6) {
          this.dg.attempts++;
          this.onStatus('Connection dropped — reconnecting (' + this.dg.attempts + ')…');
          setTimeout(() => { if (this.listening && this.engine === 'deepgram') sk.emit('dg-start', { lang: this.lang }); }, 1500);
        } else {
          this._stopDeepgram(false);
          this.onStatus(st.message || 'Voice Detect stopped.');
          this.onStopped(st.reason || 'closed');
        }
      }
    });
    // The page's own connection to the server dropped and came back: restart the session.
    sk.on('connect', () => { if (this.engine === 'deepgram' && this.listening) sk.emit('dg-start', { lang: this.lang }); });
  }

  async _startDeepgram() {
    this.listening = true;
    this.dg.attempts = 0;
    this.rollingBuffer = '';
    this.onStatus('Starting the microphone…');
    try {
      await this._openMic();
    } catch (e) {
      this.listening = false;
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      this.onStatus(denied ? 'Microphone access was blocked — allow it for this site and press Start again.' : 'No microphone found — check it is connected.');
      this.onStopped('mic');
      return;
    }
    this.socket.emit('dg-start', { lang: this.lang });
  }

  // Microphone -> 16 kHz mono 16-bit PCM, ~100 ms chunks, sent to the server.
  async _openMic() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    const ratio = ctx.sampleRate / 16000;
    let carry = [];
    proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const out = [];
      for (let pos = 0; Math.floor(pos * ratio) < input.length; pos++) {
        const from = Math.floor(pos * ratio), to = Math.min(input.length, Math.floor((pos + 1) * ratio));
        let sum = 0, n = 0;
        for (let i = from; i < to; i++) { sum += input[i]; n++; }
        out.push(n ? sum / n : 0);
      }
      carry = carry.concat(out);
      while (carry.length >= 1600) {
        const chunk = carry.slice(0, 1600); carry = carry.slice(1600);
        const pcm = new Int16Array(1600);
        for (let i = 0; i < 1600; i++) { const v = Math.max(-1, Math.min(1, chunk[i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
        if (this.socket.connected) this.socket.volatile.emit('dg-audio', pcm.buffer);
      }
    };
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    this.dg.mic = { stream, ctx, src, proc, mute };
  }

  _stopDeepgram(tellServer) {
    this.listening = false;
    this._clearPending();
    const m = this.dg.mic; this.dg.mic = null;
    if (m) {
      try { m.proc.onaudioprocess = null; m.src.disconnect(); m.proc.disconnect(); m.mute.disconnect(); } catch (e) {}
      try { m.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      try { m.ctx.close(); } catch (e) {}
    }
    if (tellServer && this.socket) this.socket.emit('dg-stop');
  }

  // Parse a transcript; returns the match plus the speech engine's confidence.
  _match(text, confidence) {
    const m = findScriptureReference(text);
    if (!m) return null;
    m.confidence = typeof confidence === 'number' && confidence > 0 ? confidence : null;
    m.heard = text.trim().split(/\s+/).slice(-12).join(' ');
    return m;
  }

  // Decide when a heard reference is stable enough to act on. We act on
  // INTERIM results (no waiting for the engine to finalise a sentence): a
  // reference with a verse fires once it has stayed the same for a moment,
  // or immediately when the engine finalises; a bare chapter waits a little
  // longer in case the verse is still coming ("John 3" ... "16").
  _consider(match, isFinal) {
    if (!match) return;
    const now = Date.now();
    if (match.reference === this.lastFiredRef && now - this.lastFiredAt < this.cooldownMs) return;
    if (this.pending && this.pending.match.reference === match.reference) {
      // Same reference still being heard.
      this.pending.match = match;
      if (isFinal) this._fire(match, 0);
      return;
    }
    // New or changed candidate: restart the stability timer.
    this._clearPending();
    this.onCandidate(match);
    this.onStatus('Heard “' + match.reference + '” …');
    const hold = isFinal ? (match.hasVerse ? 0 : 450) : (match.hasVerse ? this.verseHoldMs : this.chapterHoldMs);
    this._fire(match, hold);
  }

  _fire(match, delay) {
    this._clearPending();
    const go = () => {
      this.pending = null;
      this.lastFiredRef = match.reference;
      this.lastFiredAt = Date.now();
      this.rollingBuffer = ''; // so the same words aren't matched again
      this.onReferenceDetected(match);
    };
    if (delay <= 0) { go(); return; }
    this.pending = { match, timer: setTimeout(go, delay) };
  }

  _clearPending() {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; }
  }
}
