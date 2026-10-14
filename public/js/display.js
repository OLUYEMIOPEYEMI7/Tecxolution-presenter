const socket = io();

// Auto-fullscreen when launched from the Control Room's "Open Projection
// Screen" button. This can silently fail (the click's user-activation can
// expire while awaiting the screen-picker permission prompt in control.js,
// which Chrome does not always carry over into the new popup), leaving an
// ordinary bordered window sitting on the desktop with the taskbar/other
// windows visible around it — exactly the "windows showing beneath"
// problem. Detect that failure and show an unmissable full-screen button
// that guarantees success, since it's a direct click inside this window.
function showFullscreenPrompt() {
  const btn = document.createElement('button');
  btn.id = 'fullscreen-prompt-btn';
  btn.textContent = '🖥️  Click to go Fullscreen';
  btn.style.cssText = [
    'position:fixed', 'inset:0', 'width:100%', 'height:100%', 'z-index:99999',
    'background:#000', 'color:#fff', 'font-size:48px', 'font-family:sans-serif',
    'border:none', 'cursor:pointer', 'display:flex', 'align-items:center',
    'justify-content:center',
  ].join(';');
  btn.onclick = () => {
    document.documentElement.requestFullscreen()
      .then(() => btn.remove())
      .catch((e) => { btn.textContent = 'Fullscreen failed: ' + e.message + ' — try F11 instead'; });
  };
  document.body.appendChild(btn);
}

// Control Room's Preview and Live panels embed this exact /display page in
// iframes to show a miniature live-matching view to the operator. The
// fullscreen prompt below is only for the REAL projection window (opened
// as its own top-level window via "Open Projection Screen") — inside an
// iframe it would cover the operator's Preview/Live panes with a giant
// black button and hide the content entirely, which is its own bug.
const isEmbeddedPreview = window.self !== window.top;

if (!isEmbeddedPreview) {
  if (new URLSearchParams(location.search).get('launch') === '1') {
    document.documentElement.requestFullscreen().catch(() => showFullscreenPrompt());
  } else {
    // Opened via the plain fallback path (no ?launch=1) — no activation was
    // ever available for auto-fullscreen, so go straight to the one-click prompt.
    showFullscreenPrompt();
  }

  // If fullscreen is ever exited unexpectedly (Esc, alt-tab on some systems,
  // a second monitor being unplugged) during a live service, surface the
  // same one-click button again instead of silently leaving a windowed view.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && !document.getElementById('fullscreen-prompt-btn')) {
      showFullscreenPrompt();
    }
  });
}


const stage = document.getElementById('stage');
const stageBg = document.getElementById('stage-bg');
const stageContent = document.getElementById('stage-content');
const stageLabel = document.getElementById('stage-label');
const stageImage = document.getElementById('stage-image');
const stageVideo = document.getElementById('stage-video');
const stageVideoEmbed = document.getElementById('stage-video-embed');
const tickerBar = document.getElementById('ticker-bar');
const tickerText = document.getElementById('ticker-text');
let tickerActive = false;

// YouTube/Vimeo watch-page links need to be converted to their embeddable
// iframe form; a direct file link (.mp4/.webm/pasted CDN URL) plays natively
// via <video> instead.
function toEmbedUrl(url) {
  const yt = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{6,})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}?autoplay=1&rel=0`;
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}?autoplay=1`;
  return null;
}

