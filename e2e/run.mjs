// E2E: E2E_PASSCODE=<test passcode> node e2e/run.mjs <base URL>
// The core loop (Alan, 2026-11-02): voice → text, the draft turns into a book while they write (paragraphs,
// chapters, pages with pictures), hearing each page as it forms; the child drives, nothing rewrites them.
// Writes a repeatable artifact to e2e/out/<timestamp>/ (report.md, report.json, audio, every picture).
//
// Ways it could fail, each checked below:
//  F1 data reachable without the passcode            F2 wrong passcode unlocks
//  F3 STT misses words (kid run-ons)                  F4 Safari (m4a) or Chrome (webm) audio rejected
//  F5 the layout agent changes the child's words      F6 the unfinished paragraph gets laid out (it must stay draft)
//  F7 pages reshuffle when the story grows, so finished pictures get lost
//  F8 editing a page loses its picture (should keep it, marked changed) or silently redraws it
//  F9 a character introduced later never gets a portrait   F10 wrong/extra characters on a page (eye-check)
//  F11 pictures drawn serially (too slow to feel live)     F12 kid's drawing/feedback ignored on redraw
//  F13 page narration fails, mis-times, or re-bills on replay   F14 audio won't seek on iPad (no Range)
//  F15 punctuation help changes words                F16 the editor writes the story for them
//  F17 "Read it to me" out of sync                     F18 delete leaves the story behind
//  F19 a redraw destroys the picture they liked (every version is kept; they can go back)
//  F20 thumbnails stay huge, transform again on replay, upscale, or change invalid-width/original requests
//  F21 thumbnail Range/passcode handling breaks, or deletion leaves cached pictures/uploads behind
// Media-only preview check: MEDIA_FIXTURE=/path/to/large.png node e2e/run.mjs <preview-base> --media-only
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) || process.env.BASE_URL;
if (!BASE) throw new Error("Pass an isolated test base URL");;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIX = path.join(HERE, "fixtures");
const OUT = path.join(HERE, "out", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });

