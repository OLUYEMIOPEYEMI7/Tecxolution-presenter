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
