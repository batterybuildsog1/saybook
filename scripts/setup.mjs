#!/usr/bin/env node
import { APP_NAME } from '../src/config.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const ask = prompt => new Promise(resolve => {
  const line = createInterface({ input: process.stdin, output: process.stdout });
  line.question(prompt, value => { line.close(); resolve(value); });
});
async function secret(prompt) {
  if (!process.stdin.isTTY) throw new Error('Setup needs an interactive terminal for secrets.');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function input(bytes) {
      for (const char of bytes.toString('utf8')) {
        if (char === '\u0003') { cleanup(); reject(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(value.trim()); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    }
    function cleanup() {
      process.stdin.off('data', input); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
    }
    process.stdin.on('data', input);
  });
}
async function run(args, { input, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', ...args], { stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    let output = ''; child.stdout?.on('data', b => { output += b; });
    if (input !== undefined) child.stdin.end(input + '\n');
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`Wrangler failed (${code}); resource names are shown above for cleanup or retry.`)));
  });
}
try {
  console.log(`${APP_NAME} setup: your own Cloudflare account and provider keys. Secrets are never echoed.`);
  const name = (await ask('Worker name [storybook]: ')).trim() || 'storybook';
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error('Use a lowercase Worker name with letters, numbers and hyphens.');
  const endpoint = (await ask('Text API base [https://api.openai.com/v1]: ')).trim() || 'https://api.openai.com/v1';
  if (!/^https?:\/\//.test(endpoint)) throw new Error('Use an http(s) API base URL ending in /v1.');
  const textModel = (await ask('Text/vision model [gpt-4.1-mini]: ')).trim() || 'gpt-4.1-mini';
  const imageEndpoint = (await ask('Image API base [https://api.openai.com/v1]: ')).trim() || 'https://api.openai.com/v1';
  const imageModel = (await ask('Image model [gpt-image-2.5-sunburst]: ')).trim() || 'gpt-image-2.5-sunburst';
  console.log('Sign in to Cloudflare if prompted. D1, R2, Queues and Workers AI must be available on your account.');
  await run(['login']);
  const created = await run(['d1', 'create', name], { capture: true });
  const id = created.match(/database_id\s*[=:]\s*["']([a-f0-9-]+)["']/)?.[1] || created.match(/"database_id"\s*:\s*"([a-f0-9-]+)"/)?.[1];
  if (!id) throw new Error('Could not read the D1 id. Run wrangler d1 list and update your local config.');
  await run(['r2', 'bucket', 'create', `${name}-media`]);
  await run(['queues', 'create', `${name}-paint`]);
  let config = await readFile('wrangler.toml', 'utf8');
  config = config.replaceAll('storybook', name).replace('REPLACE_WITH_D1_ID', id)
    .replace('TEXT_BASE_URL = "https://api.openai.com/v1"', `TEXT_BASE_URL = ${JSON.stringify(endpoint)}`)
    .replace('TEXT_MODEL = "gpt-4.1-mini"', `TEXT_MODEL = ${JSON.stringify(textModel)}`)
    .replace('VISION_MODEL = "gpt-4.1-mini"', `VISION_MODEL = ${JSON.stringify(textModel)}`)
    .replace('IMAGE_BASE_URL = "https://api.openai.com/v1"', `IMAGE_BASE_URL = ${JSON.stringify(imageEndpoint)}`)
    .replace('IMAGE_MODEL = "gpt-image-2.5-sunburst"', `IMAGE_MODEL = ${JSON.stringify(imageModel)}`);
  await writeFile('wrangler.local.toml', config);
  // Only the numbered core migrations: hosted migrations have a separate owner/lifecycle.
  for (const file of (await readdir('migrations')).filter(f => /^\d.*\.sql$/.test(f)).sort())
    await run(['d1', 'execute', name, '--remote', '--file', `migrations/${file}`, '--config', 'wrangler.local.toml']);
  // Create the Worker before secret put, so Wrangler does not need a second confirmation on stdin.
  await run(['deploy', '--config', 'wrangler.local.toml']);
  for (const [key, prompt, required] of [
    ['TEXT_API_KEY', 'Text API key (hidden): ', true],
    ['IMAGE_API_KEY', 'Image API key (hidden, Enter uses text key): ', false],
    ['OPENAI_API_KEY', 'OpenAI TTS key (hidden, Enter uses text key): ', false],
    ['ELEVENLABS_API_KEY', 'ElevenLabs key (hidden, Enter uses OpenAI TTS): ', false],
    ['PASSCODE', 'Family passcode (hidden, Enter leaves this self-host publicly accessible): ', false],
  ]) {
    let value = await secret(prompt);
    while (required && !value) value = await secret('A text API key is required (hidden): ');
    if (value) await run(['secret', 'put', key, '--config', 'wrangler.local.toml'], { input: value });
    value = '';
  }
  await run(['deploy', '--config', 'wrangler.local.toml']);
  console.log('Ready. Open the workers.dev URL above. Add your family’s writer names in Settings.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false); }
