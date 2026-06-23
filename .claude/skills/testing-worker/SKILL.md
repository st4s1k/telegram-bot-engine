---
name: testing-worker
description: Runs and extends the Vitest suite for the Фасол Telegram-bot Cloudflare Worker (src/). Use when changing the worker, adding or fixing a command/feature/bug, or before deploying — to run the tests, read failures, and add coverage for new behavior. Knows the mock-KV / mock-fetch / SSE harness, the assert-shim, and the test-export contract the worker exposes for unit tests.
---

# testing-worker

The worker lives in `src/` (a Cloudflare Worker bridging Telegram ↔ OpenRouter, deployed via wrangler). Its test suite (~300 tests) runs fully offline — chat data lives in a **real D1** (a `node:sqlite` shim, same SQLite engine as D1, schema from `migrations/0001_init.sql`); `fetch` and KV are mocked. No network, no real Telegram/OpenRouter/workerd.

## Layout

The suite is **split across several `*.test.mjs` files** so Vitest runs them **in parallel** (one worker per file):

- **`harness.mjs`** — the shared mocks + factories. It re-exports everything from the worker entry barrel (`export * from "../../../src/index.ts"`), re-exports `test`/`describe`/`beforeEach` from `vitest` and a `WORKER` default, and exposes an **`assert` shim** (maps `assert.equal/ok/deepEqual/match/notEqual/throws` → `expect`, so the test bodies read like `node:assert` without importing it). Does NOT match `*.test.mjs`, so the runner never executes it.
- **`*.test.mjs`** — one file per area: `utils-markdown`, `config`, `prompts-storage`, `llm`, `telegram`, `vision`, `flow`, `commands`, `admin-routing`. Each starts with one import of everything from `./harness.mjs` and holds the matching `describe(...)` blocks.

Vitest runs files in isolated workers, so the harness's global `fetch`/`console` overrides and `beforeEach` reset don't leak across files.

