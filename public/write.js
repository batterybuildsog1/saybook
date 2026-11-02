// write.js: the Write surface (CONTRACT.md "core loop"). Talk or type; the draft becomes a real book in place:
// finished paragraphs are laid out by POST /book (chapters, paragraphs, a page per picture), portraits and pictures
// are painted (POST /cast {missing}, then every page's /image at once), and each page can be read aloud (/api/tts {sid}).
// The paragraph being written stays a draft below the book. The kid's words are never changed here: /book only adds
// paragraph breaks (the server rejects anything else), punctuation fixes are applied only when the kid accepts each.
//
// The app talks to this module only through this interface (so it can be swapped):
//   const w = mount(el, story, opts)
//     story  the app's story object; this module keeps text/title/book/scenes/cast/bible on it up to date
//     opts   { api, toast, kid, live, onText(text), onTitle(title), flush(): Promise (save now),
//              audio: { player, prime() }, reader (reader.js), voices(): [{id,name}], voice(): id, setVoice(id),
//              onChange() (pages, pictures or characters changed: Read mode redraws) }
//   w.getText(), w.getTitle(), w.state, w.stop(): Promise, w.stopReading(), w.settleAll(): Promise, w.unmount()
//   For Read mode (read.js): w.pages(), w.after(page), w.nextPage(page): Promise, w.firstPage(): Promise, w.forming()
import { Recorder, micTrouble } from './recorder.js';
import { tokens } from './align.js';
import { imgAttrs } from './pic.js';

