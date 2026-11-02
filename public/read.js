// read.js: Read mode, the finished book. Alan, 2026-11-02: "Use B with A and C as options I can select later in
// settings." Write mode stays the dense manuscript (write.js); the desk's Write / Read ribbons switch between them.
//
// ONE read-along engine for every style: reader.js reads a page at a time (POST /api/tts {story_id, sid}: cached per
// page, the next page fetched while this one plays, never the whole story). This module shows the page being read,
// lights the word being said, turns the page itself when the voice reaches the end, and reads from any word tapped.
// The kid's own recorded reading ("Read it to me", README) plays the same way, turning at each page's first word.
//
// Three skins share the pages, the controls and the characters; they differ in layout and in how a page turns:
//   b  Full-screen pages (default): one page per screen, the picture big beside (wide) or above (tall) the words;
//      the next page glides up.
//   a  Book spread: the picture fills the left page, the words the right one; a leaf turns. One page on narrow screens.
//   c  Story theater: while it reads, the picture fills the screen and the words come a sentence or two at a time;
//      paused, it is a page again (the picture beside the whole text, every word tappable).
// Long pages (Alan's 1280×529: option B's prototype scrolled 16 of a 22-page book's pages): option A's rule for every skin.
// One type size for the whole book, chosen so 3 pages in 4 fit whole; the longer pages step down (never below 75% of
// it or a reading minimum); a page that still doesn't fit scrolls with the voice. B also trades up to 18% of the
// picture's width (off the sides) or part of its height for type before a page may scroll.
// Pages still being painted show the pencil placeholder; write.js polls the server (every 5 s while any page is
// waiting) and calls refresh(), so pictures land on the page in front of the kid.
//
//   const r = mountRead(el, story, { api, reader, player, prime, writer, voices, voice, setVoice, toast, kid, skin,
//                                    chrome(on), onWrite(), onOwn(fields) })
//   r.enter(), r.leave(), r.refresh(), r.setSkin('a'|'b'|'c'), r.stop(), r.unmount(), r.state (for e2e/ui.mjs)
import { tokens, wordTimes, findWord } from './align.js';
import { imgAttrs } from './pic.js';
import { firstLine, costLine } from './write.js';
import { Recorder, micTrouble } from './recorder.js';

