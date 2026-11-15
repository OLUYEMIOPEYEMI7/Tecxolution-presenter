const socket = io();
if (window.watchBuild) window.watchBuild(socket);
socket.on('connect', () => { { const qs = new URLSearchParams(location.search); socket.emit('hello', (qs.get('mode') === 'preview' || qs.get('embed') === '1') ? 'preview' : 'display'); } window.syncServerTime(socket); });

// Auto-fullscreen when launched from the Control Room's "Open Projection
// Screen" button. This can silently fail (the click's user-activation can
// expire while awaiting the screen-picker permission prompt in control.js,
// which Chrome does not always carry over into the new popup), leaving an
// ordinary bordered window sitting on the desktop with the taskbar/other
// windows visible around it — exactly the "windows showing beneath"
// problem. Detect that failure and show an unmissable full-screen button
// that guarantees success, since it's a direct click inside this window.
function showFullscreenPrompt() {
  if (document.getElementById('fullscreen-prompt-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'fullscreen-prompt-btn';
  btn.textContent = '🖥️  Click to go Fullscreen';
  // A small banner, not a full-screen blackout — the actual stage (whatever
  // is staged/live) stays visible underneath exactly as it looks in the
  // Control Room's Preview/Live panels; this just floats a button to finish
  // the one click fullscreen needs.
  btn.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:28px', 'transform:translateX(-50%)',
    'z-index:99999', 'background:rgba(0,0,0,0.78)', 'color:#fff',
    'font-size:20px', 'font-family:sans-serif', 'padding:14px 28px',
    'border:2px solid #fff', 'border-radius:10px', 'cursor:pointer',
    'box-shadow:0 4px 24px rgba(0,0,0,0.6)',
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

const isDesktopProjector = new URLSearchParams(location.search).get('desktop') === '1';
if (isDesktopProjector) document.documentElement.classList.add('desktop-projector'); // the app window is already fullscreen on the projector

if (!isEmbeddedPreview && !isDesktopProjector) {
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


const isPreview = new URLSearchParams(location.search).get('mode') === 'preview';
const stage = document.getElementById('stage');
const stageBg = document.getElementById('stage-bg');
const stageContent = document.getElementById('stage-content');
const stageLabel = document.getElementById('stage-label');
const stageImage = document.getElementById('stage-image');
const stageImageBlur = document.getElementById('stage-image-blur');
const stageVideo = document.getElementById('stage-video');
const stageVideoEmbed = document.getElementById('stage-video-embed');
const tickerBar = document.getElementById('ticker-bar');
const tickerText = document.getElementById('ticker-text');
let tickerActive = false;
const timerOverlay = document.getElementById('timer-overlay');
const timerDigits = document.getElementById('timer-digits');
const timerLabel = document.getElementById('timer-label');
const alertBanner = document.getElementById('alert-banner');

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

let currentType = 'blank';
let currentTheme = 'photo';
let overlayMode = 'none';
function applyStageClass() {
  stage.className = 'stage ' + currentType + ' theme-' + currentTheme + (overlayMode !== 'none' ? ' ov-' + overlayMode : '');
}

function render(state) {
  const theme = state.theme || 'photo';
  currentType = state.type || 'blank';
  currentTheme = state.themeBg ? 'custom' : theme;
  applyStageClass();
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
    const st = state.style || {};
    const css = [];
    if (st.size && st.size !== 100) css.push(`--ft-scale:${Number(st.size) / 100}`);
    if (/^#[0-9a-f]{6}$/i.test(st.color || '')) css.push(`color:${st.color}`);
    if (['left', 'center', 'right'].includes(st.align)) css.push(`text-align:${st.align}`);
    if (st.bold === false) css.push('font-weight:400');
    stageContent.innerHTML = `<div class="free-text-body" style="${css.join(';')}">${lines}</div>`;
    stageLabel.textContent = state.label || '';
  } else if (state.type === 'image') {
    stageImage.src = state.url || '';
    stageImage.style.display = 'block';
    stageImageBlur.style.backgroundImage = state.url ? `url('${state.url}')` : '';
    applyImageLayout();
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

  // Soft cross-fade between slides instead of a hard cut.
  stageContent.classList.remove('fade-in');
  void stageContent.offsetWidth;
  stageContent.classList.add('fade-in');
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
  const tickerSpace = tickerActive ? tickerBar.offsetHeight + 8 : 0;
  const available = stage.clientHeight * 0.92 - labelSpace - tickerSpace;
  const needed = stageContent.scrollHeight;

  if (needed > available && needed > 0) {
    const scale = Math.max(0.25, available / needed);
    stageContent.style.transform = `scale(${scale})`;
  }
}

window.addEventListener('resize', () => { fitContent(); applyImageLayout(); });

// Image fit / rotate / zoom (settings from the control room). Rotating by
// 90/270 swaps the box so the picture still fits the screen.
let imgSettings = { rotate: 0, zoom: 100, x: 0, y: 0 };
function applyImageLayout() {
  const r = imgSettings.rotate, z = (imgSettings.zoom || 100) / 100;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  // Pan is in % of the screen, applied after rotate/zoom so "right" is always screen-right.
  const pan = `translate(${(imgSettings.x || 0) * sw / 100}px, ${(imgSettings.y || 0) * sh / 100}px)`;
  if (r % 180) {
    Object.assign(stageImage.style, { inset: 'auto', left: '50%', top: '50%', width: sh + 'px', height: sw + 'px',
      transform: `${pan} translate(-50%,-50%) rotate(${r}deg) scale(${z})` });
  } else {
    Object.assign(stageImage.style, { inset: '0', left: '', top: '', width: '100%', height: '100%',
      transform: (r || z !== 1 || imgSettings.x || imgSettings.y) ? `${pan} rotate(${r}deg) scale(${z})` : '' });
  }
}

// Scrolling lower-third ticker (EasyWorship-style) — independent of the main
// slide, so an account number or notice can scroll continuously underneath
// whatever is being projected without interrupting it.
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function renderTicker(state) {
  tickerActive = !!(state.active && state.text);
  if (!tickerActive) {
    tickerBar.classList.remove('on');
    fitContent();
    return;
  }
  tickerText.textContent = state.text;
  // Look: size %, text colour, bar colour, alignment (static mode), scroll on/off.
  tickerBar.style.setProperty('--tk-scale', (state.size || 100) / 100);
  tickerText.style.color = /^#[0-9a-f]{6}$/i.test(state.color || '') ? state.color : '';
  tickerBar.style.background = /^#[0-9a-f]{6}$/i.test(state.bg || '') ? hexToRgba(state.bg, 0.92) : '';
  const scrolling = state.scroll !== false;
  tickerBar.classList.toggle('static', !scrolling);
  tickerBar.dataset.align = state.align || 'center';
  // Speed scales with text length so longer messages don't zoom by too fast.
  const mult = { slow: 1.6, normal: 1, fast: 0.6 }[state.speed || 'normal'] || 1;
  const duration = Math.max(10, state.text.length * 0.22) * mult;
  tickerText.style.animationDuration = scrolling ? duration + 's' : '';
  tickerBar.classList.add('on');
  fitContent();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

socket.on(isPreview ? 'preview-state' : 'live-state', render);
socket.on('ticker-state', renderTicker);

// Black / Logo / Clear-text overlay (live slide is kept underneath).
socket.on('overlay-state', (mode) => {
  overlayMode = mode || 'none';
  applyStageClass();
});

// Text size (set from the control room) — applied via a CSS variable.
socket.on('settings-state', (s) => {
  s = s || {};
  const root = document.documentElement;
  root.style.setProperty('--font-scale', s.fontScale || 1);
  root.style.setProperty('--line-spacing', s.lineSpacing || 1.32);
  root.dataset.font = s.fontFamily || 'sans';
  root.dataset.align = s.align || 'center';
  root.dataset.caps = s.caps ? '1' : '0';
  root.dataset.shadow = String(s.shadow == null ? 1 : s.shadow);
  root.dataset.pos = s.position || 'middle';
  root.dataset.imgFit = s.imageFit || 'contain';
  root.dataset.imgBg = s.imageBg || 'black';
  imgSettings = { rotate: s.imageRotate || 0, zoom: s.imageZoom || 100, x: s.imageX || 0, y: s.imageY || 0 };
  applyImageLayout();
  fitContent();
});

// Service countdown / sermon timer. Driven by the server clock so the
// projector, stage monitor and remote all show the same time.
let timer = { active: false };
let timerTick = null;
function drawTimer() {
  if (isPreview || !timer.active || !timer.onDisplay) { timerOverlay.classList.remove('on'); return; }
  const diff = timer.mode === 'up' ? serverNow() - timer.target : timer.target - serverNow();
  timerOverlay.classList.add('on');
  timerLabel.textContent = timer.label || '';
  timerDigits.textContent = window.formatClock(Math.max(0, diff));
  timerDigits.classList.toggle('done', timer.mode === 'down' && diff <= 0);
}
socket.on('timer-state', (t) => {
  timer = t || { active: false };
  clearInterval(timerTick);
  drawTimer();
  if (timer.active) timerTick = setInterval(drawTimer, 250);
});

// Temporary alert banner (e.g. a nursery call).
let alertHide = null;
socket.on('alert-state', (a) => {
  clearTimeout(alertHide);
  if (isPreview || !a || !a.text || a.until <= serverNow()) { alertBanner.classList.remove('on'); return; }
  alertBanner.textContent = a.text;
  alertBanner.classList.add('on');
  alertHide = setTimeout(() => alertBanner.classList.remove('on'), Math.max(500, a.until - serverNow()));
});

// Don't hold a stale video/iframe when the projector tab is hidden then shown.
document.addEventListener('visibilitychange', () => { if (!document.hidden) fitContent(); });
