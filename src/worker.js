// A family writing studio.
// The kid talks or types; the settled part of their draft fades into a real book (paragraphs, chapters,
// pages with pictures) while they keep writing, and each page can be heard as it forms.
// Rule (Alan, 2026-11-02): the child drives the writing; the app never rewrites their words.
// Models plan layout and pictures; the writer owns every word.
import BOOK_SKILL from "./skills/book.md";

import { who, unlock, tenantEnv, finish } from "./tenant.js";
import { providerFetch, chatCompletion, permit, account, unknownCost, settleText, failText } from "./providers.js";
import { shareInfo, shareRoute, publicShare, parentGate } from "./sharing.js";
import { setupStatus } from "./setup.js";
import { APP_NAME } from "./config.js";
const ELEVEN = "https://api.elevenlabs.io";
const DAY = 86400;

export default {
  async scheduled(_controller, env, ctx) {
    if (env.MODE === "hosted") ctx.waitUntil(import("./hosted/index.js").then(module => module.scheduled(env)));
  },
  async queue(batch, rawEnv) {
    for (const msg of batch.messages) {
      const { kind, story_id, sid, account_id } = msg.body || {};
      if (!account_id || (rawEnv.MODE !== "hosted" && account_id !== "self")) { msg.ack(); continue; }
      if (rawEnv.MODE === "hosted") {
        const account = await rawEnv.DB.prepare("SELECT account_id FROM hosted_accounts WHERE account_id=? AND status='active' AND consent_at>0 AND parent_verified_at>0").bind(account_id).first();
        if (!account) { msg.ack(); continue; }
      }
      const env = tenantEnv(Object.assign(Object.create(rawEnv), { CTX: null }), account_id);
      try {
        if (kind === "story") await paintStory(env, story_id);
        else if (kind === "page") await paintQueued(env, story_id, sid);
        msg.ack();
      } catch (e) {
        console.error("paint", kind, story_id, sid, String(e));
        if (msg.attempts >= 3 && kind === "page")
          await env.DB.prepare("UPDATE scenes SET status='error', error=?, updated=? WHERE account_id=? AND story_id=? AND sid=? AND image_key IS NULL").bind(String(e).slice(0, 200), Date.now(), account_id, story_id, sid).run();
        if ([402,429].includes(e.status)) {
          await env.DB.prepare("UPDATE scenes SET status='error', error=?, updated=? WHERE account_id=? AND story_id=? AND image_key IS NULL").bind("The printing press is resting. A grown-up can check when it is ready.", Date.now(), account_id, story_id).run();
          msg.ack();
        } else msg.retry({ delaySeconds: 20 });
      } finally { await finish(env); }
    }
  },
  async fetch(req, rawEnv, ctx) {
    const url = new URL(req.url), p = url.pathname;
    if (rawEnv.MODE === "hosted" && rawEnv.CANONICAL_HOST && url.hostname === `www.${rawEnv.CANONICAL_HOST}`) {
      url.hostname = rawEnv.CANONICAL_HOST;
      return Response.redirect(url.href, 308);
    }
    const env = Object.assign(Object.create(rawEnv), { CTX: ctx });
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.get("origin") && req.headers.get("origin") !== url.origin) return json({ error: "Cross-origin write refused" }, 403);
      if (p === "/robots.txt" && env.MODE === "hosted") return new Response("User-agent: *\nAllow: /$\nAllow: /home/\nDisallow: /\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
      if (p === "/api/config") {
        const tenant = await who(req, env);
        return json({ app_name: APP_NAME, mode: env.MODE || "self", passcode_required: env.MODE !== "hosted" && !!env.PASSCODE,
          passcode_length: /^\d+$/.test(env.PASSCODE || "") ? env.PASSCODE.length : undefined,
          signed_in: !!tenant, signup_open: env.MODE === "hosted" && env.HOSTED_OPEN === "true",
          analytics_key: env.ANALYTICS_KEY || "", analytics_budget_verified: env.ANALYTICS_BUDGET_VERIFIED === "true", analytics_replay: env.ANALYTICS_REPLAY === "true" });
      }
      const publicMatch = p.match(/^\/api\/shared\/([^/]+)$/) || p.match(/^\/s\/([^/]+)\/(.+)$/);
      if (publicMatch && ["GET", "HEAD"].includes(req.method)) return publicShare(req, rawEnv, publicMatch[1], publicMatch[2], { loadStory, speechKey, media });
      if (/^\/b\/[^/]+$/.test(p)) {
        const asset = await env.ASSETS.fetch(new Request(new URL("/b/", url), req));
        const response = new Response(asset.body, asset);
        response.headers.set("x-robots-tag", "noindex"); response.headers.set("referrer-policy", "no-referrer"); return response;
      }
      if (p === "/health") return json({ ok: true, app: APP_NAME, mode: env.MODE || "self" });
      if (env.MODE === "hosted" && /^(\/auth\/|\/api\/(account|billing)(\/|$))/.test(p)) {
        const hosted = await import("./hosted/index.js");
        return await hosted.route(req, env, ctx) || json({ error: "not found" }, 404);
      }
      if (p === "/api/unlock" && req.method === "POST") return unlock(req, env);
      const tenant = await who(req, env);
      if (!tenant) {
        if (p.startsWith("/api/") || p.startsWith("/media/")) return json({ error: "locked" }, 401);
        return env.ASSETS.fetch(env.MODE === "hosted" && p === "/" ? new Request(new URL("/home/", url), req) : req);
      }
      tenantEnv(env, tenant.account_id, tenant.plan);
      env.recordings_enabled = !!tenant.recordings_enabled;
      if (env.MODE === "hosted" && !tenant.child_access && (/^\/api\/(stories(?:\/|$)|upload$|stt$|tts$|chat$)/.test(p) || (p === "/api/settings" && req.method !== "GET"))) return json({ error: "parental_consent_required" }, 403);
      if (p === "/api/setup") return setupStatus(req, env);
      if (p === "/api/settings") {
        if (req.method === "GET") return json(await familySettings(env));
        if (req.method === "PUT") {
          await parentGate(req, env);
          const body = await req.json();
          const writers = normalizeWriters(body.writers);
          const write = env.MODE === "hosted"
            ? env.DB.prepare("INSERT INTO settings (account_id,writers) SELECT ?,? WHERE EXISTS (SELECT 1 FROM hosted_accounts WHERE account_id=? AND status='active' AND consent_at>0 AND parent_verified_at>0) ON CONFLICT(account_id) DO UPDATE SET writers=excluded.writers").bind(env.account_id, JSON.stringify(writers), env.account_id)
            : env.DB.prepare("INSERT INTO settings (account_id,writers) VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET writers=excluded.writers").bind(env.account_id, JSON.stringify(writers));
          const changed = await write.run();
          if (!changed.meta.changes) return json({ error: "account_unavailable" }, 403);
          return json({ writers });
        }
      }
      if (p.startsWith("/media/")) return await media(p.slice(7), req, env);
      if (p.startsWith("/api/")) return await api(req, env, ctx, url);
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(p, e?.message || "request failed");
      return json({ error: e?.status ? e.message : "request failed", reason: e?.reason }, e?.status || 500);
    } finally { if (!env.streaming) await finish(env); }
  },
};

