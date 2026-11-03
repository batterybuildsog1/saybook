// The landing's moving parts (redesign A, "Read it first"). The name, seller, prices and repo come from kit.js. The
// sample book reads itself: "Read the sample" (the first action) and "Read it to me" play the app's own stock-narrator
// reading of the first or last page of "The Moon Fell in Our Pond" and light each word from its timings
// (/home/voice/page-N.json). Questions show one answer large. A signed-in family never meets the pitch: "Sign in"
// becomes Account and the start button opens Saybook (Aside report 2026-11-03 #7). No analytics here.
import { brand, config, SELLER, REPO_URL, PLANS, FREE_BOOKS } from '/kit.js';

const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
brand();
$$('[data-seller]').forEach((el) => { el.textContent = SELLER; });
$$('[data-repo]').forEach((el) => { el.href = REPO_URL; });
$$('[data-free-books]').forEach((el) => { el.textContent = FREE_BOOKS; });
$$('[data-plan-price]').forEach((el) => { el.textContent = PLANS[el.dataset.planPrice].price; });
$$('[data-plan-month]').forEach((el) => { el.textContent = PLANS[el.dataset.planMonth].monthly; });

/* ---- each section's parts rise once as it enters; nothing stays hidden if the observer never fires ---- */
$$('[data-stagger]').forEach((g) => $$('[data-reveal]').filter((el) => g.contains(el)).forEach((el, i) => { if (!el.style.getPropertyValue('--i')) el.style.setProperty('--i', String(Math.min(i, 4))); }));
const reveals = $$('[data-reveal]');
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }), { threshold: 0 });
reveals.forEach((el) => io.observe(el));
addEventListener('load', () => setTimeout(() => reveals.forEach((el) => { const r = el.getBoundingClientRect(); if (r.top < innerHeight && r.bottom > 0) el.classList.add('is-in'); }), 2200));

/* ---- the sample book: three views, two of them read aloud ---- */
const PAGES = {
  0: { img: 'moon-1', alt: 'A boy in star pyjamas at his window, watching frogs around a glowing moon in the pond', pos: '66% 60%', voice: 'page-0', title: true, next: '4', nextL: 'Last page',
    text: 'Last night the moon fell in our pond. I heard it go SPLOOSH. I looked out my window and the whole pond was glowing like a giant night light, and all the frogs were sitting around the edge looking very surprised.' },
  4: { img: 'moon-5', alt: 'The boy at his window at bedtime, smiling up at the moon back in the sky', pos: '62% 40%', voice: 'page-4', title: false, next: 'cast', nextL: 'Characters',
    text: 'Now the moon has a little bit of pond on it. That’s why it shines so much. And sometimes if you listen really really hard, it goes ribbit.' },
  cast: { next: '0', nextL: 'First page',
    text: 'Each character is drawn once and looks the same on every page: the boy, Pickles the dog, the giggling moon and the frogs. A kid’s own drawing can become a character too.' },
};
const TITLE = 'The Moon Fell in Our Pond';
const read = $('#read'), next = $('#next'), audio = $('#voice'), label = $('#read-l');
let at = '0', titleSpans = [], textSpans = [], raf = 0, cur = null;
const timings = {};
const timing = (v) => (timings[v] = timings[v] || fetch(`/home/voice/${v}.json`).then((r) => r.json()).then((d) => d.words).catch(() => []));

// Words as spans, in reading order, matching the narration's word list.
function wordSpans(el, text) {
  el.textContent = '';
  const out = [];
  text.split(/(\s+)/).forEach((part) => {
    if (!part) return;
    if (/^\s+$/.test(part)) { el.append(part); return; }
    const s = document.createElement('span'); s.className = 'w'; s.textContent = part; el.append(s); out.push(s);
  });
  return out;
}
function stop() {
  cancelAnimationFrame(raf); audio.pause();
  if (cur) cur.spans.forEach((s) => s.classList.remove('on'));
  cur = null; read.classList.remove('playing'); label.textContent = 'Read it to me';
}
function tick() {
  if (!cur) return;
  const t = audio.currentTime;
  cur.words.forEach((w, i) => cur.spans[i] && cur.spans[i].classList.toggle('on', t >= w.s && t < w.e + 0.08));
  if (audio.ended) stop(); else raf = requestAnimationFrame(tick);
}
// Called inside the click, so the browser lets the sound start.
function play() {
  const p = PAGES[at];
  if (!p.voice) return;
  stop();
  const spans = p.title ? [...titleSpans, ...textSpans] : textSpans;
  cur = { words: [], spans };
  read.classList.add('playing'); label.textContent = 'Stop reading';
  audio.src = `/home/voice/${p.voice}.mp3`; audio.currentTime = 0;
  const mine = cur;
  timing(p.voice).then((w) => { if (cur === mine) mine.words = w; });
  audio.play().then(() => { raf = requestAnimationFrame(tick); }).catch(stop);
}
function show(k) {
  stop();
  at = k;
  const p = PAGES[k];
  $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.page === k)));
  $('#cast').hidden = k !== 'cast';
  if (p.img) {
    const img = $('#plate-img');
    img.srcset = `/home/img/${p.img}-960.webp 960w, /home/img/${p.img}-1600.webp 1600w`; img.src = `/home/img/${p.img}-1600.webp`;
    img.alt = p.alt; img.style.objectPosition = p.pos;
  }
  titleSpans = wordSpans($('#title-words'), TITLE);
  textSpans = wordSpans($('#page-text'), p.text);
  $('#page-note').textContent = k === 'cast' ? 'Drawn once, before the first page.' : 'A five-page sample book, kept exactly as it was said.';
  read.hidden = !p.voice;
  next.textContent = p.nextL;
}
read.addEventListener('click', () => { if (cur) stop(); else play(); });
next.addEventListener('click', () => show(PAGES[at].next));
$$('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.page)));
$('.tabs').addEventListener('keydown', (e) => {
  if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
  const all = $$('.tabs [role=tab]'), i = all.indexOf(document.activeElement);
  const n = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
  n.focus(); n.click();
});
show('0');
timing('page-0');
// The first action: bring the sample up and read its first page aloud.
$('#read-sample').addEventListener('click', (e) => {
  e.preventDefault();
  if (at !== '0') show('0');
  $('#sample').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  play();
});

/* ---- questions: the answer follows hover, click and focus; large in the pane (inline on a phone) ---- */
const qs = $$('.q'), pane = $('#pane');
const pick = (b) => {
  qs.forEach((x) => x.setAttribute('aria-expanded', String(x === b)));
  pane.style.opacity = '0';
  setTimeout(() => { pane.textContent = b.nextElementSibling.textContent.trim(); pane.style.opacity = '1'; }, 150);
};
qs.forEach((b) => { b.addEventListener('click', () => pick(b)); b.addEventListener('focus', () => pick(b)); b.addEventListener('mouseenter', () => { if (matchMedia('(hover: hover)').matches) pick(b); }); });
pane.textContent = qs[0].nextElementSibling.textContent.trim();

/* ---- already signed in: no pitch ---- */
const cfg = await config();
if (cfg.mode === 'hosted' && cfg.signed_in) {
  $$('[data-signin]').forEach((el) => { el.textContent = 'Account'; el.href = '/account/'; });
  $$('[data-start]').forEach((el) => { el.textContent = 'Open Saybook'; el.href = '/'; });
}
