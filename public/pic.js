// pic.js: pictures at the size the screen needs. GET /media/<key>?w=480|960|1600 returns a resized WebP for page
// pictures and portraits (img/ and ref/ keys, CONTRACT.md); the originals are ~3.5 MB PNGs. Every page picture and
// portrait uses srcset/sizes, and if a resized copy fails the <img> falls back to the original URL (fallback() is
// installed once, in app.js, as a capturing 'error' listener on the document).
export const WIDTHS = [480, 960, 1600];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const resizable = (u) => /^\/media\/(img|ref)\//.test(String(u || ''));

export const sized = (u, w) => (resizable(u) ? `${u}?w=${w}` : u);
export const srcset = (u, widths = WIDTHS) => (resizable(u) ? widths.map((w) => `${u}?w=${w} ${w}w`).join(', ') : '');

// The attributes of an <img> for `u`, as HTML. sizes: how wide it shows (a CSS sizes value). src: the width used
// before srcset is read (and by anything that ignores it).
export function imgAttrs(u, sizes = '100vw', { widths = WIDTHS, src = 960 } = {}) {
  if (!resizable(u)) return `src="${esc(u)}"`;
  return `src="${esc(sized(u, src))}" srcset="${esc(srcset(u, widths))}" sizes="${esc(sizes)}" data-orig="${esc(u)}"`;
}

// A resized copy didn't load: use the original instead (once).
export function fallback(e) {
  const t = e.target;
  if (!t || t.tagName !== 'IMG' || !t.dataset.orig || t.dataset.fell) return;
  t.dataset.fell = '1';
  t.removeAttribute('srcset');
  t.removeAttribute('sizes');
  t.src = t.dataset.orig;
}