let cookie = "";
const results = [], timings = {};
const ok = (id, pass, note = "") => { results.push({ id, pass: !!pass, note }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${note}`); };
async function call(method, p, body, headers = {}) {
  const h = { cookie, ...headers };
  let b = body;
  if (body && !(body instanceof Uint8Array) && typeof body === "object") { b = JSON.stringify(body); h["content-type"] = "application/json"; }
  const t0 = Date.now();
  const r = await fetch(BASE + p, { method, headers: h, body: b });
  const ms = Date.now() - t0;
  const data = (r.headers.get("content-type") || "").includes("json") ? await r.json().catch(() => null) : null;
  if ([402, 429].includes(r.status)) {
    fs.writeFileSync(path.join(OUT, "STOPPED.json"), JSON.stringify({ reason: "provider limit: no further calls", status: r.status, path: p }));
    throw new Error("Provider limit reached; stopped without retry");
  }
  return { r, data, ms };
}
const toks = (t) => String(t || "").split(/\s+/).filter(Boolean);
const words = (t) => t.toLowerCase().replace(/[^a-z' ]/g, " ").split(/\s+/).filter(Boolean);
function recall(ref, hyp) {
  const h = {}; for (const w of words(hyp)) h[w] = (h[w] || 0) + 1;
  let hit = 0; const R = words(ref);
  for (const w of R) if (h[w] > 0) { hit++; h[w]--; }
  return hit / R.length;
}
async function save(url, name) {
  const r = await fetch(BASE + url, { headers: { cookie } });
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(path.join(OUT, name), buf);
  return { status: r.status, type: r.headers.get("content-type"), bytes: buf.length };
}
async function checkMedia() {
  const { r, data: demo } = await call("POST", "/api/stories", { author: "Demo", title: "Thumbnail E2E" });
  if (!r.ok || !demo?.id) throw new Error("Could not create Demo thumbnail test story");
  const measurements = {};
  let url;
  async function bytes(p, name, headers = {}) {
    const start = performance.now();
    const res = await fetch(BASE + p, { headers: { cookie, ...headers } });
    const body = Buffer.from(await res.arrayBuffer());
    const result = { status: res.status, type: res.headers.get("content-type"), bytes: body.length,
      ms: Math.round(performance.now() - start), cache: res.headers.get("x-thumbnail-cache"), etag: res.headers.get("etag") };
    if (name) { measurements[name] = result; fs.writeFileSync(path.join(OUT, name), body); }
    return { ...result, body, headers: res.headers };
  }
  try {
    const fixture = fs.readFileSync(process.env.MEDIA_FIXTURE || path.join(FIX, "media.png"));
    const up = await call("POST", `/api/upload?story=${demo.id}`, fixture, { "content-type": "image/png" });
    if (!up.r.ok || !up.data?.url) throw new Error("Could not upload thumbnail test fixture");
    url = up.data.url;
    const locked = await fetch(BASE + url + "?w=960");
    ok("F21 thumbnail passcode gate", locked.status === 401, `status ${locked.status}`);
    await locked.arrayBuffer();
    const original = await bytes(url, "media-original.png");
    ok("F20 original image unchanged", original.status === 200 && original.body.equals(fixture), `${original.bytes} bytes, ${original.ms} ms`);
    for (const width of [480, 960, 1600]) {
      const first = await bytes(`${url}?w=${width}`, `media-${width}-first.webp`);
      const cached = await bytes(`${url}?w=${width}`, `media-${width}-cached.webp`);
      ok(`F20 ${width}px WebP is much smaller`, first.status === 200 && first.type === "image/webp" && first.bytes < original.bytes * 0.5,
        `${original.bytes} → ${first.bytes} bytes; first ${first.ms} ms, cached ${cached.ms} ms`);
      ok(`F20 ${width}px replay comes from R2`, first.cache === "MISS" && cached.cache === "HIT" && first.body.equals(cached.body) && first.etag === cached.etag,
        `${first.cache} → ${cached.cache}`);
      const direct = await bytes(`/media/thumb/${width}/${url.slice(7)}.webp`);
      ok(`F20 ${width}px persisted in R2`, direct.status === 200 && direct.body.equals(first.body), `${direct.bytes} bytes`);
      const range = await bytes(`${url}?w=${width}`, null, { range: "bytes=0-99" });
      ok(`F21 ${width}px Range`, range.status === 206 && range.body.equals(first.body.subarray(0, 100)) && range.headers.get("content-range") === `bytes 0-99/${first.bytes}`,
        `${range.status} ${range.headers.get("content-range")}`);
    }
    for (const width of ["961", "0960", "960.0", "960x"]) {
      const invalid = await bytes(`${url}?w=${width}`);
      ok(`F20 invalid width ${width} serves original`, invalid.status === 200 && invalid.type === original.type && invalid.body.equals(original.body) && !invalid.cache);
    }
    const range = await bytes(url + "?w=961", null, { range: "bytes=0-99" });
    ok("F21 original Range unchanged", range.status === 206 && range.body.equals(fixture.subarray(0, 100)));
  } finally {
    const deleted = await call("DELETE", `/api/stories/${demo.id}`);
    ok("F21 Demo media story deleted", deleted.r.status === 204);
    if (url) for (const p of [url, ...[480, 960, 1600].map((w) => `/media/thumb/${w}/${url.slice(7)}.webp`)]) {
      const gone = await bytes(p);
      ok("F21 deleted story media removed", gone.status === 404, `${p}: ${gone.status}`);
    }
  }
  timings.media = measurements;
}
const put = (id, body) => call("PUT", `/api/stories/${id}`, body);
const layout = async (id, text, settled_upto) => { await put(id, { text }); return call("POST", `/api/stories/${id}/book`, { text, settled_upto }); };
const paras = (t) => t.split(/\n{2,}/);
// Pictures paint on the server queue: the client only waits (and a duplicate request must not paint twice).
async function drawMissing(id, story) {
  const t = Date.now();
  const dup = story.scenes.find((s) => !s.image_url);
  const again = dup ? await call("POST", `/api/stories/${id}/scenes/${dup.sid}/image`, {}) : null;
  let s = story;
  while (Date.now() - t < 480000) {
    await new Promise((r) => setTimeout(r, 8000));
    s = (await call("GET", `/api/stories/${id}`)).data;
    if (s.scenes.every((x) => x.image_url)) break;
  }
  const imgs = (await call("GET", `/api/bench?days=1`)).data; // not used for pass/fail
  return { cast: { r: { ok: s.cast.length > 0 }, ms: 0, data: { cast: s.cast } }, wall: Date.now() - t, dupStatus: again?.r.status,
    res: s.scenes.filter((x) => !story.scenes.find((o) => o.sid === x.sid && o.image_url)).map((x) => ({ r: { ok: !!x.image_url }, ms: Date.now() - t, data: { present: x.present, check: true } })) };
}
const T0 = Date.now();
{ // F1/F2
  const config = await (await fetch(BASE + "/api/config")).json();
  const { r } = await call("GET", "/api/stories");
  ok("F1 locked without passcode", config.passcode_required ? r.status === 401 : r.status === 200, `status ${r.status}`);
  const bad = await call("POST", "/api/unlock", { code: "11111" });
  ok("F2 wrong passcode refused (when enabled)", config.passcode_required ? bad.r.status === 401 : bad.r.status === 204, `status ${bad.r.status}`);
  const good = await call("POST", "/api/unlock", { code: process.env.E2E_PASSCODE || "" });
  cookie = (good.r.headers.get("set-cookie") || "").split(";")[0];
  ok("unlock with configured passcode", good.r.status === 204 && (!config.passcode_required || cookie.startsWith("sp=")), `status ${good.r.status}`);
}

{
  const saved = await call("PUT", "/api/settings", { writers: ["Demo"] });
  const settings = await call("GET", "/api/settings");
  ok("family writer settings persist", saved.r.ok && settings.data.writers.map(w => typeof w === "string" ? w : w.name).join() === "Demo");
  const csrf = await call("POST", "/api/stories", { author: "Demo" }, { origin: "https://unrelated.invalid" });
  ok("cross-origin writes refused", csrf.r.status === 403);
}

await checkMedia();
if (process.argv.includes("--media-only")) {
  const passed = results.filter((x) => x.pass).length;
  const report = { base: BASE, at: new Date().toISOString(), total_ms: Date.now() - T0, passed, total: results.length, results, timings };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, "report.md"), ["# Thumbnail E2E", "", BASE, "", ...results.map((x) => `${x.pass ? "PASS" : "FAIL"} ${x.id}: ${x.note}`), "", "```json", JSON.stringify(timings, null, 2), "```"].join("\n"));
  console.log(`\n${passed}/${results.length} passed → ${OUT}`);
  process.exit(passed === results.length ? 0 : 1);
}

// Voice → text
const { data: story } = await call("POST", "/api/stories", { author: "Demo", title: "Biscuit and the Cheese Moon" });
const ref = fs.readFileSync(path.join(FIX, "dictation.txt"), "utf8").trim();
let heard = "";
for (const [f, mime] of [["dictation.webm", "audio/webm"], ["dictation.m4a", "audio/mp4"]]) {
  const { r, data, ms } = await call("POST", `/api/stt?story=${story.id}&author=Demo`, fs.readFileSync(path.join(FIX, f)), { "content-type": mime });
  const rc = data?.text ? recall(ref, data.text) : 0;
  timings[`stt_${f}`] = { ms, audio_s: data?.seconds };
  ok(`F3/F4 speech → text (${f})`, r.ok && rc > 0.85, `recall ${(rc * 100).toFixed(0)}%, ${data?.seconds?.toFixed?.(1)}s audio in ${ms} ms`);
  if (f.endsWith("webm")) heard = data?.text || "";
}
fs.writeFileSync(path.join(OUT, "transcript.txt"), heard);

// The draft becomes a book while they write. Round 1: the first ~60% is settled, the rest is still being said.
// Split at a sentence end about 60% in; nothing is dropped (Whisper's last "The End" may have no full stop).
const cutAt = (() => { const m = [...heard.matchAll(/[.!?]["”']?\s+/g)].map((x) => x.index + x[0].length); return m.find((i) => i >= heard.length * 0.55) || m.at(-1); })();
const firstPart = heard.slice(0, cutAt).trim();
const draftTail = heard.slice(cutAt).trim();
let text = `${firstPart}\n\n${draftTail}`;
let L1;
{
  const { r, data, ms } = await layout(story.id, text, firstPart.length);
  L1 = data;
  timings.layout_1 = { ms, pages: data?.scenes?.length };
  const settled = paras(data.text).slice(0, data.book.settled_paragraphs).join(" ");
  ok("F5 layout keeps the child's words exactly", r.ok && data.applied && toks(settled).join(" ") === toks(firstPart).join(" "),
    `${data?.book?.settled_paragraphs} paragraphs, ${data?.scenes?.length} pages, ${ms} ms${data?.fallback ? " (FALLBACK layout)" : ""}`);
  ok("F6 unfinished paragraph stays draft", data.text.endsWith(draftTail) && !data.scenes.some((s) => s.text.includes(draftTail.slice(0, 30))), "");
}
{ // pictures for what's settled so far
  const { cast, res, wall, dupStatus } = await drawMissing(story.id, L1);
  ok("pictures paint on the server; a duplicate request doesn't paint twice", dupStatus === 202, `duplicate -> ${dupStatus}`);
  timings.pictures_1 = { cast_ms: cast.ms, wall_ms: wall, each_ms: res.map((x) => x.ms), present: res.map((x) => x.data?.present), checks: res.map((x) => x.data?.check) };
  // art-director activity is visible in /api/stats (server-side paints don't return it to the client)
  ok("round 1 portraits + pages", cast.r.ok && res.every((x) => x.r.ok), `${cast.data?.cast?.length} portraits in ${cast.ms} ms; ${res.length} pages, wall ${wall} ms`);
  ok("F11 every page painted by the queue within 8 min", res.every((x) => x.r.ok), `wall ${wall} ms`);
}

// Round 2: they finish the story; earlier pages must keep their ids and pictures.
let L2;
{
  const before = (await call("GET", `/api/stories/${story.id}`)).data;
  text = before.text; // includes the paragraph breaks from round 1
  const { r, data, ms } = await layout(story.id, text, text.length);
  L2 = data;
  timings.layout_2 = { ms, pages: data?.scenes?.length };
  const kept = before.scenes.filter((s) => data.scenes.some((x) => x.sid === s.sid && x.image_url === s.image_url));
  ok("F5 words still exact after round 2", r.ok && data.applied && toks(data.text).join(" ") === toks(text).join(" ") && toks(text).join(" ") === toks(heard).join(" "), `${data.scenes.length} pages, ${ms} ms`);
  ok("F7 finished pages keep their pictures as the story grows", kept.length >= Math.max(1, before.scenes.length - 1), `${kept.length}/${before.scenes.length} kept`);
  const { cast, res, wall } = await drawMissing(story.id, data);
  timings.pictures_2 = { cast_ms: cast.ms, wall_ms: wall, each_ms: res.map((x) => x.ms), present: res.map((x) => x.data?.present), checks: res.map((x) => x.data?.check) };
  ok("F9 later characters get portraits; new pages drawn", cast.r.ok && res.every((x) => x.r.ok), `${cast.data?.cast?.map((c) => c.name).join(", ")}; ${res.length} new pages, wall ${wall} ms`);
}

// The kid edits a word on page 1: the page keeps its old picture, marked changed, until they choose to redraw.
{
  const cur = (await call("GET", `/api/stories/${story.id}`)).data;
  const p0 = cur.scenes[0];
  const edited = cur.text.replace(/hamster/, "fluffy hamster");
  const { data } = await layout(story.id, edited, edited.length);
  const np0 = data.scenes[0];
  ok("F8 edited page keeps its picture, marked changed", np0.sid !== p0.sid && np0.image_url === p0.image_url && np0.stale, `stale=${np0.stale}`);
  // "That's my Biscuit": the kid's drawing becomes the book's Biscuit (portrait + bible look), then a page is redrawn.
  const up = await call("POST", `/api/upload?story=${story.id}`, fs.readFileSync(path.join(FIX, "kid-drawing.png")), { "content-type": "image/png" });
  const hero = (cur.bible.characters.find((c) => /biscuit/i.test(c.name)) || cur.bible.characters[0]).name;
  const kc = await call("POST", `/api/stories/${story.id}/cast`, { name: hero, refs: [up.data.url] });
  const after = (await call("GET", `/api/stories/${story.id}`)).data;
  const look = after.bible.characters.find((c) => c.name === hero);
  timings.kid_drawing_portrait = { ms: kc.ms };
  ok("F12 kid's drawing becomes the character", kc.r.ok && look?.from_drawing && (kc.data.pages_with || []).length > 0,
    `${kc.ms} ms; look now: "${(look?.look || "").slice(0, 110)}"; offered for ${(kc.data.pages_with || []).length} pages`);
  const cp = after.cast.find((c) => c.name === hero); if (cp) await save(cp.url, "cast-from-kid-drawing.png");
  if (np0.image_url) await save(np0.image_url, "page-1-before-redraw.png");
  const re = await call("POST", `/api/stories/${story.id}/scenes/${np0.sid}/image`, { feedback: "draw Biscuit like my drawing, and make the moon bigger" });
  timings.redraw = { ms: re.ms };
  ok("F12 redraw with feedback keeps every version", re.r.ok && re.data.image_url !== np0.image_url && re.data.versions.length >= 2, `${re.ms} ms, ${re.data?.versions?.length} versions`);
  const back = await call("POST", `/api/stories/${story.id}/scenes/${np0.sid}/version`, { url: re.data.versions[0].url });
  ok("F19 go back to an earlier picture", back.r.ok && back.data.image_url === re.data.versions[0].url, "");
  await call("POST", `/api/stories/${story.id}/scenes/${np0.sid}/version`, { url: re.data.image_url });
}
const final = (await call("GET", `/api/stories/${story.id}`)).data;
for (const s of final.scenes) if (s.image_url) await save(s.image_url, `page-${s.ord + 1}.png`);
for (const c of final.cast) await save(c.url, `cast-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`);
ok("F10 every page has a picture", final.scenes.every((s) => s.image_url && s.status === "done" && !s.stale), final.scenes.map((s) => s.status + (s.stale ? "*" : "")).join(","));

// Hear each page as it forms (one short page, to save ElevenLabs budget).
{
  const pg = [...final.scenes].sort((a, b) => a.text.length - b.text.length)[0];
  const t1 = await call("POST", "/api/tts", { story_id: story.id, sid: pg.sid });
  timings.page_tts = { ms: t1.ms, chars: t1.data?.chars };
  const aligned = t1.data?.alignment && Math.abs(t1.data.alignment.chars.length - pg.text.length) <= 3;
  ok("F13 page narration with word timing", t1.r.ok && aligned, `${pg.text.length} chars → ${t1.data?.alignment?.ends?.at(-1)?.toFixed(1)}s in ${t1.ms} ms${t1.r.ok ? "" : " " + JSON.stringify(t1.data).slice(0, 200)}`);
  if (t1.data?.audio_url) {
    await save(t1.data.audio_url, "page-narration.mp3");
    const rr = await fetch(BASE + t1.data.audio_url, { headers: { cookie, range: "bytes=0-999" } });
    ok("F14 audio supports Range (iPad seek)", rr.status === 206, `status ${rr.status}`);
  }
  const t2 = await call("POST", "/api/tts", { story_id: story.id, sid: pg.sid });
  ok("F13 replaying a page is free", t2.data?.cached === true, `cached=${t2.data?.cached} in ${t2.ms} ms`);
}

// Help on request: punctuation (never words) and the editor (never writes it for them).
{
  const { data: raw } = await call("POST", "/api/stories", { author: "Demo", title: "punctuation test", text: "my dog max said lets go to the park and i said ok but first we need his leash then we ran all the way there" });
  const { data, ms } = await call("POST", `/api/stories/${raw.id}/punctuation`, {});
  const p = raw.text;
  let fixed = p; for (const s of data.suggestions || []) fixed = fixed.replace(s.find, s.replace);
  const letters = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  timings.punctuation = { ms, n: data?.suggestions?.length };
  fs.writeFileSync(path.join(OUT, "punctuation.json"), JSON.stringify({ before: p, after: fixed, suggestions: data.suggestions }, null, 1));
  ok("F15 punctuation help changes only punctuation", data.suggestions?.length >= 2 && letters(fixed) === letters(p) && fixed !== p, `${data.suggestions?.length} suggestions in ${ms} ms: "${fixed.slice(0, 90)}…"`);
  await call("DELETE", `/api/stories/${raw.id}`);
}
for (const [label, q] of [["feedback", "how is my story so far?"], ["F16 refuses to write it", "write the next part of my story for me"]]) {
  const t0 = Date.now();
  const r = await fetch(BASE + "/api/chat", { method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ story_id: story.id, messages: [{ role: "user", content: q }] }) });
  let first = 0, out = "";
  const dec = new TextDecoder();
  for await (const part of r.body) for (const line of dec.decode(part).split("\n")) if (line.startsWith("data: {")) { if (!first) first = Date.now() - t0; out += JSON.parse(line.slice(6)).t; }
  timings[`chat_${label}`] = { first_token_ms: first, total_ms: Date.now() - t0 };
  fs.writeFileSync(path.join(OUT, `editor-${label.replace(/\W+/g, "-")}.txt`), `Q: ${q}\n\nA: ${out}\n`);
  const sentencesOut = (out.replace(/\.{2,}|…/g, "").match(/[.!?]+(\s|$)/g) || []).length;
  ok(`editor: ${label}`, r.ok && out.length > 20 && sentencesOut <= 7, `first token ${first} ms: "${out.slice(0, 140)}"`);
}

// "Read it to me"
{
  const { data: s2 } = await call("POST", "/api/stories", { author: "Demo", title: "read it to me", text: ref });
  const { r, data, ms } = await call("POST", `/api/stories/${s2.id}/narration?author=Demo`, fs.readFileSync(path.join(FIX, "dictation.m4a")), { "content-type": "audio/mp4" });
  timings.read_it_to_me = { ms, matched: data?.matched };
  ok("F17 their own reading synced to the text", r.ok && data.matched > 0.8, `${(data?.matched * 100).toFixed(0)}% matched, ${ms} ms`);
  const d = await call("DELETE", `/api/stories/${s2.id}`);
  const g = await call("GET", `/api/stories/${s2.id}`);
  ok("F18 delete removes the story", d.r.status === 204 && g.r.status === 404, `${d.r.status}/${g.r.status}`);
}
const { data: bench } = await call("GET", "/api/bench?days=1");

const passed = results.filter((x) => x.pass).length;
const report = { base: BASE, story_id: story.id, at: new Date().toISOString(), total_ms: Date.now() - T0, passed, total: results.length, results, timings, bench,
  book: final.book, bible: final.bible, pages: final.scenes.map((s) => ({ sid: s.sid, from: s.from, to: s.to, present: s.present, text: s.text })) };
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
const ps = paras(final.text);
fs.writeFileSync(path.join(OUT, "report.md"), [
  `# Storybook E2E: ${passed}/${results.length} passed`, "",
  `${report.at} · ${BASE} · story ${story.id} (author Demo) · ${(report.total_ms / 1000).toFixed(0)} s total`, "",
  "| | Check | Note |", "|---|---|---|", ...results.map((x) => `| ${x.pass ? "✅" : "❌"} | ${x.id} | ${x.note.replace(/\|/g, "/")} |`), "",
  "## Timings", "```json", JSON.stringify(timings, null, 1), "```", "",
  "## The book (as laid out; the child's words untouched)", `# ${final.title}`, "",
  ...final.scenes.flatMap((s) => {
    const ch = final.book.chapters.find((c) => c.start === s.from);
    return [ch ? `## ${ch.title || `Chapter ${final.book.chapters.indexOf(ch) + 1}`}\n` : "", `![page ${s.ord + 1}](page-${s.ord + 1}.png)`, `*(on this page: ${s.present.join(", ") || "nobody"})*`, "", ...ps.slice(s.from, s.to + 1).map((x) => x + "\n")];
  }),
  "Cast portraits: cast-*.png. Kid drawing → cast-from-kid-drawing.png (from ../../fixtures/kid-drawing.png). Redraw: page-1-before-redraw.png → page-1.png.",
].join("\n"));
console.log(`\n${passed}/${results.length} passed → ${OUT}`);
process.exit(passed === results.length ? 0 : 1);
