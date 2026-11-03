import { captureServer } from "./analytics.js";
import { APP_NAME } from './config.js';
import { tenantEnv } from './tenant.js';
export async function parentGate(req, env) {
  if (env.MODE === 'hosted') {
    const { parent } = await import('./hosted/index.js');
    await parent(req, env);
  }
}
export async function shareInfo(env, id) {
  const row = await env.DB.prepare('SELECT token,show_author,created FROM shares WHERE account_id=? AND story_id=?').bind(env.account_id, id).first();
  return row ? { token: row.token, url: `/b/${row.token}`, show_author: !!row.show_author, created: row.created } : null;
}
export const SHARE_NOTICE_VERSION = '2026-11-02';
const disclosureAction = (id, showAuthor) => `share_disclosure:${id}:${showAuthor ? 'with_author' : 'without_author'}`;
export async function shareRoute(req, env, id) {
  await parentGate(req, env);
  if (req.method === 'DELETE') {
    const statements = [];
    if (env.MODE === 'hosted') statements.push(env.DB.prepare("INSERT INTO hosted_consent (account_id,id,version,action,at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM hosted_accounts WHERE account_id=? AND status='active' AND consent_at>0 AND parent_verified_at>0)")
      .bind(env.account_id, crypto.randomUUID(), SHARE_NOTICE_VERSION, `share_revoked:${id}`, Date.now(), env.account_id));
    statements.push(env.DB.prepare('DELETE FROM shares WHERE account_id=? AND story_id=?').bind(env.account_id, id));
    await env.DB.batch(statements);
    return new Response(null, { status: 204 });
  }
  const story = await env.DB.prepare('SELECT id FROM stories WHERE account_id=? AND id=?').bind(env.account_id, id).first();
  if (!story) return Response.json({ error: 'not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  // Recent parent authentication establishes identity. This separate, affirmative
  // choice grants disclosure permission for this book and the selected author setting.
  if (env.MODE === 'hosted' && (body.disclosure_consent !== true || body.notice_version !== SHARE_NOTICE_VERSION))
    return Response.json({ error: 'sharing_consent_required', notice_version: SHARE_NOTICE_VERSION }, { status: 403 });
  const random = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, '0')).join('');
  const token = `${env.account_id}.${random}`, at = Date.now(), showAuthor = body.show_author === true;
  let result;
  if (env.MODE === 'hosted') {
    const consentId = crypto.randomUUID(), action = disclosureAction(id, showAuthor);
    const liveStory = "SELECT 1 FROM stories s JOIN hosted_accounts a ON a.account_id=s.account_id WHERE s.account_id=? AND s.id=? AND a.status='active' AND a.consent_at>0 AND a.parent_verified_at>0";
    // One D1 transaction records consent BEFORE it can create/expand a public link.
    // A deleting account or missing story can create neither consent nor a share.
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO hosted_consent (account_id,id,version,action,at) SELECT ?,?,?,?,? WHERE EXISTS (${liveStory})`)
        .bind(env.account_id, consentId, SHARE_NOTICE_VERSION, action, at, env.account_id, id),
      env.DB.prepare(`INSERT INTO shares (account_id,story_id,token,show_author,created) SELECT ?,?,?,?,? WHERE EXISTS (${liveStory}) AND EXISTS (SELECT 1 FROM hosted_consent WHERE account_id=? AND id=? AND version=? AND action=?) ON CONFLICT(account_id,story_id) DO UPDATE SET show_author=excluded.show_author`)
        .bind(env.account_id, id, token, showAuthor ? 1 : 0, at, env.account_id, id, env.account_id, consentId, SHARE_NOTICE_VERSION, action),
    ]);
    result = results[1];
  } else result = await env.DB.prepare('INSERT INTO shares (account_id,story_id,token,show_author,created) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM stories WHERE account_id=? AND id=?) ON CONFLICT(account_id,story_id) DO UPDATE SET show_author=excluded.show_author')
    .bind(env.account_id, id, token, showAuthor ? 1 : 0, at, env.account_id, id).run();
  if (!result.meta.changes) return Response.json({ error: 'account_unavailable' }, { status: 403 });
  captureServer(env,"book_shared",{}, {object:id});
  return Response.json(await shareInfo(env, id));
}
// No paid call, queue message or mutation is reachable from this public route.
export async function publicShare(req, rawEnv, token, logicalKey, { loadStory, speechKey, media }) {
  const accountId = token?.split('.')[0];
  if (!/^[a-zA-Z0-9_-]+\.[a-f0-9]{48}$/.test(token || '')) return new Response('not found', { status: 404 });
  const env = tenantEnv(Object.assign(Object.create(rawEnv), { CTX: null }), accountId);
  const share = await env.DB.prepare('SELECT story_id,show_author FROM shares WHERE account_id=? AND token=?').bind(accountId, token).first();
  if (!share) return new Response('not found', { status: 404 });
  if (env.MODE === 'hosted') {
    const consent = await env.DB.prepare("SELECT c.id FROM hosted_consent c JOIN hosted_accounts a ON a.account_id=c.account_id WHERE c.account_id=? AND c.version=? AND c.action=? AND a.status='active' AND a.consent_at>0 AND a.parent_verified_at>0 LIMIT 1")
      .bind(accountId, SHARE_NOTICE_VERSION, disclosureAction(share.story_id, !!share.show_author)).first();
    if (!consent) return new Response('not found', { status: 404 });
  }
  const L = await loadStory(env, share.story_id);
  if (!L) return new Response('not found', { status: 404 });
  const permitted = new Set(), pages = [];
  const url = k => k ? `/s/${token}/${k}` : null;
  for (const c of L.scenes) {
    if (c.image_key) permitted.add(c.image_key);
    const key = await speechKey(env, L.s, c.text);
    const cached = await env.MEDIA.get(`${key}.json`);
    if (cached) permitted.add(`${key}.mp3`);
    pages.push({ sid: c.sid, ord: c.ord, from: c.para_from, to: c.para_to, text: c.text,
      image_url: url(c.image_key), audio_url: cached ? url(`${key}.mp3`) : null, alignment: cached ? await cached.json() : null });
  }
  let result;
  if (logicalKey) result = permitted.has(logicalKey) ? await media(logicalKey, req, env) : new Response('not found', { status: 404 });
  else result = Response.json({ app_name: APP_NAME, title: L.s.title, first_line: L.s.text.split('\n')[0].slice(0,120),
    author: share.show_author ? L.s.author : null, chapters: JSON.parse(L.s.book || '{}').chapters || [], pages, updated: L.s.updated });
  const response = new Response(result.body, result);
  response.headers.set('cache-control', 'private, no-store');
  response.headers.set('x-robots-tag', 'noindex');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}
