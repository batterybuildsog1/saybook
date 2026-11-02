/*!
 * listen.js: live words from the mic (Web Speech API), plus a demo typist that sounds the same.
 * Both call onText(wholeTranscriptSoFar, isFinal), which is exactly what Imagination.feed() takes.
 *
 *   const mic = Listen.create({ onText: im.feed, onState: (s, why) => ... });
 *   Listen.supported            // false on Firefox and some WebViews; use Listen.demo() there
 *   mic.start(); mic.stop(); mic.reset(); mic.text
 *   const d = Listen.demo(storyText, { onText, onDone, wpm: 140 }); d.stop();
 *
 * States: 'listening' | 'idle' | 'denied' (mic or speech service blocked) | 'error' (kept failing,
 * or never started within 10 s).
 * Web Speech sends audio to the browser maker's servers (Google for Chrome, Apple for Safari); the
 * app's final transcript should still come from POST /api/stt (Whisper), per CONTRACT.md.
 */
(function (root) {
  'use strict';
  const SR = root.SpeechRecognition || root.webkitSpeechRecognition;

  const join = (...parts) => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  // Browsers disagree about result lists: Chrome sends one phrase per result, iOS Safari sometimes
  // sends cumulative results ("once upon", "once upon a time") or repeats a final. Merge defensively.
  function merge(acc, t) {
    if (!acc) return t;
    const a = acc.toLowerCase(), b = t.toLowerCase();
    if (b.startsWith(a)) return t;
    if (a.endsWith(b) && b.split(' ').length >= 3) return acc;
    return acc + ' ' + t;
  }

  function create(opts) {
    const o = Object.assign({ lang: 'en-US', onText: null, onState: null }, opts || {});
    let rec = null, want = false, base = '', fin = '', inter = '', lastErr = '', starts = [];
    const emit = () => o.onText && o.onText(join(base, fin, inter), !inter);
    const state = (s, why) => o.onState && o.onState(s, why);

    function begin() {
      const now = Date.now();
      starts = starts.filter((t) => now - t < 15000);
      starts.push(now);
      if (starts.length > 6) { want = false; state('error', lastErr || 'kept stopping'); return; }
      const me = rec = new SR();
      let started = false;
      // Some engines accept start() and then do nothing at all (Playwright's WebKit; Safari with
      // dictation off). 10 s leaves time for a parent to answer the mic-permission prompt.
      const watch = setTimeout(() => {
        if (started || rec !== me) return;
        want = false; rec = null; me.onend = null;
        try { me.abort(); } catch (e) { /* already dead */ }
        state('error', 'did not start');
      }, 10000);
      rec.lang = o.lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onstart = () => { started = true; clearTimeout(watch); state('listening'); };
      rec.onresult = (e) => {
        let f = '', i = '';
        for (let k = 0; k < e.results.length; k++) {
          const r = e.results[k];
          const t = (r[0] && r[0].transcript || '').trim();
          if (!t) continue;
          if (r.isFinal) f = merge(f, t); else i = merge(i, t);
        }
        if (f && i.toLowerCase().startsWith(f.toLowerCase())) i = i.slice(f.length).trim();
        fin = f; inter = i;
        emit();
      };
      rec.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        lastErr = e.error;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
          want = false;
          state('denied', e.error);
        }
      };
      rec.onend = () => {
        clearTimeout(watch);
        // A session ended (silence, a time limit, or stop()). Keep what was heard, even unfinished words.
        base = join(base, fin, inter);
        fin = ''; inter = '';
        rec = null;
        emit();
        if (want) setTimeout(() => { if (want && !rec) begin(); }, 250);
        else state('idle');
      };
      try { rec.start(); } catch (err) { lastErr = String(err && err.message || err); rec = null; want = false; state('error', lastErr); }
    }

    return {
      get text() { return join(base, fin, inter); },
      start() {
        if (!SR) { state('error', 'unsupported'); return false; }
        if (want) return true;
        want = true; starts = []; lastErr = '';
        begin();
        return true;
      },
      stop() { want = false; if (rec) rec.stop(); else state('idle'); },
      reset() { base = ''; fin = ''; inter = ''; },
    };
  }

  // Plays a story the way a speech recognizer delivers it: words arrive at talking pace, long words show
  // a partial guess first ("drag" then "dragon"), and each sentence ends with a final result.
  function demo(text, opts) {
    const o = Object.assign({ wpm: 140, onText: null, onDone: null, seed: 7 }, opts || {});
    const words = String(text).split(/\s+/).filter(Boolean);
    let s = o.seed >>> 0;
    const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const beat = 60000 / o.wpm;
    let i = 0, timer = 0, stopped = false;
    const said = [];
    const out = (t, f) => o.onText && o.onText(t, f);
    function step() {
      if (stopped) return;
      if (i >= words.length) { out(said.join(' '), true); if (o.onDone) o.onDone(); return; }
      const w = words[i++];
      const bare = w.replace(/[^\p{L}]/gu, '');
      const finish = () => {
        said.push(w);
        const end = /[.!?]$/.test(w);
        out(said.join(' '), end);
        let wait = beat * (0.75 + rand() * 0.5);
        if (end) wait += beat * 1.5; else if (/[,;]$/.test(w)) wait += beat * 0.6;
        timer = setTimeout(step, wait);
      };
      if (bare.length >= 6 && rand() < 0.6) {
        out(said.concat(bare.slice(0, Math.ceil(bare.length * 0.55))).join(' '), false);
        timer = setTimeout(() => { if (!stopped) finish(); }, beat * 0.3);
      } else finish();
    }
    timer = setTimeout(step, 250);
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  root.Listen = { supported: !!SR, create, demo };
})(typeof globalThis !== 'undefined' ? globalThis : window);
