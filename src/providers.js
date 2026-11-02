import { allow, charge } from './tenant.js';
export class ProviderError extends Error {
  constructor(message, status = 502, reason) { super(message); this.status = status; this.reason = reason; }
}
const DEFAULT_RESERVES = { image: 2, text: 0.5, tts: 0.5, stt: 0.02 };
export function reserve(env, kind) { return Number(env[`HOSTED_RESERVE_${kind.toUpperCase()}_USD`] || DEFAULT_RESERVES[kind]); }
export async function permit(env, kind, maximum = 0) {
  if (env.MODE === 'hosted' && maximum > reserve(env, kind)) throw new ProviderError('This part is too long for one reading. Try a shorter part.', 413, 'operation_too_large');
  const decision = await allow(env, env.account_id, kind);
  if (!decision.ok) throw new ProviderError(decision.message || decision.reason || 'A grown-up can check when pictures and voices are ready again.', 402, decision.reason);
  return decision;
}
export async function account(env, kind, usd, units, reservation) {
  await charge(env, env.account_id, { kind, usd, units, story_id: env.story_id || null, reservation_id: reservation?.reservation_id });
}
// A call with no trustworthy usage readback remains a conservative expense. finish()
// may release unspent reservations, but never makes an attempted paid call free.
export async function unknownCost(env, kind, reservation, detail = {}) {
  await account(env, kind, reserve(env, kind), { estimate: true, basis: 'unknown_provider_cost', ...detail, ...(kind === 'text' ? { input_tokens: 128000, output_tokens: 0, total_tokens: 128000 } : kind === 'image' ? { images: 1 } : {}) }, reservation);
}
const base = value => String(value || 'https://api.openai.com/v1').replace(/\/+$/, '');
const pendingText = new WeakMap();
function textRates(env, model = '') {
  const defaults = /opus/i.test(model) ? [5,25] : /sonnet/i.test(model) ? [3,15] : [0.4,1.6];
  return [Number(env.TEXT_INPUT_USD_PER_MILLION || defaults[0]), Number(env.TEXT_OUTPUT_USD_PER_MILLION || defaults[1])];
}
function inputCeiling(body) {
  let size = 0;
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') size += new TextEncoder().encode(m.content).length;
    else for (const c of m.content || []) size += c.type === 'image_url' ? 8192 : new TextEncoder().encode(c.text || '').length;
    size += 20;
  }
  return size + 100;
}
export async function settleText(res, usage, outputCharacters = 0) {
  const p = pendingText.get(res); if (!p) return;
  const { env, reservation, rates, input, output } = p;
  const reported = Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens);
  // Without usage, keep the bounded maximum, including hidden reasoning tokens.
  const prompt = reported ? usage.prompt_tokens : input;
  const completion = reported ? usage.completion_tokens : output;
  await account(env, 'text', (prompt * rates[0] + completion * rates[1]) / 1e6,
    { input_tokens: prompt, output_tokens: completion, total_tokens: prompt + completion, output_characters: outputCharacters,
      estimate: !reported, basis: reported ? 'provider_usage_configured_rates' : 'bounded_maximum_configured_rates' }, reservation);
  pendingText.delete(res);
}
export async function failText(res) {
  const p = pendingText.get(res); if (!p) return;
  await unknownCost(p.env, 'text', p.reservation); pendingText.delete(res);
}
export async function providerFetch(env, path, init, detail = {}) {
  const image = path.startsWith('/images/'), tts = path === '/audio/speech';
  const kind = image ? 'image' : tts ? 'tts' : 'text';
  const apiKey = image ? env.IMAGE_API_KEY || env.TEXT_API_KEY : tts ? env.OPENAI_API_KEY || env.TEXT_API_KEY : env.TEXT_API_KEY;
  if (!apiKey) throw new ProviderError(`A grown-up needs to set ${image ? 'IMAGE_API_KEY' : tts ? 'OPENAI_API_KEY or TEXT_API_KEY' : 'TEXT_API_KEY'}`, 503, 'provider_not_configured');
  let body, rates, input, output, maximum;
  if (kind === 'text') {
    body = JSON.parse(init.body); rates = textRates(env, body.model); input = inputCeiling(body); output = body.max_tokens || 1500;
    if (input > 100000 || output > 12000) throw new ProviderError('Try a shorter part of the story.', 413);
    maximum = (input * rates[0] + output * rates[1]) / 1e6;
  } else maximum = image ? Number(env.IMAGE_USD_EACH || 0.04) : detail.units / 1000 * Number(env.OPENAI_TTS_USD_PER_1K || 0.015);
  const reservation = await permit(env, kind, maximum);
  const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${apiKey}`);
  const endpoint = image ? env.IMAGE_BASE_URL || env.TEXT_BASE_URL : tts ? env.TTS_BASE_URL || env.TEXT_BASE_URL : env.TEXT_BASE_URL;
  let res;
  try { res = await fetch(base(endpoint) + path, { ...init, headers }); }
  catch { await unknownCost(env, kind, reservation, tts ? { characters: detail.units } : {}); throw new ProviderError('The provider connection stopped. A grown-up can check the account.'); }
  if (!res.ok) {
    await unknownCost(env, kind, reservation, tts ? { characters: detail.units } : {});
    if (res.status === 402 || res.status === 429) {
      if (env.MODE === 'hosted') await (await import('./hosted/index.js')).providerLimit(env);
      throw new ProviderError('The printing press is resting. A grown-up can check when it is ready.', res.status, 'provider_limit');
    }
    throw new ProviderError(`Provider request failed (${res.status})`);
  }
  if (kind === 'text') pendingText.set(res, { env, reservation, rates, input, output });
  else if (tts) await account(env, kind, maximum, { characters: detail.units, basis: 'characters_configured_rate' }, reservation);
  else {
    try {
      const data = await res.clone().json();
      const usage = data.usage;
      const actual = Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens);
      const textInput = usage?.input_tokens_details?.text_tokens || 0;
      const imageInput = usage?.input_tokens_details?.image_tokens ?? Math.max(0, (usage?.input_tokens || 0) - textInput);
      const usd = actual ? (textInput * Number(env.IMAGE_TEXT_INPUT_USD_PER_MILLION || 5) + imageInput * Number(env.IMAGE_INPUT_USD_PER_MILLION || 10) + usage.output_tokens * Number(env.IMAGE_OUTPUT_USD_PER_MILLION || 40)) / 1e6 : maximum;
      await account(env, kind, usd, { ...(usage || {}), images: 1, estimate: !actual, basis: actual ? 'provider_usage_configured_rates' : 'per_image_configured_tariff' }, reservation);
    } catch { await unknownCost(env, kind, reservation, tts ? { characters: detail.units } : {}); throw new ProviderError('The picture provider returned an unreadable response.'); }
  }
  return res;
}
export async function chatCompletion(env, body) {
  if (env.TEXT_REASONING_EFFORT) body.reasoning_effort = env.TEXT_REASONING_EFFORT;
  const res = await providerFetch(env, '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const data = await res.json(), content = data.choices?.[0]?.message?.content;
    await settleText(res, data.usage, typeof content === 'string' ? content.length : 0);
    return { text: typeof content === 'string' ? content : '', tokens: data.usage?.total_tokens || 0, status: res.status };
  } catch (e) { await failText(res); throw e; }
}