async function familySettings(env) {
  const row = await env.DB.prepare("SELECT writers FROM settings WHERE account_id=?").bind(env.account_id).first();
  return { writers: row ? normalizeWriters(JSON.parse(row.writers)) : [] };
}
function normalizeWriters(list) {
  const writers = [];
  for (const item of Array.isArray(list) ? list : []) {
    const name = clean(typeof item === "string" ? item : item?.name, 24);
    if (!name || writers.some(w => w.name === name)) continue;
    writers.push({ name, color: /^#[a-f0-9]{6}$/i.test(item?.color || "") ? item.color : "#cf6c46" });
    if (writers.length >= 12) break;
  }
  return writers;
}

// ---------- router ----------
async function api(req, env, ctx, url) {
  const p = url.pathname, m = req.method;
  let r;
  if (p === "/api/stories" && m === "GET") return listStories(env, url.searchParams.get("author"));
  if (p === "/api/stories" && m === "POST") return createStory(req, env);
  if ((r = p.match(/^\/api\/stories\/([\w-]+)\/share$/)) && ["POST", "DELETE"].includes(m)) return shareRoute(req, env, r[1]);
  if ((r = p.match(/^\/api\/stories\/([\w-]+)$/))) {
    if (m === "GET") return getStory(env, r[1]);
    if (m === "PUT") return updateStory(req, env, r[1]);
    if (m === "DELETE") return deleteStory(env, r[1]);
  }
  if ((r = p.match(/^\/api\/stories\/([\w-]+)\/book$/)) && m === "POST") return layoutBook(req, env, r[1]);
  if ((r = p.match(/^\/api\/stories\/([\w-]+)\/punctuation$/)) && m === "POST") return punctuation(req, env, r[1]);
  if ((r = p.match(/^\/api\/stories\/([\w-]+)\/cast$/)) && m === "POST") return castPortraits(req, env, r[1]);
  if ((r = p.match(/^\/api\/stories\/([\w-]+)\/narration$/)) && m === "POST") return narration(req, env, url, r[1]);
  if ((r = p.match(/^\/api\/stories\/([\w-]+)\/scenes\/([a-f0-9]+)$/)) && m === "PUT") return updateScene(req, env, r[1], r[2]);
  if ((r = p.match(/^\/api\/stories\/([\w-]+)\/scenes\/([a-f0-9]+)\/image$/)) && m === "POST") return sceneImage(req, env, r[1], r[2]);
  if ((r = p.match(/^\/api\/stories\/([\w-]+)\/scenes\/([a-f0-9]+)\/version$/)) && m === "POST") return pickVersion(req, env, r[1], r[2]);
  if (p === "/api/stt" && m === "POST") return stt(req, env, url);
  if (p === "/api/tts" && m === "POST") return tts(req, env);
  if (p === "/api/voices" && m === "GET") return voices(env);
  if (p === "/api/upload" && m === "POST") return upload(req, env, url);
  if (p === "/api/chat" && m === "POST") return chat(req, env, ctx);
  if (p === "/api/bench" && m === "GET") return bench(env, url);
  if (p === "/api/stats" && m === "GET") return stats(env, url);
  return json({ error: "not found" }, 404);
}

// ---------- stories ----------
const mediaUrl = (k) => (k ? `/media/${k}` : null);

async function listStories(env, author) {
  const q = author
    ? env.DB.prepare("SELECT * FROM stories WHERE account_id=? AND author=? ORDER BY updated DESC").bind(env.account_id, author)
    : env.DB.prepare("SELECT * FROM stories WHERE account_id=? ORDER BY updated DESC").bind(env.account_id);
  const [{ results }, sc] = await Promise.all([q.all(),
    env.DB.prepare("SELECT story_id, ord, image_key FROM scenes WHERE account_id=? ORDER BY story_id, ord").bind(env.account_id).all()]);
  const n = {}, cover = {};
  for (const c of sc.results) { n[c.story_id] = (n[c.story_id] || 0) + 1; if (c.image_key && !cover[c.story_id]) cover[c.story_id] = c.image_key; }
  return json(results.map((s) => ({ id: s.id, title: s.title, author: s.author, updated: s.updated,
    cover_url: mediaUrl(cover[s.id]), scene_count: n[s.id] || 0, words: wc(s.text),
    first_line: (String(s.text || "").split(/\n/)[0].match(/^.{1,70}?(?:[.!?](?=\s|$)|$)/) || [""])[0].trim() })));
}

async function createStory(req, env) {
  const b = await req.json().catch(() => ({}));
  if (!b.author) return json({ error: "author required" }, 400);
  const id = rid(), now = Date.now();
  const values = [env.account_id, id, clean(b.author, 40), clean(b.title || "", 120), String(b.text || ""), b.voice_id || null, now, now];
  const insert = env.MODE === "hosted"
    ? env.DB.prepare("INSERT INTO stories (account_id,id,author,title,text,voice_id,created,updated) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM hosted_accounts WHERE account_id=? AND status='active' AND consent_at>0 AND parent_verified_at>0)").bind(...values, env.account_id)
    : env.DB.prepare("INSERT INTO stories (account_id,id,author,title,text,voice_id,created,updated) VALUES (?,?,?,?,?,?,?,?)").bind(...values);
  const inserted = await insert.run();
  if (!inserted.meta.changes) return json({ error: "account_unavailable" }, 403);
  return getStory(env, id, 201);
}

async function loadStory(env, id) {
  if (!id) return null;
  env.story_id = id;
  const s = await env.DB.prepare("SELECT * FROM stories WHERE account_id=? AND id=?").bind(env.account_id, id).first();
  if (!s) return null;
  const { results } = await env.DB.prepare("SELECT * FROM scenes WHERE account_id=? AND story_id=? ORDER BY ord").bind(env.account_id, id).all();
  return { s, scenes: results };
}

async function getStory(env, id, status = 200) {
  const L = await loadStory(env, id);
  if (!L) return json({ error: "not found" }, 404);
  const { s, scenes } = L;
  const book = s.book ? JSON.parse(s.book) : { chapters: [], settled_paragraphs: 0 };
  // Read-aloud cost is accumulated per story; provider prices are configurable estimates.
  const allCost = env.MODE === "hosted" ? null : await env.DB.prepare("SELECT COALESCE(SUM(usd),0) usd FROM usage_ledger WHERE account_id=? AND story_id=?").bind(env.account_id, id).first();
  const cost = await env.DB.prepare("SELECT COALESCE(SUM(cost_usd),0) usd, COUNT(*) n FROM events WHERE account_id=? AND kind='tts' AND ok=1 AND story_id=?").bind(env.account_id, id).first();
  return json({ id: s.id, title: s.title, author: s.author, text: s.text, voice_id: s.voice_id,
    share: await shareInfo(env, id),
    book: { chapters: book.chapters || [], settled_paragraphs: book.settled_paragraphs || 0 },
    cost: { ...(allCost ? { usd: +allCost.usd.toFixed(4) } : {}), narration_usd: +cost.usd.toFixed(4), elevenlabs_usd: +cost.usd.toFixed(4), readings: cost.n },
    own_audio_url: mediaUrl(s.own_audio_key), own_alignment: s.own_alignment ? JSON.parse(s.own_alignment) : null, own_by: s.own_by || null,
    bible: s.bible ? JSON.parse(s.bible) : null, cast: castOut(s), created: s.created, updated: s.updated,
    scenes: scenes.map(sceneOut) }, status);
}

const sceneOut = (c) => ({ sid: c.sid, ord: c.ord, from: c.para_from, to: c.para_to, text: c.text,
  present: JSON.parse(c.present || "[]"), image_prompt: c.image_prompt, image_url: mediaUrl(c.image_key),
  refs: JSON.parse(c.refs || "[]"), feedback: c.feedback, stale: !!c.stale, error: c.error || null,
  // A paint whose request was cut off (tab closed mid-paint) never finishes: after 150 s it counts as not painted,
  // so the app draws it again (a writer's 22 pages sat on "generating", 2026-11-02).
  // Waiting in the paint queue shows as "generating" (queued: true), so the UI just shows the pencil placeholder.
  status: (c.status === "generating" && Date.now() - c.updated > 150000) || (c.status === "queued" && Date.now() - c.updated > 900000)
    ? (c.image_key ? "done" : "pending") : c.status === "queued" ? "generating" : c.status,
  queued: c.status === "queued" && Date.now() - c.updated <= 900000,
  versions: JSON.parse(c.versions || "[]").map((v) => ({ url: mediaUrl(v.key), how: v.how, at: v.at })) });

async function updateStory(req, env, id) {
  const b = await req.json().catch(() => ({}));
  const cur = await env.DB.prepare("SELECT * FROM stories WHERE account_id=? AND id=?").bind(env.account_id, id).first();
  if (!cur) return json({ error: "not found" }, 404);
  await env.DB.prepare("UPDATE stories SET title=?, text=?, author=?, voice_id=?, updated=? WHERE account_id=? AND id=?")
    .bind(clean(b.title ?? cur.title, 120), String(b.text ?? cur.text), clean(b.author ?? cur.author, 40), b.voice_id ?? cur.voice_id, Date.now(), env.account_id, id).run();
  return getStory(env, id);
}

async function deleteStory(env, id) {
  const L = await loadStory(env, id);
  if (!L) return new Response(null, { status: 204 });
  if (L.s.own_audio_key) await env.MEDIA.delete(L.s.own_audio_key);
  const prefixes = [`audio/${id}/`, `img/${id}/`, `ref/${id}/`, `own/${id}/`,
    ...THUMB_WIDTHS.flatMap((w) => [`thumb/${w}/img/${id}/`, `thumb/${w}/ref/${id}/`])];
  for (const prefix of prefixes) for (let cursor; ;) { // narration, every picture version, uploads and their thumbnails
    const l = await env.MEDIA.list({ prefix, cursor });
    if (l.objects.length) await env.MEDIA.delete(l.objects.map((o) => o.key));
    if (!l.truncated) break; cursor = l.cursor;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM shares WHERE account_id=? AND story_id=?").bind(env.account_id, id),
    env.DB.prepare("DELETE FROM scenes WHERE account_id=? AND story_id=?").bind(env.account_id, id),
    env.DB.prepare("DELETE FROM stories WHERE account_id=? AND id=?").bind(env.account_id, id),
  ]);
  return new Response(null, { status: 204 });
}

// ---------- Write: speech → text ----------
// Live words come from the browser's Web Speech API (free, instant). This endpoint is the final, better
// transcript from the recorded audio (Whisper large-v3-turbo on Workers AI). The audio is not kept.
async function whisper(env, buf, author) {
  const settings = await familySettings(env);
  const names = [...new Set([...(settings.writers || []).map(w => w.name), author].filter(Boolean))].join(", ");
  const reservation = await permit(env, "stt", 0.02);
  let out;
  try { out = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: b64(buf), language: "en", vad_filter: true,
    initial_prompt: `A child telling a made-up story out loud. ${names ? `Names: ${names}.` : ""}`,
  });
  } catch (e) { await unknownCost(env, "stt", reservation); throw e; }
  await account(env, "stt", (out?.transcription_info?.duration || 0) / 60 * 0.00051, { seconds: out?.transcription_info?.duration || 0, basis: "audio_seconds_configured_rate" }, reservation);
  return out;
}

async function stt(req, env, url) {
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 2000) return json({ error: "no audio" }, 400);
  if (buf.byteLength > 24e6) return json({ error: "too long, keep each recording under ~10 minutes" }, 413);
  const storyId = url.searchParams.get("story");
  if (storyId && !await loadStory(env, storyId)) return json({ error: "not found" }, 404);
  const t0 = Date.now();
  const out = await whisper(env, buf, clean(url.searchParams.get("author") || "", 40));
  const ms = Date.now() - t0;
  const seconds = out?.transcription_info?.duration || 0;
  // Workers AI whisper-large-v3-turbo: $0.00051 per audio minute.
  await log(env, "stt", url.searchParams.get("story"), true, ms, seconds, "audio_s", (seconds / 60) * 0.00051,
    { bytes: buf.byteLength, mime: req.headers.get("content-type") });
  return json({ text: (out?.text || "").trim(), seconds, ms });
}

// ---------- Listen: text → speech (ElevenLabs, with timing for the word highlight) ----------
const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"; // George, warm storyteller
const STORYTELLERS = [
  ["JBFqnCBsd6RMkjVDRZzb", "George", "warm storyteller"],
  ["cgSgspJ2msm6clMCkdW9", "Jessica", "playful and bright"],
  ["RILOU7YmBhvwJGDGjNmP", "Jeanette", "cozy audiobook grandma"],
  ["yRkCcID7C7SG09Wb6tIg", "Roger", "grand old wizard"],
  ["N2lVS1w4EtoT3dr4eOWO", "Callum", "sneaky trickster"],
  ["XrExE9yKIg1WjnnlVkGX", "Matilda", "friendly teacher"],
];

async function voices(env) {
  if (!env.ELEVENLABS_API_KEY) return json(["coral", "alloy", "nova", "sage"].map(id => ({ id, name: id, vibe: "OpenAI narrator", kind: "storyteller" })));
  return json([
    ...STORYTELLERS.map(([id, name, vibe]) => ({ id, name, vibe, kind: "storyteller" })),
  ]); // a kid's own voice is per story: story.own_audio_url ("Read it to me")
}

