const test = require('node:test');
const assert = require('node:assert');
const sec = require('../lib/security');

test('free-text style is validated', () => {
  const st = sec.sanitizeState({ type: 'free-text', text: 'Hi', style: { size: 9999, color: '#FFAA00', align: 'right', bold: false } });
  assert.deepStrictEqual(st.style, { size: 300, color: '#ffaa00', align: 'right', bold: false });
  const bad = sec.sanitizeState({ type: 'free-text', text: 'Hi', style: { size: 'x', color: 'red;background:url(x)', align: 'diagonal' } });
  assert.deepStrictEqual(bad.style, { size: 100, color: '', align: '', bold: true });
  assert.deepStrictEqual(sec.sanitizeState({ type: 'free-text', text: 'Hi' }).style, { size: 100, color: '', align: '', bold: true });
});

test('ticker look is validated', () => {
  const t = sec.cleanTicker({ active: 1, text: 'Account 123', size: 10, color: '#fff', bg: '#0b2a4a', align: 'left', scroll: false, speed: 'warp' });
  assert.deepStrictEqual(t, { active: true, text: 'Account 123', size: 60, color: '', bg: '#0b2a4a', align: 'left', scroll: false, speed: 'normal' });
  assert.deepStrictEqual(sec.cleanTicker(undefined), { active: false, text: '', size: 100, color: '', bg: '', align: 'center', scroll: true, speed: 'normal' });
});

test('image display settings are validated', () => {
  const s = sec.cleanSettings({ imageFit: 'cover', imageBg: 'blur', imageRotate: 90, imageZoom: 999 });
  assert.deepStrictEqual([s.imageFit, s.imageBg, s.imageRotate, s.imageZoom], ['cover', 'blur', 90, 400]);
  const d = sec.cleanSettings({ imageFit: 'url(x)', imageBg: 'red', imageRotate: 45, imageZoom: 'abc' });
  assert.deepStrictEqual([d.imageFit, d.imageBg, d.imageRotate, d.imageZoom], ['contain', 'black', 0, 100]);
});

test('image pan/zoom range is validated', () => {
  const s = sec.cleanSettings({ imageZoom: 9999, imageX: -500, imageY: 33.4 });
  assert.deepStrictEqual([s.imageZoom, s.imageX, s.imageY], [400, -100, 33]);
});