export const SKINS = { b: 'Full-screen pages', a: 'Book spread', c: 'Story theater' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (a, x, b) => Math.max(a, Math.min(b, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parasOf = (t) => String(t || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
const SENT_END = /[.!?…]["'”’)\]]*$/;
const ABBR = /^(mr|mrs|ms|dr|st|mt|jr|sr|vs|etc)\.$/i;

export function mountRead(el, story, opts = {}) {
  const o = { skin: 'b', chrome: () => {}, toast: () => {}, onWrite: () => {}, onOwn: () => {}, prime: () => {}, ...opts };
  const w = o.writer, reader = o.reader, player = o.player;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  el.innerHTML = `
    <div class="rd" data-skin="${esc(SKINS[o.skin] ? o.skin : 'b')}" data-play="idle" data-view="page" data-chrome="on">
      <div class="rd-stage"></div>
      <div class="rd-subs"><div class="rd-lines"><p class="rd-line"></p><p class="rd-line"></p><p class="rd-line rd-mline" aria-hidden="true"></p></div></div>
      <div class="rd-top rd-chrome">
        <div class="rd-cast" role="group" aria-label="Characters"></div>
        <button class="rd-voice" type="button" aria-haspopup="true" aria-expanded="false"><svg><use href="#i-ears"/></svg><span></span></button>
      </div>
      <div class="rd-ctl rd-chrome">
        <button class="rd-btn rd-prev" type="button" aria-label="Previous page"><svg><use href="#i-back"/></svg></button>
        <button class="rd-btn rd-play" type="button" aria-label="Read to me"><svg class="ico"><use href="#i-play"/></svg><i class="rd-spin" aria-hidden="true"></i></button>
        <button class="rd-btn rd-next" type="button" aria-label="Next page"><svg><use href="#i-next"/></svg></button>
        <span class="rd-where" aria-live="polite"></span>
      </div>
      <p class="rd-note" role="status" hidden></p>
      <div class="rd-pop" role="dialog" aria-label="Character" hidden></div>
      <div class="rd-menu" role="menu" aria-label="Who reads it" hidden></div>
      <div class="rd-light" role="dialog" aria-label="The whole picture" hidden><img alt=""></div>
      <div class="rd-measure" aria-hidden="true"><div class="rd-flow"></div></div>
    </div>`;
  const root = el.querySelector('.rd'), q = (s) => root.querySelector(s);
  const stage = q('.rd-stage'), subs = q('.rd-subs'), lineEls = [...root.querySelectorAll('.rd-line:not(.rd-mline)')], mline = q('.rd-mline');
  const castEl = q('.rd-cast'), voiceBtn = q('.rd-voice'), playBtn = q('.rd-play'), prevBtn = q('.rd-prev'), nextBtn = q('.rd-next'), where = q('.rd-where');
  const noteEl = q('.rd-note'), pop = q('.rd-pop'), menu = q('.rd-menu'), light = q('.rd-light'), measure = q('.rd-measure'), mflow = measure.firstChild;

  const R = {
    skin: root.dataset.skin, on: false, opened: false, screens: [], n: 0, k: 0, want: null, els: new Map(),
    L: null, fit: null, ar: 1.5, textKey: '', fontKey: '', memo: new Map(),
    mode: 'idle', h: null, tok: 0, turning: false, seek: null, own: null, rec: null,
    lit: -1, litKey: null, chunks: [], chunk: -1, chunksFor: null, line: 0, burns: null, chromeT: 0, faces: new Map(),
    anim: false, over: false,
  };
  const posKey = `stories.read.${story.id}`;

  /* ---------------- the book: a cover, the pages, the end ---------------- */
  const title = () => story.title || firstLine(story.text) || 'My story';
  const waiting = (p) => !p.image_url && (p.status === 'pending' || p.status === 'generating');
  function models() {
    const ps = w.pages(), chs = (story.book && story.book.chapters) || [];
    const named = chs.length > 1 || chs.some((c) => c.title);
    let prev = null;
    return ps.map((p, i) => {
      const ci = chs.findIndex((c) => c.start <= p.from && c.start > (prev ? prev.to : -1));
      prev = p;
      return { p, i, sid: p.sid, text: p.text, ch: ci >= 0 && named ? { n: ci + 1, title: chs[ci].title || '' } : null };
    });
  }
  function rebuild() {
    const keep = R.screens[R.k] && R.screens[R.k].key;
    const ms = models();
    R.screens = [{ kind: 'cover', key: 'cover' }, ...ms.map((m) => ({ kind: 'page', key: m.sid, m })), { kind: 'end', key: 'end' }];
    R.n = ms.length;
    R.textKey = ms.map((m) => `${m.sid}:${m.text.length}:${m.ch ? m.ch.n : ''}`).join(',');
    const k = R.screens.findIndex((s) => s.key === keep);
    R.k = k >= 0 ? k : clamp(0, R.k, R.screens.length - 1);
  }
  const indexOf = (key) => R.screens.findIndex((s) => s.key === key);
  const shown = () => R.screens[R.k];

  function spansHTML(text) {
    let k = 0;
    return parasOf(text).map((pa) => `<p>${tokens(pa).map((t) => `<span class="w" data-i="${k++}">${esc(t)}</span>`).join(' ')}</p>`).join('');
  }
  const chHTML = (ch) => (ch ? `<h2 class="rd-ch">${ch.title ? `<small>Chapter ${ch.n}</small>${esc(ch.title)}` : `Chapter ${ch.n}`}</h2>` : '');
  const flowHTML = (m) => chHTML(m.ch) + spansHTML(m.text);

  function picHTML(p, alt) {
    if (p && p.image_url && !(waiting(p))) return `<img ${imgAttrs(p.image_url, (R.L && R.L.sizes) || '100vw')} alt="${esc(alt)}" decoding="async">`;
    if (p && p.status === 'error') return '<div class="sketch err"><span>This picture didn’t work. Try again in Write.</span></div>';
    return `<div class="sketch painting"><span>${p && p.image_url ? 'Painting a new version…' : 'Painting the picture. It can take a few minutes.'}</span></div>`;
  }
  const picSig = (p) => `${p && p.image_url}|${p && waiting(p)}|${p && p.status === 'error'}`;
  function setFigure(c, p, alt) {
    const sig = picSig(p);
    if (c.pic === sig) return;
    const fresh = c.pic !== null && p && p.image_url;
    c.pic = sig;
    const fig = c.el.querySelector('.rd-pic');
    fig.innerHTML = picHTML(p, alt);
    const img = fig.querySelector('img');
    if (img) {
      const ready = () => {
        img.classList.add('ready');
        if (fresh) img.classList.add('develop');
        const ar = img.naturalWidth / img.naturalHeight;
        if (ar && Math.abs(ar - R.ar) > 0.03 && c.kind === 'page') { R.ar = ar; relayoutSoon(); }
      };
      if (img.complete && img.naturalWidth) ready(); else img.addEventListener('load', ready, { once: true });
    }
  }

  function buildPage(s) {
    const m = s.m;
    const a = document.createElement('section');
    a.className = 'rd-scr rd-pg';
    a.dataset.key = s.key;
    a.setAttribute('aria-label', `Page ${m.i + 1}`);
    a.innerHTML = `<figure class="rd-pic"></figure><div class="rd-txt"><div class="rd-flow">${flowHTML(m)}</div></div><span class="rd-folio"></span>`;
    return a;
  }
  function buildCover() {
    const a = document.createElement('section');
    a.className = 'rd-scr rd-cover';
    a.dataset.key = 'cover';
    a.setAttribute('aria-label', 'Cover');
    a.innerHTML = `<figure class="rd-pic"></figure><div class="rd-txt"><div class="rd-in">
      <h1 class="rd-title">${esc(title())}</h1><p class="rd-by">by ${esc(story.author || '')}</p><p class="rd-meta"></p>
      <div class="rd-go"><button class="btn primary rd-start" type="button"><svg><use href="#i-play"/></svg><span>Read to me</span></button>
      <button class="rd-hint" type="button">or turn the page <svg><use href="#i-next"/></svg></button></div></div></div>`;
    return a;
  }
  function buildEnd() {
    const a = document.createElement('section');
    a.className = 'rd-scr rd-end';
    a.dataset.key = 'end';
    a.setAttribute('aria-label', 'The end');
    a.innerHTML = `<figure class="rd-pic rd-lineup"></figure><div class="rd-txt"><div class="rd-in">
      <h2 class="rd-title"></h2><p class="rd-by"></p>
      <div class="rd-go"><button class="btn primary rd-again" type="button"><svg><use href="#i-redo"/></svg><span>Read it again</span></button>
      <button class="btn rd-to-write" type="button"><svg><use href="#i-pencil"/></svg><span>Back to writing</span></button></div>
      <p class="rd-cost" hidden></p></div></div>`;
    return a;
  }
  // The element for screen s, built once and kept (pictures update in place when they land).
  function screenEl(s) {
    let c = R.els.get(s.key);
    const sig = s.kind === 'page' ? `${s.m.text}|${s.m.ch ? `${s.m.ch.n}${s.m.ch.title}` : ''}` : s.kind;
    if (!c || c.sig !== sig) {
      const el2 = s.kind === 'page' ? buildPage(s) : s.kind === 'cover' ? buildCover() : buildEnd();
      c = { el: el2, sig, pic: null, kind: s.kind, spans: null };
      R.els.set(s.key, c);
      if (s.kind === 'page') applyFit(s.key, c);
    }
    if (s.kind === 'page') {
      setFigure(c, s.m.p, `Picture for page ${s.m.i + 1}`);
      c.el.querySelector('.rd-folio').innerHTML = `<b>${s.m.i + 1}</b> of ${R.n}${w.forming() ? '…' : ''}`;
      c.el.setAttribute('aria-label', `Page ${s.m.i + 1} of ${R.n}`);
    } else if (s.kind === 'cover') {
      const f = R.screens[1] && R.screens[1].m;
      setFigure(c, f ? f.p : null, 'Cover picture');
      c.el.querySelector('.rd-title').textContent = title();
      c.el.querySelector('.rd-meta').textContent = R.n ? `${R.n} page${R.n === 1 ? '' : 's'}` : w.forming() ? 'Your book is being made…' : '';
    } else fillEnd(c);
    return c.el;
  }
  function fillEnd(c) {
    const forming = w.forming();
    c.el.querySelector('.rd-title').textContent = forming ? 'More pages are coming…' : 'The end';
    c.el.querySelector('.rd-by').textContent = forming ? 'The rest of your story is being made into pages.' : `A story by ${story.author || ''}`;
    const usd = (story.cost && story.cost.elevenlabs_usd) || 0, cost = c.el.querySelector('.rd-cost');
    cost.hidden = !(usd > 0);
    if (usd > 0) cost.textContent = costLine(usd);
    const faces = (story.cast || []).filter((x) => x.url).slice(0, 8);
    const key = faces.map((x) => x.url).join('|');
    if (c.pic !== key) {
      c.pic = key;
      const fig = c.el.querySelector('.rd-pic');
      fig.style.setProperty('--n', Math.max(1, faces.length));
      fig.innerHTML = faces.map((x) => `<figure><img ${imgAttrs(x.url, `${Math.ceil(100 / Math.max(1, faces.length))}vw`, { src: 480 })} alt=""><figcaption>${esc(x.name)}</figcaption></figure>`).join('');
    }
  }

  /* ---------------- fitting the words to the page (option A's rule) ---------------- */
  function fitPages(box) {
    const key = `${R.skin}|${Math.round(box.cw)}x${Math.round(box.ch)}|${box.maxFs}|${box.minFs}|${box.cols || 1}|${R.fontKey}|${R.textKey}`;
    const hit = R.memo.get(key);
    if (hit) return hit;
    measure.style.width = Math.round(box.cw) + 'px';
    mflow.style.columnCount = box.cols > 1 ? String(box.cols) : '';
    const fits = new Map();
    for (const s of R.screens) {
      if (s.kind !== 'page') continue;
      mflow.innerHTML = flowHTML(s.m);
      const ok = (fs) => { mflow.style.fontSize = fs + 'px'; return mflow.offsetHeight <= box.ch + 1; };
      let f = box.maxFs;
      if (!ok(f)) {
        let lo = 8, hi = box.maxFs;
        for (let i = 0; i < 8; i++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
        f = Math.floor(lo * 2) / 2;
      }
      fits.set(s.key, f);
    }
    mflow.innerHTML = '';
    const list = [...fits.values()].sort((a, b) => a - b);
    const book = list.length ? clamp(box.minFs, list[Math.floor(list.length * 0.25)], box.maxFs) : box.maxFs;
    const floor = Math.max(box.minFs, book * 0.75);
    const fs = new Map(), scroll = new Set();
    for (const [k, f] of fits) { fs.set(k, f >= book ? book : Math.max(f, floor)); if (f < floor) scroll.add(k); }
    const out = { book, floor, fs, scroll, fits };
    if (R.memo.size > 40) R.memo.clear();
    R.memo.set(key, out);
    return out;
  }
  function applyFit(key, c) {
    if (!R.fit || c.kind !== 'page') return;
    const fs = R.fit.fs.get(key) || R.fit.book;
    c.el.querySelector('.rd-flow').style.fontSize = fs + 'px';
    c.el.querySelector('.rd-txt').classList.toggle('scrolls', R.fit.scroll.has(key));
  }

  /* ---------------- layouts, one per skin ---------------- */
  const SK = {};
  // B: side by side when the screen is wide, else the picture across the top. The picture gives up a little width
  // (or height) before any page has to scroll.
  SK.b = {
    layout(W, H, ar) {
      const phone = W < 600, short = H < 640;
      const minFs = phone ? 15.5 : 17, target = short ? 20 : phone ? 18.5 : 23;
      const minText = clamp(340, W * 0.3, 560);
      let best = null;
      if (W / H >= 1.3 && W - H * ar * 0.82 >= minText) {
        for (const f of [1, 0.94, 0.88, 0.82]) {
          const pw = Math.round(Math.min(H * ar * f, W - minText)), tw = W - pw;
          const padX = Math.round(clamp(22, tw * 0.07, 56)), padT = short ? 26 : 40, padB = short ? 40 : 52;
          const cw = Math.min(tw - padX * 2, 720), maxFs = clamp(19, cw / 21, 34);
          const box = { mode: 'side', pw, ph: H, cw, ch: H - padT - padB, padX, padT, padB, maxFs, minFs, target: Math.min(maxFs, target), sizes: `${pw}px` };
          box.fit = fitPages(box);
          best = box;
          if (box.fit.book >= target || pw === W - minText) break;
        }
        return best;
      }
      const cols = W >= 1000 && W / H > 1.2 ? 2 : 1; // a wide band (iPad landscape): the words in two columns
      const full = W / ar;
      for (const f of [1, 0.9, 0.8, 0.7, 0.62]) {
        const ph = Math.round(Math.min(full, H * 0.7) * f);
        const padX = Math.round(clamp(20, W * 0.055, 56)), padT = phone ? 18 : 26, padB = phone ? 44 : 50;
        const cw = Math.min(W - padX * 2, cols > 1 ? 1180 : 760), col = cols > 1 ? (cw - 44) / 2 : cw;
        const maxFs = clamp(18, col / 21, 32);
        const box = { mode: 'band', cols, pw: W, ph, cw, ch: H - ph - padT - padB, padX, padT, padB, maxFs, minFs, target: Math.min(maxFs, cols > 1 ? 21 : target), sizes: '100vw' };
        if (box.ch < 160) break;
        box.fit = fitPages(box);
        best = box;
        if (box.fit.book >= box.target) break;
      }
      return best;
    },
    turn(a, b, dir, { far }) {
      stage.append(b);
      if (reduce.matches) return Promise.resolve();
      if (far) return Promise.all([fade(b, 0, 1, 320), fade(a, 1, 0, 320)]);
      const d = 900, easing = 'cubic-bezier(.65,0,.35,1)';
      return Promise.all([
        a.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-dir * 100}%)` }], { duration: d, easing }).finished,
        b.animate([{ transform: `translateY(${dir * 100}%)` }, { transform: 'translateY(0)' }], { duration: d, easing }).finished,
      ]).catch(() => {});
    },
  };
  // A: an open book. Picture page | words page, a fold between, thin margins; one page (picture above) when narrow.
  SK.a = {
    layout(W, H, ar) {
      const bar = 56, m = H < 640 ? 10 : 16;
      const aw = W - 2 * m, ah = H - bar - 2 * m;
      if (aw >= 860 && aw / ah >= 1.15) {
        let pw = aw / 2;
        const ph = ah;
        if (pw / ph > 1.62) pw = ph * 1.62;
        const padX = Math.round(clamp(22, pw * 0.07, 60)), padT = Math.round(clamp(16, ph * 0.055, 48)), padB = Math.round(padT * 0.9) + 14;
        const box = { mode: 'spread', bw: Math.floor(pw * 2), bh: Math.floor(ph), pw: Math.floor(pw), ph: Math.floor(ph), cw: pw - 2 * padX, ch: ph - padT - padB, padX, padT, padB, maxFs: clamp(19, pw / 22, 32), minFs: 17, sizes: `${Math.floor(pw)}px` };
        box.fit = fitPages(box);
        return box;
      }
      const bw = aw, bh = ah, picH = Math.round(Math.min(bw / ar, bh * 0.52));
      const padX = Math.round(clamp(18, bw * 0.06, 56)), padT = Math.round(clamp(14, (bh - picH) * 0.06, 34)), padB = padT + 20;
      const box = { mode: 'single', bw, bh, pw: bw, ph: picH, cw: bw - 2 * padX, ch: bh - picH - padT - padB, padX, padT, padB, maxFs: clamp(18.5, bw / 22, 32), minFs: bw < 500 ? 15.5 : 17, sizes: '100vw' };
      box.fit = fitPages(box);
      return box;
    },
    turn(a, b, dir) {
      if (reduce.matches) { stage.append(b); return Promise.all([fade(b, 0, 1, 240), fade(a, 1, 0, 240)]); }
      const d = 1000, easing = 'cubic-bezier(.42,.06,.24,1)';
      if (R.L.mode !== 'spread') { // one page: forward, the old page lifts away like a leaf; back, the earlier one comes down
        const leaf = [{ transform: 'perspective(2200px) rotateY(0)', opacity: 1 }, { transform: 'perspective(2200px) rotateY(-70deg)', opacity: 1, offset: 0.7 }, { transform: 'perspective(2200px) rotateY(-100deg)', opacity: 0 }];
        if (dir > 0) { stage.prepend(b); a.style.transformOrigin = '0 50%'; return a.animate(leaf, { duration: d * 0.85, easing }).finished.catch(() => {}); }
        stage.append(b); b.style.transformOrigin = '0 50%';
        return b.animate(leaf, { duration: d * 0.85, easing, direction: 'reverse' }).finished.catch(() => {});
      }
      // The spread: a leaf with this page's words on its front and the next picture on its back turns over the spine.
      // Under it, the left half still shows the old picture until the leaf lands.
      stage.prepend(b);
      const leaf = document.createElement('div');
      leaf.className = `rd-leaf ${dir > 0 ? 'fwd' : 'back'}`;
      const front = document.createElement('div'), back = document.createElement('div');
      front.className = 'rd-face front'; back.className = 'rd-face back';
      front.append(a.cloneNode(true)); back.append(b.cloneNode(true));
      front.insertAdjacentHTML('beforeend', '<i class="rd-shade"></i>'); back.insertAdjacentHTML('beforeend', '<i class="rd-shade"></i>');
      leaf.append(front, back);
      a.classList.add(dir > 0 ? 'keep-left' : 'keep-right');
      stage.append(leaf);
      const to = dir > 0 ? -180 : 180;
      const anim = leaf.animate([{ transform: 'rotateY(0deg)' }, { transform: `rotateY(${to}deg)` }], { duration: d, easing });
      front.lastChild.animate([{ opacity: 0 }, { opacity: 0.9, offset: 0.5 }, { opacity: 0.9 }], { duration: d, easing });
      back.lastChild.animate([{ opacity: 0.9 }, { opacity: 0.9, offset: 0.5 }, { opacity: 0 }], { duration: d, easing });
      return anim.finished.catch(() => {}).then(() => { leaf.remove(); a.classList.remove('keep-left', 'keep-right'); });
    },
  };
  // C: listening fills the screen with the picture; the page view puts the whole text on a sheet beside it.
  SK.c = {
    layout(W, H, ar) {
      const land = W / H > 1;
      const sub = Math.round(clamp(21, Math.min(H * 0.056, W * 0.031), 40));
      if (land) {
        const sheetW = Math.round(clamp(360, W * 0.44, 620));
        const padX = Math.round(clamp(20, sheetW * 0.06, 34)), padT = H < 640 ? 64 : 76, padB = H < 640 ? 74 : 86;
        const box = { mode: 'side', sheetW, pw: W - sheetW, ph: H, cw: sheetW - 2 * padX, ch: H - padT - padB, padX, padT, padB, maxFs: H > 700 ? 25 : 22, minFs: 16, sub, sizes: '100vw' };
        box.fit = fitPages(box);
        return box;
      }
      const ph = Math.round(Math.min(W / ar, H * 0.42));
      const padX = Math.round(clamp(18, W * 0.05, 40)), padT = 60, padB = 78;
      const box = { mode: 'band', sheetW: W, pw: W, ph, cw: W - 2 * padX, ch: H - ph - padT - padB, padX, padT, padB, maxFs: W > 600 ? 26 : 20, minFs: 15.5, sub, sizes: '100vw' };
      box.fit = fitPages(box);
      return box;
    },
    turn(a, b, dir, { auto }) {
      stage.append(b);
      if (reduce.matches) return fade(b, 0, 1, 200);
      return fade(b, 0, 1, auto ? 1200 : 450).then(() => {});
    },
  };
  const fade = (x, a, b, ms) => x.animate([{ opacity: a }, { opacity: b }], { duration: ms, easing: 'ease' }).finished.catch(() => {});

  function relayout() {
    const W = root.clientWidth, H = root.clientHeight;
    if (!W || !H || !R.on) return;
    R.L = SK[R.skin].layout(W, H, R.ar);
    R.fit = R.L.fit;
    const L = R.L;
    root.dataset.mode = L.mode;
    const set = (k, v) => root.style.setProperty(k, v);
    set('--pw', L.pw + 'px'); set('--ph', L.ph + 'px'); set('--padx', L.padX + 'px'); set('--padt', L.padT + 'px'); set('--padb', L.padB + 'px');
    set('--cw', Math.round(L.cw) + 'px'); set('--cols', String(L.cols || 1));
    if (L.bw) { set('--bw', L.bw + 'px'); set('--bh', L.bh + 'px'); }
    if (L.sheetW) set('--sheet-w', L.sheetW + 'px');
    if (L.sub) set('--sub', L.sub + 'px');
    root.dataset.crop = L.mode === 'side' && R.skin === 'b' ? (L.pw < H * R.ar - 4 ? 'x' : 'none') : L.mode === 'band' && R.skin === 'b' ? (L.ph < W / R.ar - 4 ? 'y' : 'none') : 'none';
    for (const [key, c] of R.els) {
      applyFit(key, c);
      c.el.querySelectorAll('img[srcset]').forEach((img) => { if (!img.closest('.rd-lineup')) img.sizes = L.sizes; });
    }
    R.chunksFor = null;
    if (R.mode !== 'idle' && R.litKey) { const i = R.lit; R.lit = -1; paint(R.litKey, i); }
  }
  let rzT = 0;
  function relayoutSoon() { clearTimeout(rzT); rzT = setTimeout(relayout, 120); }

  /* ---------------- showing and turning ---------------- */
  let chain = Promise.resolve();
  function turnTo(k, opts = {}) {
    k = clamp(0, k, R.screens.length - 1);
    R.want = k;
    chain = chain.then(() => (R.want === k ? doTurn(k, opts) : null)).catch((e) => console.error(e));
    return chain;
  }
  async function doTurn(k, { auto = false } = {}) {
    const from = R.k, a = stage.querySelector('.rd-scr.on');
    const s = R.screens[k];
    const b = screenEl(s);
    R.k = k;
    R.want = null;
    chromeFor();
    if (!a || a === b || !a.isConnected) {
      if (a && a !== b) a.remove();
      if (!b.isConnected) stage.append(b);
      b.classList.add('on');
    } else {
      closePop();
      if (s.kind === 'page' && !R.fit.scroll.has(s.key)) b.querySelector('.rd-txt').scrollTop = 0;
      b.classList.add('on', 'in');
      a.classList.add('out');
      R.anim = true;
      try { await SK[R.skin].turn(a, b, k > from ? 1 : -1, { auto, far: Math.abs(k - from) > 2 }); }
      finally { R.anim = false; }
      a.classList.remove('on', 'out');
      a.style.transformOrigin = ''; b.style.transformOrigin = '';
      a.remove();
      b.classList.remove('in');
    }
    for (const j of [k + 1, k - 1, k + 2]) if (R.screens[j]) screenEl(R.screens[j]); // the pictures nearby start loading
    try { localStorage.setItem(posKey, s.key); } catch { /* private mode */ }
    if (R.mode !== 'idle' && R.litKey === s.key && R.lit >= 0) { const i = R.lit; R.lit = -1; paint(s.key, i); }
  }
  function showNow(k) { // no animation (opening Read mode, a new skin)
    stage.querySelectorAll('.rd-scr').forEach((x) => x.remove());
    R.k = clamp(0, k, R.screens.length - 1);
    const b = screenEl(shown());
    b.classList.add('on');
    stage.append(b);
    chromeFor();
  }
  function nav(target) {
    target = clamp(0, target, R.screens.length - 1);
    if (target === R.k && R.want === null) return;
    const busy = R.mode === 'playing' || R.mode === 'loading';
    if (busy) stopReading();
    turnTo(target).then(() => { if (busy && R.screens[target].kind === 'page') startReading(R.screens[target].m.p); });
  }
  const step = (d) => nav((R.want ?? R.k) + d);

  // Controls, the page indicator and who is in the picture change as the turn starts, not when it lands.
  function chromeFor() {
    const s = shown(), last = R.screens.length - 1;
    prevBtn.disabled = R.k === 0;
    nextBtn.disabled = R.k >= last;
    where.textContent = s.kind === 'cover' ? 'Cover' : s.kind === 'end' ? (w.forming() ? 'More coming…' : 'The end') : `${s.m.i + 1} / ${R.n}`;
    root.dataset.screen = s.kind;
    const here = new Set(s.kind === 'page' ? s.m.p.present || [] : []);
    castEl.querySelectorAll('.av').forEach((b) => b.classList.toggle('away', s.kind === 'page' && !here.has(b.dataset.name)));
    poke();
  }

  /* ---------------- reading aloud ---------------- */
  const own = () => o.voice() === 'own';
  function setMode(m) {
    R.mode = m;
    root.dataset.play = m;
    root.dataset.view = R.skin === 'c' && (m === 'playing' || m === 'loading') && shown().kind === 'page' ? 'theater' : 'page';
    const icon = m === 'playing' ? 'i-pause' : m === 'rec' ? 'i-stop' : own() && !story.own_audio_url ? 'i-mic' : 'i-play';
    playBtn.querySelector('.ico use').setAttribute('href', '#' + icon);
    const label = m === 'playing' ? 'Pause' : m === 'paused' ? 'Keep reading' : m === 'loading' ? 'Getting ready… (tap to cancel)' : m === 'rec' ? 'Stop: I finished reading'
      : m === 'saving' ? 'Listening to your reading…' : own() && !story.own_audio_url ? 'Read it aloud yourself' : 'Read to me';
    playBtn.setAttribute('aria-label', label);
    const start = root.querySelector('.rd-start span');
    if (start) start.textContent = own() ? (story.own_audio_url ? `Play ${story.own_by || story.author}’s reading` : 'Read it aloud yourself') : 'Read to me';
    if (m === 'rec') note('Reading out loud. Turn the pages as you go, then tap the red button when you finish.');
    else if (m === 'saving') note('Listening to your reading…');
    else if (m !== 'loading') note(R.noteWait ? R.noteWait : null);
    poke(m !== 'playing');
  }
  let readyT = 0;
  function note(t) {
    noteEl.hidden = !t;
    if (t) noteEl.textContent = t;
  }
  function timesOf(p) {
    if (own()) return Promise.resolve(null);
    return reader.prefetch(p, o.voice()).json.then((d) => wordTimes(d.alignment, tokens(p.text)));
  }

  function play() {
    o.prime();
    if (R.mode === 'rec') return stopRec();
    if (R.mode === 'saving') return;
    if (R.mode === 'playing') return pause();
    if (R.mode === 'paused') return resume();
    if (R.mode === 'loading') { stopReading(); return; } // a second tap while it gets ready: never mind
    if (own() && !story.own_audio_url) { startRec(); return; }
    const s = shown();
    if (s.kind === 'page') { startReading(s.m.p); return; }
    readFromStart();
  }
  async function readFromStart() {
    stopReading();
    const tok = R.tok;
    let first = R.screens[1] && R.screens[1].m.p;
    if (!first) {
      if (!w.forming()) { o.toast('Write your story first, then it can be read.'); return; }
      R.noteWait = 'Your book is still being made…'; setMode('loading');
      first = await w.firstPage();
      R.noteWait = null;
      if (tok !== R.tok) return;
      setMode('idle');
      rebuild();
      if (!first) { o.toast('Tell a few sentences first, then your book can be read.'); return; }
    }
    await turnTo(indexOf(first.sid));
    if (tok === R.tok) startReading(first);
  }
  function startReading(p, fromWord = null) {
    stopReading();
    const tok = R.tok;
    if (own()) { playOwn(p, fromWord, tok); return; }
    R.seek = fromWord != null ? { sid: p.sid, i: fromWord } : null;
    setMode('loading');
    clearTimeout(readyT);
    readyT = setTimeout(() => { if (tok === R.tok && R.mode === 'loading') note(`${voiceName()} is getting ready…`); }, 900);
    const h = R.h = reader.play({
      voice: o.voice(), first: p,
      words: (x) => tokens(x.text),
      peek: (x) => (R.turning ? null : w.after(x)),
      next: (x) => nextAfter(x, tok),
      onPage: (x, st) => {
        if (tok !== R.tok) return;
        if (st === 'load') setMode('loading');
        if (st === 'start') {
          R.turning = false;
          clearTimeout(readyT);
          note(null);
          setMode('playing');
          const k = indexOf(x.sid);
          if (k >= 0 && k !== R.k && R.want !== k) turnTo(k);
          clearLit();
          R.litKey = x.sid;
          const sk = R.seek; R.seek = null;
          if (sk && sk.sid === x.sid) seekWord(x, sk.i, true);
          else { const c = R.els.get(x.sid); if (c) c.el.querySelector('.rd-txt').scrollTop = 0; }
          if (R.skin === 'c') theaterStart(x, sk ? sk.i : 0);
        }
        if (st === 'end') R.turning = true;
      },
      onWord: (x, i) => { if (tok === R.tok) paint(x.sid, i); },
      onError: (e, x) => {
        if (tok !== R.tok) return;
        clearTimeout(readyT);
        stopReading();
        if (e.status === 401) return;
        if (e.name === 'NotAllowedError') o.toast('Tap play to listen.');
        else o.toast(e.status === 0 ? e.message : 'The storyteller couldn’t read this page just now.', { retry: () => startReading(x) });
      },
    });
    h.done.then(() => {
      if (tok !== R.tok) return;
      R.h = null;
      clearTimeout(readyT);
      setMode('idle');
      clearLit();
    });
  }
  // The voice reached the end of a page: a breath, the page turns, the next one reads. A page that isn't laid out yet
  // (the book is still forming) is waited for.
  async function nextAfter(x, tok) {
    await sleep(reduce.matches ? 150 : 380);
    if (tok !== R.tok) return null;
    let n = w.after(x);
    if (!n && w.forming()) {
      R.noteWait = 'Your book is still being made…'; note(R.noteWait);
      n = await w.nextPage(x);
      R.noteWait = null; note(null);
      if (tok !== R.tok) return null;
      rebuild();
    }
    if (!n) { await turnTo(R.screens.length - 1, { auto: true }); return null; }
    await turnTo(indexOf(n.sid), { auto: true });
    return tok === R.tok ? n : null;
  }
  async function seekWord(p, i, starting = false) {
    const times = await timesOf(p).catch(() => null);
    if (!times || !times[i]) return;
    const t = Math.max(0, times[i].t0); // at the word itself: a lead-in would light the word before it first
    const go = () => { try { player.currentTime = t; } catch { /* not seekable yet */ } };
    if (!starting || player.readyState >= 1) go(); else player.addEventListener('loadedmetadata', go, { once: true });
    paint(p.sid, i);
    if (R.burns) R.burns.currentTime = t * 1000;
  }
  function pause() {
    if (R.own) { R.own.paused = true; player.pause(); }
    else if (R.h) R.h.pause();
    if (R.burns) R.burns.pause();
    setMode('paused');
  }
  function resume() {
    if (R.own) { R.own.paused = false; const pr = player.play(); if (pr) pr.catch(() => {}); }
    else if (R.h) R.h.resume();
    if (R.burns) R.burns.play();
    setMode('playing');
  }
  function stopReading() {
    R.tok++;
    clearTimeout(readyT);
    if (R.h) { const h = R.h; R.h = null; h.stop(); }
    if (R.own) stopOwn();
    R.turning = false; R.seek = null; R.noteWait = null;
    stopBurns();
    clearLit();
    note(null);
    if (R.mode !== 'rec' && R.mode !== 'saving') setMode('idle');
  }

  // Tap a word: read from there.
  function tapWord(key, i) {
    const s = R.screens[indexOf(key)];
    if (!s || s.kind !== 'page') return;
    o.prime();
    if (R.mode === 'rec' || R.mode === 'saving') return;
    if (R.own && R.own.key === key) { ownSeek(s.m.p, i); if (R.own.paused) resume(); return; }
    if (R.h && R.h.page && R.h.page.sid === key && (R.mode === 'playing' || R.mode === 'paused')) {
      seekWord(s.m.p, i);
      if (R.mode === 'paused') resume();
      if (R.skin === 'c') { root.dataset.view = 'theater'; R.chunk = -1; }
      return;
    }
    if (own() && !story.own_audio_url) { o.toast('Tap the microphone button to read it aloud yourself.'); return; }
    startReading(s.m.p, i);
  }

  /* ---------------- the word being read ---------------- */
  function spansOf(key) {
    const c = R.els.get(key);
    if (!c || c.kind !== 'page') return [];
    if (!c.spans || !c.spans[0] || !c.spans[0].isConnected) c.spans = [...c.el.querySelectorAll('.rd-flow .w')];
    return c.spans;
  }
  function clearLit() {
    if (R.litKey) spansOf(R.litKey).forEach((x) => x.classList.remove('now', 'said'));
    R.lit = -1; R.litKey = null;
    lineEls.forEach((l) => l.querySelectorAll('.w').forEach((x) => x.classList.remove('now', 'said')));
  }
  function paint(key, i) {
    const sp = spansOf(key);
    if (!sp.length) return;
    if (R.litKey !== key) { if (R.litKey) spansOf(R.litKey).forEach((x) => x.classList.remove('now', 'said')); R.lit = -1; R.litKey = key; }
    if (i < R.lit) for (let j = Math.max(0, i); j <= R.lit && j < sp.length; j++) sp[j].classList.remove('said', 'now');
    else for (let j = Math.max(0, R.lit); j < i && j < sp.length; j++) { sp[j].classList.remove('now'); sp[j].classList.add('said'); }
    if (sp[R.lit]) sp[R.lit].classList.remove('now');
    R.lit = i;
    const cur = sp[i];
    if (cur) { cur.classList.remove('said'); cur.classList.add('now'); follow(key, cur); }
    if (R.skin === 'c') bandWord(key, i);
  }
  // Keep the line being read in view on a page that scrolls: past the middle, bring it up to a third of the way down.
  function follow(key, wEl) {
    const c = R.els.get(key), box = c && c.el.querySelector('.rd-txt');
    if (!box || box.scrollHeight <= box.clientHeight + 2) return;
    if (Date.now() - (c.handT || 0) < 4000) return; // they're looking around: don't pull them back yet
    const b = box.getBoundingClientRect(), r = wEl.getBoundingClientRect();
    const rel = (r.top - b.top) / b.height;
    if (rel >= 0.12 && rel <= 0.62) return;
    box.scrollTo({ top: Math.max(0, box.scrollTop + r.top - b.top - b.height * 0.3), behavior: reduce.matches ? 'auto' : 'smooth' });
  }

  /* ---------------- C: the words a sentence or two at a time, the camera paced by the voice ---------------- */
  function buildChunks(key) {
    const s = R.screens[indexOf(key)];
    if (!s || s.kind !== 'page') return;
    const words = tokens(s.m.text), N = words.length, end = [];
    let k = 0;
    for (const pa of parasOf(s.m.text)) { const t = tokens(pa); t.forEach((x, j) => { end[k++] = j === t.length - 1 || (SENT_END.test(x) && !ABBR.test(x)); }); }
    const lh = parseFloat(getComputedStyle(mline).lineHeight) || 40;
    const limit = lh * 2.4;
    const fits = (a, b) => { mline.textContent = words.slice(a, b + 1).join(' '); return mline.offsetHeight <= limit; };
    const out = [];
    const greedy = (a, b) => { let st = a; while (st <= b) { let e = st; while (e + 1 <= b && fits(st, e + 1)) e++; out.push([st, e]); st = e + 1; } };
    const sents = [];
    let st = 0;
    for (let i = 0; i < N; i++) if (end[i]) { sents.push([st, i]); st = i + 1; }
    if (st < N) sents.push([st, N - 1]);
    for (let j = 0; j < sents.length; j++) {
      let [a, b] = sents[j];
      if (!fits(a, b)) { greedy(a, b); continue; }
      const nx = sents[j + 1];
      if (nx && fits(a, nx[1])) { b = nx[1]; j++; }
      out.push([a, b]);
    }
    mline.textContent = '';
    R.chunks = out; R.chunksFor = key; R.chunk = -1; R.chunkWords = words;
  }
  function bandWord(key, i) {
    if (R.chunksFor !== key) buildChunks(key);
    if (!R.chunks.length) return;
    let c = R.chunks.findIndex((x) => i <= x[1]);
    if (c < 0) c = R.chunks.length - 1;
    if (c !== R.chunk) {
      R.chunk = c;
      const [a, b] = R.chunks[c];
      const old = lineEls[R.line], nx = lineEls[1 - R.line];
      R.line = 1 - R.line;
      nx.style.transition = 'none';
      nx.className = 'rd-line';
      nx.innerHTML = R.chunkWords.slice(a, b + 1).map((t, j) => `<span class="w" data-i="${a + j}">${esc(t)}</span>`).join(' ');
      nx.dataset.key = key;
      void nx.offsetWidth;
      nx.style.transition = '';
      old.classList.remove('on'); old.classList.add('gone');
      nx.classList.add('on');
    }
    lineEls[R.line].querySelectorAll('.w').forEach((x) => { const k = +x.dataset.i; x.classList.toggle('now', k === i); x.classList.toggle('said', k < i); });
  }
  function theaterStart(p, i) {
    buildChunks(p.sid);
    R.chunk = -1;
    bandWord(p.sid, Math.max(0, i));
    stopBurns();
    if (reduce.matches) return;
    const c = R.els.get(p.sid), img = c && c.el.querySelector('.rd-pic img');
    if (!img) return;
    timesOf(p).then((times) => {
      if (!times || !times.length || R.litKey !== p.sid || R.mode === 'idle') return;
      const dur = Math.max(4, times[times.length - 1].t1) * 1000;
      const z = (R.screens[indexOf(p.sid)].m.i % 2) ? ['scale(1.06)', 'scale(1)'] : ['scale(1)', 'scale(1.06)'];
      R.burns = img.animate([{ objectPosition: '47% 6%', transform: z[0] }, { objectPosition: '53% 68%', transform: z[1] }], { duration: dur, fill: 'both', easing: 'ease-in-out' });
      R.burns.currentTime = Math.max(0, player.currentTime * 1000);
      if (R.mode === 'paused') R.burns.pause();
    }).catch(() => {});
  }
  function stopBurns() { if (R.burns) { R.burns.cancel(); R.burns = null; } }

  /* ---------------- "Read it to me": the kid's own reading ---------------- */
  function ownMap() {
    const toks = tokens(story.text), times = wordTimes(story.own_alignment, toks), paras = String(story.text || '').split(/\n{2,}/);
    const pages = R.screens.filter((s) => s.kind === 'page').map((s) => ({ key: s.key, p: s.m.p, off: tokens(paras.slice(0, s.m.p.from).join(' ')).length, n: tokens(s.m.text).length }));
    return { times, pages };
  }
  function playOwn(p, fromWord, tok) {
    const M = ownMap();
    const pg = M.pages.find((x) => x.key === p.sid) || M.pages[0];
    if (!pg || !M.times.length) { o.toast('That reading wouldn’t play.'); return; }
    const O = R.own = { tok, ...M, key: pg.key, paused: false, raf: 0 };
    const g = pg.off + (fromWord || 0);
    const t0 = g > 0 && M.times[g] ? Math.max(0, M.times[g].t0) : 0;
    player.src = story.own_audio_url;
    const go = () => { try { player.currentTime = t0; } catch { /* later */ } };
    if (player.readyState >= 1) go(); else player.addEventListener('loadedmetadata', go, { once: true });
    O.onEnd = () => { if (R.own !== O) return; stopOwn(); setMode('idle'); turnTo(R.screens.length - 1, { auto: true }); };
    player.addEventListener('ended', O.onEnd);
    const pr = player.play();
    if (pr) pr.catch((e) => { if (R.own !== O) return; stopReading(); if (e && e.name === 'NotAllowedError') o.toast('Tap play to listen.'); else if (!(e && e.name === 'AbortError')) o.toast('That reading wouldn’t play.'); });
    setMode('playing');
    R.litKey = pg.key;
    let last = -1;
    const loop = () => {
      if (R.own !== O) return;
      if (!O.paused) {
        const gi = findWord(O.times, player.currentTime);
        if (gi !== last && gi >= 0) {
          last = gi;
          let at = O.pages.findIndex((x) => gi < x.off + x.n);
          if (at < 0) at = O.pages.length - 1;
          const pp = O.pages[at];
          if (pp.key !== O.key) { O.key = pp.key; const k = indexOf(pp.key); if (k >= 0 && k !== R.k) turnTo(k, { auto: true }); }
          paint(pp.key, gi - pp.off);
        }
      }
      O.raf = requestAnimationFrame(loop);
    };
    O.raf = requestAnimationFrame(loop);
  }
  function ownSeek(p, i) {
    const O = R.own, pg = O && O.pages.find((x) => x.key === p.sid);
    if (!pg) return;
    const g = pg.off + i;
    if (O.times[g]) player.currentTime = Math.max(0, O.times[g].t0);
  }
  function stopOwn() {
    const O = R.own;
    R.own = null;
    if (!O) return;
    cancelAnimationFrame(O.raf);
    player.removeEventListener('ended', O.onEnd);
    player.pause();
  }
  async function startRec() {
    if (R.rec) return;
    if (!story.text.trim()) { o.toast('Write your story first, then read it aloud.'); return; }
    stopReading();
    const Rc = R.rec = { starting: true };
    setMode('rec');
    note('Opening the microphone…');
    let r;
    try { r = await Recorder.start({ onLevel: (v) => playBtn.style.setProperty('--lvl', v.toFixed(2)) }); }
    catch (e) { if (R.rec === Rc) { R.rec = null; setMode('idle'); o.toast(micTrouble(e)); } return; }
    if (R.rec !== Rc) { r.cancel(); return; }
    Rc.r = r; Rc.starting = false;
    Rc.cap = setTimeout(() => { if (R.rec === Rc) stopRec(); }, 9 * 60e3);
    setMode('rec');
    if (shown().kind !== 'page' && R.screens[1]) turnTo(1);
  }
  async function stopRec() {
    const Rc = R.rec;
    if (!Rc || Rc.starting || Rc.stopping) return;
    Rc.stopping = true;
    clearTimeout(Rc.cap);
    const secs = Rc.r.seconds, blob = await Rc.r.stop();
    R.rec = null;
    if (secs < 2 || blob.size < 2000) { setMode('idle'); o.toast('That was very short. Tap the button and read the whole story aloud.'); return; }
    uploadOwn(blob);
  }
  function cancelRec() {
    const Rc = R.rec;
    if (!Rc) return;
    R.rec = null;
    clearTimeout(Rc.cap);
    if (Rc.r) Rc.r.cancel();
    if (R.mode === 'rec') setMode('idle');
  }
  async function uploadOwn(blob) {
    setMode('saving');
    let d;
    try { d = await o.api('POST', `/api/stories/${encodeURIComponent(story.id)}/narration?author=${encodeURIComponent(o.kid || story.author)}`, blob); }
    catch (e) { setMode('idle'); if (e.status !== 401) o.toast('Your reading didn’t save.', { retry: () => uploadOwn(blob) }); return; }
    Object.assign(story, { own_audio_url: d.own_audio_url, own_alignment: d.own_alignment, own_by: o.kid || story.author });
    o.onOwn(story);
    setMode('idle');
    renderVoice();
    if (typeof d.matched === 'number' && d.matched < 0.25) o.toast('That reading was hard to follow along with. Want to read it again?');
    if (R.on && own()) { await turnTo(1); startReading(R.screens[1].m.p); }
  }

  /* ---------------- who reads it ---------------- */
  function voiceName() {
    if (own()) return story.own_audio_url ? `Read by ${story.own_by || story.author}` : 'Read it to me';
    return ((o.voices() || []).find((v) => v.id === o.voice()) || {}).name || 'The storyteller';
  }
  function renderVoice() {
    voiceBtn.querySelector('span').textContent = voiceName();
    voiceBtn.setAttribute('aria-label', `Who reads it: ${voiceName()}`);
    setMode(R.mode);
  }
  function openMenu() {
    const by = story.own_by || story.author;
    const items = (o.voices() || []).map((v) => ({ id: v.id, name: v.name, small: v.vibe }));
    items.push(story.own_audio_url ? { id: 'own', name: `Read by ${by}`, small: 'your own reading' } : { id: 'own', name: 'Read it to me', small: 'record yourself reading it' });
    if (story.own_audio_url) items.push({ id: 'own-again', name: 'Record it again', small: 'read it aloud once more' });
    menu.innerHTML = items.map((x) => `<button type="button" role="menuitemradio" aria-checked="${x.id === o.voice()}" data-id="${esc(x.id)}"><b>${esc(x.name)}</b><small>${esc(x.small || '')}</small></button>`).join('');
    menu.hidden = false;
    voiceBtn.setAttribute('aria-expanded', 'true');
    const r = voiceBtn.getBoundingClientRect(), rr = root.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom - rr.top + 6) + 'px';
    menu.style.left = Math.round(clamp(8, r.right - rr.left - menu.offsetWidth, rr.width - menu.offsetWidth - 8)) + 'px';
    poke(true);
    (menu.querySelector('[aria-checked="true"]') || menu.firstChild).focus({ preventScroll: true });
  }
  function closeMenu() { if (menu.hidden) return; menu.hidden = true; voiceBtn.setAttribute('aria-expanded', 'false'); shield(); }
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const id = b.dataset.id;
    closeMenu();
    if (id === 'own-again') { o.setVoice('own'); renderVoice(); startRec(); return; }
    if (id === o.voice()) return;
    const was = (R.mode === 'playing' || R.mode === 'loading') && shown().kind === 'page';
    stopReading();
    cancelRec();
    o.setVoice(id);
    renderVoice();
    if (was && (id !== 'own' || story.own_audio_url)) startReading(shown().m.p);
  });
  voiceBtn.addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) openMenu(); else closeMenu(); });

  /* ---------------- characters: tiny faces, one tap to the portrait ---------------- */
  function renderCast() {
    const chars = (story.bible && story.bible.characters) || [];
    const have = new Map((story.cast || []).map((c) => [c.name, c.url]));
    const names = [...new Set([...have.keys(), ...chars.map((c) => c.name)])];
    const key = names.map((n) => `${n}=${have.get(n) || ''}`).join('|');
    if (castEl.dataset.key === key) { chromeFor(); return; }
    castEl.dataset.key = key;
    castEl.innerHTML = names.map((n) => {
      const u = have.get(n);
      return `<button class="av" type="button" data-name="${esc(n)}" aria-label="${esc(n)}" title="${esc(n)}">${u ? `<img ${imgAttrs(u, '64px', { src: 480, widths: [480] })} alt="" decoding="async">` : '<span class="sketch mini"></span>'}</button>`;
    }).join('');
    castEl.querySelectorAll('.av img').forEach(faceCrop);
    chromeFor();
  }
  // The portraits are whole figures on a plain ground: centre the circle on the head (from option B).
  function faceCrop(img) {
    const done = () => {
      const k = img.currentSrc || img.src, f = R.faces.get(k);
      if (f) { img.style.cssText = f; return; }
      try {
        const W = 60, H = Math.round((W * img.naturalHeight) / img.naturalWidth);
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0, W, H);
        const d = cx.getImageData(0, 0, W, H).data, at = (x, y) => (y * W + x) * 4, bg = [0, 0, 0];
        for (const [x, y] of [[1, 1], [W - 2, 1], [1, H - 2], [W - 2, H - 2]]) for (let j = 0; j < 3; j++) bg[j] += d[at(x, y) + j] / 4;
        const fg = (x, y) => { const i = at(x, y); return Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 60; };
        let top = -1, bottom = -1;
        for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) n += fg(x, y); if (n >= 2) { if (top < 0) top = y; bottom = y; } }
        if (top < 0) throw new Error('no figure');
        const headH = (bottom - top) * 0.17;
        let sx = 0, n = 0;
        for (let y = top; y <= top + headH; y++) for (let x = 0; x < W; x++) if (fg(x, y)) { sx += x; n++; }
        const fx = (n ? sx / n : W / 2) / W, fy = (top + headH * 0.55) / H, size = Math.max(0.12, (headH * 1.5) / W);
        const css = `position:absolute;max-width:none;height:auto;width:${100 / size}%;left:${(0.5 - fx / size) * 100}%;top:${(0.5 - (fy * (H / W)) / size) * 100}%`;
        R.faces.set(k, css);
        img.style.cssText = css;
      } catch { img.style.objectPosition = '50% 8%'; }
    };
    if (img.complete && img.naturalWidth) done(); else img.addEventListener('load', done, { once: true });
  }
  function openPortrait(name, btn) {
    const c = (story.cast || []).find((x) => x.name === name);
    const pages = R.screens.filter((s) => s.kind === 'page' && (s.m.p.present || []).includes(name));
    const runs = [];
    for (const s of pages) { const r = runs[runs.length - 1]; if (r && s.m.i === r[1].m.i + 1) r[1] = s; else runs.push([s, s]); }
    const look = (((story.bible && story.bible.characters) || []).find((x) => x.name === name) || {}).look || '';
    pop.innerHTML = `<button class="x rd-x" type="button" aria-label="Close"><svg><use href="#i-close"/></svg></button>
      ${c ? `<img ${imgAttrs(c.url, '(max-width: 600px) 80vw, 420px', { src: 960 })} alt="${esc(name)}">` : '<div class="sketch"><span>Sketching…</span></div>'}
      <div class="rd-pop-txt"><h2>${esc(name)}</h2>${look ? `<p class="rd-look">${esc(look)}</p>` : ''}
      <p class="rd-on">${!pages.length ? 'Not in a picture yet' : pages.length === R.n ? 'On every page' : `On page${pages.length === 1 ? '' : 's'} ${runs.map(([a, b]) => `<button type="button" data-k="${esc(a.key)}">${a === b ? a.m.i + 1 : `${a.m.i + 1}–${b.m.i + 1}`}</button>`).join(', ')}`}</p></div>`;
    pop.hidden = false;
    pop.dataset.name = name;
    castEl.querySelectorAll('.av').forEach((b) => b.setAttribute('aria-expanded', String(b.dataset.name === name)));
    const r = btn.getBoundingClientRect(), rr = root.getBoundingClientRect();
    pop.style.top = Math.round(r.bottom - rr.top + 8) + 'px';
    pop.style.left = Math.round(clamp(8, r.left - rr.left + r.width / 2 - pop.offsetWidth / 2, rr.width - pop.offsetWidth - 8)) + 'px';
    poke(true);
  }
  function closePop() {
    if (pop.hidden) return;
    pop.hidden = true; pop.innerHTML = ''; delete pop.dataset.name;
    castEl.querySelectorAll('.av').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    shield();
  }
  castEl.addEventListener('click', (e) => {
    const b = e.target.closest('.av');
    if (!b) return;
    e.stopPropagation();
    if (pop.dataset.name === b.dataset.name) closePop(); else { pop.hidden = true; openPortrait(b.dataset.name, b); }
  });
  pop.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('.rd-x')) { closePop(); return; }
    const j = e.target.closest('button[data-k]');
    if (j) { closePop(); nav(indexOf(j.dataset.k)); }
  });

  // After an overlay closes, the next ~0.65 s of clicks land on nothing: a double or rage click on a close button
  // must not fall through to whatever is under it (Alan's PostHog session, 2026-11-02 20:55: the 4th click hit
  // "Type instead" under the picture sheet's ×).
  function shield() {
    const s = document.createElement('div');
    s.className = 'click-shield';
    document.body.append(s);
    setTimeout(() => s.remove(), 650);
  }

  /* ---------------- the whole picture ---------------- */
  function openLight(p) {
    if (!p || !p.image_url) return;
    const img = light.querySelector('img');
    img.outerHTML = `<img ${imgAttrs(p.image_url, '100vw', { src: 1600 })} alt="The whole picture">`;
    light.hidden = false;
    poke(true);
  }
  function closeLight() { if (light.hidden) return; light.hidden = true; shield(); poke(); }
  light.addEventListener('click', (e) => { e.stopPropagation(); closeLight(); });

  /* ---------------- chrome: there when you move, gone while you read (B) ---------------- */
  function poke(stay) {
    clearTimeout(R.chromeT);
    setChrome(true);
    if (!stay && R.skin === 'b' && R.mode === 'playing') R.chromeT = setTimeout(() => {
      if (R.mode === 'playing' && pop.hidden && menu.hidden && light.hidden && !R.over) setChrome(false);
    }, 2600);
  }
  function setChrome(on) {
    const v = on ? 'on' : 'off';
    if (root.dataset.chrome === v) return;
    root.dataset.chrome = v;
    o.chrome(on);
  }

  /* ---------------- input ---------------- */
  playBtn.addEventListener('click', (e) => { e.stopPropagation(); play(); });
  prevBtn.addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
  nextBtn.addEventListener('click', (e) => { e.stopPropagation(); step(1); });
  let down = null, swiped = false;
  root.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; swiped = false; }, { passive: true });
  root.addEventListener('pointerup', (e) => {
    if (!down || e.target.closest('.rd-chrome, .rd-pop, .rd-menu, .rd-light, .btn')) { down = null; return; }
    const dx = e.clientX - down.x, dy = e.clientY - down.y, txt = e.target.closest('.rd-txt');
    down = null;
    const scrollsText = txt && txt.scrollHeight > txt.clientHeight + 2;
    if (e.pointerType === 'mouse') return; // a mouse drag selects words; it never turns the page
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) { swiped = true; step(dx < 0 ? 1 : -1); }
    else if (!scrollsText && R.skin === 'b' && Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx) * 1.3) { swiped = true; step(dy < 0 ? 1 : -1); }
  });
  root.addEventListener('click', (e) => {
    if (swiped) { swiped = false; return; }
    if (!menu.hidden && !e.target.closest('.rd-menu')) { closeMenu(); return; }
    if (!pop.hidden && !e.target.closest('.rd-pop')) { closePop(); return; }
    const wd = e.target.closest('.w');
    if (wd) {
      const host = wd.closest('.rd-scr') || wd.closest('.rd-line');
      const key = host && (host.dataset.key || (R.litKey));
      if (key && key !== 'cover' && key !== 'end') { e.stopPropagation(); tapWord(key, +wd.dataset.i); }
      return;
    }
    if (e.target.closest('.rd-start')) { readFromStart(); return; }
    if (e.target.closest('.rd-hint')) { step(1); return; }
    if (e.target.closest('.rd-again')) { readFromStart(); return; }
    if (e.target.closest('.rd-to-write')) { o.onWrite(); return; }
    const pic = e.target.closest('.rd-scr.rd-pg .rd-pic');
    if (pic) {
      const s = shown();
      if (R.skin === 'c' && root.dataset.view === 'theater') { pause(); return; }
      if (s.kind === 'page' && pic.querySelector('img')) { openLight(s.m.p); return; }
    }
    if (R.skin === 'c' && root.dataset.view === 'theater' && e.target.closest('.rd-stage')) { pause(); return; }
    poke();
  });
  ['wheel', 'touchmove'].forEach((ev) => root.addEventListener(ev, (e) => {
    const txt = e.target.closest && e.target.closest('.rd-txt');
    if (txt) { const c = R.els.get(txt.closest('.rd-scr') && txt.closest('.rd-scr').dataset.key); if (c) c.handT = Date.now(); }
  }, { passive: true }));
  // Mouse wheel and trackpad: one gesture turns exactly one page; a long page's words scroll first.
  let lastWheel = 0, gesture = null, acc = 0;
  root.addEventListener('wheel', (e) => {
    if (e.ctrlKey || !R.on || !light.hidden || e.target.closest('.rd-menu, .rd-pop')) return;
    const now = performance.now();
    if (now - lastWheel > 260) { gesture = null; acc = 0; }
    lastWheel = now;
    const dy = (e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * root.clientHeight : e.deltaY) + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0);
    const txt = e.target.closest('.rd-txt');
    const can = txt && (dy > 0 ? txt.scrollTop + txt.clientHeight < txt.scrollHeight - 1 : txt.scrollTop > 0);
    if (can && (gesture === null || gesture === 'text')) { gesture = 'text'; return; }
    e.preventDefault();
    if (gesture === 'text' || gesture === 'turned') return;
    gesture = 'page';
    acc += dy;
    if (Math.abs(acc) >= 30) { gesture = 'turned'; step(Math.sign(acc)); }
  }, { passive: false });
  function onKey(e) {
    if (!R.on || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (document.querySelector('.modal:not([hidden])')) return;
    const k = e.key;
    poke();
    if (k === 'Escape') { if (!light.hidden) closeLight(); else if (!pop.hidden) closePop(); else if (!menu.hidden) closeMenu(); else if (R.mode === 'playing') pause(); return; }
    if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(k)) { e.preventDefault(); step(1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) { e.preventDefault(); step(-1); }
    else if (k === 'Home') { e.preventDefault(); nav(0); }
    else if (k === 'End') { e.preventDefault(); nav(R.screens.length - 1); }
    else if (k === ' ' && !(e.target.closest && e.target.closest('button, a'))) { e.preventDefault(); play(); }
  }
  addEventListener('pointermove', (e) => { if (R.on && e.pointerType === 'mouse') poke(); }, { passive: true });
  root.querySelectorAll('.rd-chrome').forEach((c) => {
    c.addEventListener('pointerenter', () => { R.over = true; });
    c.addEventListener('pointerleave', () => { R.over = false; poke(); });
  });
  const ro = new ResizeObserver(() => { if (R.on) relayoutSoon(); });
  ro.observe(root);
  const fontsDone = () => { const k = `${document.fonts.size}|${document.fonts.status}`; if (k !== R.fontKey) { R.fontKey = k; R.memo.clear(); relayoutSoon(); } };
  if (document.fonts) document.fonts.addEventListener('loadingdone', fontsDone);

  /* ---------------- the module's face ---------------- */
  let refreshT = 0;
  const api = {
    enter() {
      R.on = true;
      if (w.forming()) w.settleAll(); // the rest of the draft becomes pages while the first ones are read
      rebuild();
      R.fontKey = document.fonts ? `${document.fonts.size}|${document.fonts.status}` : '';
      relayout();
      if (!R.opened) {
        R.opened = true;
        let at = null;
        try { at = localStorage.getItem(posKey); } catch { at = null; }
        R.k = Math.max(0, indexOf(at));
      }
      showNow(R.k);
      renderCast();
      renderVoice();
      document.addEventListener('keydown', onKey);
      if (document.fonts) document.fonts.ready.then(() => { if (R.on) fontsDone(); });
    },
    leave() {
      if (!R.on) return;
      stopReading();
      cancelRec();
      closePop(); closeMenu(); closeLight();
      R.on = false;
      setChrome(true);
      document.removeEventListener('keydown', onKey);
    },
    // write.js: the pages, pictures or characters changed (a poll found a picture; /book laid out more pages).
    refresh() {
      if (!R.on) return;
      clearTimeout(refreshT);
      refreshT = setTimeout(() => {
        if (!R.on) return;
        const before = R.textKey;
        rebuild();
        if (R.textKey !== before) relayout();
        for (const s of R.screens) if (R.els.has(s.key)) screenEl(s);
        const cur = stage.querySelector('.rd-scr.on'), want = screenEl(shown());
        if (cur !== want && R.want === null && !R.anim) { if (cur) cur.remove(); want.classList.add('on'); stage.append(want); }
        renderCast();
        chromeFor();
      }, 120);
    },
    setSkin(s) {
      if (!SKINS[s] || s === R.skin) return;
      const was = R.mode;
      stopReading();
      R.skin = s;
      root.dataset.skin = s;
      R.els.clear(); R.memo.clear();
      if (R.on) { relayout(); showNow(R.k); }
      if (was === 'playing') { const sc = shown(); if (sc.kind === 'page') startReading(sc.m.p); }
    },
    stop: () => stopReading(),
    unmount() {
      api.leave();
      ro.disconnect();
      if (document.fonts) document.fonts.removeEventListener('loadingdone', fontsDone);
      el.innerHTML = '';
    },
    get state() {
      const s = shown();
      return {
        skin: R.skin, view: root.dataset.view, mode: R.mode, k: R.k, key: s && s.key, kind: s && s.kind, n: R.n, lit: R.lit, litKey: R.litKey,
        chrome: root.dataset.chrome, layout: R.L && { mode: R.L.mode, pw: R.L.pw, ph: R.L.ph, cw: Math.round(R.L.cw), ch: Math.round(R.L.ch), cols: R.L.cols || 1, maxFs: R.L.maxFs },
        book: R.fit && R.fit.book,
        pages: R.screens.filter((x) => x.kind === 'page').map((x) => ({ key: x.key, chars: x.m.text.length, fs: R.fit && R.fit.fs.get(x.key), fit: R.fit && R.fit.fits.get(x.key), scrolls: !!(R.fit && R.fit.scroll.has(x.key)) })),
      };
    },
    _R: R,
  };
  return api;
}