// POST /api/tts {story_id, sid?, voice_id?}: one page (sid) or the whole story. Cached in R2 by
// model+voice+text, so replays and unchanged pages are free; editing one paragraph re-reads one page.
// The app reads page by page. Any text over ~3,500 chars is read in sentence-aligned pieces and stitched into
// one MP3 with one continuous timing track (provider input limits apply to each piece).
async function tts(req, env) {
  const b = await req.json().catch(() => ({}));
  const L = await loadStory(env, b.story_id);
  if (!L) return json({ error: "story not found" }, 404);
  const page = b.sid ? L.scenes.find((c) => c.sid === b.sid) : null;
  if (b.sid && !page) return json({ error: "page not found" }, 404);
  const text = String(page ? page.text : L.s.text || "").trim();
  if (!text) return json({ error: "story is empty" }, 400);
  const eleven = !!env.ELEVENLABS_API_KEY;
  const voice = eleven ? b.voice_id || L.s.voice_id || DEFAULT_VOICE : env.OPENAI_TTS_VOICE || "coral";
  const model = eleven ? env.TTS_MODEL || "eleven_multilingual_v2" : env.OPENAI_TTS_MODEL || "tts-1";
  const key = await speechKey(env, { ...L.s, voice_id: voice }, text);
  const hit = await env.MEDIA.get(`${key}.json`);
  if (hit) {
    await log(env, "play", L.s.id, true, 0, 0, "credits", 0, { sid: b.sid || null, cached: true }); // a re-listen (free)
    return json({ audio_url: mediaUrl(`${key}.mp3`), alignment: await hit.json(), ms: 0, chars: 0, credits: 0, usd: 0, cached: true, sid: b.sid || null });
  }
  const t0 = Date.now();
  const pieces = splitForSpeech(text, 3500);
  const out = [];
  for (let i = 0; i < pieces.length; i += 3) out.push(...await Promise.all(pieces.slice(i, i + 3).map((pc) => speakOnce(env, pc.text, voice, model))));
  const ms = Date.now() - t0;
  const bad = out.find((o) => !o.ok);
  if (bad) {
    await log(env, "tts", L.s.id, false, ms, text.length, "chars", 0, { status: bad.status, err: bad.err, model, sid: b.sid, pieces: pieces.length });
    return json({ error: "the reading voice said no", detail: bad.err }, 502);
  }
  // Stitch: MP3 frames concatenate cleanly; each piece's timings shift by the audio before it.
  const chars = text.split(""), starts = new Array(text.length).fill(0), ends = new Array(text.length).fill(0);
  let shift = 0;
  for (const [k, pc] of pieces.entries()) {
    const a = out[k].alignment, n = pc.text.length;
    for (let c = 0; c < n; c++) {
      const j = a.chars.length === n ? c : Math.min(a.chars.length - 1, Math.floor((c * a.chars.length) / n));
      starts[pc.at + c] = (a.starts[j] || 0) + shift; ends[pc.at + c] = (a.ends[j] || 0) + shift;
    }
    shift += out[k].duration;
  }
  for (let c = 1; c < text.length; c++) if (!ends[c]) { starts[c] = ends[c - 1]; ends[c] = ends[c - 1]; } // gaps between pieces
  const alignment = { chars, starts, ends };
  const mp3 = new Uint8Array(out.reduce((t, o) => t + o.bytes.length, 0));
  { let o = 0; for (const x of out) { mp3.set(x.bytes, o); o += x.bytes.length; } }
  await env.MEDIA.put(`${key}.mp3`, mp3, { httpMetadata: { contentType: "audio/mpeg" } });
  await env.MEDIA.put(`${key}.json`, JSON.stringify(alignment), { httpMetadata: { contentType: "application/json" } });
  if (b.voice_id && b.voice_id !== L.s.voice_id) await env.DB.prepare("UPDATE stories SET voice_id=? WHERE account_id=? AND id=?").bind(voice, env.account_id, L.s.id).run();
  // Credits are reported by the provider. Configure the rate for your own account.
  const credits = out.reduce((t, o) => t + o.credits, 0);
  const usd = eleven ? credits * Number(env.ELEVEN_USD_PER_CREDIT || 0.0003) : text.length / 1000 * Number(env.OPENAI_TTS_USD_PER_1K || 0.015);
  await log(env, "tts", L.s.id, true, ms, credits, "credits", usd, { model, voice, chars: text.length, pieces: pieces.length, sid: b.sid || null, audio_s: ends.at(-1) });
  return json({ audio_url: mediaUrl(`${key}.mp3`), alignment, ms, chars: text.length, credits, usd: +usd.toFixed(4), pieces: pieces.length, sid: b.sid || null });
}

