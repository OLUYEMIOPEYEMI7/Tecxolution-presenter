// Live voice detection: listens continuously via the browser's SpeechRecognition
// API, scans the running transcript for spoken scripture references, and fires
// a callback when one is confidently found (with debounce so the same verse
// isn't re-triggered every few seconds while the preacher keeps talking about it).

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
  }

  isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start() {
    if (!this.isSupported()) {
      this.onStatus('Speech recognition is not supported in this browser. Use Chrome.');
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event) => {
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
    };

    this.recognition.onerror = (event) => {
      this.onStatus('Mic error: ' + event.error);
    };

    this.recognition.onend = () => {
      if (this.listening) {
        // Browsers auto-stop after a pause; restart to stay continuously listening
        try { this.recognition.start(); } catch (e) {}
      }
    };

    try {
      this.recognition.start();
      this.listening = true;
      this.onStatus('Listening…');
    } catch (e) {
      this.onStatus('Could not start mic: ' + e.message);
    }
  }

  stop() {
    this.listening = false;
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
