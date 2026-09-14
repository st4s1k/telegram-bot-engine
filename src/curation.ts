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
  MEM_KNOWN_SHOWN, MEM_CONSOLIDATE_MAX, MEM_CONSOLIDATE_MAX_TOKENS,
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
const RE_UPDATE = /^update\s+(\d+)\s*:\s*(.*)$/i;
const RE_DELETE = /^delete\s+(\d+)\s*$/i;

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
      const id = Number(m[1]);
      const k = byId.get(id);
      if (!k || k.source === "manual" || touched.has(id)) continue;
      touched.add(id);
      ops.deletes.push(id);
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
      seen.add(key);
      ops.updates.push({ id, text });
      continue;
    }
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
export async function applyMemoryOps(ctx: Ctx, ops: MemoryOps): Promise<ApplyResult> {
  const res: ApplyResult = { added: 0, updated: 0, deleted: 0 };
  for (const id of ops.deletes) {
    if (await deleteMemory(ctx, id)) res.deleted++;
  }
  for (const u of ops.updates) {
    if (await updateMemory(ctx, u.id, u.text)) res.updated++;
  }
  for (const text of ops.adds) {
    if (await addMemory(ctx, text, "auto")) res.added++;
  }
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
export async function consolidateMemories(ctx: Ctx): Promise<(ApplyResult & { total: number; partial: boolean }) | null> {
  if (ctx._preview) return null;
  const all = toKnown(await listMemories(ctx.env, ctx.chatId));
  const total = all.length;
  if (total < 2) return { added: 0, updated: 0, deleted: 0, total, partial: false };
  // One pass covers a bounded slice (oldest first — that is where the stale layers accumulate).
  const slice = all.slice(0, MEM_CONSOLIDATE_MAX);
  const out = await runLLMWithHistory(
    ctx.cfg,
    buildMemoryConsolidationPrompt(ctx.cfg.lang, slice),
    [],
    t(ctx.cfg.lang, "mem_consolidate_user_turn"),
    ctx.msg,
    { forceAppendUser: true, ctx, modelOverride: ctx.cfg.summaryModel, maxTokens: MEM_CONSOLIDATE_MAX_TOKENS, reasoning: false }
  );
  if (isFallbackMessage(out)) return null;
  // A consolidation pass rewrites what exists; it is not a place to invent new facts.
  const ops = parseMemoryOps(out, slice, ctx.cfg.lang, 0);
  const res = await applyMemoryOps(ctx, ops);
  return { ...res, total, partial: total > slice.length };
}