// Cut text into pieces of at most `max` chars at sentence ends (then spaces), keeping each piece's offset.
function splitForSpeech(text, max) {
  const out = [];
  let at = 0;
  while (at < text.length) {
    while (at < text.length && /\s/.test(text[at])) at++;
    if (at >= text.length) break;
    let end = Math.min(text.length, at + max);
    if (end < text.length) {
      const win = text.slice(at, end);
      const m = [...win.matchAll(/[.!?…]["”'’)]*\s/g)].pop() || [...win.matchAll(/\s/g)].pop();
      if (m && m.index > max * 0.3) end = at + m.index + m[0].length;
    }
    const piece = text.slice(at, end).replace(/\s+$/, "");
    out.push({ at, text: piece });
    at = end;
  }
  return out;
}

async function speechKey(env, story, text) {
  const eleven = !!env.ELEVENLABS_API_KEY;
  const voice = eleven ? story.voice_id || DEFAULT_VOICE : env.OPENAI_TTS_VOICE || "coral";
  const model = eleven ? env.TTS_MODEL || "eleven_multilingual_v2" : env.OPENAI_TTS_MODEL || "tts-1";
  return `audio/${story.id}/${(await sha256(`${eleven ? "elevenlabs" : "openai"}|${model}|${voice}|${String(text).trim()}`)).slice(0, 24)}`;
}

async function speakOnce(env, text, voice, model) {
  if (!env.ELEVENLABS_API_KEY) return openaiSpeech(env, text, voice, model);
  const reservation = await permit(env, "tts", text.length * Number(env.ELEVEN_MAX_USD_PER_CHAR || 0.00014));
  let res;
  try { res = await fetch(`${ELEVEN}/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST", headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true } }),
  });
  } catch (e) { await unknownCost(env, "tts", reservation, { characters: text.length }); throw e; }
  if (!res.ok) await unknownCost(env, "tts", reservation, { characters: text.length });
  if (res.status === 402 || res.status === 429) throw Object.assign(new Error("Provider usage limit reached"), { status: res.status });
  if (!res.ok) return { ok: false, status: res.status, err: `Voice provider request failed (${res.status})` };
  let d;
  try { d = await res.json(); } catch (e) { await unknownCost(env, "tts", reservation, { characters: text.length }); throw e; }
  const creditHeader = res.headers.get("character-cost");
  const credits = creditHeader === null ? text.length * 0.45 : Number(creditHeader);
  await account(env, "tts", credits * Number(env.ELEVEN_USD_PER_CREDIT || 0.0003), { credits, characters: text.length, estimate: creditHeader === null, basis: creditHeader === null ? "characters_estimate" : "provider_credit_header_configured_rate" }, reservation);
  const a = d.alignment || d.normalized_alignment;
  const bytes = unb64(d.audio_base64);
  // Duration from the MP3 itself (128 kbps CBR), so stitched timings don't drift; timing track as a floor.
  const duration = Math.max(a.character_end_times_seconds.at(-1) || 0, (bytes.length * 8) / 128000);
  return { ok: true, bytes, duration, credits: Number(res.headers.get("character-cost")) || 0,
    alignment: { chars: a.characters, starts: a.character_start_times_seconds, ends: a.character_end_times_seconds } };
}

// OpenAI TTS has no character timestamps. Whisper aligns its generated MP3 to the
// original words; interpolation is an explicit fallback if Whisper cannot align it.
async function openaiSpeech(env, text, voice, model) {
  const res = await providerFetch(env, "/audio/speech", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }) }, { units: text.length });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let duration = mp3Duration(bytes) || Math.max(1, wc(text) / 2.5);
  let alignment;
  try {
    const heard = await whisper(env, bytes.buffer);
    duration = heard?.transcription_info?.duration || duration;
    const words = (heard?.segments || []).flatMap(s => s.words || []);
    if (words.length) alignment = alignWords(text, words).alignment;
  } catch (e) { if (e.status === 402 || e.status === 429) throw e; }
  if (!alignment) {
    const chars = text.split("");
    alignment = { chars, starts: chars.map((_, i) => duration * i / chars.length), ends: chars.map((_, i) => duration * (i + 1) / chars.length) };
  }
  return { ok: true, bytes, duration, credits: 0, alignment };
}
// Count MPEG-1/2 Layer III frames rather than assuming a provider's output bitrate.
function mp3Duration(bytes) {
  let i = 0, seconds = 0;
  if (bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) i = 10 + ((bytes[6] & 127) << 21 | (bytes[7] & 127) << 14 | (bytes[8] & 127) << 7 | bytes[9] & 127);
  while (i + 4 < bytes.length) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    if (a !== 255 || (b & 224) !== 224 || (b & 6) !== 2) { i++; continue; }
    const version = (b >> 3) & 3, rate = (c >> 2) & 3, idx = c >> 4;
    if (version === 1 || rate === 3 || idx === 0 || idx === 15) { i++; continue; }
    const bitrate = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[idx] * 1000;
    const sampleRate = [44100,48000,32000][rate] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length = Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + ((c >> 1) & 1);
    if (i + length > bytes.length) break;
    seconds += (version === 3 ? 1152 : 576) / sampleRate; i += length;
  }
  return seconds;
}

// ---------- "Read it to me": the kid reads the finished story aloud, and that becomes its narration ----------
// Replaces voice cloning: ElevenLabs (and OpenAI, Google, Cartesia) forbid cloning anyone under 18
// (ElevenLabs Prohibited Use Policy, 09 Oct 2026; research/voice-tts-stt-2026-11.md). Their real voice, no model.
async function narration(req, env, url, id) {
  if (env.MODE === "hosted" && !env.recordings_enabled) return json({ error: "A parent needs to enable saved recordings first", reason: "recordings_disabled" }, 403);
  const L = await loadStory(env, id);
  if (!L) return json({ error: "not found" }, 404);
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 2000) return json({ error: "no audio" }, 400);
  if (buf.byteLength > 24e6) return json({ error: "too long" }, 413);
  const by = clean(url.searchParams.get("author") || L.s.author, 40);
  const mime = (req.headers.get("content-type") || "audio/webm").split(";")[0];
  const t0 = Date.now();
  const out = await whisper(env, buf, by);
  const ms = Date.now() - t0;
  const heard = (out?.segments || []).flatMap((g) => g.words || []);
  const { alignment, matched } = alignWords(L.s.text, heard);
  const key = `own/${id}/${Date.now()}.${ext(mime)}`;
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: mime } });
  if (L.s.own_audio_key) await env.MEDIA.delete(L.s.own_audio_key);
  await env.DB.prepare("UPDATE stories SET own_audio_key=?, own_alignment=?, own_by=?, updated=? WHERE account_id=? AND id=?")
    .bind(key, JSON.stringify(alignment), by, Date.now(), env.account_id, id).run();
  const seconds = out?.transcription_info?.duration || 0;
  await log(env, "narration", id, true, ms, seconds, "audio_s", (seconds / 60) * 0.00051, { matched });
  return json({ own_audio_url: mediaUrl(key), own_alignment: alignment, matched, seconds, ms });
}

// Map Whisper's timed words onto the story text, producing the same {chars,starts,ends} shape as ElevenLabs,
// so one highlighter plays both. Kids skip, repeat and misread words: greedy match with a small lookahead,
// then interpolate the unmatched words between their matched neighbours.
function alignWords(text, heard) {
  const norm = (w) => String(w).toLowerCase().replace(/[^a-z0-9']/g, "");
  const words = [...String(text).matchAll(/\S+/g)].map((m) => ({ w: norm(m[0]), a: m.index, b: m.index + m[0].length, t0: null, t1: null }));
  const H = heard.map((h) => ({ w: norm(h.word), s: h.start, e: h.end }));
  let j = 0, matched = 0;
  for (const wd of words) {
    if (!wd.w) continue;
    for (let k = j; k < Math.min(H.length, j + 4); k++) {
      if (H[k].w === wd.w || (wd.w.length > 3 && H[k].w.startsWith(wd.w.slice(0, 4)))) { wd.t0 = H[k].s; wd.t1 = H[k].e; j = k + 1; matched++; break; }
    }
  }
  const end = H.length ? H[H.length - 1].e : 0;
  for (let i = 0; i < words.length; i++) if (words[i].t0 == null) {
    let p = i - 1; while (p >= 0 && words[p].t0 == null) p--;
    let n = i + 1; while (n < words.length && words[n].t0 == null) n++;
    const from = p >= 0 ? words[p].t1 : 0, to = n < words.length ? words[n].t0 : end;
    const gap = n - p - 1, pos = i - p;
    words[i].t0 = from + ((to - from) * (pos - 1)) / gap; words[i].t1 = from + ((to - from) * pos) / gap;
  }
  const chars = [...String(text)], starts = new Array(chars.length).fill(0), ends = new Array(chars.length).fill(0);
  let last = 0;
  for (const wd of words) {
    for (let c = wd.a; c < wd.b; c++) { const f = (c - wd.a) / (wd.b - wd.a); starts[c] = wd.t0 + (wd.t1 - wd.t0) * f; ends[c] = wd.t0 + ((wd.t1 - wd.t0) * (c - wd.a + 1)) / (wd.b - wd.a); }
  }
  for (let c = 0; c < chars.length; c++) { if (!ends[c]) { starts[c] = last; ends[c] = last; } last = ends[c]; }
  return { alignment: { chars, starts, ends }, matched: words.length ? +(matched / words.length).toFixed(2) : 0 };
}

// ---------- The book forms while they write ----------
// POST /api/stories/:id/book {text, settled_upto?}: lay out the settled part of the draft (everything before
// the paragraph they're still working on) as paragraphs, chapters and pages (skills/book.md).
// No model ever returns story text: paragraph breaks are cut by the server at quoted sentence starts, and pages
// refer to paragraphs by number, so the kid's words cannot change (Alan: "the assistant doesn't re-write it").
// Pages have stable ids (hash of their words): untouched pages keep their pictures; a page whose words changed
// keeps its old picture marked stale, and the kid decides whether to redraw it.

async function layoutBook(req, env, id) {
  const b = await req.json().catch(() => ({}));
  const L = await loadStory(env, id);
  if (!L) return json({ error: "not found" }, 404);
  const text = String(b.text ?? L.s.text);
  if (text !== L.s.text) return json({ error: "save the text first", applied: false }, 409);
  const cut = Math.max(0, Math.min(text.length, Number.isFinite(+b.settled_upto) ? +b.settled_upto : text.length));
  const settled = text.slice(0, cut).trim(), tail = text.slice(cut).trim();
  const prev = L.s.book ? JSON.parse(L.s.book) : {};
  const settledHash = (await sha256(settled)).slice(0, 16);
  if (wc(settled) < 12 || prev.settled_hash === settledHash) return json({ applied: false, unchanged: true, ...(await storyJson(env, id)) });
  const t0 = Date.now();

  // 1. Paragraphs. The kid's own breaks stay; only long ones get split, at sentence starts the model QUOTES.
  //    The server cuts the kid's text at those quotes, so no word can change (the model never re-types the
  //    story: re-typing 13,035 chars failed twice and took 101 s, 2026-11-02).
  const prevParas = settledParas(L.s.text, prev.settled_paragraphs);
  const { paras, splitMs, splitFallback } = await splitParagraphs(env, settled, new Set(prevParas.map((x) => x.trim())));

  // 2. Pages. Pages lying entirely inside the unchanged opening paragraphs are kept as they are; the model
  //    plans only the rest, by paragraph number (skills/book.md).
  let same = 0; while (same < paras.length && same < prevParas.length && paras[same] === prevParas[same].trim()) same++;
  const kept = L.scenes.filter((c) => c.para_to < same).sort((x, y) => x.ord - y.ord);
  let start = 0; for (const c of kept) if (c.para_from === start) start = c.para_to + 1; else break;
  const keptScenes = kept.filter((c) => c.para_to < start).map((c) => ({ from: c.para_from, to: c.para_to, present: JSON.parse(c.present || "[]"), image_prompt: c.image_prompt }));
  const bibleIn = L.s.bible ? JSON.parse(L.s.bible) : { style: "", characters: [] };
  let planned = [], chaptersNew = [], bible = bibleIn, planFallback = false, model = env.TEXT_MODEL || "gpt-4.1-mini";
  if (start < paras.length) {
    const ctx = paras.slice(Math.max(0, start - 2), start).join("\n\n");
    const numbered = paras.slice(start).map((t, k) => `[${start + k}] ${t}`).join("\n\n");
    const r = await chatCompletion(env, { model, max_tokens: 12000, messages: [{ role: "system", content: BOOK_SKILL },
      { role: "user", content: `Author: ${L.s.author}\nBible so far: ${JSON.stringify(bibleIn)}\nWords so far: ${wc(settled)}\n${ctx ? `\nJust before (already planned, context only):\n${ctx}\n` : ""}\nPlan paragraphs ${start}–${paras.length - 1} (${wc(paras.slice(start).join(" "))} words: aim for about ${Math.max(1, Math.round(wc(paras.slice(start).join(" ")) / 170))} pages, ~120–250 words each):\n\n${numbered}` }] });
    const plan = parseJson(r.text);
    planned = validScenes(plan?.scenes, start, paras.length);
    if (!planned) { planFallback = true; planned = naiveScenes(paras, start, bibleIn); }
    planned = planned.flatMap((sc) => { // over-long pages become one page per paragraph
      const len = paras.slice(sc.from, sc.to + 1).join("\n\n").length;
      if (len <= MAX_PAGE || sc.to === sc.from) return [sc];
      const out = []; let a = sc.from, size = 0;
      for (let i = sc.from; i <= sc.to; i++) {
        if (size && size + paras[i].length > MAX_PAGE) { out.push({ ...sc, from: a, to: i - 1 }); a = i; size = 0; }
        size += paras[i].length + 2;
      }
      out.push({ ...sc, from: a, to: sc.to });
      return out;
    });
    chaptersNew = (plan?.chapters || []).filter((c) => Number.isInteger(c.start) && c.start >= start && c.start < paras.length)
      .map((c) => ({ start: c.start, title: c.title ? clean(c.title, 80) : null }));
    bible = mergeBible(bibleIn, plan?.bible);
  }
  const scenes = [...keptScenes, ...planned];
  const chapters = [...(prev.chapters || []).filter((c) => c.start < start), ...chaptersNew];
  if (!chapters.length || chapters[0].start !== 0) chapters.unshift({ start: 0, title: null });
  const ms = Date.now() - t0;

  const newText = paras.join("\n\n") + (tail ? "\n\n" + tail : "");
  if (newText.replace(/\s+/g, " ").trim() !== text.replace(/\s+/g, " ").trim()) return json({ error: "layout would change the writer’s words", applied: false }, 422);
  const bookJson = JSON.stringify({ chapters, settled_paragraphs: paras.length, settled_hash: (await sha256(paras.join("\n\n"))).slice(0, 16) });
  const now = Date.now();
  const upd = await env.DB.prepare("UPDATE stories SET text=?, book=?, bible=?, updated=? WHERE account_id=? AND id=? AND text=?")
    .bind(newText, bookJson, JSON.stringify(bible), now, env.account_id, id, text).run();
  await log(env, "book", id, true, ms, paras.length, "paragraphs", 0, { model, split_ms: splitMs, split_fallback: splitFallback,
    plan_fallback: planFallback, kept_pages: keptScenes.length, new_pages: planned.length, chars: settled.length, applied: !!upd.meta.changes });
  if (!upd.meta.changes) return json({ error: "the text changed while laying out; try again", applied: false }, 409);
  // Diff pages by stable id.
  const next = [];
  for (const [ord, sc] of scenes.entries()) {
    const ptext = paras.slice(sc.from, sc.to + 1).join("\n\n");
    // Page id from the words only: accepting a punctuation fix must not mark the picture as changed.
    const wordsOnly = ptext.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    // Two pages with the same words (a refrain) need different ids, or one replaces the other: add which repeat it is.
    const repeat = next.filter((x) => x.wordsOnly === wordsOnly).length;
    next.push({ ord, sc, ptext, wordsOnly, sid: (await sha256(repeat ? `${wordsOnly}#${repeat}` : wordsOnly)).slice(0, 12), present: JSON.stringify((sc.present || []).map((x) => clean(x, 60))) });
  }
  const nextIds = new Set(next.map((x) => x.sid)), stmts = [], carried = new Set();
  for (const x of next) {
    const same = L.scenes.find((c) => c.sid === x.sid);
    if (same) {
      stmts.push(env.DB.prepare("UPDATE scenes SET ord=?, para_from=?, para_to=?, present=?, text=?, updated=? WHERE account_id=? AND story_id=? AND sid=?")
        .bind(x.ord, x.sc.from, x.sc.to, x.present, x.ptext, now, env.account_id, id, x.sid));
      continue;
    }
    // A page whose words changed inherits the old picture that started at the same paragraph (marked stale).
    const was = L.scenes.find((c) => !nextIds.has(c.sid) && !carried.has(c.sid) && c.image_key && c.para_from === x.sc.from);
    if (was) carried.add(was.sid);
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO scenes (account_id,story_id,sid,ord,para_from,para_to,text,image_prompt,present,image_key,versions,refs,feedback,status,stale,updated)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM stories WHERE account_id=? AND id=?)`).bind(env.account_id, id, x.sid, x.ord, x.sc.from, x.sc.to, x.ptext, String(x.sc.image_prompt || ""), x.present,
      was?.image_key || null, was?.versions || "[]", was?.refs || "[]", was?.feedback || "", was ? "done" : "pending", was ? 1 : 0, now, env.account_id, id));
  }
  const gone = L.scenes.filter((c) => !nextIds.has(c.sid));
  for (const c of gone) stmts.push(env.DB.prepare("DELETE FROM scenes WHERE account_id=? AND story_id=? AND sid=?").bind(env.account_id, id, c.sid));
  const drop = gone.filter((c) => !carried.has(c.sid)).flatMap((c) => [c.image_key, ...JSON.parse(c.versions || "[]").map((v) => v.key)]).filter(Boolean);
  if (stmts.length) await env.DB.batch(stmts);
  if (drop.length) await env.MEDIA.delete(drop);
  await enqueuePaint(env, id);
  return json({ applied: true, ms, fallback: splitFallback || planFallback, ...(await storyJson(env, id)) });
}

function settledParas(text, n) { return String(text || "").split(/\n{2,}/).slice(0, n || 0); }

const LONG_PARA = 650; // characters; a kid's paragraph longer than this gets split for the book
const MAX_PARA = 900;  // no paragraph in the book is longer than this (a page must fit a book spread)
const MAX_PAGE = 1400; // a planned page longer than this is split at its paragraphs

// Paragraphs already laid out (`done`) are never split again, so their pages and pictures stay put.
async function splitParagraphs(env, settled, done = new Set()) {
  const given = settled.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  const long = given.map((t, i) => ({ t, i })).filter((x) => x.t.length > LONG_PARA && !done.has(x.t));
  if (!long.length) return { paras: boundedParagraphs(given), splitMs: 0, splitFallback: false };
  const t0 = Date.now();
  const r = await chatCompletion(env, { model: env.TEXT_MODEL || "gpt-4.1-mini", max_tokens: 6000, messages: [{ role: "user", content:
    `A child's story (from speech-to-text) needs paragraph breaks for a printed book. For each numbered passage below, list where NEW paragraphs should start (a new moment, place, speaker or time jump; about 2–5 sentences per paragraph). Quote the EXACT first 4–8 words of each sentence that should start a new paragraph, copied character for character from the passage. Don't quote the passage's first sentence. Don't change or fix anything.\nReply ONLY with JSON: {"breaks": {"<number>": ["exact first words", "..."]}}\n\n` +
    long.map((x) => `[${x.i}] ${x.t}`).join("\n\n") }] });
  const plan = parseJson(r.text);
  let fallback = !plan?.breaks;
  const paras = [];
  for (const [i, t] of given.entries()) {
    if (t.length <= LONG_PARA || done.has(t)) { paras.push(t); continue; }
    const quotes = plan?.breaks?.[i] || plan?.breaks?.[String(i)] || [];
    const cuts = [];
    let from = 1;
    for (const q of quotes) {
      const at = findQuote(t, q, from);
      if (at > 0) { cuts.push(at); from = at + 1; }
    }
    if (!cuts.length) { fallback = true; cuts.push(...sentenceCuts(t)); }
    let last = 0;
    for (const c of [...cuts, t.length]) {
      const piece = t.slice(last, c).trim(); last = c;
      if (!piece) continue;
      if (piece.length <= MAX_PARA) { paras.push(piece); continue; }
      // The model's breaks left a piece too long for a book page: cut it at sentence ends as well.
      let from = 0;
      for (const sc of [...sentenceCuts(piece), piece.length]) { const q = piece.slice(from, sc).trim(); if (q) paras.push(q); from = sc; }
    }
  }
  return { paras: boundedParagraphs(paras), splitMs: Date.now() - t0, splitFallback: fallback };
}

// Deterministic last guard: even a run-on paragraph with no sentence stops must fit.
function boundedParagraphs(paras) {
  const out = [];
  for (let paragraph of paras) {
    while (paragraph.length > MAX_PARA) {
      const matches = [...paragraph.slice(0, MAX_PARA + 1).matchAll(/\s+/g)];
      const at = matches.at(-1)?.index;
      if (!at) throw Object.assign(new Error("A single word is too long to fit on a page."), { status: 413 });
      out.push(paragraph.slice(0, at).trim()); paragraph = paragraph.slice(at).trim();
    }
    if (paragraph) out.push(paragraph);
  }
  return out;
}

// Where a quoted sentence start begins in the kid's text: same words in order, ignoring case, punctuation and
// quote styles (models straighten curly quotes), at a word boundary after `from`.
function findQuote(t, q, from) {
  const words = String(q || "").match(/[A-Za-z0-9']+/g);
  if (!words || words.length < 2) return -1;
  const re = new RegExp("(^|[\\s\"“”‘’'(])(" + words.slice(0, 6).map((w) => w.replace(/'/g, "['’]")).join("[^A-Za-z0-9]+") + ")", "ig");
  re.lastIndex = from;
  const m = re.exec(t);
  if (!m) return -1;
  return /^\s*$/.test(m[1]) ? m.index + m[1].length : m.index; // an opening quote or bracket starts the new paragraph
}

// Every ~3 sentences: only when the model gave no usable breaks.
function sentenceCuts(t) {
  const ends = [...t.matchAll(/[.!?…]["”'’)]*\s+(?=\S)/g)].map((m) => m.index + m[0].length);
  return ends.filter((_, k) => (k + 1) % 3 === 0 && k + 1 < ends.length);
}

function validScenes(sc, start, n) {
  if (!Array.isArray(sc) || !sc.length) return null;
  let next = start;
  for (const x of sc) { if (!Number.isInteger(x.from) || !Number.isInteger(x.to) || x.from !== next || !(x.to >= x.from) || x.to >= n) return null; next = x.to + 1; }
  return next === n ? sc : null;
}

// Pages of ~2 paragraphs, when the planner fails.
function naiveScenes(paras, start, bible) {
  const names = (bible?.characters || []).map((c) => c.name);
  const out = [];
  for (let i = start; i < paras.length; i += 2) {
    const to = Math.min(i + 1, paras.length - 1), t = paras.slice(i, to + 1).join(" ");
    out.push({ from: i, to, present: names.filter((nm) => t.toLowerCase().includes(nm.toLowerCase())), image_prompt: t.slice(0, 600) });
  }
  return out;
}

// Existing characters never change (least of all ones drawn from a kid's drawing); new ones are appended.
function mergeBible(old, add) {
  const chars = [...(old?.characters || [])];
  for (const c of add?.characters || []) if (c?.name && !chars.some((x) => x.name.toLowerCase() === String(c.name).toLowerCase())) chars.push({ name: clean(c.name, 60), look: clean(c.look || "", 600) });
  return { style: old?.style || clean(add?.style || "", 300), characters: chars };
}

async function storyJson(env, id) { return (await getStory(env, id)).json(); }

async function updateScene(req, env, id, sid) {
  const b = await req.json().catch(() => ({}));
  const c = await env.DB.prepare("SELECT * FROM scenes WHERE account_id=? AND story_id=? AND sid=?").bind(env.account_id, id, sid).first();
  if (!c) return json({ error: "not found" }, 404);
  await env.DB.prepare("UPDATE scenes SET feedback=?, refs=?, updated=? WHERE account_id=? AND story_id=? AND sid=?")
    .bind(b.feedback ?? c.feedback, JSON.stringify(okRefs(b.refs ?? JSON.parse(c.refs))), Date.now(), env.account_id, id, sid).run();
  return json(sceneOut(await env.DB.prepare("SELECT * FROM scenes WHERE account_id=? AND story_id=? AND sid=?").bind(env.account_id, id, sid).first()));
}

// On request only ("fix my punctuation"): suggestions the kid accepts one by one. Each must change only
// punctuation, capital letters or spacing; anything else is dropped by the server.
async function punctuation(req, env, id) {
  const b = await req.json().catch(() => ({}));
  const L = await loadStory(env, id);
  if (!L) return json({ error: "not found" }, 404);
  const paras = String(L.s.text).split(/\n{2,}/);
  const pick = Number.isInteger(b.para) ? [b.para] : paras.map((_, i) => i);
  const body = pick.filter((i) => paras[i]).map((i) => `[${i}] ${paras[i]}`).join("\n\n");
  if (!body) return json({ suggestions: [] });
  const t0 = Date.now();
  const r = await chatCompletion(env, { model: env.TEXT_MODEL || "gpt-4.1-mini", max_tokens: 3000, messages: [{ role: "user", content:
    `A child (6–12) wrote this story by talking. Suggest punctuation and capital-letter fixes ONLY (full stops, commas, question marks, quotation marks around speech, apostrophes, capitals at sentence starts and names). Never change, add, remove or reorder a word. Each suggestion quotes a short exact snippet from one paragraph ("find", 2–8 words) and the same snippet fixed ("replace"), plus a one-line kid-friendly reason ("why"). At most 12 suggestions, most useful first.\nReply ONLY with JSON: {"suggestions":[{"para":0,"find":"...","replace":"...","why":"..."}]}\n\n${body}` }] });
  const plan = parseJson(r.text) || {};
  const letters = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const ok = (plan.suggestions || []).filter((x) => Number.isInteger(x.para) && paras[x.para] && x.find && x.replace
    && x.find !== x.replace && paras[x.para].includes(x.find) && letters(x.find) === letters(x.replace)).slice(0, 12);
  await log(env, "punctuation", id, true, Date.now() - t0, ok.length, "suggestions", 0, { offered: (plan.suggestions || []).length });
  return json({ suggestions: ok.map((x) => ({ para: x.para, find: x.find, replace: x.replace, why: clean(x.why || "", 140) })), ms: Date.now() - t0 });
}

// ---------- pictures (process: bench/images/skills/book-pictures.md, bake-off 2026-11-02) ----------
// One portrait per character; each page gets ONLY the portraits of who is in it. History: passing a finished
// page copied its composition onto every page; one group sheet put every character on every page; a global
// "World:" line put the bedroom on the moon (bake-off P5), so it's gone.
const HOUSE_STYLE = "Classic modern picture-book illustration: transparent watercolour and coloured pencil on textured cold-press paper, visible pencil linework under loose washes, natural proportions (not big-headed or chibi), a restrained palette with a few strong accents, soft natural light, generous calm space; painterly and handmade, like an award-winning picture book for 6–12 year olds, never glossy, never 3D, no cartoon shine.";
const styleLine = (bible) => `Style: ${HOUSE_STYLE}${bible.style ? ` Mood and palette for this book: ${bible.style}` : ""}`;
const castMap = (s) => { try { return JSON.parse(s.cast_key || "{}") || {}; } catch { return {}; } };
const castOut = (s) => Object.entries(castMap(s)).map(([name, k]) => ({ name, url: mediaUrl(k) }));

function inScene(bible, c) {
  const names = JSON.parse(c.present || "[]").map((n) => String(n).toLowerCase());
  return (bible.characters || []).filter((x) => names.includes(String(x.name).toLowerCase()));
}

// OpenAI Images shape: generations without references, multipart edits with them.
async function drawImage(env, prompt, refs, size = "1536x1024") {
  const quality = env.IMAGE_QUALITY || "medium";
  const t0 = Date.now();
  let res;
  if (refs.length) {
    const fd = new FormData();
    fd.append("model", env.IMAGE_MODEL || "gpt-image-2.5-sunburst"); fd.append("prompt", prompt); fd.append("size", size); fd.append("quality", quality);
    for (const [k, r] of refs.entries())
      fd.append("image[]", new Blob([r.bytes || await r.o.arrayBuffer()], { type: r.o?.httpMetadata?.contentType || "image/png" }), `${r.name}-${k}.png`);
    res = await providerFetch(env, "/images/edits", { method: "POST", body: fd });
  } else {
    res = await providerFetch(env, "/images/generations", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: env.IMAGE_MODEL || "gpt-image-2.5-sunburst", prompt, size, quality }) });
  }
  const d = await res.json().catch(() => ({}));
  const b64img = d?.data?.[0]?.b64_json;
  return { ok: res.ok && !!b64img, bytes: b64img ? unb64(b64img) : null, ms: Date.now() - t0, status: res.status,
    quality_asked: quality, quality_got: d.quality, tokens: d.usage?.total_tokens,
    err: b64img ? null : (d?.error?.message || JSON.stringify(d)).slice(0, 300) };
}
// Read R2 objects once into bytes, so the same picture can go to the painter and the art director.
const load = async (env, key, name) => { const o = key ? await env.MEDIA.get(key) : null; return o ? { o, name, bytes: await o.arrayBuffer() } : null; };
const getRefs = async (env, urls, name) => (await Promise.all(urls.slice(0, 4).map((u) => load(env, u.slice(7), name)))).filter(Boolean);
const okRefs = (list) => (list || []).filter((u) => typeof u === "string" && u.startsWith("/media/ref/"));
const dataUrl = (r) => `data:${r.o?.httpMetadata?.contentType || "image/png"};base64,${b64(r.bytes)}`;

// OpenAI-compatible vision messages. Some models count reasoning against max_tokens too.
async function visionJson(env, text, images, maxTokens = 3000) {
  const r = await chatCompletion(env, { model: env.VISION_MODEL || env.TEXT_MODEL || "gpt-4.1-mini", max_tokens: maxTokens, messages: [{ role: "user", content: [
    { type: "text", text }, ...images.map((im) => ({ type: "image_url", image_url: { url: im } })) ] }] });
  return parseJson(r.text);
}

// POST /cast {missing?:true | name?, refs?, feedback?}
//  - missing: portraits for characters that don't have one yet (new characters show up as the book forms).
//  - name + refs (a kid's drawing): "that's my Biscuit". Claude reads the drawing's design choices into the
//    bible look, then the portrait translates the drawing into the book's style (bake-off P4a: keeps the bow
//    tie, teeth and ears on every later page; pasting the drawing into a page did not).
async function castPortraits(req, env, id) { return castCore(env, id, await req.json().catch(() => ({}))); }
async function castCore(env, id, b) {
  const L = await loadStory(env, id);
  if (!L?.s.bible) return json({ error: "the book needs a few sentences first" }, 400);
  const bible = JSON.parse(L.s.bible);
  const have = castMap(L.s);
  // One portrait run per story at a time: three overlapping {missing:true} calls drew 15 portraits for 5 (2026-11-02).
  if (b.missing) {
    const lock = await env.DB.prepare("UPDATE stories SET cast_lock=? WHERE account_id=? AND id=? AND (cast_lock IS NULL OR cast_lock < ?)")
      .bind(Date.now(), env.account_id, id, Date.now() - 90000).run();
    if (!lock.meta.changes) {
      for (let i = 0; i < 45; i++) { // wait for the run in progress, then answer with its result
        await new Promise((r) => setTimeout(r, 2000));
        const row = await env.DB.prepare("SELECT cast_key, cast_lock FROM stories WHERE account_id=? AND id=?").bind(env.account_id, id).first();
        if (!row.cast_lock) return json({ cast: castOut(row), failed: [], ms: 0, waited: true });
      }
      return json({ cast: castOut(L.s), failed: [], ms: 0, busy: true });
    }
  }
  const who = (bible.characters || []).filter((x) => (!b.name || x.name.toLowerCase() === String(b.name).toLowerCase()) && (!b.missing || !have[x.name])).slice(0, 6);
  if (!who.length) {
    if (b.missing) await env.DB.prepare("UPDATE stories SET cast_lock=NULL WHERE account_id=? AND id=?").bind(env.account_id, id).run();
    return json(b.missing ? { cast: castOut(L.s), failed: [], ms: 0 } : { error: "no such character" }, b.missing ? 200 : 404);
  }
  const drawing = b.name ? (await getRefs(env, okRefs(b.refs), "kid-drawing"))[0] : null;
  const t0 = Date.now();
  let kidlook = "";
  if (drawing) {
    const x = who[0];
    const r = await visionJson(env, `Look at this child's drawing of ${x.name}, a character in their story. List the design choices a child would care about (colours, clothes, accessories, face details, body shape) as one short comma-separated phrase. Then write a replacement one-sentence visual description of ${x.name} for an illustrator that keeps those choices; where the drawing is silent, keep the old description: "${x.look}". Answer ONLY JSON: {"kidlook": "...", "look": "..."}`, [dataUrl(drawing)], 2000);
    if (r?.look) { kidlook = clean(r.kidlook || "", 300); x.look = clean(r.look, 600); x.from_drawing = true; }
  }
  const drawn = await Promise.all(who.map((x) => drawImage(env, drawing ? [
    `Character portrait for a children's picture book. ${styleLine(bible)}`,
    `The reference image is a child's own drawing of ${x.name}. Turn it into a finished book illustration of the same character: keep every design choice the child made (${kidlook || x.look}), and the shape, proportions and personality of their drawing, but paint it in the book's style, not as crayon on paper.`,
    b.feedback ? `The child also said: "${String(b.feedback).slice(0, 300)}".` : "",
    "Full body, friendly expression, evenly lit, alone on a plain cream background, no scenery, no paper texture or table.",
    "No words, names, labels or letters anywhere.",
  ].filter(Boolean).join("\n") : [
    `Character portrait for a children's picture book. ${styleLine(bible)}`,
    `${x.name}: ${x.look}. Full body, friendly expression, evenly lit, alone on a plain cream background, no scenery.`,
    b.feedback ? `The child's feedback: "${String(b.feedback).slice(0, 300)}".` : "",
    "No words, names, labels or letters anywhere.",
  ].filter(Boolean).join("\n"), drawing ? [drawing] : [], "1024x1024")));
  const map = castMap(L.s);
  for (const [k, x] of who.entries()) {
    if (!drawn[k].ok) continue;
    const key = `img/${id}/cast-${slug(x.name)}-${Date.now()}.png`;
    await env.MEDIA.put(key, drawn[k].bytes, { httpMetadata: { contentType: "image/png" } });
    map[x.name] = key; // old portraits stay in R2 until the story is deleted
  }
  await env.DB.prepare("UPDATE stories SET cast_key=?, bible=?, cast_lock=NULL WHERE account_id=? AND id=?").bind(JSON.stringify(map), JSON.stringify(bible), env.account_id, id).run();
  const failed = who.filter((_, k) => !drawn[k].ok).map((x) => x.name);
  await log(env, "cast", id, !failed.length, Date.now() - t0, who.length, "images", 0,
    { each_ms: drawn.map((d) => d.ms), failed, from_drawing: !!drawing, err: drawn.find((d) => !d.ok)?.err });
  if (failed.length === who.length) return json({ error: "the character pictures didn't work, try again", detail: drawn[0].err }, 502);
  // After a drawing, the app asks the kid: "Draw Biscuit like this on the other pages too?" (pages that show them).
  const pagesWith = drawing ? L.scenes.filter((c) => c.image_key && JSON.parse(c.present || "[]").some((n) => n.toLowerCase() === who[0].name.toLowerCase())).map((c) => c.sid) : [];
  return json({ cast: castOut({ cast_key: JSON.stringify(map) }), failed, ms: Date.now() - t0, pages_with: pagesWith });
}

// The art director (bake-off P3: caught 3 of 14 pages, no false alarms, ~11 s). Runs only on pages the app
// draws by itself, before the kid sees them. Kill criterion: < 1 major flag in 20 pages over ~10 real stories.
async function artDirector(env, page, portraits, present, absent, c) {
  const t0 = Date.now();
  const r = await visionJson(env, `You are the art director for a children's picture book (readers 6–12). Check ONE finished page illustration against what it must show. The FIRST image is the page. The following images are the official character portraits, in this order: ${portraits.map((p) => p.who).join(", ") || "(none)"}.

Scene text (the child's words): "${c.text.slice(0, 1500)}"
What the picture should show: ${c.image_prompt}
Characters who must appear, and nobody else from the cast: ${present.join(", ") || "nobody"}
Other cast members who must NOT appear on this page: ${absent.join(", ") || "none"}

Report only real problems a parent or child would notice. Check:
1. missing: a required character isn't in the picture
2. extra: a cast member who should be absent appears, or a duplicate of a character
3. off_model: a character clearly doesn't match their portrait (species, main colours, signature clothing/detail)
4. text: any letters, words, numbers or speech bubbles in the image (tiny unreadable squiggles don't count)
5. story: the picture doesn't show the key moment of the scene text
6. safety: anything scary, violent or not kid-friendly
7. craft: a broken anatomy or a glaring rendering error (extra limbs, melted faces)

Answer ONLY JSON:
{"redraw": true|false, "issues": [{"type": "missing|extra|off_model|text|story|safety|craft", "severity": "minor|major", "detail": "..."}], "fix": "one or two imperative sentences for the illustrator, or empty"}
Set redraw true only when at least one issue is major.`, [dataUrl(page), ...portraits.map(dataUrl)]);
  return { ...(r || { redraw: false, issues: [], fix: "" }), ms: Date.now() - t0, ok: !!r };
}

// POST .../scenes/:sid/image. First pictures are painted by the server queue (see `queue` below); a call
// without the kid's input for a page that's queued, painting or already painted just reports that.
// The kid's own requests (feedback, references, "update the picture") paint right away, while they wait.
async function sceneImage(req, env, id, sid) {
  const b = await req.json().catch(() => ({}));
  const kidAsked = !!(String(b.feedback || "").trim() || (b.refs || []).length);
  if (!kidAsked) {
    const c = await env.DB.prepare("SELECT * FROM scenes WHERE account_id=? AND story_id=? AND sid=?").bind(env.account_id, id, sid).first();
    if (!c) return json({ error: "page not found" }, 404);
    const o = sceneOut(c);
    if (o.status === "queued" || o.status === "generating") return json({ ...o, painting: true }, 202);
    if (o.image_url && !o.stale) return json({ ...o, already: true });
    if (!o.image_url) { await enqueuePaint(env, id); return json({ ...o, status: "generating", painting: true }, 202); } // the queue paints first pictures
  }
  return paintPage(env, id, sid, b);
}

// One page (~45–80 s, plus ~11 s art check), everyone on it already has a portrait.
// Every picture is a new version; nothing is overwritten, and the kid can go back (POST .../version).
async function paintPage(env, id, sid, b) {
  const L = await loadStory(env, id);
  const c = L?.scenes.find((x) => x.sid === sid);
  if (!c) return json({ error: "page not found" }, 404);
  const feedback = String(b.feedback ?? "").slice(0, 500);
  const refs = okRefs(b.refs ?? []);
  await env.DB.prepare("UPDATE scenes SET status='generating', feedback=?, refs=?, error=NULL, updated=? WHERE account_id=? AND story_id=? AND sid=?")
    .bind(feedback, JSON.stringify(refs), Date.now(), env.account_id, id, sid).run();

  const bible = L.s.bible ? JSON.parse(L.s.bible) : {};
  const present = inScene(bible, c), map = castMap(L.s);
  const portraits = (await Promise.all(present.map((x) => load(env, map[x.name], `portrait-${slug(x.name)}`))))
    .map((r, k) => r && { ...r, who: present[k].name }).filter(Boolean);
  const prev = c.image_key && (feedback || c.stale || refs.length) ? await load(env, c.image_key, "previous") : null;
  const kidRefs = await getRefs(env, refs, "kid-ref");
  const how = prev ? (feedback || refs.length ? "feedback" : "text-changed") : "first";

  const prompt = (fix) => [
    `Children's picture-book illustration. ${styleLine(bible)}`,
    present.length ? `Characters in this picture (and nobody else): ${present.map((x) => `${x.name}: ${x.look}`).join("; ")}.`
      : "No characters in this picture, just the place.",
    `Scene: ${c.image_prompt || c.text}`,
    portraits.length ? `Reference portraits show exactly how ${present.map((x) => x.name).join(" and ")} look: match their faces, colors and clothes, but draw them in a full new scene, not on a plain background.` : "",
    kidRefs.length ? "The child gave reference pictures: use them for how those things should look." : "",
    prev ? (how === "text-changed" ? "One reference image is this page's previous picture; the story text changed, so update it to match the new text, keeping what still fits."
      : "One reference image is the previous version of THIS page: keep what works and apply the feedback.") : "",
    feedback ? `The child's feedback for this picture: "${feedback}". Follow it.` : "",
    fix ? `An art director checked an earlier attempt at this page and asked for these fixes: ${fix}` : "",
    "No words, letters or speech bubbles in the picture. Friendly and safe for young kids. Landscape composition.",
  ].filter(Boolean).join("\n");
  const refsFor = [...kidRefs, ...portraits, ...(prev ? [prev] : [])];

  let d = await drawImage(env, prompt(""), refsFor), check = null;
  // The kid's own requests show the result as-is; pages the app drew by itself get the art director first.
  if (d.ok && how === "first" && env.ART_DIRECTOR !== "off") {
    const cast = (bible.characters || []).map((x) => x.name);
    check = await artDirector(env, { bytes: d.bytes }, portraits, present.map((x) => x.name), cast.filter((n) => !present.some((x) => x.name === n)), c);
    if (check.redraw) { const d2 = await drawImage(env, prompt(check.fix), refsFor); if (d2.ok) d = { ...d2, ms: d.ms + check.ms + d2.ms }; }
  }
  if (!d.ok) {
    await env.DB.prepare("UPDATE scenes SET status=?, error=?, updated=? WHERE account_id=? AND story_id=? AND sid=?")
      .bind(c.image_key ? "done" : "error", d.err, Date.now(), env.account_id, id, sid).run();
    await log(env, "image", id, false, d.ms, 1, "images", 0, { sid, status: d.status, err: d.err });
    return json({ error: "the picture didn't work, try again", detail: d.err }, 502);
  }
  const key = `img/${id}/${sid}-${Date.now()}.png`;
  await env.MEDIA.put(key, d.bytes, { httpMetadata: { contentType: "image/png" } });
  const versions = [...JSON.parse(c.versions || "[]"), { key, how: check?.redraw ? "check-fix" : how, feedback, at: Date.now() }];
  await env.DB.prepare("UPDATE scenes SET status='done', stale=0, image_key=?, versions=?, updated=? WHERE account_id=? AND story_id=? AND sid=?")
    .bind(key, JSON.stringify(versions), Date.now(), env.account_id, id, sid).run();
  await log(env, "image", id, true, d.ms, 1, "images", 0, { sid, how, present: present.map((x) => x.name), refs: refsFor.length,
    check: check && { redraw: !!check.redraw, ms: check.ms, issues: (check.issues || []).map((i) => `${i.severity}:${i.type}`) },
    quality_asked: d.quality_asked, quality_got: d.quality_got });
  return json({ image_url: mediaUrl(key), ms: d.ms, quality: d.quality_got, present: present.map((x) => x.name),
    versions: versions.map((v) => ({ url: mediaUrl(v.key), how: v.how, at: v.at })), check: check && { redraw: !!check.redraw, issues: check.issues || [] } });
}

// POST .../scenes/:sid/version {url}: go back to an earlier picture (moves the pointer, deletes nothing).
async function pickVersion(req, env, id, sid) {
  const { url } = await req.json().catch(() => ({}));
  const c = await env.DB.prepare("SELECT * FROM scenes WHERE account_id=? AND story_id=? AND sid=?").bind(env.account_id, id, sid).first();
  if (!c) return json({ error: "page not found" }, 404);
  const v = JSON.parse(c.versions || "[]").find((x) => mediaUrl(x.key) === url);
  if (!v) return json({ error: "no such version" }, 404);
  await env.DB.prepare("UPDATE scenes SET image_key=?, updated=? WHERE account_id=? AND story_id=? AND sid=?").bind(v.key, Date.now(), env.account_id, id, sid).run();
  return json(sceneOut({ ...c, image_key: v.key }));
}

async function upload(req, env, url) {
  const type = (req.headers.get("content-type") || "").split(";")[0];
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(type)) return json({ error: "pictures only (png, jpg, webp, gif)" }, 415);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > 15e6) return json({ error: "picture too big" }, 413);
  const storyId = url.searchParams.get("story");
  if (storyId && !await loadStory(env, storyId)) return json({ error: "not found" }, 404);
  const key = `ref/${(url.searchParams.get("story") || "loose").replace(/[^\w-]/g, "")}/${Date.now()}-${rid()}.${ext(type)}`;
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: type } });
  return json({ url: mediaUrl(key) });
}

