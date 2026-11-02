// Self-host status (GET /api/setup; LAUNCH-PLAN UI addendum 3). Shows what's connected and what's missing, and the one
// command that fixes it. Keys are Worker secrets set by `npm run setup`; this page never takes or shows a key.
import { brand, config, call, esc, REPO_URL } from '/kit.js';
import { analyticsOffered, analyticsChoice, startAnalytics, stopAnalytics } from '/analytics.js';

const $ = (s) => document.querySelector(s);
brand();
$('#repo').href = REPO_URL;
const first = new URLSearchParams(location.search).has('first');

const cfg = await config();
if (cfg.mode === 'hosted') location.replace('/account/');

// What each part does, in a parent's words. The server sends ids, state, model and host.
const PARTS = [
  ['text', 'Words and pages', 'lays the story out as a book and answers the story helper', true],
  ['image', 'Pictures', 'paints a picture for each page', true],
  ['voice', 'Reading aloud', 'reads each page in a storyteller’s voice', true],
  ['stt', 'Talking', 'turns speech into words', true],
  ['vision', 'Looking at drawings', 'turns a kid’s drawing into a character', false],
];
const ENV_HELP = { AI: 'the Workers AI binding in wrangler.toml' };

async function load(check = false) {
  let d;
  try { d = await call('GET', '/api/setup' + (check ? '?check=1' : '')); }
  catch (e) {
    if (e.status === 401) { location.replace('/'); return; } // the passcode first (the app's lock screen)
    $('#loading').innerHTML = `<h1>Status</h1><p>${e.status === 404 ? 'This copy doesn’t report its status yet. Update it, then run <code>npm run setup</code>.' : esc(e.message)}</p>`;
    return;
  }
  render(d, check);
}

function render(d, checked) {
  const P = d.providers || {}, st = d.storage || {};
  $('#loading').hidden = true;
  ['#status', '#more', '#go'].forEach((s) => { $(s).hidden = false; });
  $('#fix').hidden = !!d.ready;
  // Not ready: the one command comes right after the headline, before the details.
  if (!d.ready) { $('#status-p').after($('#fix-in')); $('#fix').hidden = true; } else $('#fix').appendChild($('#fix-in'));
  $('#status-h').textContent = d.ready ? 'Everything’s connected' : first ? 'Almost ready' : 'Some parts aren’t connected';
  $('#status-p').textContent = d.ready
    ? 'Kids can talk, write, see pictures and hear their books read aloud.'
    : 'A few keys are missing. Kids can still type, but books won’t get pictures or be read aloud until they’re added.';
  if (d.command) $('#cmd').textContent = d.command;

  const rows = PARTS.map(([id, name, what, needed]) => {
    const p = P[id] || {};
    const prov = { openai: 'OpenAI', elevenlabs: 'ElevenLabs', 'workers-ai': 'Cloudflare Workers AI' }[p.provider] || p.provider;
    const where = [p.model, prov, p.host].filter(Boolean).join(' · ');
    const missing = (p.missing || []).map((m) => `<code>${esc(m)}</code>${ENV_HELP[m] ? ` (${esc(ENV_HELP[m])})` : ''}`).join(', ');
    let cls = p.ok ? 'ok' : needed ? 'no' : 'opt', say = p.ok ? 'Connected' : needed ? 'Missing' : 'Optional';
    if (p.ok && checked && p.verified === true) say = 'Key works';
    if (p.ok && checked && p.verified === false && id !== 'stt') { say = 'Couldn’t check'; }
    return `<li><span class="dot ${cls}"></span><b>${esc(name)}</b><span class="st ${p.ok ? 'ok' : needed ? 'no' : ''}">${esc(say)}</span>
      <span class="what">${esc(what)}${where ? `<br>${esc(where)}` : ''}${!p.ok && missing ? `<br>Needs ${missing}` : ''}${checked && p.error && p.ok && id !== 'stt' ? `<br>${esc(p.error)}` : ''}</span></li>`;
  });
  const store = st.db && st.media;
  rows.push(`<li><span class="dot ${store ? 'ok' : 'no'}"></span><b>Saving books</b><span class="st ${store ? 'ok' : 'no'}">${store ? 'Connected' : 'Missing'}</span><span class="what">stories in D1, pictures and audio in R2${store ? '' : '<br>Run <code>npm run setup</code> to create them'}</span></li>`);
  rows.push(`<li><span class="dot ${st.queue ? 'ok' : 'opt'}"></span><b>Painting in the background</b><span class="st ${st.queue ? 'ok' : ''}">${st.queue ? 'Connected' : 'Optional'}</span><span class="what">pictures keep painting after the tab closes</span></li>`);
  rows.push(`<li><span class="dot ${d.passcode ? 'ok' : 'opt'}"></span><b>Passcode</b><span class="st ${d.passcode ? 'ok' : ''}">${d.passcode ? 'On' : 'Off'}</span><span class="what">${d.passcode ? 'the family enters it once on each device' : 'anyone with the link can open it; <code>npm run setup</code> can add one'}</span></li>`);
  $('#lines').innerHTML = rows.join('');

  const m = d.month || {};
  const usd = Number(m.usd) || 0;
  $('#month').textContent = `Spent with your providers this month: about ${usd < 0.01 ? 'nothing yet' : '$' + usd.toFixed(2)}${m.since ? `, since ${new Date(m.since).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}` : ''}. These are estimates; your providers’ bills are exact.`;
  $('#open').hidden = !d.ready;
  $('#anyway').hidden = !!d.ready;
  $('#go').hidden = false;
}

// A self-hoster's own PostHog key (never a default): off until switched on here.
if (analyticsOffered(cfg)) {
  $('#stats-sec').hidden = false;
  $('#stats').checked = analyticsChoice.get();
  $('#stats').onchange = (e) => { if (e.target.checked) { analyticsChoice.set(true); startAnalytics(cfg, { surface: 'parent', parentalConsent: true }); } else stopAnalytics(); };
}
$('#copy').onclick = async () => { try { await navigator.clipboard.writeText($('#cmd').textContent); $('#copy').textContent = 'Copied'; setTimeout(() => { $('#copy').textContent = 'Copy'; }, 1500); } catch { /* select it by hand */ } };
$('#check').onclick = async () => { $('#check').disabled = true; $('#check-say').textContent = 'Checking…'; await load(true); $('#check').disabled = false; $('#check-say').textContent = 'Checked just now.'; };
// "Open it anyway": skip this page for the rest of this visit.
const skip = () => { try { sessionStorage.setItem('setup-skip', '1'); } catch { /* private mode */ } };
$('#anyway').onclick = skip;
$('#nav-open').onclick = skip;
load();
