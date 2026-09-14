/* ================= MEMORY CURATION ================= */
// Curation of long-term memory facts. Two entry points:
//  • runMemoryCuration — extract durable facts from NEW interlocutor messages (id > boundary) and
//    RECONCILE them with what is already remembered. Under cfg.rag, best-effort. Called once a day
//    (cron) and before the /summary command — NOT on every bot reply.
//  • consolidateMemories — an explicit full pass over ALL of a chat's facts (/memory consolidate):
//    merge duplicates, resolve contradictions, drop the obsolete. No new messages involved.
//
// Both speak the same OPERATION PROTOCOL to the model (see parseMemoryOps). Memory is therefore not
// append-only: a stale fact gets replaced (UPDATE) or removed (DELETE) instead of piling up next to
// its newer version — which is what kept degrading recall into contradictions over months.
// Manual facts (/memory add) are never modified by an LLM pass: user intent wins; `/memory del` exists.

import {
  MEM_CURATION_MIN_NEW, MEM_MAX_FACTS_PER_RUN, MEM_MAX_FACT_CHARS, MEM_MAX_TOKENS,
  MEM_KNOWN_SHOWN, MEM_CONSOLIDATE_MAX, MEM_CONSOLIDATE_MAX_TOKENS, MEM_CONSOLIDATE_TIME_BUDGET_MS, MEM_CONSOLIDATE_PARALLEL, MEM_CONSOLIDATE_ROUND_FLOOR_MS, MEM_APPLY_PARALLEL, MEM_CONSOLIDATE_DIFF_MAX, MEM_UPDATE_MIN_RATIO,
} from "./constants";
import { messagesSince, addMemory, listMemories, updateMemory, deleteMemory } from "./storage";
import { runLLMWithHistory } from "./llm";
import { buildMemoryExtractionPrompt, buildMemoryConsolidationPrompt } from "./prompts";
import { isFallbackMessage } from "./utils";
import { t, tList, DEFAULT_LANG } from "./i18n";
import type { Ctx, Memory } from "./types";

/* ---------- protocol ---------- */

export interface MemoryOps {
  adds: string[];
  updates: { id: number; text: string }[];
  deletes: number[];
}

export interface ApplyResult { added: number; updated: number; deleted: number }

// A known fact as shown to the model: `[id] text`. Only ids in this list may be UPDATEd/DELETEd.
export interface KnownFact { id: number; text: string; source: string }

const RE_ADD    = /^add\s*:\s*(.*)$/i;
// The model may echo ids the way it saw them — `[182]` — or as `#182`; DELETE may list several ids.
const RE_UPDATE = /^update\s+#?\[?\s*(\d+)\s*\]?\s*:\s*(.*)$/i;
const RE_DELETE = /^delete\s+([#\[\]\d,\s]+)$/i; // ids extracted with /\d+/g
const RE_OP_WORD = /^(?:delete|update)\b/i;         // a protocol line that failed to parse must never become an ADD

// Normalize one candidate fact line: strip a real list marker, drop headings/refusals, cap length.
// Returns "" when the line carries no fact. Shared by the plain-line (ADD) path and UPDATE texts.
function cleanFactLine(rawLine: string, refusalStarts: string[], refusalContains: string[]): string {
  // Strip ONLY a real list marker: a bullet or a short ordinal with a delimiter.
  // `1990` is NOT a marker (no delimiter after the digits) → do not mangle a fact starting with a number.
  const line = rawLine.replace(/^\s*(?:[-*•·]+|\d{1,3}[.)\]])\s*/, "").trim();
  if (!line) return "";
  if (line.endsWith(":")) return ""; // heading line (e.g. "Here are facts:", "Extracted facts:" …)
  const norm = line.toLowerCase().replace(/[.!?]+$/, "").trim();
  // Refusals: locale markers (start-anchored words + whole phrases) + universal English/abbrev forms.
  if (refusalStarts.some(w => norm === w || norm.startsWith(w + " "))
      || refusalContains.some(w => norm.includes(w))
      || norm.includes("no facts") || ["none", "empty", "n/a"].includes(norm)) return "";
  return line.slice(0, MEM_MAX_FACT_CHARS);
}

const normKey = (s: string): string => s.trim().toLowerCase();