// ---------- the little chat bar ----------
async function chat(req, env, ctx) {
  const b = await req.json().catch(() => ({}));
  const L = await loadStory(env, b.story_id);
  const model = env.TEXT_MODEL || "gpt-4.1-mini";
  // Rules from Alan (2026-11-02): help only when asked; give narrative feedback and examples; the child
  // drives the writing and the helper never rewrites their story.
  const sys = `You are the Story Editor inside a story-writing app used by young writers (ages about 6–12). They
write by talking or typing, and their draft turns into a real illustrated book as they go.
You only respond to what they ask. Be warm, honest and brief (2–4 sentences), like a good writing teacher,
never babyish. You can: give feedback on the story (what works, one or two things to try), answer questions
about writing, explain ideas (describing words, dialogue, a good ending), and give a SHORT example sentence
when asked, always clearly labelled as an example ("For example: ...") so they write their own version.
Never rewrite their story or write the next part for them, even if asked; offer a starting idea or a
question instead and hand the pen back. Don't fix spelling. Punctuation fixes have their own button
("Fix my punctuation"). Keep everything kind and age-appropriate.`
    + (L ? `\n\nTheir current story "${L.s.title}" by ${L.s.author}:\n${L.s.text.slice(0, 6000)}`
      + (L.scenes.length ? `\nScenes: ${L.scenes.map((c) => `${c.i + 1}. ${c.text.slice(0, 120)}`).join(" | ")}` : "") : "");
  const msgs = (b.messages || []).slice(-16).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 4000) }));
  const t0 = Date.now();
  const res = await providerFetch(env, "/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
        // max_tokens includes hidden thinking: at 400, Sonnet 5.5 sometimes spent it all and said nothing (2026-11-02).
    body: JSON.stringify({ model, max_tokens: 1500, stream: true, stream_options: { include_usage: true }, messages: [{ role: "system", content: sys }, ...msgs] }) });
  if (!res.ok || !res.body) return json({ error: "the helper is napping", detail: (await res.text()).slice(0, 200) }, 502);
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(), enc = new TextEncoder(), dec = new TextDecoder();
  env.streaming = true;
  const pump = (async () => {
    let buf = "", first = 0, chars = 0, usage;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const event = parseJson(line.slice(5).trim());
          if (event?.usage) usage = event.usage;
          const t = event?.choices?.[0]?.delta?.content;
          if (t) { if (!first) first = Date.now() - t0; chars += t.length; await w.write(enc.encode(`data: ${JSON.stringify({ t })}\n\n`)); }
        }
      }
      await settleText(res, usage, chars);
    } catch (e) { await failText(res); } finally {
      await finish(env);
      await w.write(enc.encode("data: [DONE]\n\n")).catch(() => {}); await w.close().catch(() => {});
      await log(env, "chat", b.story_id || null, chars > 0, Date.now() - t0, chars, "chars_out", 0, { first_token_ms: first, model });
    }
  })();
  ctx.waitUntil(pump); // keep the relay (and its usage log) alive however long the answer takes
  return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

