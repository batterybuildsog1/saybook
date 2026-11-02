// The only mode switch. Hosted code is evaluated only in hosted mode.
const hosted = () => import('./hosted/index.js');
const json = (body, status) => Response.json(body, { status });
async function cookieToken(env) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`storybook:${env.PASSCODE}`));
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function who(req, env) {
  if (env.MODE === 'hosted') return (await hosted()).who(req, env);
  if (!env.PASSCODE) return { account_id: 'self', plan: 'self' };
  const cookie = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sp=([a-f0-9]+)/)?.[1];
  return cookie === await cookieToken(env) ? { account_id: 'self', plan: 'self' } : null;
}
export async function unlock(req, env) {
  if (env.MODE === 'hosted') return json({ error: 'Use your parent account to sign in' }, 401);
  const { code } = await req.json().catch(() => ({}));
  if (env.PASSCODE && String(code || '') !== env.PASSCODE) return json({ error: 'Incorrect passcode' }, 401);
  return new Response(null, { status: 204, headers: env.PASSCODE ? {
    'set-cookie': `sp=${await cookieToken(env)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`,
  } : {} });
}
export async function allow(env, account_id, kind) {
  if (env.MODE === 'hosted') return (await hosted()).allow(env, account_id, kind);
  return { ok: account_id === 'self', reason: account_id === 'self' ? null : 'Invalid account' };
}
export async function charge(env, account_id, detail) {
  if (env.MODE === 'hosted') return (await hosted()).charge(env, account_id, detail);
  await env.DB.prepare('INSERT INTO usage_ledger (account_id,at,kind,usd,units,story_id) VALUES (?,?,?,?,?,?)')
    .bind(account_id, Date.now(), detail.kind, detail.usd || 0, typeof detail.units === "object" ? JSON.stringify(detail.units) : detail.units || 0, detail.story_id || null).run();
}
export async function finish(env) {
  if (env.MODE === 'hosted') await (await hosted()).finish(env);
}
// Call on a request/message-local object, never the raw Worker bindings object.
export function tenantEnv(env, account_id, plan) {
  if (!/^[a-zA-Z0-9_-]+$/.test(account_id || '')) throw new Error('Invalid account id');
  env.account_id = account_id;
  env.plan = plan;
  const bucket = env.MEDIA;
  const prefix = `accounts/${account_id}/`;
  const key = k => {
    if (typeof k !== 'string' || k.startsWith('/') || k.split('/').includes('..')) throw new Error('Invalid media key');
    return prefix + k;
  };
  env.MEDIA = {
    get: (k, options) => bucket.get(key(k), options),
    head: k => bucket.head(key(k)),
    async put(k, body, options) {
      if (env.MODE === 'hosted') {
        const account = await env.DB.prepare("SELECT account_id FROM hosted_accounts WHERE account_id=? AND status='active' AND consent_at>0 AND parent_verified_at>0").bind(account_id).first();
        if (!account) throw new Error('Account no longer writable');
      }
      const storyId = k.match(/^(?:thumb\/\d+\/)?(?:img|audio|own|ref)\/([^/]+)\//)?.[1];
      if (storyId && storyId !== 'loose') {
        const story = await env.DB.prepare('SELECT id FROM stories WHERE account_id=? AND id=?').bind(account_id, storyId).first();
        if (!story) throw new Error('Story no longer writable');
      }
      const result = await bucket.put(key(k), body, options);
      let active = true;
      if (env.MODE === 'hosted') active = !!await env.DB.prepare("SELECT account_id FROM hosted_accounts WHERE account_id=? AND status='active' AND consent_at>0 AND parent_verified_at>0").bind(account_id).first();
      if (active && storyId && storyId !== 'loose') active = !!await env.DB.prepare('SELECT id FROM stories WHERE account_id=? AND id=?').bind(account_id, storyId).first();
      if (!active) { await bucket.delete(key(k)); throw new Error('Account or story was deleted while saving media'); }
      return result;
    },
    delete: k => bucket.delete(Array.isArray(k) ? k.map(key) : key(k)),
    async list(options = {}) {
      const result = await bucket.list({ ...options, prefix: key(options.prefix || '') });
      return { ...result, objects: result.objects.map(o => ({ ...o, key: o.key.slice(prefix.length) })) };
    },
  };
  return env;
}
