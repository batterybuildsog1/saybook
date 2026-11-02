# Saybook

**Talk or type. Watch your own words become an illustrated book. Read it aloud and share it.**

Saybook is a family writing studio built on a Cloudflare Worker, D1, R2, Queues and Workers AI. Models plan page breaks and illustrations; they never replace the writer's story text. Punctuation suggestions are optional and checked to preserve letters and numbers. A child can record their own reading; no voice cloning is involved.

Two modes share the same core: **self** is one family with your own provider keys and an optional passcode. **hosted** adds parent accounts, paid consent, subscriptions and usage limits; see [the hosted guide](docs/HOSTED.md). The working public name is Saybook; `APP_NAME` lives in `src/config.js` and is mirrored in `public/config.js`.

## The three-minute self-host path

You need Node 22+, a Cloudflare account with Workers, D1, R2, Queues and Workers AI enabled, and your own OpenAI-compatible API key. Account activation or enabling billing can take longer than three minutes.

```sh
npm install
npm run setup
```

Setup signs in to Cloudflare, creates your own database/bucket/queue, applies the core schema, prompts for provider keys and an optional family passcode **without echoing them**, stores secrets through Wrangler, and deploys. It writes the resource IDs into ignored `wrangler.local.toml`. Open the workers.dev URL printed by Wrangler, then add writer names and colors in Settings. A blank passcode means anyone who knows the deployment URL can access the family workspace; choose a passcode for private use.

For later deployments:

```sh
npx wrangler deploy --config wrangler.local.toml
```

The Deploy to Cloudflare template is configured through `wrangler.toml`, `.dev.vars.example`, the `cloudflare.bindings` descriptions and the migration/deploy commands in `package.json`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/batterybuildsog1/saybook)

## Bring your own providers

| Setting | Purpose |
| --- | --- |
| `TEXT_BASE_URL`, `TEXT_API_KEY`, `TEXT_MODEL` | OpenAI-compatible `/chat/completions`; default base `https://api.openai.com/v1`, model `gpt-4.1-mini` |
| `VISION_MODEL` | Same endpoint and key, with image inputs; defaults to the text model |
| `IMAGE_BASE_URL`, `IMAGE_API_KEY`, `IMAGE_MODEL` | OpenAI Images `/images/generations` and multipart `/images/edits`; defaults to OpenAI / `gpt-image-2.5-sunburst`; omitted image key uses the text key |
| `ELEVENLABS_API_KEY`, `TTS_MODEL` | Read-aloud with per-character timing; default model `eleven_multilingual_v2` |
| `OPENAI_API_KEY`, `TTS_BASE_URL`, `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE` | When no ElevenLabs key is set: OpenAI TTS (`tts-1`, `coral`); omitted TTS key/base uses the text key/base |
| Workers AI binding `AI` | Whisper dictation and alignment, without another provider key |
| `PASSCODE` | Optional family gate, stored as a Worker secret |

One OpenAI key is sufficient for text, vision, pictures and read-aloud. If text uses another vendor or a local server, configure an OpenAI Images endpoint and an OpenAI speech endpoint separately. Configure secrets with `npx wrangler secret put NAME --config wrangler.local.toml`; never paste keys into source files. Provider switching requires configuration and redeployment, with no code edits.

Real API behavior retained: output token limits can include hidden reasoning; the planner uses a generous bounded token budget and validates the resulting page indexes. Set `TEXT_REASONING_EFFORT` only if your endpoint supports it. A provider's malformed layout falls back to deterministic page planning, retaining every word. A provider limit error stops the operation. Pictures with references use multipart edits. Large narration is split into bounded pieces and cached by provider/model/voice/text. OpenAI TTS alignment uses Whisper, with estimated character timing if alignment is unavailable. Text metering reads input/output usage separately; image metering uses returned token usage or an explicitly estimated per-image tariff. Rates are configuration, not invoice guarantees.

## What a book costs

Provisional estimate for a short 200–300-word book with two illustrated pages, two reusable character portraits and one narration: **roughly $0.20–$0.80 with your own OpenAI keys**, depending on image size/quality, model and retries. Re-reading a cached page costs no new TTS call. An image redraw is another billable generation. ElevenLabs can add roughly $0.15–$0.45 for a short reading, depending on plan/model. These BYOK figures are planning estimates, not a fixed price. The [cost guide](docs/COSTS.md) recommends the hosted allowance of 120 image attempts, 1,000,000 text/vision tokens and 50,000 newly synthesized characters per family per month; at its cited ElevenLabs v4 Turbo rate, that character allowance costs about $2 before tax. Pictures may take several minutes under shared load; these figures are estimates, not a capacity guarantee.

Cloudflare may require a paid Workers plan (typically starting around $5/month) for the queue-based workflow; storage and traffic are extra beyond included allowances. There is no app subscription in self mode. Usage displays use configurable rates: `TEXT_INPUT_USD_PER_MILLION`, `TEXT_OUTPUT_USD_PER_MILLION`, `IMAGE_TEXT_INPUT_USD_PER_MILLION`, `IMAGE_INPUT_USD_PER_MILLION`, `IMAGE_OUTPUT_USD_PER_MILLION`, `IMAGE_USD_EACH` (fallback estimate), `OPENAI_TTS_USD_PER_1K`, and `ELEVEN_USD_PER_CREDIT`.

## Privacy and sharing

Stories, page plans, writer settings and operation events live in your Cloudflare D1 database. Pictures, uploads, cached narration and explicitly saved own-reading recordings live in your R2 bucket. Objects and database queries are scoped to the account; self mode uses `self`. Dictation recordings are sent to Workers AI Whisper and are not retained by this app. Browser live dictation may also use the browser/OS speech service. Text/vision providers receive story excerpts, character details and reference images; speech providers receive narration text. Their retention policies apply separately.

Saved own-reading recordings contain a child's real voice. In hosted mode, a parent must explicitly enable saved recordings; paid parent consent is required before creating any child content. Self-hosters control their deployment, storage and provider accounts. Analytics is off by default. An operator may configure a separate project; it loads only after a parent opts in on that device. Shared books and the landing never load analytics.

A parent can create and revoke a read-only bearer link. Hosted sharing requires a separate affirmative disclosure choice and the current parent-notice version; confirming the parent password alone does not grant sharing consent. That choice is durably recorded for the book and author-display setting. Anyone with that link can see the shared book and its already-cached narration. Authors are hidden unless explicitly enabled. Shared readers cannot edit or trigger paid generation; revoked links stop serving the book and media. Deleting a story removes its media and revokes the share. Keep private family links private.

## Verification and license

```sh
E2E_PASSCODE='<your isolated test passcode>' npm run e2e -- https://your-test-worker.workers.dev
```

The E2E creates author `Demo` only, exercises real providers, and writes a repeatable report, images and audio in `e2e/out/`. It spends provider usage. Never target a family production app. `--media-only` exercises storage/thumbnails without paid model calls.

Released under [MIT](LICENSE). Security boundaries and the scrub audit are in [SECURITY.md](SECURITY.md).