// ---------- benchmark readout (production numbers) ----------
async function bench(env, url) {
  const days = Number(url.searchParams.get("days") || 30);
  const { results } = await env.DB.prepare(`SELECT kind, COUNT(*) n, SUM(ok) ok, ROUND(AVG(CASE WHEN ok=1 THEN ms END)) avg_ms,
    MIN(ms) min_ms, MAX(ms) max_ms, ROUND(SUM(units),1) units, MAX(unit) unit, ROUND(SUM(cost_usd),4) usd
    FROM events WHERE account_id=? AND at > ? GROUP BY kind ORDER BY kind`).bind(env.account_id, Date.now() - days * DAY * 1000).all();
  return json(results);
}

// ---------- pictures paint on the server, not in the browser (Alan, 2026-11-02: "deeper fixes beat shallower ones") ----------
// The browser used to fire every picture request itself, so a closed tab left pages stuck on "painting" and two
// tabs drew every portrait twice. Now /book enqueues the story; the consumer draws missing portraits (one run per
// story, cast_lock), then fans out one message per page. Pages paint even if the iPad sleeps. The UI just polls.
async function enqueuePaint(env, id) {
  if (!env.PAINT) return;
  const { results } = await env.DB.prepare("SELECT sid FROM scenes WHERE account_id=? AND story_id=? AND image_key IS NULL AND status IN ('pending','error')").bind(env.account_id, id).all();
  if (results.length) await env.PAINT.send({ kind: "story", story_id: id, account_id: env.account_id });
}

