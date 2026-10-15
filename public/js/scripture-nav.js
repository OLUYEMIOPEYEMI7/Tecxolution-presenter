// Scripture navigator: once any verse is on screen (typed, picked in the Bible
// browser, voice-detected or from the schedule) the preacher can move to the
// next / previous verse or chapter, or click any verse in the chapter list —
// no retyping. Builds on control.js (stageScriptureResult, scriptureUrl, ...).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (t) => escapeHtmlLocal(t == null ? '' : String(t));

  const nav = { active: false, bookIndex: 0, chapter: 1, selStart: 1, selEnd: 1, translation: '', verses: null, version: 'kjv' };
  const chapterCache = new Map(); // "version|book|chapter" -> verses[] | null
  let navStaging = false;
  let anchor = null;
  let liveRange = null; // {start,end} of the verse(s) currently live in this chapter

  const bookName = (i) => BIBLE_STRUCTURE[i].name;
  const verseCount = (b, c) => BIBLE_STRUCTURE[b].chapters[c - 1];
  const autoLive = () => $('verse-autolive').checked;
  const refString = (b, c, vs, ve) => `${bookName(b)} ${c}:${vs}${ve > vs ? '-' + ve : ''}`;

  // ---------------------------------------------------------------- loading
  async function ensureChapter() {
    const version = getSelectedBibleVersion();
    nav.version = version;
    const key = `${version}|${nav.bookIndex}|${nav.chapter}`;
    if (chapterCache.has(key)) { nav.verses = chapterCache.get(key); return; }
    nav.verses = null;
    renderChapter(true);
    try {
      const d = await fetch(scriptureUrl(`${bookName(nav.bookIndex)} ${nav.chapter}`)).then((r) => r.json());
      if (d && !d.error) nav.translation = d.translation || nav.translation;
      const verses = d && Array.isArray(d.verses) && d.verses.length ? d.verses : null;
      chapterCache.set(key, verses);
      nav.verses = verses;
    } catch (e) {
      nav.verses = null;
    }
  }

  // ---------------------------------------------------------------- staging
  async function gotoVerse(b, c, vs, ve, live) {
    if (!(b >= 0 && b < BIBLE_STRUCTURE.length)) return;
    nav.active = true; nav.bookIndex = b; nav.chapter = c; nav.selStart = vs; nav.selEnd = ve;
    await ensureChapter();
    const ref = refString(b, c, vs, ve);
    const n = verseCount(b, c);
    navStaging = true;
    try {
      if (nav.verses) {
        const subset = nav.verses.filter((v) => v.n >= vs && v.n <= ve);
        if (!subset.length) { toast('That verse is not in this translation'); return; }
        const nextV = nav.verses.find((v) => v.n === ve + 1);
        window.scriptureNextHint = nextV ? [refString(b, c, nextV.n, nextV.n), nextV.text.slice(0, 140) + (nextV.text.length > 140 ? '…' : '')] : [];
        stageScriptureResult(ref, { reference: ref, text: subset.map((v) => v.text).join(' '), translation: nav.translation, verses: subset }, live);
      } else {
        // Translations without a per-verse feed (e.g. NIV via API.Bible): fetch just this passage.
        const d = await fetch(scriptureUrl(ref)).then((r) => r.json());
        if (d.error) { toast('Not found: ' + d.error); return; }
        nav.translation = d.translation || nav.translation;
        stageScriptureResult(ref, d, live);
      }
    } finally { navStaging = false; }
    $('scripture-input').value = ref;
    $('scripture-status').textContent = (live ? 'Live: ' : 'Staged: ') + ref + (live ? '' : ' (click GO LIVE)');
    renderChapter(); updateBar();
    void n;
  }

  function stepVerse(delta, live) {
    if (!nav.active) return;
    let b = nav.bookIndex, c = nav.chapter;
    let v = delta > 0 ? nav.selEnd + 1 : nav.selStart - 1;
    if (delta > 0 && v > verseCount(b, c)) {
      if (c < BIBLE_STRUCTURE[b].chapters.length) { c++; v = 1; }
      else if (b < BIBLE_STRUCTURE.length - 1) { b++; c = 1; v = 1; }
      else { toast('End of the Bible'); return; }
    } else if (delta < 0 && v < 1) {
      if (c > 1) { c--; v = verseCount(b, c); }
      else if (b > 0) { b--; c = BIBLE_STRUCTURE[b].chapters.length; v = verseCount(b, c); }
      else { toast('Start of the Bible'); return; }
    }
    gotoVerse(b, c, v, v, live == null ? autoLive() : live);
  }
  function stepChapter(delta, live) {
    if (!nav.active) return;
    let b = nav.bookIndex, c = nav.chapter + delta;
    if (c > BIBLE_STRUCTURE[b].chapters.length) { b++; c = 1; }
    else if (c < 1) { b--; if (b >= 0) c = BIBLE_STRUCTURE[b].chapters.length; }
    if (b < 0 || b >= BIBLE_STRUCTURE.length) { toast(delta > 0 ? 'End of the Bible' : 'Start of the Bible'); return; }
    gotoVerse(b, c, 1, 1, live == null ? autoLive() : live);
  }
  window.scrNav = { step: stepVerse, chapter: stepChapter, active: () => nav.active };

  // Called by control.js whenever a scripture has been staged/shown by any other path.
  window.scrNavFromResult = function (data) {
    if (navStaging) return;
    if (!data || !data.book) { nav.active = false; updateBar(); renderChapter(); return; }
    nav.active = true;
    nav.bookIndex = data.bookIndex; nav.chapter = data.chapter;
    nav.selStart = data.verseStart; nav.selEnd = data.verseEnd;
    nav.translation = data.translation || nav.translation;
    nav.version = getSelectedBibleVersion();
    const key = `${nav.version}|${nav.bookIndex}|${nav.chapter}`;
    if (Array.isArray(data.verses) && data.verses.length === data.verseCount) { chapterCache.set(key, data.verses); nav.verses = data.verses; renderChapter(); }
    else ensureChapter().then(() => { renderChapter(); updateBar(); });
    updateBar();
  };

  // ------------------------------------------------------------------ views
  function updateBar() {
    const bar = $('verse-bar');
    bar.style.display = nav.active ? 'flex' : 'none';
    if (!nav.active) return;
    $('verse-bar-ref').textContent = refString(nav.bookIndex, nav.chapter, nav.selStart, nav.selEnd);
  }

  // Rows are only rebuilt when the chapter itself changes; selection / live
  // highlights are updated IN PLACE. (Replacing the clicked element between the
  // two clicks of a double-click would stop the browser sending `dblclick`.)
  let renderedKey = '';
  function paintRows() {
    document.querySelectorAll('#cv-list [data-v]').forEach((el) => {
      const v = Number(el.dataset.v);
      el.classList.toggle('sel', v >= nav.selStart && v <= nav.selEnd);
      el.classList.toggle('live', !!liveRange && v >= liveRange.start && v <= liveRange.end);
    });
    const sel = document.querySelector('#cv-list .sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function renderChapter(loading) {
    const box = $('chapter-view');
    if (!nav.active) { box.style.display = 'none'; renderedKey = ''; return; }
    box.style.display = '';
    $('cv-title').textContent = `${bookName(nav.bookIndex)} ${nav.chapter}` + (nav.translation ? ` · ${nav.translation}` : '');
    const list = $('cv-list');
    if (loading) { list.innerHTML = '<div class="cv-note">Loading chapter…</div>'; renderedKey = ''; return; }
    const key = `${nav.version}|${nav.bookIndex}|${nav.chapter}|${nav.verses ? 'v' : 'n'}`;
    if (key === renderedKey) { paintRows(); return; }
    renderedKey = key;
    if (!nav.verses) {
      const n = verseCount(nav.bookIndex, nav.chapter);
      list.innerHTML = `<div class="cv-note">The verse list isn't available for this translation. Use the ◀ Verse / Verse ▶ buttons, or pick a number:</div>
        <div class="cv-numbers">${Array.from({ length: n }, (_, i) => `<button class="secondary cv-num" data-v="${i + 1}">${i + 1}</button>`).join('')}</div>`;
    } else {
      list.innerHTML = nav.verses.map((v) => `<div class="verse-row" data-v="${v.n}" title="Click to stage · double-click to go live · Shift+click to select a range"><b>${v.n}</b><span>${esc(v.text)}</span></div>`).join('');
    }
    paintRows();
  }

  // ----------------------------------------------------------------- events
  $('verse-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-vnav]');
    if (!btn) return;
    const [kind, d] = btn.dataset.vnav.split(':');
    (kind === 'verse' ? stepVerse : stepChapter)(Number(d));
  });
  $('chapter-view').addEventListener('click', (e) => {
    const nb = e.target.closest('[data-cvchap]');
    if (nb) { stepChapter(Number(nb.dataset.cvchap)); return; }
    const el = e.target.closest('[data-v]');
    if (!el) return;
    const v = Number(el.dataset.v);
    if (e.shiftKey && anchor != null) gotoVerse(nav.bookIndex, nav.chapter, Math.min(anchor, v), Math.max(anchor, v), autoLive());
    else { anchor = v; gotoVerse(nav.bookIndex, nav.chapter, v, v, autoLive()); }
  });
  $('chapter-view').addEventListener('dblclick', (e) => {
    const el = e.target.closest('[data-v]');
    if (!el) return;
    const v = Number(el.dataset.v);
    gotoVerse(nav.bookIndex, nav.chapter, v, v, true);
  });
  try { $('verse-autolive').checked = localStorage.getItem('wp_verse_autolive') === '1'; } catch (e) {}
  $('verse-autolive').addEventListener('change', (e) => { try { localStorage.setItem('wp_verse_autolive', e.target.checked ? '1' : '0'); } catch (x) {} });

  // Switching Bible version re-loads the same chapter and re-stages the same verses.
  $('bible-version-select').addEventListener('change', () => {
    if (nav.active) gotoVerse(nav.bookIndex, nav.chapter, nav.selStart, nav.selEnd, false);
  });

  // Mark which verse(s) are on the projector right now.
  socket.on('live-state', (st) => {
    liveRange = null;
    if (st && st.type === 'scripture' && nav.active) {
      const m = String(st.reference || '').match(/^(.+?)\s+(\d+):(\d+)(?:-(\d+))?$/);
      if (m && m[1].toLowerCase() === bookName(nav.bookIndex).toLowerCase() && Number(m[2]) === nav.chapter) {
        liveRange = { start: Number(m[3]), end: Number(m[4] || m[3]) };
      }
    }
    if (nav.active) renderChapter();
  });

  updateBar(); renderChapter();
})();
