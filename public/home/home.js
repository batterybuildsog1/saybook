// The landing's few moving parts: the name, seller and price from one place; page one set from the visitor's own first
// line in any of the three themes; "Start" becomes "Join the waitlist" when every family place is taken, and "Open"
// for a signed-in parent; each section's parts rise once as it comes into view. No analytics here.
import { brand, config, SELLER, REPO_URL, priceText } from '/kit.js';

const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
document.documentElement.classList.add('js');
brand();
$$('[data-seller]').forEach((el) => { el.textContent = SELLER; });
$$('[data-repo]').forEach((el) => { el.href = REPO_URL; });
$$('[data-start]').forEach((el) => { el.textContent = el.textContent.replace('$19.50', priceText()); });

/* ---- page one, live: the visitor's first line, set like the book sets it ---- */
const THEME_FONTS = {
  'paper-cut-forest': 'family=Atkinson+Hyperlegible:wght@400;700&family=Bagel+Fat+One',
  'night-sky-lanterns': 'family=Lexend:wght@400;500&family=Sniglet:wght@400;800',
  'watercolor-meadow': 'family=Andika:wght@400;700&family=Cherry+Swash:wght@400;700',
};
const loaded = new Set();
function themeFonts(t) {
  if (loaded.has(t)) return;
  loaded.add(t);
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = `https://fonts.googleapis.com/css2?${THEME_FONTS[t]}&display=swap`;
  document.head.appendChild(l);
}
const DEFAULT = $('#plate-text').textContent;
let paintT = 0;
$('#first').addEventListener('input', (e) => {
  const v = e.target.value.replace(/\s+/g, ' ').trim();
  $('#plate-text').textContent = v || DEFAULT;
  $('#plate-title').textContent = v ? (v.split(/[.!?]/)[0].slice(0, 48) || 'My story') : 'The Moon Fell in Our Pond';
  // Their own line has no picture yet: the pencil placeholder holds its place, as in the app.
  const own = !!v;
  $('#sketch').hidden = !own;
  $('#plate-img').style.opacity = own ? '0' : '1';
  clearTimeout(paintT);
});
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  const t = b.dataset.theme;
  themeFonts(t);
  $('#plate').dataset.theme = t;
  $$('.tabs button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
}));
// Arrow keys move between the theme radios.
$('.tabs').addEventListener('keydown', (e) => {
  if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
  const all = $$('.tabs button'), i = all.indexOf(document.activeElement);
  const n = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
  n.focus(); n.click();
});
const io0 = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { themeFonts('paper-cut-forest'); io0.disconnect(); } }, { rootMargin: '400px' });
io0.observe($('#plate'));

/* ---- the parts of each section rise once ---- */
const io = new IntersectionObserver((es) => es.forEach((x) => { if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); } }), { threshold: 0.12 });
$$('.rise').forEach((el) => {
  // stagger siblings that rise together: heading, then text, then the picture
  const sibs = [...el.parentElement.children].filter((c) => c.classList.contains('rise'));
  el.style.setProperty('--d', `${Math.min(sibs.indexOf(el), 6) * 0.07}s`);
  io.observe(el);
});

/* ---- full, or already signed in ---- */
const [cfg, enroll] = await Promise.all([
  config(),
  fetch('/auth/enrollment', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
]);
if (cfg.mode === 'hosted' && cfg.signed_in) {
  $$('[data-signin]').forEach((el) => { el.textContent = 'Open'; el.href = '/'; });
}
if (enroll && enroll.waitlist_only) {
  $$('[data-start]').forEach((el) => { el.textContent = 'Join the waitlist'; el.href = '/signin/?waitlist=1'; });
  $('#full-note').hidden = false;
}
