export async function setupStatus(req, env) {
  if (env.MODE === 'hosted') return Response.json({ error: 'not found' }, { status: 404 });
  const textKey = !!env.TEXT_API_KEY, imageKey = !!(env.IMAGE_API_KEY || env.TEXT_API_KEY), voiceKey = !!(env.OPENAI_API_KEY || env.TEXT_API_KEY);
  const host = value => { try { return new URL(value || 'https://api.openai.com/v1').host; } catch { return ''; } };
  const providers = {
    text: { ok: textKey, model: env.TEXT_MODEL || 'gpt-4.1-mini', host: host(env.TEXT_BASE_URL), missing: textKey ? [] : ['TEXT_API_KEY'] },
    vision: { ok: textKey, model: env.VISION_MODEL || env.TEXT_MODEL || 'gpt-4.1-mini', host: host(env.TEXT_BASE_URL), missing: textKey ? [] : ['TEXT_API_KEY'] },
    image: { ok: imageKey, model: env.IMAGE_MODEL || 'gpt-image-2.5-sunburst', host: host(env.IMAGE_BASE_URL), missing: imageKey ? [] : ['IMAGE_API_KEY'] },
    voice: { ok: !!env.ELEVENLABS_API_KEY || voiceKey, provider: env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'openai', missing: env.ELEVENLABS_API_KEY || voiceKey ? [] : ['OPENAI_API_KEY'] },
    stt: { ok: !!env.AI, provider: 'workers-ai', missing: env.AI ? [] : ['AI'] },
  };
  // Deliberately free checks only. Not every compatible endpoint implements /models;
  // such an endpoint can be configured correctly while reporting verified:false here.
  if (new URL(req.url).searchParams.get('check') === '1') {
    for (const [name, provider] of Object.entries(providers)) {
      if (!provider.ok || name === 'stt') { provider.verified = false; provider.error = 'No free verification endpoint'; continue; }
      const eleven = name === 'voice' && env.ELEVENLABS_API_KEY;
      const endpoint = eleven ? 'https://api.elevenlabs.io/v1/voices' : `${String(name === 'image' ? env.IMAGE_BASE_URL || env.TEXT_BASE_URL || 'https://api.openai.com/v1' : name === 'voice' ? env.TTS_BASE_URL || env.TEXT_BASE_URL || 'https://api.openai.com/v1' : env.TEXT_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/models`;
      const key = eleven ? env.ELEVENLABS_API_KEY : name === 'image' ? env.IMAGE_API_KEY || env.TEXT_API_KEY : name === 'voice' ? env.OPENAI_API_KEY || env.TEXT_API_KEY : env.TEXT_API_KEY;
      try {
        const response = await fetch(endpoint, { headers: eleven ? { 'xi-api-key': key } : { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
        provider.verified = response.ok;
        if (!response.ok) provider.error = `Free check returned ${response.status}`;
        if ([402,429].includes(response.status)) { provider.error = 'Provider limit reached; further checks stopped'; break; }
      } catch { provider.verified = false; provider.error = 'Free check unavailable'; }
    }
  }
  const since = new Date(); since.setUTCDate(1); since.setUTCHours(0,0,0,0);
  const row = await env.DB.prepare('SELECT COALESCE(SUM(usd),0) usd FROM usage_ledger WHERE account_id=? AND at>=?').bind(env.account_id, since.getTime()).first();
  const storage = { db: !!env.DB, media: !!env.MEDIA, queue: !!env.PAINT };
  return Response.json({ ready: providers.text.ok && providers.image.ok && providers.voice.ok && providers.stt.ok && storage.db && storage.media,
    command: 'npm run setup', providers, storage, passcode: !!env.PASSCODE, month: { usd: row.usd, since: since.toISOString() } });
}
