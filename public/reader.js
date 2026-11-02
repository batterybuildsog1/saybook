// reader.js: reads a book aloud PAGE BY PAGE (POST /api/tts {story_id, sid}: one page per request, cached per page on
// the server, so a replay or an unchanged page costs nothing). The UI never sends the whole story to /api/tts
// (Alan's 13,035-character story hit ElevenLabs' 10,000-character limit, 2026-11-02).
// While a page plays, the next page's reading AND its audio bytes are fetched, so pages follow without a gap.
// Used by Write ("Read my book", "Read this chapter", one page) and by Listen (a storyteller reads the book).
// The seam for any book view (the page design is still being chosen, 2026-11-02): this module knows audio and the
// order of pages; the book's pages come from write.js (w.pages/after/nextPage/firstPage), and the view only supplies
// words(page) and paints onPage/onWord. A new reading view needs nothing else.
//
//   const r = createReader({ api, player, storyId, onCost })
//   const h = r.play({ voice, first, next, peek, words, onPage, onWord, onWait, onError })
//     first        the page to start with ({sid, text, ...}), or a Promise of it (the book is still forming)
//     peek(page)   the page after `page` if it is known now (for prefetching), else null
//     next(page)   Promise of the page after `page` (may wait for the book to finish forming), null = the end
//     words(page)  the word strings shown for that page (for the highlight)
//     onPage(page, 'load'|'start'|'end'), onWord(page, i), onError(err, page)
//     onWait(bool) the next page isn't laid out yet (the book is still forming)
//   h.stop(), h.pause(), h.resume(), h.paused, h.page, h.done (Promise: true if it read to the end)
//   r.stop(), r.dispose()
import { wordTimes, findWord } from './align.js';

export function createReader({ api, player, storyId, onCost = () => {} }) {
  const cache = new Map(); // `${sid}|${voice}|${text}` → { json: Promise<tts reply>, bytes?: Promise<blob url>, url? }
  const urls = new Set();
  let cur = null;

  function load(page, voice) {
    const key = `${page.sid}|${voice}|${page.text}`;
    let e = cache.get(key);
    if (!e) {
      e = { json: api('POST', '/api/tts', { story_id: storyId, sid: page.sid, voice_id: voice }).then((d) => { onCost(d); return d; }) };
      e.json.catch(() => { if (cache.get(key) === e) cache.delete(key); });
      cache.set(key, e);
    }
    return e;
  }
  // The audio itself, so the next page starts the instant this one ends.
  function warm(page, voice) {
    const e = load(page, voice);
    if (!e.bytes) {
      e.bytes = e.json
        .then((d) => fetch(d.audio_url, { credentials: 'same-origin' }))
        .then((res) => (res.ok ? res.blob() : null))
        .then((b) => { if (!b) return null; const u = URL.createObjectURL(b); urls.add(u); e.url = u; return u; })
        .catch(() => null);
    }
    return e;
  }

  function stop() { if (cur) cur.stop(); }

  function play({ voice, first, next = async () => null, peek = () => null, words = () => [], onPage = () => {}, onWord = () => {}, onWait = () => {}, onError = () => {} }) {
    stop();
    const H = {
      stopped: false, paused: false, page: null, raf: 0, end: null, loop: null,
      stop() {
        if (H.stopped) return;
        H.stopped = true;
        cancelAnimationFrame(H.raf);
        if (H.page) player.pause();
        if (H.end) H.end(false);
        if (cur === H) cur = null;
      },
      pause() { if (H.stopped || H.paused || !H.page) return; H.paused = true; cancelAnimationFrame(H.raf); player.pause(); },
      resume() {
        if (H.stopped || !H.paused) return;
        H.paused = false;
        const p = player.play();
        if (p) p.catch(() => {});
        if (H.loop) H.loop();
      },
    };
    cur = H;
    H.done = (async () => {
      let page = first;
      if (page && typeof page.then === 'function') { onWait(true); page = await page.catch(() => null); onWait(false); }
      while (page && !H.stopped) {
        const e = load(page, voice);
        let d = null;
        const t = setTimeout(() => onPage(page, 'load'), 120); // a new reading takes a few seconds; replays are instant
        try { d = await e.json; } catch (err) { clearTimeout(t); if (!H.stopped) { onPage(page, 'end'); onError(err, page); H.stop(); } return false; }
        clearTimeout(t);
        if (H.stopped) return false;
        const times = wordTimes(d.alignment, words(page));
        const ended = new Promise((res) => { H.end = res; });
        const onEnded = () => { if (H.end) H.end(true); };
        H.page = page;
        player.src = e.url || d.audio_url;
        player.addEventListener('ended', onEnded);
        onPage(page, 'start');
        try { await player.play(); }
        catch (err) {
          player.removeEventListener('ended', onEnded);
          if (!H.stopped && !(err && err.name === 'AbortError')) { onPage(page, 'end'); onError(err, page); H.stop(); }
          return false;
        }
        // While this page plays: the next page's reading and audio.
        const nx = peek(page);
        if (nx) warm(nx, voice);
        let last = -1;
        H.loop = () => {
          if (H.stopped || H.paused || H.page !== page) return;
          const i = findWord(times, player.currentTime);
          if (i !== last) { last = i; onWord(page, i); }
          H.raf = requestAnimationFrame(H.loop);
        };
        H.loop();
        const ok = await ended;
        player.removeEventListener('ended', onEnded);
        cancelAnimationFrame(H.raf);
        if (ok) onWord(page, times.length - 1);
        onPage(page, 'end');
        if (!ok || H.stopped) return false;
        let n = peek(page);
        if (!n) {
          const slow = setTimeout(() => onWait(true), 150);
          n = await next(page);
          clearTimeout(slow);
          onWait(false);
        }
        page = n;
      }
      if (cur === H) cur = null;
      H.page = null;
      return !H.stopped;
    })();
    return H;
  }

  return {
    play, stop,
    get playing() { return cur; },
    prefetch: (page, voice) => warm(page, voice),
    dispose() { stop(); for (const u of urls) URL.revokeObjectURL(u); urls.clear(); cache.clear(); },
  };
}