function render(state) {
  const theme = state.theme || 'photo';
  stage.className = 'stage ' + (state.type || 'blank') + ' theme-' + (state.themeBg ? 'custom' : theme);
  stage.style.background = state.themeBg || '';

  if (theme === 'photo' && state.background) {
    stageBg.style.backgroundImage = `url('${state.background}')`;
    stageBg.style.opacity = 1;
  } else {
    stageBg.style.opacity = 0;
  }

  // Always reset media elements first so a stale image/video doesn't linger
  // behind whatever renders next.
  stageVideo.pause();
  stageVideo.removeAttribute('src');
  stageVideo.style.display = 'none';
  stageVideoEmbed.src = 'about:blank';
  stageVideoEmbed.style.display = 'none';
  stageImage.style.display = 'none';

  if (state.type === 'song') {
    let html = '';
    (state.pairs || []).forEach(([call, response]) => {
      html += `<div class="lyric-line">${escapeHtml(call)}`;
      if (response) html += ` <span class="response">${escapeHtml(response)}</span>`;
      html += `</div>`;
    });
    if (state.finale) {
      html += `<div class="finale-banner">${escapeHtml(state.finale)}</div>`;
    }
    stageContent.innerHTML = html;
    stageLabel.textContent = state.label || '';
  } else if (state.type === 'scripture') {
    stageContent.innerHTML = `
      <div class="scripture-ref">${escapeHtml(state.reference || '')}</div>
      <div class="scripture-text">${escapeHtml(state.text || '')}</div>
      <div class="scripture-translation">${escapeHtml(state.translation || '')}</div>
    `;
    stageLabel.textContent = '';
  } else if (state.type === 'free-text') {
    // Plain typed text/announcement slide — no reference or translation line,
    // just the words themselves, large and centered, same auto-fit-to-screen
    // behavior as every other slide type.
    const lines = (state.text || '').split('\n').map((l) => escapeHtml(l)).join('<br>');
    stageContent.innerHTML = `<div class="free-text-body">${lines}</div>`;
    stageLabel.textContent = state.label || '';
  } else if (state.type === 'image') {
    stageImage.src = state.url || '';
    stageImage.style.display = 'block';
    stageContent.innerHTML = '';
    stageLabel.textContent = '';
  } else if (state.type === 'video') {
    const embed = toEmbedUrl(state.url || '');
    if (embed) {
      stageVideoEmbed.src = embed;
      stageVideoEmbed.style.display = 'block';
    } else {
      stageVideo.src = state.url || '';
      stageVideo.loop = !!state.loop;
      stageVideo.muted = !!state.muted;
      stageVideo.style.display = 'block';
      stageVideo.play().catch(() => {}); // autoplay can be blocked until user interaction on some browsers
    }
    stageContent.innerHTML = '';
    stageLabel.textContent = '';
  } else {
    stageContent.innerHTML = '';
    stageLabel.textContent = '';
  }

  fitContent();
}

// Shrinks the content block (as a whole, via transform:scale so nothing
// stretches) until it fits the stage vertically — long verses must never
// run off the screen. Anchored center so it shrinks in place, matching the
// now-centered (not bottom-pinned) layout.
function fitContent() {
  stageContent.style.transform = 'scale(1)';
  // Force a synchronous layout read before measuring.
  void stageContent.offsetHeight;

  const labelSpace = stageLabel.textContent ? stageLabel.offsetHeight + 40 : 20;
  const tickerSpace = tickerActive ? stage.clientHeight * 0.09 : 0;
  const available = stage.clientHeight * 0.92 - labelSpace - tickerSpace;
  const needed = stageContent.scrollHeight;

  if (needed > available && needed > 0) {
    const scale = Math.max(0.25, available / needed);
    stageContent.style.transform = `scale(${scale})`;
  }
}

window.addEventListener('resize', fitContent);

// Scrolling lower-third ticker (EasyWorship-style) — independent of the main
// slide, so an account number or notice can scroll continuously underneath
// whatever is being projected without interrupting it.
function renderTicker(state) {
  tickerActive = !!(state.active && state.text);
  if (!tickerActive) {
    tickerBar.classList.remove('on');
    fitContent();
    return;
  }
  tickerText.textContent = state.text;
  // Speed scales with text length so longer messages don't zoom by too fast.
  const duration = Math.max(10, state.text.length * 0.22);
  tickerText.style.animationDuration = duration + 's';
  tickerBar.classList.add('on');
  fitContent();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const isPreview = new URLSearchParams(location.search).get('mode') === 'preview';
socket.on(isPreview ? 'preview-state' : 'live-state', render);
socket.on('ticker-state', renderTicker);
