const socket = io();

const stage = document.getElementById('stage');
const stageBg = document.getElementById('stage-bg');
const stageContent = document.getElementById('stage-content');
const stageLabel = document.getElementById('stage-label');

function render(state) {
  const theme = state.theme || 'photo';
  stage.className = 'stage ' + (state.type || 'blank') + ' theme-' + (state.themeBg ? 'custom' : theme);
  stage.style.background = state.themeBg || '';

  // "photo" keeps each song's own background image; any other theme is a
  // flat color design and ignores the per-song image entirely.
  if (theme === 'photo' && state.background) {
    stageBg.style.backgroundImage = `url('${state.background}')`;
    stageBg.style.opacity = 1;
  } else {
    stageBg.style.opacity = 0;
  }

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
  } else {
    stageContent.innerHTML = '';
    stageLabel.textContent = '';
  }

  fitContent();
}

// Shrinks the content block (as a whole, via transform:scale so nothing
// stretches) until it fits the stage vertically — long verses must never
// run off the top of the screen. Anchored bottom-center so it shrinks
// toward the same spot the layout is already anchored to.
function fitContent() {
  stageContent.style.transform = 'scale(1)';
  // Force a synchronous layout read before measuring.
  void stageContent.offsetHeight;

  const labelSpace = stageLabel.textContent ? stageLabel.offsetHeight + 40 : 20;
  const available = stage.clientHeight * 0.92 - labelSpace;
  const needed = stageContent.scrollHeight;

  if (needed > available && needed > 0) {
    const scale = Math.max(0.25, available / needed);
    stageContent.style.transform = `scale(${scale})`;
  }
}

window.addEventListener('resize', fitContent);

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const isPreview = new URLSearchParams(location.search).get('mode') === 'preview';
socket.on(isPreview ? 'preview-state' : 'live-state', render);