const IDLE_MS = 15000;               // a pause this long settles the draft (contract: ~15–20 s)
// A long unsettled stretch (a pasted story, a long dictation) starts with a small first chunk, so the first pages
// appear (and start painting) in ~15 s and "page X" is real progress; the rest goes in one call, because each call
// costs ~15-30 s of model time whatever its size (10.7k chars: one call 38 s, 2.4k chunks 149 s; 2026-11-02).
const FIRST_CHUNK = 1200, CHUNK = 12000;
const BIG_PASTE = 280;               // a paste this long is finished text: it becomes the book right away
const MAX_REC_MS = 9 * 60 * 1000;    // /api/stt takes up to ~10 minutes of audio
const SEP = /\n{2,}/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const canon = (s) => String(s || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n');
const parasOf = (t) => String(t || '').split(SEP);
const wc = (t) => tokens(t).length;
// For grown-ups on a self-hosted copy: what reading this book aloud has cost (the provider's billed price; hidden in hosted).
export const costLine = (usd) => `Reading this book aloud cost ${usd < 0.01 ? 'less than 1¢' : usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`}`;
export const firstLine = (t) => { const l = String(t || '').trim().split('\n')[0].trim(); return l.length <= 70 ? l : ''; }; // the kid's own words, as a title stand-in
const paraOffset = (t, k) => { const p = parasOf(t); let o = 0; for (let i = 0; i < k && i < p.length; i++) o += p[i].length + 2; return Math.min(o, t.length); };
const LABEL = { starting: 'Opening the microphone…', recording: 'Listening. Tap to stop', transcribing: 'Writing it down…', typing: 'Talk instead' };
const offsetAfterWords = (t, n) => { const re = /\S+/g; let m, k = 0; while ((m = re.exec(t))) if (++k >= n) return m.index + m[0].length; return t.length; };
// Where to end a chunk: a paragraph break, else a sentence end, else a space, in the last 60% before `at`.
function cutNear(t, from, at) {
  const win = t.slice(from, at), min = (at - from) * 0.4;
  let k = win.lastIndexOf('\n\n');
  if (k > min) return from + k;
  const end = [...win.matchAll(/[.!?…]["”'’)]*\s+/g)].pop();
  if (end && end.index > min) return from + end.index + end[0].length;
  k = win.search(/\s\S*$/);
  return k > min ? from + k : at;
}
// Which of two queued layout jobs covers more: 'all' > {words} > 'caret' > 'book'.
const rank = (m) => (m === 'all' ? 3e9 : m && m.words ? m.words : m === 'caret' ? 1 : m === 'book' ? 0 : -1);
const bigger = (a, b) => (rank(b) > rank(a) ? b : a);

export function mount(el, story, opts = {}) {
  const o = { api: null, toast: () => {}, kid: '', live: true, onText: () => {}, onTitle: () => {}, flush: async () => {},
    audio: null, reader: null, voices: () => [], voice: () => null, setVoice: () => {}, onChange: () => {}, ...opts };
  const W = {
    text: canon(story.text), state: 'idle', rec: null, typed: false, dead: false, pending: Promise.resolve(),
    idleT: 0, retryT: 0, booking: null, again: null, chunked: false, quiet: 0, since: {}, painting: new Set(), fresh: new Set(), pageEls: new Map(),
    knownCast: new Set((story.cast || []).map((c) => c.name)), h: null, single: null, playTok: 0, reading: false, poll: 0,
    pasted: 0, userScroll: 0, lit: -1, spans: [], opened: Date.now(),
  };
  story.scenes = story.scenes || [];
  story.book = story.book || { chapters: [], settled_paragraphs: 0 };

  el.innerHTML = `
    <div class="ws" data-state="idle">
      <section class="ms" aria-label="Your story">
        <div class="ms-scroll">
          <h1 class="ms-title" contenteditable="true" spellcheck="false" data-ph="Name your book" aria-label="The book's title"></h1>
          <div class="bk" aria-label="Your book"></div>
          <div class="draft">
            <p class="draft-label" aria-live="polite"></p>
            <div class="draft-text"></div>
            <textarea class="typer" aria-label="Your story" hidden></textarea>
            <p class="empty-hint">Tap the microphone and start telling your story, or type it.</p>
          </div>
          <p class="bk-cost" hidden></p>
        </div>
        <footer class="ms-foot">
          <button class="side-btn type-btn" type="button" aria-label="Type instead"><svg><use href="#i-keys"/></svg></button>
          <div class="act">
            <button class="press" type="button" aria-label="Start talking"><svg class="ico"><use href="#i-mic"/></svg><i class="lvl-ring" aria-hidden="true"></i></button>
            <span class="press-lbl">Start talking</span>
          </div>
          <p class="ms-status" aria-live="polite"></p>
        </footer>
      </section>
      <aside class="ws-side">
        <div class="side-card">
          <button class="btn primary read-book" type="button"><svg class="ico"><use href="#i-play"/></svg><span>Read my book</span></button>
          <label class="voice-pick">Read by <select class="voice" aria-label="Who reads it"></select></label>
        </div>
        <button class="btn fix-punct" type="button"><svg><use href="#i-pencil"/></svg><span>Fix my punctuation</span></button>
        <div class="cast-box" hidden><h3 class="cast-h">Characters</h3><div class="cast-list"></div></div>
        <button class="btn cast-btn" type="button" hidden><svg><use href="#i-people"/></svg><span>Characters</span></button>
      </aside>
      <div class="modal" hidden></div>
    </div>`;
  const q = (s) => el.querySelector(s);
  const ws = q('.ws'), scroller = q('.ms-scroll'), titleEl = q('.ms-title'), bk = q('.bk'), draftEl = q('.draft'), draftText = q('.draft-text'),
    draftLabel = q('.draft-label'), typer = q('.typer'), press = q('.press'), lbl = q('.press-lbl'), typeBtn = q('.type-btn'), status = q('.ms-status'),
    costEl = q('.bk-cost'), readBtn = q('.read-book'), voiceSel = q('.voice'), punctBtn = q('.fix-punct'), castBox = q('.cast-box'), castList = q('.cast-list'), castBtn = q('.cast-btn'), modal = q('.modal'), foot = q('.ms-foot'), side = q('.ws-side');
  const reader = o.reader;
  const prime = () => o.audio && o.audio.prime();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- text model: settled paragraphs (the book) + the draft ---------------- */
  const settledN = () => Math.min(story.book.settled_paragraphs || 0, parasOf(W.text).length);
  const draftOf = (t = W.text) => parasOf(t).slice(settledN()).join('\n\n');
  const settledOf = (t = W.text) => parasOf(t).slice(0, settledN()).join('\n\n');
  function setText(t, { render = true } = {}) {
    W.text = canon(t);
    story.text = W.text;
    o.onText(W.text);
    renderTitleHint();
    if (render) renderDraft();
  }
  function renderTitleHint() {
    const f = firstLine(W.text);
    titleEl.dataset.ph = f || 'Name your book';
    titleEl.classList.toggle('from-text', !!f);
  }
  function setDraft(d) {
    const s = settledOf();
    d = canon(d);
    setText(s && d.trim() ? `${s}\n\n${d}` : s || d, { render: W.state !== 'typing' });
  }
  function appendParagraph(words) {
    const d = draftOf().replace(/\s+$/, '');
    setDraft(d ? `${d}\n\n${words}` : words);
  }

  /* ---------------- rendering ---------------- */
  function wordsHTML(t) { return parasOf(t).map((p) => `<p>${tokens(p).map((w) => `<span class="w">${esc(w)}</span>`).join(' ')}</p>`).join(''); }
  function renderDraft() {
    const d = draftOf();
    draftText.innerHTML = d.trim() ? parasOf(d).map((p) => `<p>${esc(p)}</p>`).join('') : '';
    if (W.rec) draftText.insertAdjacentHTML('beforeend', `<p class="live">${esc(W.rec.live || '')}</p>`);
    const empty = !W.text.trim() && !W.rec && W.state !== 'typing';
    ws.classList.toggle('empty', empty);
    draftEl.classList.toggle('has-draft', !!d.trim() || !!W.rec || W.state === 'typing');
    updateStatus();
  }
  // Keeps whatever the kid is looking at in the draft (usually the caret at its end) still while the book above it
  // changes: pages appear above, and the settled words leave the draft.
  function holdDraft() {
    if (W.dead) return () => {};
    const s = scroller.getBoundingClientRect(), r = draftEl.getBoundingClientRect();
    if (r.bottom < s.top || r.top > s.bottom) return () => {}; // not on screen: nothing to hold
    const y = Math.min(r.bottom, s.bottom) - s.top, fromBottom = r.bottom - (s.top + y);
    return () => {
      const s2 = scroller.getBoundingClientRect(), r2 = draftEl.getBoundingClientRect();
      const want = r2.bottom - fromBottom - s2.top; // where that same spot of the draft is now
      scroller.scrollTop += want - y;
    };
  }
  function fitTyper() { // the textarea grows with the words: one scroll for the whole sheet, never a box inside it
    if (typer.hidden) return;
    const top = scroller.scrollTop;
    typer.style.height = 'auto';
    typer.style.height = typer.scrollHeight + 'px';
    scroller.scrollTop = top;
  }
  function caretInView() { // typing at the very end: keep the last line above the foot of the sheet
    if (typer.hidden || typer.selectionEnd < typer.value.length - 1) return;
    const s = scroller.getBoundingClientRect(), r = typer.getBoundingClientRect();
    if (r.bottom > s.bottom - 12) scroller.scrollTop += r.bottom - s.bottom + 12;
  }
  function chapterFor(p, prev) {
    const chs = story.book.chapters || [];
    const i = chs.findIndex((c) => c.start <= p.from && c.start > (prev ? prev.to : -1));
    return i < 0 ? null : { n: i + 1, title: chs[i].title };
  }
  function figureHTML(p) {
    const busy = W.painting.has(p.sid) || (p.status === 'generating' && !p.queued); // queued = waiting its turn
    if (p.image_url && !busy) { // the frame (.bk-pic, 3:2) holds the space before the picture loads: nothing below it moves
      return `<button class="bk-pic" type="button" aria-label="Change the picture on page ${p.ord + 1}"><img ${imgAttrs(p.image_url, '(max-width: 760px) 40vw, 230px', { src: 480, widths: [480, 960] })} alt="" width="1536" height="1024" loading="lazy" decoding="async" class="${W.fresh.has(p.sid) ? 'develop' : ''}"></button>`
        + (p.stale ? '<button class="btn small bk-stale" type="button"><svg><use href="#i-redo"/></svg>Update the picture?</button>' : '');
    }
    if (p.status === 'error' && !busy) {
      return '<div class="sketch err"><span>The picture didn\'t work.</span><button class="btn small primary bk-retry" type="button"><svg><use href="#i-redo"/></svg>Try again</button></div>';
    }
    const what = busy ? (p.image_url ? 'Painting a new version…' : 'Painting…') : castMissing() ? 'Sketching the characters first…' : 'Sketching…';
    return `<div class="sketch${busy ? ' painting' : ''}"><i class="pencil" aria-hidden="true"></i><span>${what}</span></div>`;
  }
  function pageEl(p) {
    const a = document.createElement('article');
    a.className = 'bk-page';
    a.dataset.sid = p.sid;
    a.dataset.text = p.text;
    a.innerHTML = `<figure class="bk-fig"></figure><div class="bk-text">${wordsHTML(p.text)}</div>
      <footer class="bk-foot"><button class="bk-play" type="button" aria-label="Read this page"><svg><use href="#i-play"/></svg></button>
      <span class="bk-num"></span><button class="bk-edit" type="button" aria-label="Change the words on this page"><svg><use href="#i-pencil"/></svg></button></footer>`;
    a.querySelector('.bk-play').onclick = () => togglePage(p.sid);
    a.querySelector('.bk-edit').onclick = () => editPage(p.sid);
    a.querySelector('.bk-fig').onclick = (e) => {
      const pg = page(p.sid);
      if (!pg) return;
      if (e.target.closest('.bk-stale')) paint(p.sid, {});
      else if (e.target.closest('.bk-retry')) paint(p.sid, {});
      else if (e.target.closest('.bk-pic')) openPicture(p.sid);
    };
    return a;
  }
  function renderFigure(sid) {
    const p = page(sid), a = W.pageEls.get(sid);
    if (!p || !a) return;
    a.querySelector('.bk-fig').innerHTML = figureHTML(p);
    W.fresh.delete(sid);
  }
  function renderBook() {
    const pages = sorted();
    const keep = new Map(), many = (story.book.chapters || []).length > 1;
    bk.querySelectorAll('.bk-ch').forEach((h) => h.remove());
    let prev = null, n = 0;
    for (const p of pages) {
      let a = W.pageEls.get(p.sid);
      if (!a || a.dataset.text !== p.text) {
        if (a && a.classList.contains('playing')) stopPlay(); // its words changed under the reading
        a = pageEl(p);
        if (!W.firstRender) { a.classList.add('fresh'); a.style.animationDelay = Math.min(n++, 8) * 90 + 'ms'; }
      }
      keep.set(p.sid, a);
      const ch = chapterFor(p, prev);
      if (ch) {
        const h = document.createElement('header');
        h.className = 'bk-ch';
        h.innerHTML = `<h2><small>Chapter ${ch.n}</small>${ch.title ? esc(ch.title) : ''}</h2>`
          + (many ? `<button class="bk-ch-read" type="button" data-sid="${esc(p.sid)}"><svg><use href="#i-play"/></svg><span>Read this chapter</span></button>` : '');
        const b = h.querySelector('.bk-ch-read');
        if (b) b.onclick = () => readBook({ from: p.sid, chapter: true, btn: b });
        bk.appendChild(h);
      }
      a.querySelector('.bk-num').textContent = String(p.ord + 1);
      bk.appendChild(a);
      a.querySelector('.bk-fig').innerHTML = figureHTML(p);
      W.fresh.delete(p.sid);
      prev = p;
    }
    for (const [sid, a] of W.pageEls) if (!keep.has(sid)) a.remove();
    W.pageEls = keep;
    W.firstRender = false;
    if (W.chapterBtn) { const b = bk.querySelector(`.bk-ch-read[data-sid="${W.chapterBtn}"]`); if (b) chapterBtnState(b, true); }
    renderCast();
    renderCost();
    updateStatus();
    o.onChange();
  }
  // The characters: a panel beside the sheet on wide screens; on narrow ones a "Characters" button opens them in a sheet.
  function castHTML() {
    const chars = (story.bible && story.bible.characters) || [];
    const have = new Map((story.cast || []).map((c) => [c.name, c.url]));
    const names = [...new Set([...chars.map((c) => c.name), ...have.keys()])];
    return { n: names.length, html: names.map((n) => {
      const url = have.get(n);
      const meet = url && !W.knownCast.has(n);
      return `<button class="who${meet ? ' meet' : ''}" type="button" data-name="${esc(n)}">
        ${url ? `<img ${imgAttrs(url, '(max-width: 760px) 30vw, 120px', { src: 480, widths: [480, 960] })} alt="" width="1448" height="1086">` : `<span class="sketch mini"><i class="pencil"></i></span>`}
        <span class="who-name">${meet ? `Meet ${esc(n)}` : esc(n)}</span></button>`;
    }).join('') };
  }
  function renderCast() {
    const c = castHTML();
    castBox.hidden = castBtn.hidden = !c.n;
    castBtn.querySelector('span').textContent = `Characters (${c.n})`;
    if (W.castHtml !== c.html) { // unchanged: keep the portraits as they are (no reload flicker)
      castList.innerHTML = W.castHtml = c.html;
      castList.querySelectorAll('.who').forEach((b) => { b.onclick = () => openCharacter(b.dataset.name); });
    }
    if (modal.dataset.cast) openCast();
  }
  function openCast() {
    const card = openModal(`<div class="m-side wide"><h2 class="m-h">Characters</h2><p class="m-label">Tap one to see them, or to give the book your own drawing.</p><div class="cast-list in-sheet">${castHTML().html}</div></div>`, 'Characters');
    modal.dataset.cast = '1';
    card.querySelectorAll('.who').forEach((b) => { b.onclick = () => openCharacter(b.dataset.name); });
  }
  castBtn.onclick = openCast;
  // What's happening, at the foot of the sheet (always on screen) and above the draft that is turning into pages.
  function updateStatus() {
    const pages = story.scenes.length, waits = story.scenes.filter(waiting);
    const n = new Set([...W.painting, ...waits.map((p) => p.sid)]).size;
    const forming = W.booking ? `Turning your story into a book…${W.chunked && pages ? ` page ${pages}` : ''}` : '';
    status.textContent = forming || (waits.length && castMissing() ? 'Sketching the characters…' : n ? `Painting ${n} picture${n === 1 ? '' : 's'}. Keep writing; they’ll appear on their own.` : '');
    status.classList.toggle('busy', !!forming);
    draftEl.classList.toggle('forming', !!W.booking);
    draftLabel.textContent = forming || 'Still writing';
  }
  const page = (sid) => story.scenes.find((p) => p.sid === sid);
  const sorted = () => [...story.scenes].sort((x, y) => x.ord - y.ord);
  // For grown-ups: what reading this story aloud has cost on ElevenLabs (exact credits × the price paid; pictures are free).
  function renderCost() {
    const usd = (story.cost && story.cost.elevenlabs_usd) || 0;
    costEl.hidden = !(usd > 0);
    if (usd > 0) costEl.textContent = costLine(usd);
  }

  function setState(s) {
    W.state = s;
    ws.dataset.state = s;
    const recording = s === 'recording';
    press.classList.toggle('rec', recording);
    press.classList.toggle('busy', s === 'transcribing' || s === 'starting');
    press.querySelector('.ico use').setAttribute('href', recording ? '#i-stop' : '#i-mic');
    const label = LABEL[s] || (W.text.trim() ? 'Keep going' : 'Start talking');
    lbl.textContent = label;
    press.setAttribute('aria-label', label);
    typeBtn.classList.toggle('on', s === 'typing');
    typeBtn.querySelector('use').setAttribute('href', s === 'typing' ? '#i-check' : '#i-keys');
    typeBtn.setAttribute('aria-label', s === 'typing' ? 'Done typing' : 'Type instead');
    draftEl.classList.toggle('rec', recording);
    draftEl.classList.toggle('tidy', s === 'transcribing');
    if (!W.dead && s !== 'typing') renderDraft();
  }
  const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };

  /* ---------------- settling: the draft becomes the book ---------------- */
  function idleSoon() { clearTimeout(W.idleT); W.idleT = setTimeout(() => settle(W.state === 'typing' ? 'caret' : 'all'), IDLE_MS); }
  function caretPara() { // how many whole draft paragraphs come before the one the caret is in
    const before = canon(typer.value.slice(0, typer.selectionStart || 0));
    return (before.match(SEP) ? before.split(SEP).length - 1 : 0);
  }
  // Lays out the part of the text `mode` asks for, a chunk at a time when it's long. Modes:
  //   'caret' the paragraphs before the one being written · 'all' everything · 'book' the book part again (after a
  //   page edit or a punctuation fix) · {words: n} the first n words (a big paste: up to its end).
  function goalOf(mode, t, n) {
    if (mode === 'all') return t.length;
    if (mode === 'book') return paraOffset(t, n);
    if (mode && mode.words) return offsetAfterWords(t, mode.words);
    const k = W.state === 'typing' ? caretPara() : parasOf(draftOf(t)).length - 1;
    return k <= 0 ? -1 : paraOffset(t, n + k);
  }
  async function settle(mode = 'caret') {
    clearTimeout(W.idleT);
    clearTimeout(W.retryT);
    if (W.dead && mode !== 'all') return;
    if (W.booking) { W.again = bigger(W.again, mode); return W.booking; }
    const run = (async () => {
      for (let round = 0; round < 60; round++) {
        const t = W.text, n = settledN(), from = paraOffset(t, n);
        let goal = goalOf(mode, t, n);
        if (goal < 0) return;
        while (goal > 0 && /\s/.test(t[goal - 1])) goal--;
        if (wc(t.slice(0, goal)) < 12) return;
        if (mode !== 'book' && !t.slice(from, goal).trim()) return; // nothing new to lay out
        let upto = goal;
        const span = goal - from, size = !story.scenes.length && span > FIRST_CHUNK * 2.5 ? FIRST_CHUNK : span > CHUNK * 1.25 ? CHUNK : 0;
        if (mode !== 'book' && size) { W.chunked = true; upto = cutNear(t, from, from + size); } // this chunk now, the rest next round
        updateStatus();
        await o.flush(); // the server must hold exactly this text
        if (W.text !== t) continue; // they changed something while it saved: look again
        let d;
        try { d = await o.api('POST', `/api/stories/${story.id}/book`, { text: t, settled_upto: upto }); }
        catch (e) { if (e.status !== 401) W.retryT = setTimeout(() => settle(mode), e.status === 409 ? 3000 : 8000); return; }
        applyBook(d, t, upto);
        if (upto === goal || mode === 'book' || !(d && d.applied) || settledN() <= n) return; // done, or no headway
      }
    })();
    W.booking = run;
    updateStatus();
    try { await run; } finally {
      W.booking = null;
      W.chunked = false;
      updateStatus();
      if (W.again) { const m = W.again; W.again = null; settle(m); }
    }
  }
  function applyBook(d, sent, upto) {
    if (!d || !d.book) return;
    const hold = holdDraft();
    Object.assign(story, { book: d.book, scenes: d.scenes || [], bible: d.bible, cast: d.cast || story.cast, cost: d.cost || story.cost, title: story.title || d.title || '' });
    if (story.title && !titleEl.textContent.trim() && document.activeElement !== titleEl) titleEl.textContent = story.title;
    if (d.applied) {
      const served = parasOf(d.text).slice(0, d.book.settled_paragraphs).join('\n\n');
      if (W.text.slice(0, upto) === sent.slice(0, upto)) {
        // They only added words after the cut while we waited: keep those, take the server's paragraph breaks.
        const oldDraft = typer.value, rest = W.text.slice(upto).replace(/^\s+/, '');
        setText(rest ? `${served}\n\n${rest}` : served, { render: W.state !== 'typing' });
        if (W.state === 'typing') {
          const nd = draftOf(), caret = typer.selectionStart || 0, cut = oldDraft.length - nd.length;
          typer.value = nd;
          typer.setSelectionRange(Math.max(0, caret - cut), Math.max(0, caret - cut));
        }
      } else W.again = bigger(W.again, 'caret'); // they changed something inside the part being laid out: lay out again
    }
    renderBook();
    renderDraft();
    fitTyper();
    hold();
    watchPictures();
    const w = pageWaiters; pageWaiters = []; w.forEach((f) => f());
  }

  /* ---------------- where they were: the page at the top of the sheet, per story ---------------- */
  // A saved book opens where the kid left it (or at page one), not at the draft; starting to talk or type still goes
  // to the end. Saved as a page id + offset (not a raw scroll position), so it survives pictures and new pages.
  const posKey = `stories.pos.${story.id}`;
  function savePos() {
    if (W.dead || W.restoring) return;
    const s = scroller.getBoundingClientRect();
    for (const el of [...bk.querySelectorAll('.bk-page'), draftEl]) {
      const r = el.getBoundingClientRect();
      if (r.bottom > s.top + 12) { try { localStorage.setItem(posKey, JSON.stringify({ at: el.dataset.sid || 'draft', off: Math.round(s.top - r.top) })); } catch { /* private mode */ } return; }
    }
  }
  function restorePos() {
    let a = null;
    try { a = JSON.parse(localStorage.getItem(posKey) || 'null'); } catch { a = null; }
    const el = a && (a.at === 'draft' ? draftEl : W.pageEls.get(a.at));
    W.restoring = true;
    if (el) scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + (a.off || 0);
    else if (story.scenes.length) scroller.scrollTop = 0; // a book: page one
    else toBottom(); // only a draft: where the writing goes on
    requestAnimationFrame(() => { W.restoring = false; });
  }
  let posT = 0;
  scroller.addEventListener('scroll', () => { clearTimeout(posT); posT = setTimeout(savePos, 300); }, { passive: true });

  /* ---------------- pictures: painted on the server (CONTRACT.md, 2026-11-02) ---------------- */
  // /book enqueues the story; the server draws portraits of new characters, then every page without a picture, even
  // if this tab closes. The browser never asks for first pictures: it only watches (GET every 5 s while any page is
  // waiting) and shows the pencil placeholder, then the picture. The kid's own requests (feedback, a reference, "Update
  // the picture?", "Try again") still go to /image; for a page with no picture that returns 202 and the queue paints it.
  const waiting = (p) => !p.image_url && (p.status === 'pending' || p.status === 'generating');
  function castMissing() {
    const have = new Set((story.cast || []).map((c) => c.name));
    return ((story.bible && story.bible.characters) || []).some((c) => !have.has(c.name));
  }
  function watchPictures() {
    if (W.dead || W.poll) return;
    if (!story.scenes.some(waiting) && !(story.scenes.length && castMissing())) return;
    W.quiet = 0;
    W.poll = setInterval(lookAgain, 5000);
    updateStatus();
  }
  function stopWatching() { clearInterval(W.poll); W.poll = 0; }
  async function lookAgain() {
    if (W.dead) { stopWatching(); return; }
    const fresh = await o.api('GET', `/api/stories/${story.id}`).catch(() => null);
    if (!fresh || W.dead) return;
    let changed = false, sheetPage = false;
    const hadCast = castMissing();
    if (JSON.stringify(fresh.cast || []) !== JSON.stringify(story.cast || [])) { story.cast = fresh.cast || []; renderCast(); changed = true; }
    for (const f of fresh.scenes || []) {
      const p = page(f.sid);
      if (!p || W.painting.has(p.sid)) continue; // the kid's own redraw is in flight here
      const was = `${p.image_url}|${p.status}|${p.stale}|${!!p.queued}`;
      if (`${f.image_url}|${f.status}|${f.stale}|${!!f.queued}` === was) continue;
      if (f.image_url && f.image_url !== p.image_url) W.fresh.add(p.sid);
      if (p.sid === modal.dataset.sid) sheetPage = true;
      Object.assign(p, { image_url: f.image_url, status: f.status, queued: !!f.queued, versions: f.versions, stale: f.stale, error: f.error });
      renderFigure(p.sid);
      changed = true;
    }
    if (hadCast && !castMissing()) story.scenes.filter(waiting).forEach((p) => renderFigure(p.sid)); // "Sketching the characters first…" → "Sketching…"
    // A page still "pending" (not queued, not painting) after 2 minutes isn't in the server's queue (a story laid out
    // before the queue existed): offer "Try again", which asks the server (202) to queue it.
    const now = Date.now();
    for (const p of story.scenes) {
      if (p.status !== 'pending' || p.image_url) { delete W.since[p.sid]; continue; }
      W.since[p.sid] = W.since[p.sid] || now;
      if (now - W.since[p.sid] > 120000) { p.status = 'error'; delete W.since[p.sid]; renderFigure(p.sid); changed = true; }
    }
    if (changed) o.onChange();
    W.quiet = changed ? 0 : W.quiet + 1;
    if (W.quiet > 120) { // 10 minutes with nothing new: stop watching and let the kid ask again
      story.scenes.filter(waiting).forEach((p) => { p.status = 'error'; renderFigure(p.sid); });
      stopWatching();
    } else if (!story.scenes.some(waiting) && !castMissing()) stopWatching();
    updateStatus();
    // The open picture sheet is redrawn only when its own page changed (it used to be rebuilt on every change in the
    // book, every 5 s while pictures painted, replacing the × under the pointer mid-click).
    if (sheetPage && modal.dataset.sid && page(modal.dataset.sid) && !W.painting.has(modal.dataset.sid)) openPicture(modal.dataset.sid);
  }
  async function paint(sid, body) {
    if (W.painting.has(sid)) return;
    W.painting.add(sid);
    renderFigure(sid);
    updateStatus();
    try {
      const d = await o.api('POST', `/api/stories/${story.id}/scenes/${sid}/image`, body || {});
      const p = page(sid);
      if (p && d && d.painting) Object.assign(p, { status: 'generating', queued: !!d.queued, error: null }); // 202: the queue paints it
      else if (p && d && d.image_url) { Object.assign(p, { image_url: d.image_url, status: 'done', stale: false, error: null }); if (d.versions) p.versions = d.versions; W.fresh.add(sid); }
    } catch (e) {
      const p = page(sid);
      if (p && e.status !== 401) { p.status = 'error'; p.error = e.message; }
    }
    W.painting.delete(sid);
    if (W.dead) return;
    renderFigure(sid);
    updateStatus();
    watchPictures();
    o.onChange();
    if (modal.dataset.sid === sid) openPicture(sid);
  }

  /* ---------------- reading aloud: one page, a chapter, or the whole book, always page by page ---------------- */
  // reader.js asks /api/tts for one page at a time and fetches the next page while this one plays (never the whole
  // story: ElevenLabs refuses over 10,000 characters). The highlight moves across pages and the sheet follows it.
  const after = (p) => sorted().find((x) => x.from > p.to) || null; // by paragraph: stable while later pages form
  const draftWaiting = () => !!draftOf().trim() && W.state === 'idle';
  const forming = () => !!W.booking || draftWaiting();
  let pageWaiters = [];
  const pagesLanded = () => new Promise((r) => pageWaiters.push(r)); // the next time pages arrive from /book
  async function formMore() { // lays out more of the book if it can; false when nothing more will come
    if (W.booking) { await Promise.race([W.booking, pagesLanded()]); return true; }
    if (!draftWaiting()) return false;
    const before = `${settledN()}|${story.scenes.length}`;
    await settle('all');
    return `${settledN()}|${story.scenes.length}` !== before || !!W.booking;
  }
  async function nextPage(p) {
    for (let i = 0; i < 60; i++) { const n = after(p); if (n) return n; if (!(await formMore())) return after(p); }
    return null;
  }
  async function firstPage() {
    if (W.state === 'typing') finishTyping();
    for (let i = 0; i < 60; i++) { const f = sorted()[0]; if (f) return f; if (!(await formMore())) break; }
    return sorted()[0] || null;
  }
  const wordsOf = (p) => { const a = W.pageEls.get(p.sid); return a ? [...a.querySelectorAll('.bk-text .w')].map((x) => x.textContent) : tokens(p.text); };

  function setReadBtn(mode) { // idle · making (the book is still forming) · on
    readBtn.classList.toggle('on', mode === 'on');
    readBtn.classList.toggle('making', mode === 'making');
    readBtn.querySelector('span').textContent = mode === 'making' ? 'Your book is still being made…' : mode === 'on' ? 'Stop reading' : 'Read my book';
    readBtn.querySelector('use').setAttribute('href', mode === 'on' ? '#i-pause' : '#i-play');
    readBtn.setAttribute('aria-label', mode === 'idle' ? 'Read my book' : 'Stop reading');
  }
  function chapterBtnState(b, on) {
    b.classList.toggle('on', on);
    b.querySelector('span').textContent = on ? 'Stop reading' : 'Read this chapter';
    b.querySelector('use').setAttribute('href', on ? '#i-pause' : '#i-play');
  }
  function stopPlay() {
    W.playTok++;
    if (W.h) { W.h.stop(); W.h = null; }
    bk.querySelectorAll('.bk-page.playing, .bk-page.loading').forEach((a) => { a.classList.remove('playing', 'loading'); a.querySelector('.bk-play use').setAttribute('href', '#i-play'); });
    bk.querySelectorAll('.w.lit, .w.now').forEach((x) => x.classList.remove('lit', 'now'));
    bk.querySelectorAll('.bk-ch-read.on').forEach((b) => chapterBtnState(b, false));
    W.single = null; W.reading = false; W.chapterBtn = null; W.spans = []; W.lit = -1;
    setReadBtn('idle');
  }
  // The page being read: its play button becomes a stop button; the sheet brings it into view.
  function onPage(p, s) {
    const a = W.pageEls.get(p.sid);
    if (!a) return;
    if (s === 'load') { a.classList.add('loading'); return; }
    a.classList.remove('loading');
    if (s === 'start') {
      a.classList.add('playing');
      a.querySelector('.bk-play use').setAttribute('href', '#i-pause');
      W.spans = [...a.querySelectorAll('.bk-text .w')]; W.lit = -1;
      follow(a.querySelector('.bk-text') || a, true);
    } else {
      a.classList.remove('playing');
      a.querySelector('.bk-play use').setAttribute('href', '#i-play');
      a.querySelectorAll('.w.lit, .w.now').forEach((x) => x.classList.remove('lit', 'now'));
    }
  }
  function onWord(p, i) {
    const sp = W.spans;
    if (!sp.length || !sp[0].isConnected) return;
    if (i < W.lit) { sp.forEach((x) => x.classList.remove('lit')); W.lit = -1; }
    for (let j = W.lit + 1; j <= i && j < sp.length; j++) sp[j].classList.add('lit');
    if (sp[W.lit]) sp[W.lit].classList.remove('now');
    W.lit = i;
    if (sp[i]) { sp[i].classList.add('now'); follow(sp[i]); }
  }
  // Keep the word being read on screen, unless the kid is scrolling around themselves.
  function follow(el, pageStart = false) {
    if (Date.now() - W.userScroll < 2500) return;
    const s = scroller.getBoundingClientRect(), r = el.getBoundingClientRect();
    const low = pageStart ? r.top > s.top + s.height * 0.55 : r.bottom > s.bottom - s.height * 0.2;
    if (!low && r.top >= s.top + 4) return;
    const y = scroller.scrollTop + r.top - s.top - (pageStart ? 16 : s.height * 0.3);
    scroller.scrollTo({ top: Math.max(0, y), behavior: reduce ? 'auto' : 'smooth' });
  }
  ['wheel', 'touchmove'].forEach((ev) => scroller.addEventListener(ev, () => { W.userScroll = Date.now(); }, { passive: true }));
  function readError(e, p, again) {
    if (e.status === 401 || W.dead) return;
    if (e.name === 'NotAllowedError') o.toast('Tap play to listen.');
    else o.toast(e.status === 0 ? e.message : "This page couldn't be read just now.", { retry: again });
  }

  function togglePage(sid) {
    const same = W.single === sid;
    stopPlay();
    const p = page(sid);
    if (same || !p || !reader) return;
    prime();
    const tok = W.playTok;
    W.single = sid;
    W.h = reader.play({ voice: o.voice(), first: p, words: wordsOf, onPage, onWord,
      onError: (e) => readError(e, p, () => togglePage(sid)) });
    W.h.done.then(() => { if (tok === W.playTok) stopPlay(); });
  }
  // The whole book (or one chapter) from `from`, page after page. Pages that are still forming are waited for.
  async function readBook({ from = null, chapter = false, btn = null } = {}) {
    const wasChapter = W.chapterBtn;
    if (W.reading) { stopPlay(); if (!btn || wasChapter === from) return; }
    if (!reader) return;
    prime();
    stopPlay();
    const tok = W.playTok;
    W.reading = true;
    if (btn) { W.chapterBtn = from; chapterBtnState(btn, true); }
    if (W.state === 'typing') finishTyping();
    if (draftWaiting()) settle('all'); // the rest joins the book while the first pages are read
    const first = (from && page(from)) || sorted()[0] || firstPage(); // a Promise while the first page is still forming
    setReadBtn(first.then ? 'making' : 'on');
    const chs = (story.book.chapters || []).map((c) => c.start).sort((a, b) => a - b);
    const end = chapter && first.from !== undefined ? (chs.find((c) => c > first.from) ?? Infinity) : Infinity;
    const inRange = (n) => (n && n.from < end ? n : null);
    let started = false;
    W.h = reader.play({
      voice: o.voice(), first, words: wordsOf, onWord,
      onPage: (p, s) => { started = true; onPage(p, s); },
      peek: (p) => inRange(after(p)),
      next: async (p) => (p.to + 1 >= end ? null : inRange(await nextPage(p))),
      onWait: (on) => { if (tok === W.playTok) setReadBtn(on ? 'making' : 'on'); },
      onError: (e, p) => readError(e, p, () => readBook({ from: p.sid, chapter })),
    });
    await W.h.done;
    if (tok !== W.playTok) return;
    stopPlay();
    if (!started && !sorted().length) o.toast('Tell a few sentences first, then your book can be read.');
  }
  readBtn.onclick = () => readBook();
  function renderVoices() {
    const vs = o.voices() || [], cur = o.voice();
    voiceSel.innerHTML = vs.map((v) => `<option value="${esc(v.id)}"${v.id === cur ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
  }
  voiceSel.onchange = () => { const was = W.reading && W.h && W.h.page; stopPlay(); o.setVoice(voiceSel.value); if (was) readBook({ from: was.sid }); };

  /* ---------------- talking ---------------- */
  async function startRec() {
    if (W.state === 'typing') finishTyping();
    if (W.state !== 'idle') return;
    stopPlay();
    clearTimeout(W.idleT);
    setState('starting');
    let r;
    try { r = await Recorder.start({ onLevel: (v) => press.style.setProperty('--lvl', v.toFixed(2)) }); }
    catch (e) { if (!W.dead && W.state === 'starting') { setState('idle'); o.toast(micTrouble(e)); } return; }
    if (W.dead || W.state !== 'starting') { r.cancel(); return; }
    const R = W.rec = { r, live: '', mic: null, cap: setTimeout(() => { if (W.rec === R) stopRec(); }, MAX_REC_MS) };
    if (o.live && globalThis.Listen && globalThis.Listen.supported) {
      R.mic = globalThis.Listen.create({
        onText: (t) => { if (W.rec !== R) return; R.live = t; const l = draftText.querySelector('.live'); if (l) l.textContent = t; toBottom(); },
        onState: () => {},
      });
      R.mic.start();
    }
    setState('recording');
    toBottom();
    settle('all'); // a new recording is a new paragraph: what came before is finished
  }
  function stopRec() {
    const R = W.rec;
    if (!R) { if (W.state === 'starting') setState('idle'); return W.pending; }
    W.rec = null;
    clearTimeout(R.cap);
    if (R.mic) { try { R.mic.stop(); } catch { /* already stopped */ } }
    const liveText = clean((R.mic && R.mic.text) || R.live);
    setState('transcribing');
    W.pending = R.r.stop().then((blob) => transcribe(blob, liveText));
    return W.pending;
  }
  // Whisper's text is the real one; the live words are the fallback if Whisper fails or hears nothing.
  async function transcribe(blob, liveText) {
    let heard = '', err = null;
    if (blob.size >= 2000) {
      try {
        const d = await o.api('POST', `/api/stt?story=${encodeURIComponent(story.id)}&author=${encodeURIComponent(o.kid || story.author || '')}`, blob);
        heard = clean(d && d.text);
      } catch (e) { err = e; }
    }
    const words = heard || liveText;
    if (!words) {
      setState('idle');
      if (err && err.status !== 401) o.toast("Those words didn't make it onto the page.", { retry: () => { setState('transcribing'); W.pending = transcribe(blob, liveText); return W.pending; } });
      else if (!err) o.toast("I didn't catch any words. Try again a little closer to the microphone.");
      return;
    }
    appendParagraph(words);
    setState('idle');
    const last = draftText.lastElementChild;
    if (last) last.classList.add('fresh');
    toBottom();
    idleSoon();
  }

  /* ---------------- typing (the draft only; book pages have their own pencil button) ---------------- */
  function startTyping() {
    if (W.state === 'transcribing') { o.toast('One moment, still writing down your words.'); return; }
    if (W.state !== 'idle') return;
    stopPlay();
    W.typed = false;
    typer.value = draftOf();
    typer.hidden = false;
    setState('typing');
    renderDraft();
    fitTyper();
    typer.focus({ preventScroll: true });
    typer.setSelectionRange(typer.value.length, typer.value.length);
    toBottom();
  }
  function finishTyping() {
    if (W.state !== 'typing') return;
    typer.hidden = true;
    if (W.typed) setDraft(typer.value.replace(/\s+$/, ''));
    W.typed = false;
    setState('idle');
    idleSoon();
  }
  // A big paste is a finished story (or a big part of one): it becomes the book right away, a chunk at a time.
  typer.addEventListener('paste', (e) => { W.pasted = ((e.clipboardData && e.clipboardData.getData('text')) || '').length; });
  typer.addEventListener('input', (e) => {
    W.typed = true;
    setDraft(typer.value);
    fitTyper();
    const big = e.inputType === 'insertFromPaste' && W.pasted >= BIG_PASTE;
    W.pasted = 0;
    if (big) settle({ words: wc(settledOf()) + wc(typer.value.slice(0, typer.selectionEnd)) });
    else idleSoon();
    caretInView();
  });
  typer.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    // Enter starts a new paragraph, and the one before it becomes part of the book.
    e.preventDefault();
    const a = typer.selectionStart, b = typer.selectionEnd, v = typer.value;
    const before = v.slice(0, a).replace(/[ \t]+$/, '');
    if (!before.trim() || /\n\n$/.test(before)) return;
    typer.value = `${before}\n\n${v.slice(b).replace(/^\s+/, '')}`;
    typer.setSelectionRange(before.length + 2, before.length + 2);
    W.typed = true;
    setDraft(typer.value);
    fitTyper();
    caretInView();
    settle('caret');
  });

  /* ---------------- changing the words on a finished page ---------------- */
  function editPage(sid) {
    const p = page(sid), a = W.pageEls.get(sid);
    if (!p || !a || a.classList.contains('editing')) return;
    stopPlay();
    const box = a.querySelector('.bk-text');
    a.classList.add('editing');
    box.innerHTML = '<textarea class="pg-typer" aria-label="The words on this page"></textarea><button class="btn small primary pg-done" type="button"><svg><use href="#i-check"/></svg>Done</button>';
    const ta = box.querySelector('textarea');
    ta.value = p.text;
    const grow = () => { const top = scroller.scrollTop; ta.style.height = 'auto'; ta.style.height = Math.max(120, ta.scrollHeight + 4) + 'px'; scroller.scrollTop = top; };
    ta.addEventListener('input', grow);
    grow();
    ta.focus({ preventScroll: true });
    box.querySelector('.pg-done').onclick = () => {
      a.classList.remove('editing');
      const nt = canon(ta.value).trim();
      if (!nt || nt === p.text) { box.innerHTML = wordsHTML(p.text); return; }
      const paras = parasOf(W.text), n = settledN(), np = parasOf(nt);
      paras.splice(p.from, p.to - p.from + 1, ...np);
      story.book.settled_paragraphs = n + np.length - (p.to - p.from + 1);
      p.text = nt;
      a.dataset.text = nt;
      box.innerHTML = wordsHTML(nt);
      setText(paras.join('\n\n'));
      settle('book');
    };
  }

  /* ---------------- sheets: a picture, a character, punctuation ---------------- */
  // One dialog for every sheet (a picture, a character, the characters, punctuation): it has a name, takes the focus,
  // keeps Tab inside, makes everything behind it inert, closes on Escape or a tap outside, and gives the focus back.
  // Closing happens once, however many times the × is hit, and the sheet fades for 0.65 s without taking clicks, so a
  // double or rage click can't fall through to what is underneath. Alan's PostHog session (2026-11-02 20:55, page 16):
  // two clicks 2 px left of the × landed on the sheet's heading, the third closed it and the fourth hit "Type instead"
  // under it. The × now has a 12 px wider target too (read.css). Redrawing an open sheet (a picture landed) replaces
  // it in place, without the arrival animation.
  let returnFocus = null, inerted = [], closing = 0;
  function openModal(html, label = 'Sheet') {
    const again = !modal.hidden && !closing;
    if (closing) { clearTimeout(closing); closing = 0; modal.classList.remove('closing'); }
    if (modal.hidden) returnFocus = document.activeElement;
    modal.innerHTML = `<div class="m-card${again ? ' again' : ''}" role="dialog" aria-modal="true" aria-label="${esc(label)}" tabindex="-1"><button class="x m-x" type="button" aria-label="Close"><svg><use href="#i-close"/></svg></button>${html}</div>`;
    delete modal.dataset.sid; delete modal.dataset.name; delete modal.dataset.cast; delete modal.dataset.punct;
    modal.hidden = false;
    if (!inerted.length) for (let n = modal; n && n.parentElement && n !== document.body; n = n.parentElement) {
      for (const sib of n.parentElement.children) if (sib !== n && !sib.inert && !sib.matches('script, [role="status"]')) { sib.inert = true; inerted.push(sib); }
    }
    modal.querySelector('.m-x').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    const card = modal.querySelector('.m-card');
    card.focus({ preventScroll: true }); // the dialog itself: no keyboard popping up on an iPad
    return card;
  }
  function closeModal() {
    if (modal.hidden || closing) return;
    const wasPunct = !!modal.dataset.punct;
    delete modal.dataset.sid; delete modal.dataset.name; delete modal.dataset.cast; delete modal.dataset.punct; cancelNote();
    modal.classList.add('closing');
    inerted.forEach((x) => { x.inert = false; }); inerted = [];
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
    closing = setTimeout(() => { closing = 0; modal.hidden = true; modal.classList.remove('closing'); modal.innerHTML = ''; }, 650);
    if (wasPunct && W.punct) stopPunct();
  }
  modal.addEventListener('keydown', (e) => { // Tab moves through the sheet's controls and stays inside (the same in every
    if (e.key !== 'Tab') return;             // browser: Safari's own Tab skips buttons)
    const f = [...modal.querySelectorAll('button, input, select, textarea, [href]')].filter((x) => !x.disabled && x.offsetParent);
    if (!f.length) return;
    e.preventDefault();
    const i = f.indexOf(document.activeElement);
    f[(i < 0 ? (e.shiftKey ? f.length - 1 : 0) : i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  });

  // A short recording for a feedback box: tap to talk, tap to stop, the words land in the box.
  let note = null;
  function cancelNote() { if (note) { note.r.cancel(); note.btn.classList.remove('rec'); note = null; } }
  async function dictateInto(input, btn) {
    if (note && note.btn === btn) {
      const n = note; note = null; btn.classList.remove('rec'); btn.classList.add('busy');
      const blob = await n.r.stop();
      try { const d = await o.api('POST', `/api/stt?story=${encodeURIComponent(story.id)}&author=${encodeURIComponent(o.kid || '')}`, blob); if (d.text) input.value = clean(`${input.value} ${d.text}`); }
      catch (e) { if (e.status !== 401) o.toast("I didn't catch that. Try typing it."); }
      btn.classList.remove('busy');
      return;
    }
    cancelNote();
    try { note = { r: await Recorder.start(), btn }; btn.classList.add('rec'); } catch (e) { o.toast(micTrouble(e)); }
  }
  async function uploadPicture(file) {
    const blob = await shrink(file);
    const d = await o.api('POST', `/api/upload?story=${encodeURIComponent(story.id)}`, blob);
    return d.url;
  }

  function openPicture(sid) {
    const p = page(sid);
    if (!p) return;
    const busy = W.painting.has(sid);
    const card = openModal(`
      <div class="m-pic">${p.image_url ? `<img ${imgAttrs(p.image_url, '(max-width: 760px) 92vw, 480px')} alt="">` : '<div class="sketch"><i class="pencil"></i></div>'}${busy ? '<div class="m-busy">Painting a new version…</div>' : ''}</div>
      <div class="m-side">
        <h2 class="m-h">Page ${p.ord + 1}</h2>
        ${(p.versions || []).length > 1 ? `<p class="m-label">Earlier pictures: tap one to go back</p><div class="m-versions">${p.versions.map((v) => `<button type="button" class="ver${v.url === p.image_url ? ' on' : ''}" data-url="${esc(v.url)}"><img ${imgAttrs(v.url, '76px', { src: 480, widths: [480] })} alt=""></button>`).join('')}</div>` : ''}
        <p class="m-label">What should change?</p>
        <label class="note"><input class="m-feedback" value="${esc(p.feedback || '')}" placeholder="Make the moon bigger…" aria-label="What should change?"><button class="mic" type="button" aria-label="Say it"><svg><use href="#i-mic"/></svg></button></label>
        <p class="m-label">A picture to copy from (a drawing, a photo)</p>
        <div class="m-refs">${(p.refs || []).map((u) => `<span class="ref"><img ${imgAttrs(u, '66px', { src: 480, widths: [480] })} alt=""><button type="button" class="rm" data-url="${esc(u)}" aria-label="Remove">✕</button></span>`).join('')}<label class="add-ref" aria-label="Add a picture"><svg><use href="#i-plus"/></svg><input type="file" accept="image/*"></label></div>
        <button class="btn primary m-go" type="button"${busy ? ' disabled' : ''}><svg><use href="#i-redo"/></svg>Draw it again</button>
      </div>`, `The picture on page ${p.ord + 1}`);
    modal.dataset.sid = sid;
    const fb = card.querySelector('.m-feedback');
    card.querySelector('.mic').onclick = (e) => dictateInto(fb, e.currentTarget);
    card.querySelectorAll('.ver').forEach((b) => { b.onclick = async () => {
      try { const d = await o.api('POST', `/api/stories/${story.id}/scenes/${sid}/version`, { url: b.dataset.url }); Object.assign(p, { image_url: d.image_url, stale: d.stale, versions: d.versions || p.versions }); renderFigure(sid); openPicture(sid); }
      catch (e) { if (e.status !== 401) o.toast("Couldn't switch pictures."); }
    }; });
    card.querySelectorAll('.m-refs .rm').forEach((b) => { b.onclick = () => { p.refs = (p.refs || []).filter((u) => u !== b.dataset.url); o.api('PUT', `/api/stories/${story.id}/scenes/${sid}`, { refs: p.refs }).catch(() => {}); p.feedback = fb.value; openPicture(sid); }; });
    card.querySelector('.add-ref input').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      e.target.closest('.add-ref').classList.add('busy');
      try { const url = await uploadPicture(f); p.refs = [...(p.refs || []), url].slice(-4); await o.api('PUT', `/api/stories/${story.id}/scenes/${sid}`, { refs: p.refs }); }
      catch (err) { if (err.status !== 401) o.toast("That picture didn't upload. Try another?"); }
      p.feedback = fb.value;
      if (modal.dataset.sid === sid) openPicture(sid);
    };
    card.querySelector('.m-go').onclick = () => {
      p.feedback = fb.value.trim();
      closeModal();
      paint(sid, { feedback: p.feedback, refs: p.refs || [] });
    };
  }

  function openCharacter(name) {
    const c = (story.cast || []).find((x) => x.name === name);
    const look = (((story.bible && story.bible.characters) || []).find((x) => x.name === name) || {}).look || '';
    W.knownCast.add(name);
    renderCast();
    const card = openModal(`
      <div class="m-pic">${c ? `<img ${imgAttrs(c.url, '(max-width: 760px) 92vw, 480px')} alt="">` : '<div class="sketch"><i class="pencil"></i><span>Sketching…</span></div>'}</div>
      <div class="m-side">
        <h2 class="m-h">${esc(name)}</h2>
        ${look ? `<p class="m-look">${esc(look)}</p>` : ''}
        <p class="m-label">Did you draw ${esc(name)}? Show me and the book will use your drawing.</p>
        <label class="btn primary m-upload"><svg><use href="#i-plus"/></svg>Add my drawing<input type="file" accept="image/*" class="m-file"></label>
        <div class="m-after"></div>
      </div>`, name);
    modal.dataset.name = name;
    card.querySelector('.m-upload input').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const up = card.querySelector('.m-upload');
      up.classList.add('busy');
      card.querySelector('.m-pic').insertAdjacentHTML('beforeend', '<div class="m-busy">Painting your drawing…</div>');
      try {
        const url = await uploadPicture(f);
        const d = await o.api('POST', `/api/stories/${story.id}/cast`, { name, refs: [url] });
        story.cast = d.cast || story.cast;
        renderCast();
        if (modal.dataset.name !== name) return;
        const nc = story.cast.find((x) => x.name === name);
        card.querySelector('.m-pic').innerHTML = nc ? `<img ${imgAttrs(nc.url, '(max-width: 760px) 92vw, 480px')} alt="" class="develop">` : '';
        up.classList.remove('busy');
        const pages = (d.pages_with || []).filter((sid) => page(sid));
        if (pages.length) {
          card.querySelector('.m-after').innerHTML = `<p class="m-label">Draw ${esc(name)} like this on the other pages too?</p><button class="btn primary m-redo" type="button"><svg><use href="#i-redo"/></svg>Yes, redraw ${pages.length} page${pages.length === 1 ? '' : 's'}</button>`;
          card.querySelector('.m-redo').onclick = () => { closeModal(); pages.forEach((sid) => paint(sid, { feedback: `Draw ${name} so they look like their new portrait.` })); };
        }
      } catch (err) {
        up.classList.remove('busy');
        card.querySelector('.m-busy')?.remove();
        if (err.status !== 401) o.toast(`Couldn't paint ${name} from that drawing. Try again?`);
      }
    };
  }

  // "Fix my punctuation" (on request): one /punctuation {para} call per paragraph, 6 at a time, so the first
  // suggestions come in seconds and the button shows how far it has looked. (A whole long story in one call took 25 s
  // with no feedback: Alan's PostHog session, 2026-11-02.) Suggestions open one at a time, in story order, as they
  // arrive; the kid accepts or skips each. Closing the sheet stops the checking.
  const PUNCT_AT_ONCE = 6;
  function stopPunct() {
    W.punct = null;
    punctBtn.classList.remove('busy');
    punctBtn.style.removeProperty('--p');
    punctBtn.querySelector('span').textContent = 'Fix my punctuation';
  }
  async function fixPunctuation() {
    if (W.punct) return;
    if (!W.text.trim()) { o.toast('Write something first.'); return; }
    if (W.state === 'typing') finishTyping();
    const todo = parasOf(W.text).map((t, i) => (t.trim() ? i : -1)).filter((i) => i >= 0);
    const P = W.punct = { total: todo.length, done: 0, failed: 0, list: [], at: 0, fin: false, changedBook: false };
    const label = punctBtn.querySelector('span');
    const progress = () => {
      if (W.punct !== P) return;
      label.textContent = `Checking… ${P.done} of ${P.total}`;
      punctBtn.style.setProperty('--p', `${Math.round((P.done / Math.max(1, P.total)) * 100)}%`);
      const c = modal.dataset.punct && modal.querySelector('.pz-count');
      if (c) c.textContent = countText();
    };
    const countText = () => (P.at < P.list.length ? `Suggestion ${P.at + 1} of ${P.list.length}${P.fin ? '' : ' so far'}` : '')
      + (P.fin ? '' : `${P.at < P.list.length ? ' · ' : ''}still checking (${P.done} of ${P.total})`);
    const finish = () => {
      const changed = P.changedBook;
      W.punct = null; // closeModal must not stop it again
      closeModal();
      stopPunct();
      o.toast(changed ? 'Done. Your book pages are updating.' : 'Done.');
      if (changed) settle('book');
    };
    const show = () => {
      if (W.punct !== P) return;
      if (P.at >= P.list.length) {
        if (P.fin) { finish(); return; }
        const card = openModal(`<div class="m-side wide"><p class="m-label pz-count">${esc(countText())}</p>
          <p class="pz-wait">Looking at the rest of your story…</p></div>`, 'Punctuation');
        modal.dataset.punct = '1';
        return card;
      }
      const sg = P.list[P.at];
      const para = parasOf(W.text)[sg.para] || '';
      const at = para.indexOf(sg.find);
      if (at < 0) { P.at++; show(); return; } // an earlier fix already changed this spot
      const ctx = `${esc(para.slice(Math.max(0, at - 50), at))}<mark>${esc(sg.find)}</mark>${esc(para.slice(at + sg.find.length, at + sg.find.length + 50))}`;
      const card = openModal(`<div class="m-side wide">
        <p class="m-label pz-count">${esc(countText())}</p>
        <p class="pz-ctx">…${ctx}…</p>
        <p class="pz-fix"><span class="pz-old">${esc(sg.find)}</span> → <span class="pz-new">${esc(sg.replace)}</span></p>
        <p class="m-look">${esc(sg.why)}</p>
        <div class="pz-btns"><button class="btn primary pz-yes" type="button"><svg><use href="#i-check"/></svg>Fix it</button><button class="btn pz-no" type="button">Skip</button></div>
      </div>`, 'Punctuation');
      modal.dataset.punct = '1';
      card.querySelector('.pz-yes').onclick = () => {
        const paras = parasOf(W.text);
        if (paras[sg.para] && paras[sg.para].includes(sg.find)) {
          paras[sg.para] = paras[sg.para].replace(sg.find, sg.replace);
          if (sg.para < settledN()) { P.changedBook = true; for (const p of story.scenes) if (sg.para >= p.from && sg.para <= p.to) p.text = paras.slice(p.from, p.to + 1).join('\n\n'); }
          setText(paras.join('\n\n'));
          if (P.changedBook) renderBook();
        }
        P.at++; show();
      };
      card.querySelector('.pz-no').onclick = () => { P.at++; show(); };
    };
    punctBtn.classList.add('busy');
    progress();
    await o.flush(); // the server reads the saved text
    let next = 0;
    const worker = async () => {
      while (next < todo.length && W.punct === P && !W.dead) {
        const i = todo[next++];
        let got = [];
        try { const d = await o.api('POST', `/api/stories/${story.id}/punctuation`, { para: i }); got = ((d && d.suggestions) || []).filter((x) => x.para === i); }
        catch (e) { if (e.status === 401) { if (W.punct === P) stopPunct(); return; } P.failed++; }
        if (W.punct !== P) return;
        P.done++;
        // in story order, after the one on screen
        for (const x of got) { let k = P.list.length; while (k > P.at + 1 && P.list[k - 1].para > x.para) k--; P.list.splice(k, 0, x); }
        progress();
        const open = !!modal.dataset.punct;
        if (got.length && (!open || modal.querySelector('.pz-wait'))) show();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PUNCT_AT_ONCE, todo.length) }, worker));
    if (W.punct !== P) return;
    P.fin = true;
    progress();
    if (!P.list.length) {
      const failed = P.failed === P.total;
      if (modal.dataset.punct) { W.punct = null; closeModal(); }
      stopPunct();
      o.toast(failed ? 'Couldn’t check the punctuation just now.' : 'Your punctuation looks good.');
      return;
    }
    if (!modal.dataset.punct || modal.querySelector('.pz-wait')) show();
    stopPunctButton();
    function stopPunctButton() { punctBtn.classList.remove('busy'); punctBtn.style.removeProperty('--p'); label.textContent = 'Fix my punctuation'; }
  }
  punctBtn.onclick = fixPunctuation;

  // A picture from the camera roll: at most 1600 px on its long side, as JPEG.
  async function shrink(file, max = 1600) {
    let src, w, h, url;
    try { src = await createImageBitmap(file); w = src.width; h = src.height; }
    catch {
      url = URL.createObjectURL(file);
      src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
      w = src.naturalWidth; h = src.naturalHeight;
    }
    const k = Math.min(1, max / Math.max(w, h));
    if (k === 1 && /^image\/(png|jpeg|webp)$/.test(file.type) && file.size < 4e6) { if (url) URL.revokeObjectURL(url); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    if (url) URL.revokeObjectURL(url);
    return new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.88));
  }

  /* ---------------- title, buttons, start ---------------- */
  // The title is a field on the book's first page. Empty, it shows the story's first line in the kid's own words when
  // that line is short (≤ 70 characters), else "Name your book". It never makes a title up (Alan, 2026-11-02).
  titleEl.textContent = story.title || '';
  titleEl.addEventListener('input', () => { story.title = clean(titleEl.textContent).slice(0, 120); o.onTitle(story.title); });
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } });
  titleEl.addEventListener('blur', () => { if (!titleEl.textContent.trim()) titleEl.textContent = ''; });
  press.addEventListener('click', () => { if (W.state === 'recording') stopRec(); else if (W.state === 'idle' || W.state === 'typing') startRec(); });
  typeBtn.addEventListener('click', () => { if (W.state === 'typing') finishTyping(); else startTyping(); });
  document.addEventListener('keydown', onKey);
  function onKey(e) { if (e.key === 'Escape' && !modal.hidden) closeModal(); }

  const wideQ = matchMedia('(min-width: 1000px)');
  const placeFoot = () => { if (wideQ.matches) side.prepend(foot); else q('.ms').append(foot); };
  wideQ.addEventListener('change', placeFoot);
  placeFoot();
  renderTitleHint();
  W.firstRender = true;
  renderVoices();
  renderBook();
  setState('idle');
  requestAnimationFrame(restorePos);
  // Late reflows right after opening (web fonts rewrapping the text) would push the page away: for 4 s, keep it
  // anchored, unless the kid scrolls or starts writing.
  const settleRO = new ResizeObserver(() => { if (!W.dead && W.state === 'idle' && Date.now() - W.userScroll > 3000) restorePos(); });
  settleRO.observe(bk);
  setTimeout(() => settleRO.disconnect(), 4000);
  watchPictures();     // pages still being painted by the server (or waiting their turn) fill in as they finish

  return {
    get state() { return W.state; },
    getText: () => W.text,
    getTitle: () => story.title || '',
    settleAll: () => settle('all'),
    refreshVoices: renderVoices,
    refreshCost: renderCost,
    pages: sorted, after, nextPage, firstPage, forming,
    stopReading: () => stopPlay(),
    stop() { stopPlay(); finishTyping(); if (W.rec || W.state === 'starting') return stopRec(); return W.pending; },
    unmount() {
      savePos();
      stopPlay(); finishTyping(); cancelNote();
      if (W.rec || W.state === 'starting') stopRec();
      W.dead = true;
      clearTimeout(W.idleT); clearTimeout(W.retryT); clearTimeout(posT); clearInterval(W.poll);
      wideQ.removeEventListener('change', placeFoot); closeModal();
      document.removeEventListener('keydown', onKey);
      el.innerHTML = '';
    },
    _debug: W,
  };
}
