const socket = io();

const stage = document.getElementById('stage');
const stageBg = document.getElementById('stage-bg');
const stageContent = document.getElementById('stage-content');
const stageLabel = document.getElementById('stage-label');

function render(state) {
  stage.className = 'stage ' + (state.type || 'blank');

  if (state.background) {
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
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const isPreview = new URLSearchParams(location.search).get('mode') === 'preview';
socket.on(isPreview ? 'preview-state' : 'live-state', render);