async function paintStory(env, id) {
  const cast = await castCore(env, id, { missing: true });
  if (cast.status >= 400 && cast.status !== 404) throw new Error(`portraits ${cast.status}`);
  const { results } = await env.DB.prepare("SELECT sid, updated, status FROM scenes WHERE account_id=? AND story_id=? AND image_key IS NULL").bind(env.account_id, id).all();
  const todo = results.filter((c) => c.status === "pending" || c.status === "error"
    || (c.status === "queued" && Date.now() - c.updated > 900000) || (c.status === "generating" && Date.now() - c.updated > 150000));
  if (!todo.length) return;
  const now = Date.now();
  await env.DB.batch(todo.map((c) => env.DB.prepare("UPDATE scenes SET status='queued', updated=? WHERE account_id=? AND story_id=? AND sid=?").bind(now, env.account_id, id, c.sid)));
  for (let i = 0; i < todo.length; i += 100) await env.PAINT.sendBatch(todo.slice(i, i + 100).map((c) => ({ body: { kind: "page", story_id: id, sid: c.sid, account_id: env.account_id } })));
}

async function paintQueued(env, id, sid) {
  const c = await env.DB.prepare("SELECT image_key, stale, status FROM scenes WHERE account_id=? AND story_id=? AND sid=?").bind(env.account_id, id, sid).first();
  if (!c || (c.image_key && !c.stale)) return; // gone, or painted meanwhile
  const r = await paintPage(env, id, sid, {});
  if (r.status >= 500) throw new Error(`page ${r.status}`); // the queue retries (max_retries in wrangler.toml)
}

