// A shared book (/b/<token>), read-only. GET /api/shared/<token> (no sign-in): the pages, their pictures, and the
// read-aloud audio of pages the family already had read (a visitor never makes anything new). Pages turn by button,
// arrow key or swipe; "Read to me" plays the page and turns to the next one that has audio, lighting each word.
import { APP_NAME, REPO_URL, config, esc } from '/kit.js';
import { tokens, wordTimes, findWord } from '/align.js';

const $ = (s) => document.querySelector(s);
const bk = $('#bk'), player = $('#player');
const token = decodeURIComponent(location.pathname.replace(/^\/b\//, '').replace(/\/$/, ''));
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.querySelectorAll('[data-app-name]').forEach((el) => { el.textContent = APP_NAME; });

// Pictures at the size the screen needs (?w= on shared page pictures, like /media/img/…).
const resizable = (u) => /^\/s\/[^/]+\/(img|ref)\//.test(String(u || ''));
function setImg(img, u, sizes) {
  img.removeAttribute('srcset'); img.dataset.fell = '';
  if (!u) { img.removeAttribute('src'); img.parentElement.classList.add('none'); return; }
  img.parentElement.classList.remove('none');
  if (resizable(u)) { img.srcset = [480, 960, 1600].map((w) => `${u}?w=${w} ${w}w`).join(', '); img.sizes = sizes; img.src = `${u}?w=960`; }
  else img.src = u;
  img.onerror = () => { if (!img.dataset.fell) { img.dataset.fell = '1'; img.removeAttribute('srcset'); img.src = u; } };
}

let B = null, at = -1; // -1 cover, 0..n-1 pages, n the end
const P = { on: false, times: [], spans: [], raf: 0 };

async function load() {
  let r;
  try { r = await fetch('/api/shared/' + encodeURIComponent(token), { credentials: 'omit', referrerPolicy: 'no-referrer' }); }
  catch { $('#wait').textContent = "Can't reach the book. Check the connection and try again."; return; }
  if (!r.ok) { $('#wait').hidden = true; $('#gone').hidden = false; bk.dataset.at = 'gone'; return; }
  B = await r.json();
  B.pages = (B.pages || []).filter((p) => p && p.text).sort((a, b) => a.ord - b.ord);
  const title = B.title || B.first_line || 'A book';
  document.title = `${title} · ${B.app_name || APP_NAME}`;
  $('#c-title').textContent = title;
  $('#e-title').textContent = title;
  if (B.author) { $('#c-by').textContent = `by ${B.author}`; $('#c-by').hidden = false; }
  const coverPic = (B.pages.find((p) => p.image_url) || {}).image_url;
  setImg($('#c-img'), coverPic, '(min-width: 900px) 55vw, 100vw');
  $('#cover').classList.toggle('no-pic', !coverPic);
  if (!B.pages.length) { // shared before its pages formed
    $('#open').hidden = true;
    $('#c-by').insertAdjacentHTML('afterend', '<p class="c-wait">This book is still being made. Come back soon.</p>');
  }
  const cfg = await config();
  if (cfg.mode !== 'hosted') $('#made').href = REPO_URL;
  $('#wait').hidden = true;
  const start = Number(location.hash.slice(1));
  go(Number.isInteger(start) && start >= 1 && start <= B.pages.length ? start - 1 : -1, false);
  B.pages.forEach((p) => { if (p.image_url) { const i = new Image(); i.decoding = 'async'; i.sizes = '50vw'; if (resizable(p.image_url)) i.srcset = [480, 960, 1600].map((w) => `${p.image_url}?w=${w} ${w}w`).join(', '); else i.src = p.image_url; } });
}

function chapterAt(p) {
  const ch = (B.chapters || []).find((c) => c.start === p.from && (c.title || c.start > 0));
  if (!ch) return '';
  const n = (B.chapters || []).indexOf(ch) + 1;
  return ch.title || `Chapter ${n}`;
}

function go(i, turn = true) {
  stop();
  const n = B.pages.length;
  at = Math.max(-1, Math.min(n, i));
  bk.dataset.at = at < 0 ? 'cover' : at >= n ? 'end' : 'page';
  $('#cover').hidden = at !== -1;
  $('#end').hidden = at !== n;
  $('#spread').hidden = !(at >= 0 && at < n);
  $('#bar').hidden = false;
  $('#prev').disabled = at < 0;
  $('#next').disabled = at >= n;
  $('#where').textContent = at >= 0 && at < n ? `${at + 1} of ${n}` : '';
  if (at >= 0 && at < n) {
    const p = B.pages[at], ch = chapterAt(p);
    setImg($('#p-img'), p.image_url, '(min-width: 900px) 52vw, 100vw');
    const paras = String(p.text).split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
    let k = 0;
    $('#txt-in').innerHTML = (ch ? `<h2 class="ch">${esc(ch)}</h2>` : '') + paras.map((t) => `<p>${(t.match(/\S+/g) || []).map((w) => `<span class="w" data-i="${k++}">${esc(w)}</span>`).join(' ')}</p>`).join('');
    $('#folio').textContent = String(at + 1);
    $('#txt').scrollTop = 0;
    if (turn && !reduce) { const s = $('#spread'); s.classList.remove('turn'); void s.offsetWidth; s.classList.add('turn'); }
  }
  const audio = at >= 0 && at < n && B.pages[at].audio_url;
  const anyAudio = B.pages.some((p) => p.audio_url);
  $('#play').hidden = !(audio || (at === -1 && anyAudio));
  paintPlay();
  history.replaceState(null, '', at >= 0 && at < n ? `#${at + 1}` : location.pathname);
}

/* ---- read to me: page audio, words lit, next page with audio turns by itself ---- */
function paintPlay() {
  $('#play .ico use').setAttribute('href', P.on ? '#i-pause' : '#i-play');
  $('#play-l').textContent = P.on ? 'Pause' : 'Read to me';
  bk.classList.toggle('reading', P.on);
}
function stop() {
  P.on = false; cancelAnimationFrame(P.raf); player.pause();
  document.querySelectorAll('.w.lit').forEach((w) => w.classList.remove('lit'));
  paintPlay();
}
async function playPage() {
  if (at === -1) { const first = B.pages.findIndex((p) => p.audio_url); if (first < 0) return; go(first); }
  const p = B.pages[at];
  if (!p || !p.audio_url) { stop(); return; }
  P.spans = [...document.querySelectorAll('#txt-in .w')];
  P.times = wordTimes(p.alignment, tokens(p.text));
  if (player.dataset.src !== p.audio_url) { player.src = p.audio_url; player.dataset.src = p.audio_url; }
  P.on = true; paintPlay();
  try { await player.play(); } catch { stop(); return; }
  let lit = -1;
  const loop = () => {
    if (!P.on) return;
    const i = findWord(P.times, player.currentTime);
    if (i !== lit) {
      for (let j = 0; j < P.spans.length; j++) P.spans[j].classList.toggle('lit', j <= i);
      lit = i;
      const el = P.spans[i], box = $('#txt');
      if (el && (el.offsetTop - box.scrollTop > box.clientHeight - 60 || el.offsetTop < box.scrollTop)) box.scrollTop = el.offsetTop - 40;
    }
    P.raf = requestAnimationFrame(loop);
  };
  loop();
}
player.addEventListener('ended', () => {
  if (!P.on) return;
  const next = at + 1;
  if (next < B.pages.length && B.pages[next].audio_url) { go(next); setTimeout(playPage, reduce ? 0 : 450); }
  else { stop(); if (next >= B.pages.length) go(next); }
});
$('#play').onclick = () => { if (P.on) stop(); else playPage(); };

/* ---- turning ---- */
$('#open').onclick = () => go(0);
$('#prev').onclick = () => go(at - 1);
$('#next').onclick = () => go(at + 1);
$('#again').onclick = () => go(-1);
addEventListener('keydown', (e) => {
  if (!B || e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') go(at + 1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(at - 1);
});
let sx = null, sy = 0;
bk.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
bk.addEventListener('touchend', (e) => {
  if (sx === null) return;
  const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
  sx = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(at + (dx < 0 ? 1 : -1));
}, { passive: true });

load();
