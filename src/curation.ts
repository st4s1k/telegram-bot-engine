/* ================= MEMORY CURATION ================= */
// Curation of long-term memory facts. One entry point: runMemoryCuration — extract durable facts from NEW
// interlocutor messages (id > boundary) and RECONCILE them with what is already remembered. Under cfg.rag,
// best-effort. Called once a day (cron) and before the /summary command — NOT on every bot reply.
//
// There is deliberately NO list-only "consolidation" pass: given nothing but the fact list, a model invents the
// passage of time («должна сделать MVP до зимы» → «сделала»), glues facts of different people and never
// converges (five runs, five different rewrites of the same facts — 2026-09-15). Every UPDATE here is grounded
// in NEW messages, i.e. in evidence; contradictions between old facts are handled at answer time by the dates
// on recalled facts (recall.ts), not by rewriting the store.
//
// The OPERATION PROTOCOL to the model (see parseMemoryOps): ADD and UPDATE. There is NO
// DELETE — an LLM pass never removes a fact. Recall is contextual (top-k by similarity), so a stale or
// trivial fact costs nothing, while a wrongly deleted one is gone for good — and live runs showed the
// model calling any two facts about the same person "duplicates". Only a human deletes (/memory del,
// /memory forget, the mechanical exact-text /memory dedupe). A fact that changed is UPDATEd in place.
// Manual facts (/memory add) are never modified by an LLM pass: user intent wins.

import {
  MEM_CURATION_MIN_NEW, MEM_MAX_FACTS_PER_RUN, MEM_MAX_FACT_CHARS, MEM_MAX_TOKENS,
  MEM_KNOWN_SHOWN, MEM_APPLY_PARALLEL, MEM_UPDATE_MIN_RATIO,
} from "./constants";
import { messagesSince, addMemory, listMemories, updateMemory } from "./storage";
import { runLLMWithHistory } from "./llm";
import { buildMemoryExtractionPrompt } from "./prompts";
import { isFallbackMessage } from "./utils";
import { t, tList, DEFAULT_LANG } from "./i18n";
import type { Ctx } from "./types";

/* ---------- protocol ---------- */

export interface MemoryOps {
  adds: string[];
  updates: { id: number; text: string }[];
}

export interface ApplyResult { added: number; updated: number }

// A known fact as shown to the model: `[id] text`. Only ids in this list may be UPDATEd.
export interface KnownFact { id: number; text: string; source: string }

const RE_ADD    = /^add\s*:\s*(.*)$/i;
// The model may echo ids the way it saw them — `[182]` — or as `#182`.
const RE_UPDATE = /^update\s+#?\[?\s*(\d+)\s*\]?\s*:\s*(.*)$/i;
// A protocol-shaped line that is not a valid UPDATE — a malformed one, or a DELETE (which does not exist:
// an LLM pass never deletes) — is dropped, never treated as an ADD.
const RE_OP_WORD = /^(?:delete|update|remove)\b/i;

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
//  • `ADD: text`, `UPDATE <id>: text` — the protocol (case-insensitive keywords);
//  • `DELETE …` is NOT an operation: the line is dropped (an LLM pass never deletes — see the header);
//  • any other non-empty line is treated as a plain ADD — so a model that ignores the protocol
//    degrades exactly to the old append-only behaviour, never to silence.
// Rules: an id must be one of `known` (the facts the model was shown) — anything else is a
// hallucinated reference and is dropped; `manual` facts are protected from UPDATE; an UPDATE whose
// new text already exists as another fact is a no-op (it used to be a merge = a delete of the updated
// id — the model abused it to "merge" unrelated facts about the same person); ADD texts are deduped
// against known facts and within the batch and capped at `maxAdds`.
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
  const ops: MemoryOps = { adds: [], updates: [] };
  const touched = new Set<number>(); // an id gets at most one op per pass (first wins)

  for (const rawLine of String(out ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = line.match(RE_UPDATE);
    if (m) {
      const id = Number(m[1]);
      const k = byId.get(id);
      if (!k || k.source === "manual" || touched.has(id)) continue;
      const text = cleanFactLine(m[2], refusalStarts, refusalContains);
      if (!text) continue;
      const key = normKey(text);
      touched.add(id);
      if (key === normKey(k.text)) continue;      // no-op: same text
      if (seen.has(key)) continue;                // the text already exists as another fact → nothing to do
      // An UPDATE that shrinks a fact to less than half its length is compression, not a correction (the model
      // dropping dosages, names, details) — skip it; the original stays intact. A genuine rewording keeps the substance.
      if (text.length < k.text.length * MEM_UPDATE_MIN_RATIO) continue;
      seen.add(key);
      ops.updates.push({ id, text });
      continue;
    }
    if (RE_OP_WORD.test(line)) continue; // `DELETE 12`, `UPDATE 12 text` (no colon) — not a fact, drop it
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

// Apply parsed operations to storage (D1 rows + Vectorize vectors): updates, then adds. Best-effort per op.
// Ops of one phase are independent (distinct ids), so each phase runs CONCURRENTLY in chunks of
// MEM_APPLY_PARALLEL — applied one by one (D1 + Vectorize + an embed per UPDATE) a batch of ops could
// stall the caller.
async function eachConcurrently<T>(items: T[], fn: (x: T) => Promise<boolean>): Promise<number> {
  let n = 0;
  for (let i = 0; i < items.length; i += MEM_APPLY_PARALLEL) {
    const res = await Promise.all(items.slice(i, i + MEM_APPLY_PARALLEL).map(x => fn(x).catch(() => false)));
    n += res.filter(Boolean).length;
  }
  return n;
}
export async function applyMemoryOps(ctx: Ctx, ops: MemoryOps): Promise<ApplyResult> {
  const res: ApplyResult = { added: 0, updated: 0 };
  res.updated = await eachConcurrently(ops.updates, (u) => updateMemory(ctx, u.id, u.text));
  res.added = await eachConcurrently(ops.adds, async (text) => !!(await addMemory(ctx, text, "auto")));
  return res;
}


/* ---------- entry points ---------- */

// Extract durable facts from NEW messages (id > boundary), reconciling them with the remembered ones.
// Under cfg.rag, best-effort. Advance the _memUptoId boundary on LLM success (even with 0 ops).
export async function runMemoryCuration(ctx: Ctx): Promise<void> {
  if (ctx._preview) return; // /admin chat <id> preview: writes are write-through (bypass flush), don't touch someone else's chat
  if (!ctx.cfg.rag) return;
  try {
    const since = ctx.chatData._memUptoId || 0;
    const { items, maxId } = await messagesSince(ctx.env, ctx.chatId, since);
    if (items.length < MEM_CURATION_MIN_NEW) return; // too little new content — don't invoke the LLM
    // Extract facts ONLY from interlocutor messages, not from the bot's own replies (its
    // vulgar remark is not a source of facts). Advance the boundary across the whole slice anyway.
    const userItems = items.filter(it => it.role === "user");
    if (!userItems.length) { ctx.chatData._memUptoId = maxId; ctx.chatData._dirty = true; return; }
    const all: KnownFact[] = (await listMemories(ctx.env, ctx.chatId)).map(r => ({ id: r.id, text: r.text, source: r.source }));
    // The model is shown (and may reference) only the most recent facts — bounds prompt tokens.
    // Older facts are still deduped against on ADD.
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
