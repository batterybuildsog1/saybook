# Provider costs and allowances

The source is free under MIT. Self-hosters pay their own Cloudflare and AI providers. Costs depend on model, quality, reference images, narration length and redraws. Check current provider prices before enabling a deployment.

The hosted family plan is $19.50/month. Its combined monthly allowance is 120 image attempts, 1,000,000 text/vision tokens, 50,000 newly synthesized narration characters, and a $2.25 provider dollar reserve. Advertise about eight typical picture books; long books and redraws use more. Cached narration adds no new synthesis charge. Usage does not roll over.

A planning case using commercial APIs estimates about $1.29 for an eight-page, 1,500-character book and about $3.99 for a 20-page, 12,000-character book. Reference-image input tokens are uncertain and can dominate cost. These are estimates, not measured provider invoices. Under the current hosted subscription-backed gateway, narration is the principal marginal provider charge; image and token quotas still protect capacity. Moving to metered commercial APIs requires revisiting the allowance and configuring actual tariffs.

Pictures can take several minutes under shared load. Keep a small initial cohort, account and global quotas, a voice pause and a generation kill switch. Do not promise unlimited usage or fixed completion times.

Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [image API](https://developers.openai.com/api/docs/guides/image-generation), [ElevenLabs](https://elevenlabs.io/pricing/api), [Cloudflare](https://developers.cloudflare.com/workers/platform/pricing/), [Stripe](https://stripe.com/pricing). Planning checked 2026-11-02.