// ---------- grown-ups analytics (Alan, 2026-11-02: "what analytics can we use") ----------
// First-party only: built from the stories, pages and the event log above; nothing leaves Cloudflare.
// GET /api/stats?days=30&demo=1 (Demo = test stories, hidden unless asked).
async function stats(env, url) {
  const days = Math.min(365, Number(url.searchParams.get("days") || 30));
  const since = Date.now() - days * DAY * 1000;
  const demo = url.searchParams.get("demo") === "1";
  const keep = (a) => demo || a !== "Demo";
  const [st, sc, ev] = await Promise.all([
    env.DB.prepare("SELECT id, author, title, text, created, updated FROM stories WHERE account_id=?").bind(env.account_id).all(),
    env.DB.prepare("SELECT story_id, status, stale, image_key, versions FROM scenes WHERE account_id=?").bind(env.account_id).all(),
    env.DB.prepare("SELECT e.kind, e.story_id, e.ok, e.ms, e.units, e.cost_usd, e.meta, e.at, s.author FROM events e LEFT JOIN stories s ON s.id = e.story_id AND s.account_id = e.account_id WHERE e.account_id=? AND e.at > ?").bind(env.account_id, since).all(),
  ]);
  const stories = st.results.filter((x) => keep(x.author));
  const pages = {};
  for (const c of sc.results) {
    const p = (pages[c.story_id] ||= { pages: 0, pictures: 0, redraws: 0, stale: 0 });
    p.pages++; if (c.image_key) p.pictures++; if (c.stale) p.stale++;
    p.redraws += Math.max(0, JSON.parse(c.versions || "[]").length - 1);
  }
  const events = ev.results.filter((e) => !e.author || keep(e.author));
  const per = {};
  for (const e of events) if (e.story_id) {
    const x = (per[e.story_id] ||= { readings: 0, replays: 0, usd: 0, recordings: 0, talk_s: 0, help: 0 });
    if (e.kind === "tts" && e.ok) { x.readings++; x.usd += e.cost_usd || 0; }
    if (e.kind === "play") x.replays++;
    if (e.kind === "stt" && e.ok) { x.recordings++; x.talk_s += e.units || 0; }
    if (e.kind === "chat" || e.kind === "punctuation") x.help++;
  }
  const list = stories.map((x) => ({ id: x.id, author: x.author, title: x.title || "Untitled story", words: wc(x.text),
    created: x.created, updated: x.updated, ...(pages[x.id] || { pages: 0, pictures: 0, redraws: 0, stale: 0 }),
    ...(per[x.id] || { readings: 0, replays: 0, usd: 0, recordings: 0, talk_s: 0, help: 0 }) }))
    .sort((a, z) => z.updated - a.updated);
  const kids = {};
  for (const x of list) {
    const k = (kids[x.author] ||= { author: x.author, stories: 0, active: 0, words: 0, pages: 0, pictures: 0, readings: 0, talk_min: 0, usd: 0, last: 0 });
    k.stories++; if (x.updated > since) k.active++; k.words += x.words; k.pages += x.pages; k.pictures += x.pictures;
    k.readings += x.readings; k.talk_min += x.talk_s / 60; k.usd += x.usd; k.last = Math.max(k.last, x.updated);
  }
  const q = (arr, f) => { if (!arr.length) return null; const a = [...arr].sort((m, n) => m - n); return a[Math.min(a.length - 1, Math.floor(f * a.length))]; };
  const speed = {};
  for (const e of events) { const k = (speed[e.kind] ||= { kind: e.kind, n: 0, fails: 0, ms: [] }); k.n++; if (!e.ok) k.fails++; else if (e.ms) k.ms.push(e.ms); }
  const speedOut = Object.values(speed).map((k) => ({ kind: k.kind, n: k.n, fails: k.fails, p50_ms: q(k.ms, 0.5), p90_ms: q(k.ms, 0.9) })).sort((a, z) => z.n - a.n);
  const checks = events.filter((e) => e.kind === "image" && e.ok).map((e) => JSON.parse(e.meta || "{}").check).filter(Boolean);
  const issues = {};
  for (const c of checks) for (const i of c.issues || []) issues[i] = (issues[i] || 0) + 1;
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const elevenMonth = events.filter((e) => e.kind === "tts" && e.ok && e.at >= monthStart.getTime()).reduce((t, e) => t + (e.cost_usd || 0), 0);
  const failures = events.filter((e) => !e.ok).sort((a, z) => z.at - a.at).slice(0, 25)
    .map((e) => ({ at: e.at, kind: e.kind, story_id: e.story_id, author: e.author, err: (() => { const m = JSON.parse(e.meta || "{}"); return String(m.err || m.status || "").slice(0, 200); })() }));
  return json({ days, demo, kids: Object.values(kids).map((k) => ({ ...k, talk_min: +k.talk_min.toFixed(1), usd: +k.usd.toFixed(4) })),
    stories: list.slice(0, 60).map((x) => ({ ...x, usd: +x.usd.toFixed(4), talk_s: Math.round(x.talk_s) })),
    speed: speedOut, art_director: { pages_checked: checks.length, redrawn: checks.filter((c) => c.redraw).length, issues },
    cost: { elevenlabs_month_usd: +elevenMonth.toFixed(4), elevenlabs_period_usd: +events.filter((e) => e.kind === "tts" && e.ok).reduce((t, e) => t + (e.cost_usd || 0), 0).toFixed(4), monthly_cap_usd: null },
    failures });
}

// ---------- utils ----------
const THUMB_WIDTHS = [480, 960, 1600];
// Coalesce simultaneous cold requests in this isolate; R2 persists the result across isolates/versions.
const thumbnailJobs = new Map();
async function media(key, req, env) {
  const width = new URL(req.url).searchParams.get("w");
  const thumbnail = req.method === "GET" && THUMB_WIDTHS.some((w) => String(w) === width) && /^(img|ref)\//.test(key);
  let cache;
  let o;
  if (thumbnail) {
    const thumbKey = `thumb/${width}/${key}.webp`;
    o = await env.MEDIA.get(thumbKey, { range: req.headers });
    cache = o ? "HIT" : "MISS";
    if (!o) {
      let job = thumbnailJobs.get(`${env.account_id}/${thumbKey}`);
      if (!job) {
        job = (async () => {
          const source = await env.MEDIA.get(key); // Images needs the whole image, even for a Range request.
          if (!source) return;
          if (!env.IMAGES) throw new Error("Cloudflare Images binding IMAGES is unavailable");
          const image = await env.IMAGES.input(source.body)
            .transform({ width: Number(width), fit: "scale-down" })
            .output({ format: "image/webp", quality: 82 });
          await env.MEDIA.put(thumbKey, image.image(), { httpMetadata: { contentType: "image/webp" } });
        })();
        thumbnailJobs.set(`${env.account_id}/${thumbKey}`, job);
        // Remove both successful and failed work so a failure can be retried.
        job.finally(() => thumbnailJobs.delete(`${env.account_id}/${thumbKey}`)).catch(() => {});
      }
      await job;
      o = await env.MEDIA.get(thumbKey, { range: req.headers });
    }
  } else o = await env.MEDIA.get(key, { range: req.headers });
  if (!o) return new Response("not found", { status: 404 });
  const h = new Headers();
  o.writeHttpMetadata(h);
  if (cache) h.set("x-thumbnail-cache", cache);
  h.set("etag", o.httpEtag); h.set("cache-control", "private, max-age=31536000, immutable"); h.set("accept-ranges", "bytes");
  if (o.range && req.headers.has("range")) {
    const start = o.range.offset ?? 0, len = o.range.length ?? o.size - start;
    h.set("content-range", `bytes ${start}-${start + len - 1}/${o.size}`);
    h.set("content-length", String(len));
    return new Response(o.body, { status: 206, headers: h });
  }
  return new Response(o.body, { headers: h });
}
async function log(env, kind, story, ok, ms, units, unit, usd, meta) {
  try {
    const values = [env.account_id, Date.now(), kind, story || null, ok ? 1 : 0, ms, units ?? null, unit, usd ?? 0, JSON.stringify(meta || {})];
    const statement = env.MODE === "hosted"
      ? env.DB.prepare("INSERT INTO events (account_id,at,kind,story_id,ok,ms,units,unit,cost_usd,meta) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM hosted_accounts WHERE account_id=? AND status='active' AND consent_at>0 AND parent_verified_at>0)").bind(...values, env.account_id)
      : env.DB.prepare("INSERT INTO events (account_id,at,kind,story_id,ok,ms,units,unit,cost_usd,meta) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(...values);
    await statement.run();
  } catch (e) { console.error("log", e); }

}
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const wc = (t) => (String(t || "").trim().match(/\S+/g) || []).length;
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const ext = (mime) => ({ "audio/webm": "webm", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif" })[mime] || "bin";
async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function b64(buf) {
  const u = new Uint8Array(buf); let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function parseJson(t) {
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const m = String(t).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
