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
  constructor({ onTranscript, onReferenceDetected, onStatus }) {
    this.onTranscript = onTranscript || (() => {});
    this.onReferenceDetected = onReferenceDetected || (() => {});
    this.onStatus = onStatus || (() => {});
    this.recognition = null;
    this.listening = false;
    this.lastFiredRef = null;
    this.lastFiredAt = 0;
    this.cooldownMs = 12000; // don't re-fire the same reference within 12s
    this.rollingBuffer = '';
    this.lastResultAt = 0;
    this.watchdogTimer = null;
    this.watchdogStallMs = 15000; // no speech events in 15s while "listening" -> assume stalled
    this.restartAttempts = 0;
  }

  isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start() {
    if (!this.isSupported()) {
      this.onStatus('Speech recognition is not supported in this browser. Use Chrome.');
      return;
    }
    this.restartAttempts = 0;
    this._startRecognitionSession();
    this._startWatchdog();
  }

  _startRecognitionSession() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event) => {
      this.lastResultAt = Date.now();
      this.restartAttempts = 0;
      let interim = '';
      let finalChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalChunk += transcript + ' ';
        } else {
          interim += transcript;
        }
      }
      if (finalChunk) {
        this.rollingBuffer = (this.rollingBuffer + ' ' + finalChunk).split(/\s+/).slice(-40).join(' ');
      }
      const displayText = this.rollingBuffer + ' ' + interim;
      this.onTranscript(displayText.trim());
      this.scanForReference(this.rollingBuffer + ' ' + interim);
      if (this.listening) this.onStatus('Listening — hearing you clearly');
    };

    this.recognition.onspeechstart = () => {
      this.lastResultAt = Date.now();
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
        // Browsers auto-stop after a pause (or after a network error); restart
        // to stay continuously listening. A tiny delay avoids a tight
        // start/stop loop if something is persistently failing.
        setTimeout(() => {
          if (!this.listening) return;
          try {
            this._startRecognitionSession();
            this.recognition.start();
          } catch (e) {
            // Already started / transient — the watchdog will catch a real stall.
          }
        }, 300);
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
            try { this._startRecognitionSession(); this.recognition.start(); } catch (e) {}
          }
        }, 500);
      }
    }, 5000);
  }

  stop() {
    this.listening = false;
    clearInterval(this.watchdogTimer);
    if (this.recognition) this.recognition.stop();
    this.onStatus('Stopped');
  }

  scanForReference(text) {
    const match = findScriptureReference(text);
    if (!match) return;

    const now = Date.now();
    const sameAsLast = this.lastFiredRef === match.reference;
    if (sameAsLast && now - this.lastFiredAt < this.cooldownMs) return;

    this.lastFiredRef = match.reference;
    this.lastFiredAt = now;
    this.rollingBuffer = ''; // reset so we don't immediately re-match the same words
    this.onReferenceDetected(match);
  }
}
