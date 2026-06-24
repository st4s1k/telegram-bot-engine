# telegram-bot-engine — a Telegram ↔ LLM bot engine

A reusable **Telegram bot engine** on **Cloudflare Workers**: a bridge between a Telegram webhook
and **OpenRouter** (LLM), plus per-chat config, long-term memory (RAG), summaries, vision, dedup and
a daily cron. The bot's **personality** — its name, voice and "fun" commands — is a swappable
**persona pack** loaded at runtime that **does not live in this repo**: it is wired in at build time
via the `PERSONA_PACK` env-path (see [Persona pack](#persona-pack)). Without a pack the engine runs
neutral. Engine code, comments and UI strings are in **English**; UI strings are localizable (see
[Localization](#localization)).

> Chat memory (history + state) lives in Cloudflare **D1** (one state row per chat + one row per
> message). **KV** holds only the technical update-dedup flags. Long-term semantic memory lives in
> **Vectorize** + **Workers AI** (curated facts), enabled per chat (`/config rag on`).

**Contents:** [What the engine does](#what-the-engine-does) · [Engine commands](#engine-commands) ·
[Persona pack](#persona-pack) · [Localization](#localization) · [When the bot replies on its own](#when-the-bot-replies-on-its-own) ·
[Stack](#stack) · [Layout](#layout-src) · [Development](#development) · [Deployment](#deployment) ·
[Configuration](#configuration) · [For agents](#for-agents--contributors)

## What the engine does

- **LLM conversation** (streaming SSE) with a per-chat role (`/rp`) and model switching (`/model`).
- **Long-term memory (RAG):** curated facts in Vectorize + Workers AI, semantic recall into the reply.
- **Summaries:** an incremental `/summary` "what's new" digest + an optional daily summary via cron.
- **Vision:** describes sent photos/stickers, with a per-image description cache.
- **Per-chat config** via `/config`, memory control via `/memory`.
- **Persona system:** personality (voice, fun commands, quick replies, random throws, presets) is a
  swappable pack layered over a persona-free core (see [Persona pack](#persona-pack)).
- **Localization:** UI strings are externalized to locale files; language is per-chat (`/config lang`).
- Reliability: always `200 ok` (no webhook duplicates), dedup by `update_id`, critical failures go
  through `reportError` (log + admin alert).

## Engine commands

Commands are written with a slash (`/help`); in groups they can be addressed (`/help@<bot>`). Command
names are fixed by the engine/pack (there is no env-based renaming).

| Command | What it does |
|---|---|
| `/help` | Command list: the engine renders its base list and **appends** the active pack's help section below it. |
| `/info` | Chat status: role, active model, history size, number of custom settings. |
| `/summary` | Incremental "what's new" LLM digest since the last call (needs a few new messages). In supergroups its `HH:MM` timestamps become tap-to-jump links to the message at that minute. |
| `/rp` `<description>` / `off` / — | Set / clear / show the chat role. |
| `/config` `[key value]` / `reset` | Show or change chat settings (see [keys](#config-keys)). |
| `/model` `[id]` / `vision <id>` / `summary <id>` / `reset` | Model(s), price, balance; switch/reset. |
| `/memory` `add` / `list` / `del N` / `forget` / `dedupe` / `size_chars N` | Long-term memory + history. |
| `/lang` `[code]` / — | Show the current UI language + available locales, or switch (unknown code is rejected). |
| `/alias` `@user Name` / `del @user` / — | Set / remove / list per-chat display-name aliases (`username → name`). |
| `/stop` · `/resume` | Pause (commands only) and resume. |

> `/admin` is a **hidden** command (only usernames in `ADMIN_USERNAMES`, private chats only): inspect
> all sessions, statistics, run any command remotely in another chat. It is never advertised.

**Fun commands** (jokes, dice, "mood", etc.) come from the persona pack and are documented in its repo,
not here.

## Persona pack

The core contains **no** personality content. The personality is a pack the engine reads at runtime
through the registry `src/persona/registry.ts` (`setPersona`/`getPersona` + getters). The
`PersonaPack` contract:

| Part | What it provides |
|---|---|
| `wakeWords` | words that wake the bot in groups (substring, any case) — part of the pack's non-localized identity |
| `usernameAliases` | pack-static `username (lowercase, no @) → display name` defaults (per-chat `/alias` entries merge **over** them — see below) |
| `commands` | extra commands (`{type, defaultCmd, handler, llm?, skipHistory?, state?}`) |
| `quickReplies` | trigger replies (substring / token table, gated by `cfgFlag`×`probKey`); `responses`/`tokenTable` values are **i18n keys** resolved per `cfg.lang` (see below) |
| `randomThrows` | random "throws" (weighted pick) |
| `config` | own schema keys, groups, presets, defaults (`defaults(env)`) |
| `buildPromptLines` / `infoLines` / `adminFlags` | optional hooks: extra system-prompt / `/info` / `/admin` lines derived from the pack's own state |

All fields are **optional** (the neutral pack is `{}`). **Every localized string a pack produces** lives
in the **pack's own `i18n/<lang>.json` folder** (discovered and merged into the engine i18n by the same
generate step; see [Localization](#localization)), not on the pack object: displayed command/status
output, prompt-builder instruction lines, prompt seeds / synthetic user-turns, the injected flavor/state
lines, **and** the quick-reply responses. The former `PersonaTexts` (default voice, language line,
fallback strings, `/help` text, `/info` title) plus the `/config` descriptions / group titles / preset
descriptions are stored under `persona_*` and config keys; `getPersonaTexts(lang)` rebuilds the
`PersonaTexts` per call via `t()` with neutral defaults. The **only** things that stay inline in a pack
are (a) the non-localized identity (`wakeWords` / `usernameAliases`) and (b) input-matching triggers —
the quick-reply test regexes and the `tokenTable` **keys** — which match incoming messages rather than
being output. Accordingly a `QuickReplyRule`'s `responses` is an i18n **key** whose value is the candidate
array, and `tokenTable` maps an input token → an i18n key; `tryQuickReply` resolves them per `cfg.lang`
via `tList` → `pickOne`.

A command may declare a `state` slice — a piece of the generic per-chat **`personaState`** JSON slot
whose schema the persona defines. The engine merges the defaults from all commands' `state` slices and
calls the pack's hooks **without knowing their semantics** (so "mood", "energy", or any per-chat
persona state lives entirely in the pack — the engine stays neutral).

Composition is **eager**: the pack is registered by a side-effect `import "./persona/active"` placed
**first** in `index.ts`. **`src/persona/active.ts` is generated** by `scripts/select-persona.mjs`
(from `prepare`/`pretest`/`precheck`/`predev`) from the **`PERSONA_PACK`** env-path:

- `PERSONA_PACK=<path to a pack dir of *.ts>` → the script copies them into `src/persona/_pack/` and
  writes `active.ts` = `import "./_pack"`;
- unset → `active.ts` = `import "./default"` (neutral engine: a generic voice, no fun commands).

`active.ts` and `_pack/` are **gitignored**, so the repo carries **zero** personality content (the
engine never names a specific pack). The per-call persona readers degrade cleanly under the neutral
pack (`personaless.test.mjs`).

```bash
# locally with a pack:
PERSONA_PACK=../my-pack npm test       # (+ copy tests/*.persona.test.mjs next to the core tests)
# without a pack — neutral engine:
npm test
```

To re-skin the bot, supply your own pack (a dir of `*.ts` matching the `PersonaPack` contract) via
`PERSONA_PACK`. Deployment lives in a **separate pack project** that pulls this engine and injects its
own `PERSONA_PACK`.

## Localization

UI strings are externalized to JSON locale files in `src/i18n/` and resolved through
`t(lang, key, ...args)` (`src/i18n/index.ts`). A value is a string or an array of lines (joined with
`\n`); `{0}`/`{1}` are positional args; a missing key falls back to the default language and then to the
key itself. The default UI language is **English** (`DEFAULT_LANG = "en"`, env `BOT_LANG`, default `en`)
— a localized deployment opts in by setting `BOT_LANG` (e.g. a Russian deployment sets `BOT_LANG=ru`).
`tList(lang, key)` returns a raw array (no fallback) for input-matching vocabularies; `tRaw(lang, key)`
returns a single string or `undefined` (with lang→default fallback).

- **Per chat:** `/lang <code>` or `/config lang <code>` overrides the language for that chat; an unknown
  code is **rejected** (the language stays unchanged), not silently accepted.
- **Persona texts** are localized in the **pack's own `i18n/<lang>.json` folder** (merged into the engine
  i18n by the generate step), so the personality is multilingual independently of the engine UI language.
- **Name aliases:** per-chat aliases (set by `/alias`, stored in the reserved `chats.config.aliases` object)
  merge **over** the pack-static `usernameAliases` in the name resolvers (`resolveUserName`), so a `/alias`
  also fixes the `[from:Name]` tag the model sees in history (not just displayed `/dice`-style names).
- **Neutral / personaless fallbacks** are engine i18n keys (`neutral_fallback_error`,
  `neutral_fallback_no_credits`, `neutral_target_name`, `neutral_info_title`), so a no-pack deployment
  still localizes per `cfg.lang`. Other engine-only strings follow suit: `/config` booleans render via
  `cfg_on`/`cfg_off`, the `reportError` admin alert via `err_admin_alert`, and `getUserName` falls back to
  `name_user_fallback`.

**Locales are discovered from the folders — the code hardcodes no language list.**
`scripts/select-persona.mjs` scans `src/i18n/*.json` (engine) and the staged pack's
`src/persona/_pack/i18n/*.json` (persona) and generates the **gitignored** `src/i18n/_generated.ts`, a
static import manifest (Cloudflare Workers have no runtime fs, so locales are baked in at generate time).
The filename minus `.json` is the locale code, and `LOCALES = Object.keys(MESSAGES)` (engine ∪ persona
tables merged per locale). **Adding a language = drop a `src/i18n/<code>.json` file** — `<code>` is then
immediately usable via `/lang <code>` or `/config lang <code>` with no code change and no manual
registration.

> **Every** localized string a pack produces — displayed command/status output **and** its model-input
> strings (prompt-builder instructions, prompt seeds, flavor arrays injected into the system prompt) **and**
> its quick-reply responses — is localized via `t()`/`tList()` from its `i18n/<lang>.json`. Only the
> non-localized identity (`wakeWords`/`usernameAliases`) and the input-matching triggers (quick-reply test
> regexes, `tokenTable` keys) stay inline in the pack code, since they match incoming messages rather than
> being output.

## When the bot replies on its own

- **Private chats** — always.
- **Groups** — on a mention (`@<bot>` or a pack wake-word) or by random chance (`answer_prob`).
- **Quick replies / random throws** — persona content (toggled by `/config` keys), documented in the
  pack repo.
- **Photos/stickers:** if vision is on (`/config vision on`) the bot looks, describes and reacts; a
  trigger word in the caption (`VISION_HD_WORDS`) bumps the detail; descriptions are cached.

## Stack

- **Cloudflare Worker** (strict TypeScript, ES-modules in `src/`), deployed via **Wrangler** + GitHub Actions.
- **OpenRouter** — LLM replies (streaming SSE), price/balance, optional separate vision/summary models.
- **D1** (`DB`) — primary store: one state row per chat + one row per message.
- **Vectorize** + **Workers AI** — long-term memory (RAG, curated facts).
- **KV** (`KV`) — technical update-dedup flags (`dedup:*`).
- **Vitest** — offline tests (~315 neutral / ~364 with a pack) on a real D1 (`node:sqlite` shim) +
  mocked `fetch` / SSE / AI / Vectorize.

## Layout (`src/`)

Typed ES-modules, layered bottom-up (each imports only from lower layers; no cycles):

| Module | Purpose |
|---|---|
| `types.ts` | shared domain types |
| `constants.ts` | limits, timeouts, delimiters |
| `i18n/` | locale JSON files (folder-discovered) + the `t()`/`tList`/`tRaw` resolver |
| `utils.ts` | pure helpers: `makeCtx`, `shouldAnswer`, visual/parsing/name helpers, time formatters |
| `prompts.ts` | system-prompt assembly (engine builders: default/reply/vision) |
| `rag.ts` | Vectorize/Workers AI: embed/upsert/query/delete |
| `persona/registry.ts` | persona contract + active-pack singleton; `persona/active.ts`, `persona/default.ts` |
| `storage.ts` | chat state (D1 row) + write-through history + `memories` |
| `telegram.ts` | MarkdownV2 converter + Telegram I/O + `reportError` |
| `llm.ts` | OpenRouter: `callOpenRouter` (SSE), history → messages, price/balance |
| `config.ts` | `CONFIG_SCHEMA` (core ∪ pack), config layering, `/config`/`/help`/status builders |
| `vision.ts` | photos/stickers: vision request, description cache, albums |
| `summary.ts` · `curation.ts` | incremental summary · fact extraction into long-term memory |
| `commands.ts` | engine command plugins + the `COMMANDS` map (core ∪ pack), hidden `/admin`, `tryCommand` |
| `flow.ts` | update routing + `handleTelegramMessage` + cron |
| `index.ts` | entry (`export default { fetch, scheduled }`) + the `export *` barrel for tests |

Engine commands are themselves plugins (the same `RegisteredCommand` contract as the pack): the engine
registers them via `setEngineCommands`, and `getAllCommands()` = engine ∪ persona drives
`COMMANDS`/`TECH_COMMANDS`/`LLM_COMMANDS`/`buildCommandRegex` from a single list.

## Development

```bash
npm install
npm test                          # vitest run — offline, neutral pack (~315 core tests)
PERSONA_PACK=../my-pack npm test  # with a pack (+ copy its tests/*.persona.test.mjs next to the core tests)
npm run typecheck                 # tsc --noEmit (strict); npm run check is an alias
npm run dev                       # wrangler dev — local run
```

Tests and the harness live in `.claude/skills/testing-worker/` (see the **testing-worker** skill). A
new testable core function just needs to be `export`ed from its module — the `index.ts` barrel
re-exports it automatically. Persona-specific tests (`*.persona.test.mjs`) live in the pack repo.

## Deployment

The engine is a **library — it does not deploy itself.** A push to `master` triggers GitHub Actions
(`.github/workflows/ci.yml`) which only runs typecheck + the neutral test suite — no deploy.
**Deployment lives in the consuming pack project**, which pulls this engine, injects its pack via
`PERSONA_PACK`, applies D1 migrations (before deploy — `wrangler deploy` alone does not apply them),
and runs `wrangler deploy` against its own resources/secrets.

- **Worker secrets** (write-only, survive deploys): `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`,
  `OPENROUTER_PROVISIONING_KEY` (optional — full balance via `/model`), `TELEGRAM_WEBHOOK_SECRET`
  (optional but recommended — webhook origin check, see below).
- The deployment's `wrangler.jsonc` holds the real `vars` + the `KV`, D1 `DB`, `AI`, `VECTORIZE` bindings.
- The Telegram webhook must point at the worker URL.
- **Webhook origin check (recommended):** set the `TELEGRAM_WEBHOOK_SECRET` secret and register the webhook
  with that token (`setWebhook` with `secret_token=…`). The worker then rejects any POST whose
  `X-Telegram-Bot-Api-Secret-Token` header doesn't match. Without it, anyone who learns the worker URL can
  forge Updates — and since `/admin` trusts `msg.from.username`, impersonate an admin. Unset → no check
  (backward-compatible), so set the secret **and** re-register the webhook together.

A manual `npx wrangler deploy` is an emergency fallback (apply migrations and stage the pack first).

## Configuration

Engine env vars live in the deployment's `wrangler.jsonc` → `vars` (all optional, with defaults):
models (`OPENROUTER_MODEL`/`OPENROUTER_VISION_MODEL`/`OPENROUTER_SUMMARY_MODEL`/`OPENROUTER_HOST`/`OPENROUTER_TITLE`),
`MAX_HISTORY_CHARS`, `MAX_TOKENS`, `ANSWER_PROB`, `ENABLE_VISION`, `ENABLE_REASONING`, `VISION_DETAIL`,
`VISION_HD_WORDS`, `ENABLE_RAG`, `RAG_TOP_K`, `RAG_MIN_SCORE`, `BOT_NAME`/`BOT_USERNAME`,
`BOT_LANG` (UI language, default `en`), `BOT_TZ` (IANA timezone for history timestamps and the
daily-summary cron gate, default `UTC`), `ADMIN_USERNAMES`, `ADMIN_USER_IDS`, `ADMIN_CHAT_IDS`, `LLM_LOG`.
Persona env (switches/probabilities) is set by the pack.

### `/config` keys

Configured **per chat** (`/config <key> <value>`). Booleans — `on`/`off`; probabilities — `0.0–1.0`.

| Key | Type | Purpose |
|---|---|---|
| `random` | bool | Allow the bot to reply on its own |
| `answer_prob` | float | Chance to reply to an arbitrary group message |
| `history_chars` | int | Short-memory size in characters (500–100000) |
| `model` · `vision_model` · `summary_model` | string | Chat models (`reset` — default) |
| `reasoning` | bool | Allow the model to "think" |
| `max_tokens` | int | Response length cap in tokens (256–65536, default 4000) |
| `vision` | bool | Look at sent photos/stickers |
| `rag` · `rag_top_k` · `rag_min_score` | bool/int/float | Long-term memory: on, how many facts, similarity threshold |
| `daily_summary` | bool | Daily summary at 08:00 (in the configured `BOT_TZ`, default UTC) |
| `lang` | string | UI language for this chat — any discovered locale; an unknown code is rejected |

Fun keys (triggers/throws/their probabilities) are added by the persona pack — see its repo. The
timezone is deployment-wide (`BOT_TZ` env), not a per-chat key.

### Admins

`ADMIN_USERNAMES` — a CSV list of Telegram usernames (without `@`) with access to the hidden `/admin`
(inspect sessions, statistics, remote command execution). Case-insensitive. **`ADMIN_USER_IDS`** — a CSV
list of immutable Telegram **user ids** with the same access (preferred — a username can be renamed or
re-registered by someone else). A user is an admin if they match *either* list. Both unset → **no admins**
(the engine hardcodes no personal username/id).

`/admin chat_cmd <id> <command>` runs **any** command in another chat (the reply goes to the admin).
Control commands persist their effect in the target chat; **LLM commands are a preview**: they are not
written to the target chat's history/memory/state.

## For agents / contributors

- **[CLAUDE.md](CLAUDE.md)** — core architecture, invariants (write-through history, dedup, layering),
  the persona-pack contract and procedures.
- `WORK.md` — the live to-do is kept **outside** this repo (shared between the engine and pack), driven
  by the `tracking-work` skill.
- Style: engine in English, types everywhere (strict, no implicit `any`), state edits go through mutators.
- Personality content lives in the persona-pack repo, not here.
