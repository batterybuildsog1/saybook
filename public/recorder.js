// recorder.js: record the microphone for the server (Whisper STT, "Read it to me").
// Shared by write.js (dictation) and app.js (the kid's own reading).
//
//   const r = await Recorder.start({ onLevel });   // onLevel(0..1) ~60×/s for a level ring; optional
//   r.seconds                                       // how long it has been recording
//   const blob = await r.stop();                    // the audio (webm/opus on Chrome, mp4/aac on Safari/iPad)
//   r.cancel();                                     // throw it away
//
// start() must be called from a tap (iPad asks for the mic then). It throws the getUserMedia error;
// micTrouble(err) turns it into a sentence a kid (or the grown-up nearby) can act on.

const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus'];

export const Recorder = {
  mime() {
    if (!window.MediaRecorder) return null;
    for (const t of TYPES) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* old Safari */ } }
    return '';
  },

  async start({ onLevel } = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      throw Object.assign(new Error('recording unsupported'), { name: 'NotSupportedError' });
    }
    // The level meter's AudioContext is made before the first await: iPad Safari only starts one inside the tap.
    let ac = null, raf = 0;
    if (onLevel) {
      try { ac = new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume().catch(() => {}); }
      catch { ac = null; }
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { if (ac) ac.close().catch(() => {}); throw e; }
    const mime = Recorder.mime();
    let mr;
    try { mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined); }
    catch { mr = new MediaRecorder(stream); }
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.start(1000);
    const t0 = Date.now();

    // Level meter: lets a kid see the page is hearing them, even where live words aren't available.
    if (ac) {
      try {
        const an = ac.createAnalyser();
        an.fftSize = 512;
        ac.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let s = 0;
          for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; s += x * x; }
          onLevel(Math.min(1, Math.sqrt(s / buf.length) * 4));
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch { /* the meter is a nicety */ }
    }
    const type = () => (mr.mimeType || mime || 'audio/webm');
    const end = () => {
      cancelAnimationFrame(raf);
      if (ac) ac.close().catch(() => {});
      stream.getTracks().forEach((t) => t.stop());
      if (onLevel) onLevel(0);
    };
    return {
      get seconds() { return (Date.now() - t0) / 1000; },
      stop() {
        return new Promise((resolve) => {
          const done = () => { end(); resolve(new Blob(chunks, { type: type() })); };
          if (mr.state === 'inactive') { done(); return; }
          mr.onstop = done;
          mr.stop();
        });
      },
      cancel() {
        try { mr.onstop = null; if (mr.state !== 'inactive') mr.stop(); } catch { /* already stopped */ }
        end();
      },
    };
  },
};

export function micTrouble(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'The microphone is turned off for this page. A grown-up can allow it in the browser settings.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No microphone found on this device. You can type instead.';
  if (n === 'NotSupportedError') return "This browser can't record. You can type instead.";
  return "The microphone didn't start. Try again?";
}
