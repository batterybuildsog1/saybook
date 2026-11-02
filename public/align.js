// align.js: word timing for read-aloud highlighting, shared by Listen (app.js) and the page play buttons (write.js).
// Alignment {chars, starts, ends} is per character (ElevenLabs, or Whisper for the kid's own reading).

export const tokens = (t) => String(t || '').match(/\S+/g) || [];
export const norm = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// → one {t0, t1} per word of `toks`. Words are matched by spelling, so a reading still lines up after small
// edits; words nobody read are spread evenly between their timed neighbours.
export function wordTimes(al, toks) {
  const A = [];
  if (al && Array.isArray(al.chars)) {
    let cur = null;
    for (let k = 0; k < al.chars.length; k++) {
      const c = al.chars[k];
      if (/\s/.test(c)) { if (cur) { A.push(cur); cur = null; } continue; }
      if (!cur) cur = { w: '', t0: al.starts[k], t1: al.ends[k] };
      cur.w += c; cur.t1 = al.ends[k];
    }
    if (cur) A.push(cur);
  }
  const out = toks.map(() => null);
  let j = 0;
  toks.forEach((w, i) => {
    const t = norm(w);
    for (let k = j; k < Math.min(A.length, j + 6); k++) {
      if (norm(A[k].w) === t) { out[i] = { t0: A[k].t0, t1: A[k].t1 }; j = k + 1; break; }
    }
  });
  const end = A.length ? A[A.length - 1].t1 : 0;
  for (let i = 0; i < out.length;) {
    if (out[i]) { i++; continue; }
    let b = i;
    while (b + 1 < out.length && !out[b + 1]) b++;
    const from = i > 0 ? out[i - 1].t1 : 0, to = b + 1 < out.length ? out[b + 1].t0 : Math.max(end, from), n = b - i + 1;
    for (let k = 0; k < n; k++) out[i + k] = { t0: from + ((to - from) * k) / n, t1: from + ((to - from) * (k + 1)) / n };
    i = b + 1;
  }
  for (let k = 1; k < out.length; k++) if (out[k].t0 < out[k - 1].t0) out[k].t0 = out[k - 1].t0;
  return out;
}

export function findWord(times, t) {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid].t0 <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
