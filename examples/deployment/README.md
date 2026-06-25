# Deployment scaffold

A copy-paste starting point for shipping your own bot on `telegram-bot-engine`. The engine is a
**library — it does not deploy itself**; deployment lives in *your* pack repo, which pulls the engine,
injects your pack via `PERSONA_PACK`, and `wrangler deploy`s against your own Cloudflare resources.

Files here (copy them into your pack repo, then replace every `<PLACEHOLDER>`):

| File | Goes to | What it is |
|---|---|---|
| `wrangler.jsonc` | your repo root | Worker config: name, account, `vars`, the `KV`/`DB`/`AI`/`VECTORIZE` bindings, crons |
| `deploy.yml` | `.github/workflows/deploy.yml` | CI: clone engine → stage pack → gate → migrate → deploy |
| `.dev.vars.example` | copy to `.dev.vars` (gitignored) | the Worker **secrets** (tokens) — never in `vars` |
| `setWebhook.mjs` | run locally | register/delete the Telegram webhook (+ optional origin secret) |

## 1. Create the Cloudflare resources (once)

```bash
npx wrangler d1 create <your-db-name>            # → copy database_id into wrangler.jsonc
npx wrangler kv namespace create KV              # → copy id into wrangler.jsonc
npx wrangler vectorize create <your-index> --dimensions=1024 --metric=cosine   # only if you enable RAG
```

Put the returned ids into `wrangler.jsonc`. The `AI` binding needs no id. These ids point at **live data** —
set them once and don't change them.

## 2. Secrets (write-only, survive deploys)

Set each secret from `.dev.vars.example` — locally a `.dev.vars` file for `wrangler dev`, in production:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put OPENROUTER_API_KEY
# optional: OPENROUTER_PROVISIONING_KEY, TELEGRAM_WEBHOOK_SECRET
```

Plaintext config (model, language, admins, …) goes in `wrangler.jsonc` → `vars`, **not** as secrets.
A deploy *replaces* `vars`, so list every one you depend on; secrets are untouched by deploys.

## 3. CI (GitHub Actions)

Put `deploy.yml` at `.github/workflows/deploy.yml` and set these repo secrets:

- `CLOUDFLARE_API_TOKEN` — Workers Scripts:Edit + D1:Edit (+ Vectorize/AI if RAG is on).
- `ENGINE_SSH_KEY` — a read-only deploy key for the engine repo. *(If the engine repo is public, delete the
  `ssh-key:` line in `deploy.yml`.)*

A push to `main` then runs the gate **with your pack**, applies D1 migrations (before deploy — `wrangler
deploy` does not), and deploys. Migrations are idempotent; only new `migrations/*.sql` run.

## 4. Point Telegram at the worker

After the first deploy, register the webhook (use the same secret you set for `TELEGRAM_WEBHOOK_SECRET`):

```bash
TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node setWebhook.mjs https://<your-worker-url>
node setWebhook.mjs --info     # confirm
```

The native "/" command menu syncs itself on the next daily cron (or run `/admin commands` to do it now).

## Minimal pack

You still need a pack for `PERSONA_PACK` to point at. The smallest is an `index.ts` calling
`setPersona({})` plus an `i18n/en.json` with a `persona_defaultVoice` — see the demo pack
([telegram-bot-persona](https://github.com/st4s1k/telegram-bot-persona)) → *The smallest possible pack*.
