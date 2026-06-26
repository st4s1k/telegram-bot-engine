---
name: tracking-work
description: The standard procedure for any work request on this Telegram bot engine (Cloudflare Worker, TypeScript in src/) — feature, command, fix, refactor, or tweak. Records the task and its subtasks in WORK.md as a live to-do list, implements it, type-checks + runs the Vitest suite, commits, and pushes to master — which triggers the GitHub Actions CI/CD that applies D1 migrations and deploys. Removes the task from WORK.md once every subtask is done. Use whenever the user asks for a change to this project.
---

# tracking-work

Run this loop for **every** change request to the worker (`src/`). `WORK.md` (repo root) is the single source of truth for what is in flight, and nothing ships untested or uncommitted.

Steps are ordered and gated — do not skip ahead. Step 3 is a hard gate (types + tests green). **This repo is a library — it does not deploy.** A push to `master` triggers GitHub Actions (`.github/workflows/ci.yml`) which re-runs the gate (typecheck + tests on the neutral persona). So Claude **commits and pushes**; deployment is the consuming deployment/pack project's job.

## 1. Record the task in WORK.md

Read `WORK.md`. Break the request into a task with concrete checkbox **subtasks** and add it under **`## 🔧 В работе`**. If the user gave several requests, the one you start now goes under `В работе`; the rest go under **`## 📋 Очередь`**.

```markdown
## 🔧 В работе

- [ ] <Короткое название задачи>
  - [ ] <подзадача 1>
  - [ ] <подзадача 2>

## 📋 Очередь

- [ ] <Будущая задача> — <одна строка контекста>
```

Make "add/adjust tests", "commit", and "push" their own subtasks — they're part of the definition of done.

## 2. Implement

Do the work in `src/` (TypeScript — **types everywhere**: annotate every function signature and exported binding; no implicit `any`). Tick each subtask `- [x]` in `WORK.md` as you finish it.

## 3. Type-check + tests — hard gate

Both must be green before committing (use the **`testing-worker`** skill for the test details):

```
npx tsc --noEmit     # strict types — zero errors
npm test             # vitest run — all green
```

- New behavior → add/adjust tests for it. If you added a unit-testable function, export it so the harness can import it.
- Red → fix code or test before moving on. Never push with failing/skipped tests or type errors — CI runs the same gate and a red push fails the deploy.

## 4. Commit

Commit the tested state. This is a local, reversible action; do it without waiting for confirmation.

```
git add -A
git commit -m "<imperative summary of the change>"
```

End the commit message body with the standard Co-Authored-By trailer. Don't commit if the tree is dirty with unrelated changes — stage only this task's files.

## 5. Push → CI

The user has **durably authorized Claude to push to `master`** (`Bash(git push:*)` is allow-listed in `.claude/settings.json`). **Push yourself** after the gate + commit; don't ask for per-push confirmation. State in one line what's shipping.

```
git push
```

The push triggers **`.github/workflows/ci.yml`**: `npm ci` → typecheck + tests on the **neutral** persona (no `PERSONA_PACK` → `src/persona/active.ts` = `import "./default"`). **This repo is a library — the engine does not deploy itself.** Deployment lives in the consuming **deployment/pack project**, which pulls this engine, injects its persona pack via the `PERSONA_PACK` env-path, and runs `wrangler deploy` against its own Cloudflare resources (it owns the real `wrangler.jsonc`, migrations-apply ordering, secrets and the worker).

**Verify CI** (don't assume green): check the run and confirm it succeeded.

```
gh run list --limit 1                 # latest run + status
gh run watch                          # follow the in-progress run to completion
```

If CI fails: read the logs (`gh run view --log-failed`), fix, and push again.

## 6. Update WORK.md

When **all** subtasks of a task are `- [x]`, **remove that task block from `WORK.md`** (and commit/push that prune too). Then promote the next `## 📋 Очередь` item into `## 🔧 В работе` if any. Partly-done tasks stay in `В работе` with progress ticked.