We use **plain Vitest (node environment)**, NOT `@cloudflare/vitest-pool-workers`: D1 is exercised via a **`node:sqlite` shim** (real SQLite — correct SQL incl. window functions — without booting workerd, and without the pool's Cyrillic-test-name `MF-Vitest-Source` warnings / slower startup). A spike confirmed pool-workers works but isn't worth the harness rewrite + speed cost here; the shim gives real-D1 fidelity on one fast runner. If you ever need full workerd integration tests, add a separate pool-workers project — don't move this suite into it.

## Run

From the repo root:

```
npm test         # vitest run  — all green required before any deploy
npm run typecheck # tsc --noEmit — strict types, zero errors
npm run check     # tsc --noEmit (alias of typecheck)
```

`npm test` ends with `Tests N passed`. Vitest config (`vitest.config.mts`) points `include` at `.claude/skills/testing-worker/*.test.mjs`.

## How the worker is made testable (test-export contract)

Cloudflare runs only `export default { fetch }`. To unit-test internals, the entry **`src/index.ts` is a barrel**: after the default export it does `export * from "./constants"`, `"./utils"`, …, `"./flow"` — re-exporting every module's named exports. These re-exports are **inert at runtime** (the Worker uses only the default export).

**When you add a function you want to unit-test, just `export` it from its own module** (`constants.ts`/`utils.ts`/`storage.ts`/…). The `export *` barrel in `index.ts` picks it up automatically — no central list to maintain. If a name is *not* exported from its module, the test imports `undefined` (ReferenceError). `harness.mjs` imports the worker via `../../../src/index.ts`; Vitest transforms TS/ESM. (Caveat: `export *` requires names be **unique across modules** — a collision is a compile error.)

## The harness (harness.mjs)

`harness.mjs` registers one global `beforeEach(() => { resetFetch(); clearConsole(); restoreRandom(); })`. Building blocks — all imported into each test file from `./harness.mjs`:

- **`assert`** — shim over Vitest `expect` (`equal`→`toBe`, `deepEqual`→`toEqual`, `ok`→`toBeTruthy`, `match`→`toMatch`, `notEqual`→`not.toBe`, `throws`→`toThrow`). Use it exactly like `node:assert/strict`.
- **`makeEnv(over?, kvInit?, kvOpts?)`** → an `env` with a fresh **`DB`** (real D1 via `node:sqlite`, schema applied) + a mock `KV` namespace (`get`/`put`/`delete`/`list`) + a mock **`AI`** (Workers AI) and **`VECTORIZE`** (Vectorize) binding for RAG + token/key defaults. `env._db`/`env._kv`/`env._ai`/`env._vec` exposed for inspection. `kvInit` seeds raw KV blobs (now only for dedup tests).
- **`seedChat(env, id, cd)`** → seed a chat into D1: state (`flushChatData`) + history rows. Use this instead of `kvInit` for storage/flow/admin tests. **`dbChat(env, id)`** / **`dbHistory(env, id)`** → read the D1 `chats` row / `messages` for assertions.
- **`makeAI({dim})`** → deterministic embed mock (char-histogram → L2-normalized; `dim=8` in tests, prod is 1024 — only top-K ordering matters). Records `.calls`; throws on missing `inputs.text` (mirrors the strict bge-m3 contract). **`makeVectorize(seed?)`** → in-memory cosine top-K index (`upsert`/`insert`/`query` with namespace pre-filter + `returnMetadata`/`returnValues` gating/`deleteByIds`/`getByIds`); `.store` exposed. **`seedMemories(env, id, items)`** (items `[{mem_id, text, source?}]`) → seed curated-fact vectors in `mem:<id>` for recall tests; **`dbMemories(env, id)`** → read the `memories` rows for assertions. Long-term memory = curated facts (auto-extracted on reply + `/memory add`), not raw messages; recall/curation gate on `cfg.rag` (default OFF, turn on with `makeEnv({ ENABLE_RAG: "true" })` — env var keeps the `ENABLE_` prefix, config key is bare `rag`), while `addMemory` embeds regardless of the flag.
- **`makeMsg(o?)`** → a Telegram message. Keys: `text`, `caption`, `chatType` (`"private"`/`"group"`), `chatId`, `chatTitle`, `from`/`username`/`firstName`, `photo`, `sticker`, `reply_to_message`, `media_group_id`, `message_id`.
- **`makeCtxFor(msg, env, chatData?)`** → the `ctx` the worker passes around (`getGlobalConfig` → `mergeConfig` → `makeCtx`). Default `chatData` is `DEFAULT_CHAT_DATA()`; pass `{ ...DEFAULT_CHAT_DATA(), config: { vision: true } }` to flip per-chat settings.
- **`photoSizes(uidBig?, {sameUid?})`** → a 3-element Telegram `photo` array; `photoCacheKey` resolves to `uidBig`.
- **`FETCH`** — the mock `globalThis.fetch` router. A **stable singleton** (safe to destructure); state resets each test. Override with `FETCH.set(name, responder)` where name ∈ `chat` (OpenRouter `/chat/completions`), `model`, `key`, `credits`, `send`, `chatAction`, `getFile`, `getChat`. Inspect with `FETCH.calls`, `FETCH.sends()`, `FETCH.of(substr)`, `FETCH.chatBody()`. `newFetch()` resets mid-test (returns the same `FETCH`).
- **`sse(deltas, {cost?, ok?, status?, raw?, splitAcrossChunks?})`** → streaming OpenRouter SSE response. `sse(["при","вет"])` streams `"привет"`; `{cost: 0.002}` adds a usage chunk; `{splitAcrossChunks:true}` tests SSE buffering; `{ok:false,status:402}` for error paths.
- **`jsonResp(obj, {ok?, status?})`** → non-streaming JSON response.
- **`stubRandom(...values)`** → deterministic `Math.random`. Always stub for anything probabilistic (quick replies, `shouldAnswer` random branch, `roll`, `pickRandomRandomKind`, `pickOne`).
- **`CONSOLE`** — captured `{log,warn,error}` arrays (assert on these instead of seeing the worker's expected-warning noise).

## Adding a test

Put it in the **`*.test.mjs` whose area matches** (new `/command` → `commands.test.mjs`; routing/webhook → `admin-routing.test.mjs`; markdown/utils → `utils-markdown.test.mjs`) inside the relevant `describe(...)`. Every file already imports the full surface from `./harness.mjs` — just write the test; only export a brand-new helper from `harness.mjs` if you add one. New area grown large → its own `*.test.mjs` (more files = more parallelism; the config glob picks it up). Shapes:

```js
test("...", () => { assert.equal(lastToken("это 300!"), "300"); });

test("...", async () => {
  const ctx = makeCtxFor(makeMsg({ chatType: "private", text: "хай" }), makeEnv());
  FETCH.set("chat", () => sse(["ответ"]));
  await handleChatMessage(ctx);
  assert.ok(FETCH.sends()[0].body.text.includes("ответ"));
});

// whole webhook
const res = await WORKER.fetch({ method: "POST", json: async () => update }, env, { waitUntil(){} });
```

Tests assert the **current** behavior. When you change behavior intentionally, update the affected test in the same change.

## Gotchas (cost real debugging)

- `buildCommandRegex` **caches by `botUsername` only**, ignoring `*_CMD` env overrides. To test a custom command name, use a **unique `BOT_USERNAME`** so the cache compiles fresh.
- `parseConfigValue` **bool** branch does `toLowerCase()` but **no `trim()`** — `" on "` is invalid; only the **string** branch trims.
- `getChatData` keeps `photoCache` if `typeof === "object"`, so an **array passes** — coercion to `{}` only fires for strings/null/numbers.
- `flushChatData` persists `_name || title || ""`, so an empty `_name` **falls back to the legacy `title`**.
- `toMarkdownV2` on an unterminated ```` ``` ```` greedily makes an empty inline `` `` `` from the first two backticks — assert the real output.
- `toLLMMessages(..., null, {forceAppendUser:true})` throws (reads `null.from`); in practice `msg` is always real.