// Parse the model's output into operations. Tolerant by design:
//  • `ADD: text`, `UPDATE <id>: text`, `DELETE <id>` — the protocol (case-insensitive keywords);
//  • any other non-empty line is treated as a plain ADD — so a model that ignores the protocol
//    degrades exactly to the old append-only behaviour, never to silence.
// Rules: an id must be one of `known` (the facts the model was shown) — anything else is a
// hallucinated reference and is dropped; `manual` facts are protected from UPDATE/DELETE; an UPDATE
// whose new text already exists as another fact is a MERGE → becomes a DELETE of the updated id;
// ADD texts are deduped against known facts and within the batch and capped at `maxAdds`.
export function parseMemoryOps(
  out: string,
  known: KnownFact[] = [],
  lang: string = DEFAULT_LANG,
  maxAdds: number = MEM_MAX_FACTS_PER_RUN,
): MemoryOps {
  const refusalStarts = tList(lang, "mem_refusal_starts");
  const refusalContains = tList(lang, "mem_refusal_contains");
  const byId = new Map<number, KnownFact>(known.map(k => [k.id, k]));
  const seen = new Set(known.map(k => normKey(k.text)));
  const ops: MemoryOps = { adds: [], updates: [], deletes: [] };
  const touched = new Set<number>(); // an id gets at most one op per pass (first wins)

  for (const rawLine of String(out ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let m: RegExpMatchArray | null;
    if ((m = line.match(RE_DELETE))) {
      for (const idStr of m[1].match(/\d+/g) || []) {
        const id = Number(idStr);
        const k = byId.get(id);
        if (!k || k.source === "manual" || touched.has(id)) continue;
        touched.add(id);
        ops.deletes.push(id);
      }
      continue;
    }
    if ((m = line.match(RE_UPDATE))) {
      const id = Number(m[1]);
      const k = byId.get(id);
      if (!k || k.source === "manual" || touched.has(id)) continue;
      const text = cleanFactLine(m[2], refusalStarts, refusalContains);
      if (!text) continue;
      const key = normKey(text);
      touched.add(id);
      if (key === normKey(k.text)) continue;      // no-op: same text
      if (seen.has(key)) { ops.deletes.push(id); continue; } // MERGE into the existing twin
      // An UPDATE that shrinks a fact to less than half its length is compression, not a correction (the model
      // dropping dosages, names, details) — skip it; the original stays intact. A genuine rewording keeps the substance.
      if (text.length < k.text.length * MEM_UPDATE_MIN_RATIO) continue;
      seen.add(key);
      ops.updates.push({ id, text });
      continue;
    }
    if (RE_OP_WORD.test(line)) continue; // e.g. `UPDATE 12 text` (no colon) or `DELETE all` — not a fact, drop it
    const addM = line.match(RE_ADD);
    const text = cleanFactLine(addM ? addM[1] : line, refusalStarts, refusalContains);
    if (!text) continue;
    const key = normKey(text);
    if (seen.has(key)) continue; // dedup against known facts and within the batch
    seen.add(key);
    if (ops.adds.length >= maxAdds) continue;
    ops.adds.push(text);
  }
  return ops;
}

// Back-compat wrapper: the old "lines → new facts" parser. Kept for callers/tests that only care about
// additions; ops on ids are ignored here (no ids were shown).
export function parseExtractedFacts(out: string, existing: string[] = [], lang: string = DEFAULT_LANG): string[] {
  const known = existing.map((text, i) => ({ id: -(i + 1), text, source: "auto" }));
  return parseMemoryOps(out, known, lang).adds;
}

// Apply parsed operations to storage (D1 rows + Vectorize vectors). Deletes first, then updates, then
// adds — so a merge that deletes an id never races its own update. Best-effort per op.
// Ops of one phase are independent (distinct ids), so each phase runs CONCURRENTLY in chunks of
// MEM_APPLY_PARALLEL — a consolidation pass can emit dozens of ops, and applied one by one (D1 +
// Vectorize + an embed per UPDATE) they alone could push the webhook past its limit. Phase order is
// kept: deletes → updates → adds (a merge never races its own update).
async function eachConcurrently<T>(items: T[], fn: (x: T) => Promise<boolean>): Promise<number> {
  let n = 0;
  for (let i = 0; i < items.length; i += MEM_APPLY_PARALLEL) {
    const res = await Promise.all(items.slice(i, i + MEM_APPLY_PARALLEL).map(x => fn(x).catch(() => false)));
    n += res.filter(Boolean).length;
  }
  return n;
}
export async function applyMemoryOps(ctx: Ctx, ops: MemoryOps): Promise<ApplyResult> {
  const res: ApplyResult = { added: 0, updated: 0, deleted: 0 };
  res.deleted = await eachConcurrently(ops.deletes, (id) => deleteMemory(ctx, id));
  res.updated = await eachConcurrently(ops.updates, (u) => updateMemory(ctx, u.id, u.text));
  res.added = await eachConcurrently(ops.adds, async (text) => !!(await addMemory(ctx, text, "auto")));
  return res;
}

const toKnown = (rows: Memory[]): KnownFact[] => rows.map(r => ({ id: r.id, text: r.text, source: r.source }));

/* ---------- entry points ---------- */

// Extract durable facts from NEW messages (id > boundary), reconciling them with the remembered ones.
// Under cfg.rag, best-effort. Advance the _memUptoId boundary on LLM success (even with 0 ops).
export async function runMemoryCuration(ctx: Ctx): Promise<void> {
  if (ctx._preview) return; // /admin chat_cmd preview: writes are write-through (bypass flush), don't touch someone else's chat
  if (!ctx.cfg.rag) return;
  try {
    const since = ctx.chatData._memUptoId || 0;
    const { items, maxId } = await messagesSince(ctx.env, ctx.chatId, since);
    if (items.length < MEM_CURATION_MIN_NEW) return; // too little new content — don't invoke the LLM
    // Extract facts ONLY from interlocutor messages, not from the bot's own replies (its
    // vulgar remark is not a source of facts). Advance the boundary across the whole slice anyway.
    const userItems = items.filter(it => it.role === "user");
    if (!userItems.length) { ctx.chatData._memUptoId = maxId; ctx.chatData._dirty = true; return; }
    const all = toKnown(await listMemories(ctx.env, ctx.chatId));
    // The model is shown (and may reference) only the most recent facts — bounds prompt tokens.
    // Older facts are still deduped against on ADD; a full reconciliation is `/memory consolidate`.
    const shown = all.slice(-MEM_KNOWN_SHOWN);
    const out = await runLLMWithHistory(
      ctx.cfg,
      buildMemoryExtractionPrompt(ctx.cfg.lang, shown), // NEUTRAL prompt, no persona
      userItems,                                        // only new interlocutor messages
      t(ctx.cfg.lang, "mem_extract_user_turn"),
      ctx.msg,
      // Auxiliary call: tight response cap + reasoning off (a handful of short ops; no chain-of-thought needed).
      { forceAppendUser: true, ctx, modelOverride: ctx.cfg.summaryModel, maxTokens: MEM_MAX_TOKENS, reasoning: false }
    );
    if (isFallbackMessage(out)) return; // LLM error/timeout → don't advance the boundary (retried next time)
    // Ops may reference only the shown ids; ADD dedup runs against ALL known facts.
    const ops = parseMemoryOps(out, shown, ctx.cfg.lang);
    ops.adds = dedupAgainst(ops.adds, all);
    await applyMemoryOps(ctx, ops);
    ctx.chatData._memUptoId = maxId; // success (even 0 ops) → don't reprocess this slice
    ctx.chatData._dirty = true;
  } catch (e: any) {
    console.warn("memory curation failed", { chatId: ctx.chatId, err: e?.message || e });
  }
}

// Drop ADDs whose text is already remembered anywhere in the chat (beyond the shown slice).
function dedupAgainst(adds: string[], all: KnownFact[]): string[] {
  const seen = new Set(all.map(k => normKey(k.text)));
  return adds.filter(a => !seen.has(normKey(a)));
}

// Explicit full pass over the chat's facts: merge duplicates, resolve contradictions (newest wins),
// drop the obsolete. Works regardless of cfg.rag (an explicit user action, like /memory add).
// Returns the applied counts, or null when the LLM failed. `partial` = more facts than one pass covers.
export interface ConsolidateResult extends ApplyResult {
  total: number;   // facts in the chat when the command started
  checked: number; // facts covered so far, counting from the oldest (== total when the pass is complete)
  passes: number;  // LLM passes made in THIS invocation
  partial: boolean;
  /** what was (or, in a dry run, would be) changed — capped at MEM_CONSOLIDATE_DIFF_MAX entries in total */
  diff: ConsolidateDiff;
  /** dry run: nothing written, cursor untouched */
  dryRun: boolean;
}
export interface ConsolidateDiff {
  deleted: { id: number; text: string }[];
  updated: { id: number; from: string; to: string }[];
  more: number; // entries beyond the cap
}

// The resume cursor: the id of the last fact covered by a previous invocation. Kept in KV (best-effort,
// 1-day TTL): the next /memory consolidate continues AFTER it instead of re-checking the oldest window —
// without it a clean oldest window (the model answers NONE) would be re-checked forever and the facts
// beyond it would never be reached. 0 / missing = start from the oldest fact.
const consolidateCursorKey = (chatId: number | string): string => "consolidate:" + chatId;
async function readConsolidateCursor(env: Ctx["env"], chatId: number | string): Promise<number> {
  if (!env.KV) return 0;
  try { return Number(await env.KV.get(consolidateCursorKey(chatId))) || 0; } catch { return 0; }
}
async function writeConsolidateCursor(env: Ctx["env"], chatId: number | string, id: number): Promise<void> {
  if (!env.KV) return;
  try {
    if (id > 0) await env.KV.put(consolidateCursorKey(chatId), String(id), { expirationTtl: 86_400 });
    else await env.KV.delete(consolidateCursorKey(chatId));
  } catch { /* best-effort */ }
}

// /memory consolidate: LOOPS over the chat's facts in windows of MEM_CONSOLIDATE_MAX (oldest first), one
// LLM pass per window — up to MEM_CONSOLIDATE_PARALLEL windows per ROUND run concurrently — while under the time budget — the command runs inside the Telegram webhook, so it
// must answer within ~60 s. Progress is kept between invocations via the KV cursor (see above): a run that
// hits the budget (or a mid-loop LLM failure) reports a partial pass and the next run resumes after the
// last covered window; a run that reaches the end clears the cursor. Returns null only when NOTHING was
// done in this invocation (the very first pass failed) — a later failure keeps the progress made.
// budgetMs / parallel / roundMs are injectable for tests.
// Wait for the passes of a round, but not past `deadlineMs`: one stuck stream (a provider hiccup that only
// ends at LLM_TIMEOUT_MS) must not hold the whole round — and the Telegram webhook — hostage. A pass that
// has not settled by the deadline counts as failed for THIS run (its window is re-checked from the cursor
// next time); the underlying request still ends on its own timers, its late result is simply dropped.
async function settleWithin<T>(promises: Promise<T>[], deadlineMs: number): Promise<(T | undefined)[]> {
  const results: (T | undefined)[] = new Array(promises.length).fill(undefined);
  let pending = promises.length;
  if (!pending) return results;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, deadlineMs));
    promises.forEach((p, i) => p.then(
      (v) => { results[i] = v; },
      () => { results[i] = undefined; },
    ).finally(() => { if (--pending === 0) { clearTimeout(timer); resolve(); } }));
  });
  return results;
}
export async function consolidateMemories(ctx: Ctx, opts: { budgetMs?: number; parallel?: number; roundMs?: number; dryRun?: boolean } = {}): Promise<ConsolidateResult | null> {
  if (ctx._preview) return null;
  const budgetMs = opts.budgetMs ?? MEM_CONSOLIDATE_TIME_BUDGET_MS;
  const parallel = Math.max(1, opts.parallel ?? MEM_CONSOLIDATE_PARALLEL);
  const dryRun = !!opts.dryRun;
  const diff: ConsolidateDiff = { deleted: [], updated: [], more: 0 };
  const emptyDiff = (): ConsolidateDiff => ({ deleted: [], updated: [], more: 0 });
  const all = toKnown(await listMemories(ctx.env, ctx.chatId));
  const total = all.length;
  if (total < 2) return { added: 0, updated: 0, deleted: 0, total, checked: total, passes: 0, partial: false, diff: emptyDiff(), dryRun };

  const cursor = await readConsolidateCursor(ctx.env, ctx.chatId);
  let start = cursor > 0 ? all.findIndex(k => k.id > cursor) : 0;
  if (start < 0) start = 0; // a stale cursor past the newest fact → start over from the oldest

  const t0 = Date.now();
  let passes = 0, updated = 0, deleted = 0, lastRoundMs = 0, failed = false;
  // A pass cut by max_tokens (finish=length) ends in a partial line — drop it: applying a fragment as an
  // UPDATE would overwrite a fact with half a sentence. (A complete last line lost this way is just redone next time.)
  const passOver = async (slice: KnownFact[]): Promise<string> => {
    let truncated = false;
    const out = await runLLMWithHistory(
    ctx.cfg,
    buildMemoryConsolidationPrompt(ctx.cfg.lang, slice),
    [],
    t(ctx.cfg.lang, "mem_consolidate_user_turn"),
    ctx.msg,
      { forceAppendUser: true, ctx, modelOverride: ctx.cfg.summaryModel, maxTokens: MEM_CONSOLIDATE_MAX_TOKENS, reasoning: false,
        onMeta: (m) => { if (m.finishReason === "length") truncated = true; } }
    );
    if (!truncated || isFallbackMessage(out)) return out;
    const lines = out.split("\n");
    lines.pop();
    return lines.join("\n");
  };
  while (start < total && !failed) {
    // Never start a round that (judging by the previous one) would overrun the budget; the first always runs.
    if (passes > 0 && Date.now() - t0 + lastRoundMs >= budgetMs) break;
    // One ROUND = up to parallel windows whose LLM passes run CONCURRENTLY — windows are independent
    // (ops may only reference the ids shown in their own window), so a round costs the time of its
    // slowest pass, not the sum. Ops are applied in window order afterwards.
    const windows: KnownFact[][] = [];
    for (let s = start; s < total && windows.length < parallel; s += MEM_CONSOLIDATE_MAX) windows.push(all.slice(s, s + MEM_CONSOLIDATE_MAX));
    const r0 = Date.now();
    // The round may run until the budget is spent (never less than a floor, so a fast model always gets a
    // fair chance) — a window still in flight after that is treated as failed for this run.
    const deadline = opts.roundMs ?? Math.max(MEM_CONSOLIDATE_ROUND_FLOOR_MS, budgetMs - (Date.now() - t0));
    const outs = await settleWithin(windows.map(passOver), deadline);
    lastRoundMs = Date.now() - r0;
    for (let w = 0; w < windows.length; w++) {
      const out = outs[w];
      if (out === undefined || isFallbackMessage(out)) { failed = true; continue; } // failed or not settled in time → redone next run
      // A consolidation pass rewrites what exists; it is not a place to invent new facts.
      const ops = parseMemoryOps(out, windows[w], ctx.cfg.lang, 0);
      // Record the diff (texts come from the window the model saw) — the reply shows WHAT changed, so a
      // human reviews a short diff instead of the whole list. A dry run stops here: counts, no writes.
      const byId = new Map(windows[w].map(k => [k.id, k]));
      const room = () => diff.deleted.length + diff.updated.length < MEM_CONSOLIDATE_DIFF_MAX;
      for (const id of ops.deletes) { if (room()) diff.deleted.push({ id, text: byId.get(id)?.text ?? "" }); else diff.more++; }
      for (const u of ops.updates) { if (room()) diff.updated.push({ id: u.id, from: byId.get(u.id)?.text ?? "", to: u.text }); else diff.more++; }
      if (dryRun) { updated += ops.updates.length; deleted += ops.deletes.length; passes++; }
      else {
        const res = await applyMemoryOps(ctx, ops);
        updated += res.updated; deleted += res.deleted; passes++;
      }
      // The cursor must stay CONTIGUOUS: a window after a failed one is still applied (its ops are safe and
      // already paid for) but does not advance \`start\` — it gets re-checked from the cursor next time.
      if (!failed) start += windows[w].length;
    }
  }
  if (passes === 0) return null; // nothing achieved in this invocation → report the failure
  const partial = start < total;
  if (!dryRun) await writeConsolidateCursor(ctx.env, ctx.chatId, partial && start > 0 ? all[start - 1].id : 0); // start=0 → no contiguous progress → no cursor; a dry run never moves it
  return { added: 0, updated, deleted, total, checked: start, passes, partial, diff, dryRun };
}
