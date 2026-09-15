/* ================= RECALL (hybrid long-term-memory retrieval) ================= */
// How facts get from the `memories` table into a reply. Three steps, each best-effort (a failure
// degrades to the previous behaviour, never breaks the reply):
//
//  1. QUERY REWRITE (`rewriteRecallQuery`): the user's message is often not a standalone question —
//     «а что у него с зубами?» carries no name, «и когда это было?» carries nothing at all. A cheap LLM
//     call (summary model, reasoning off, ~100 tokens, RAG_REWRITE_TIMEOUT_MS) rewrites it into a
//     self-contained search query using the last RAG_REWRITE_HISTORY chat messages (names instead of
//     pronouns, the topic from the previous turns). No prior history → nothing to resolve → raw query.
//  2. HYBRID SEARCH (`ragRetrieveMemories`): the vector index alone misses names, nicknames and jargon
//     («водомут», «хокаге» embed as nothing in particular), so the semantic candidates from Vectorize
//     are fused with a LEXICAL ranking over the chat's facts (loaded from D1 — hundreds of short rows,
//     one query; stem-prefix match with an idf weight, i.e. BM25-lite; no FTS5 table needed, and the
//     test shim's SQLite has no FTS5 module anyway). Fusion is reciprocal-rank (RRF, k=RAG_RRF_K): a fact
//     found by both lists rises, a fact found by one still gets in. Top `rag_top_k` survive.
//  3. DATES: every recalled fact is prefixed with the date it was noted — `[2026-07-15] Алёна в отпуске`
//     (created_at in the chat timezone; an UPDATE bumps it). Contradictions therefore need no cleanup:
//     «работает» and «уволили» sit side by side and the model sees which is newer (`prompt_rag_intro`
//     says so). Nothing is ever deleted for that — see curation.ts.

import {
  RAG_CANDIDATES, RAG_RRF_K, RAG_LEX_MIN_MATCH, RAG_REWRITE_TIMEOUT_MS, RAG_REWRITE_MAX_TOKENS, RAG_REWRITE_HISTORY, RAG_REWRITE_MAX_CHARS,
} from "./constants";
import { listMemories } from "./storage";
import { ragQueryMemories, withTimeout } from "./rag";
import { runLLMWithHistory } from "./llm";
import { isFallbackMessage, tzStamp } from "./utils";
import { t } from "./i18n";
import { traceEvent } from "./trace";
import type { Ctx, Memory } from "./types";

/* ---------- lexical side ---------- */

// Function/question words that carry no topic — they would otherwise match half the facts.
const LEX_STOP = new Set([
  "что", "как", "где", "кто", "когда", "почему", "зачем", "какой", "какая", "какие", "каком", "есть", "был", "была", "было", "были",
  "для", "она", "они", "оно", "его", "ему", "нею", "все", "всё", "так", "уже", "нет", "или", "под", "над", "при", "про", "без", "ещё", "еще",
  "это", "эта", "эти", "этот", "тот", "том", "той", "чем", "там", "тут", "вот", "раз", "мне", "нам", "вам", "тебя", "меня", "себя", "него", "неё",
  "the", "and", "has", "had", "not", "was", "are", "for", "but", "who", "his", "her", "she", "him", "its", "did", "can", "may", "all", "any", "out",
  "now", "what", "where", "when", "why", "how", "does", "this", "that", "with", "from", "have", "you", "your",
]);

// Stems of a text: lower-cased words of ≥3 letters/digits cut to 4 chars — a crude prefix stemmer that survives
// Russian inflection (Алёна/Алёны/Алёне → алён, отпуск/отпуске → отпу) — minus the stop-list. Names are KEPT
// (unlike the old consolidation guard): here a name is exactly what a question is about.
export function lexStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of String(text ?? "").match(/[\p{L}\p{N}]+/gu) || []) {
    if (w.length < 3) continue;
    const lw = w.toLowerCase();
    if (LEX_STOP.has(lw)) continue;
    out.add(lw.slice(0, 4));
  }
  return out;
}

// Rank facts lexically against the query: a fact qualifies when it shares at least min(RAG_LEX_MIN_MATCH,
// |query stems|) stems with the query; its score is the sum of idf(stem) = ln(1 + N/df) over the shared stems
// (rare words weigh more, «Алёна» beats «работа»). Ties → newer first. Returns fact ids, best first.
export function lexicalRank(query: string, facts: Pick<Memory, "id" | "text" | "created_at">[]): number[] {
  const q = lexStems(query);
  if (!q.size || !facts.length) return [];
  const stems = facts.map(f => lexStems(f.text));
  const df = new Map<string, number>();
  for (const s of stems) for (const st of s) if (q.has(st)) df.set(st, (df.get(st) || 0) + 1);
  const need = Math.min(RAG_LEX_MIN_MATCH, q.size);
  const scored: { id: number; score: number; created_at: number }[] = [];
  facts.forEach((f, i) => {
    let matched = 0, score = 0;
    for (const st of q) if (stems[i].has(st)) { matched++; score += Math.log(1 + facts.length / (df.get(st) || 1)); }
    if (matched >= need) scored.push({ id: f.id, score, created_at: f.created_at });
  });
  scored.sort((a, b) => b.score - a.score || b.created_at - a.created_at);
  return scored.map(s => s.id);
}

/* ---------- hybrid retrieval ---------- */

// Recall the facts relevant to `queryText` → ready-made strings for the prompt (`[date] fact`), best first.
// Under cfg.rag. Vector candidates (score ≥ rag_min_score) and lexical candidates are fused by RRF; the
// text and date come from the D1 row (the vector's metadata text is the fallback for a vector with no row).
// Best-effort → [] on any error.
// `dbg` (optional) receives the candidate lists for the trace journal: vector hits with scores, lexical hits, the fused order.
export interface RecallDebug { vector?: { id: number; score: number }[]; lexical?: number[]; fused?: number[] }
export async function ragRetrieveMemories(ctx: Ctx, queryText: string, dbg?: RecallDebug): Promise<string[]> {
  if (!ctx.cfg.rag) return [];
  const q = String(queryText ?? "").trim();
  if (!q) return [];
  try {
    const topK = Math.max(1, Number.isFinite(ctx.cfg.rag_top_k) ? Math.trunc(ctx.cfg.rag_top_k) : 5);
    let facts: Memory[] = [];
    try { facts = await listMemories(ctx.env, ctx.chatId); } catch (e: any) { console.warn("recall.listMemories failed", { chatId: ctx.chatId, err: e?.message || e }); }
    const byId = new Map<number, Memory>(facts.map(f => [f.id, f]));
    const [vec, lex] = await Promise.all([
      ragQueryMemories(ctx, q, Math.max(topK, RAG_CANDIDATES)),
      Promise.resolve(lexicalRank(q, facts)),
    ]);
    // RRF fusion: score = Σ 1/(k + rank) over the lists a fact appears in.
    const fused = new Map<number, { score: number; text: string }>();
    const add = (id: number, rank: number, text: string) => {
      const cur = fused.get(id) || { score: 0, text };
      cur.score += 1 / (RAG_RRF_K + rank + 1);
      if (!cur.text) cur.text = text;
      fused.set(id, cur);
    };
    vec.forEach((m, i) => add(m.memId, i, m.text));
    lex.forEach((id, i) => add(id, i, byId.get(id)?.text ?? ""));
    const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, topK);
    if (dbg) { dbg.vector = vec.map(m => ({ id: m.memId, score: Math.round(m.score * 1000) / 1000 })); dbg.lexical = lex; dbg.fused = ranked.map(([id]) => id); }
    const out: string[] = [];
    for (const [id, r] of ranked) {
      const row = byId.get(id);
      const text = row?.text || r.text;
      if (!text) continue;
      const date = row && row.created_at > 0 ? "[" + tzStamp(row.created_at, ctx.cfg.timezone).slice(0, 10) + "] " : "";
      out.push(date + text); // facts are neutral statements, no role label; "—" is added by assemblePrompt
    }
    return out;
  } catch (e: any) {
    console.warn("recall.ragRetrieveMemories failed", { chatId: ctx.chatId, err: e?.message || e });
    return [];
  }
}

/* ---------- query rewrite ---------- */

// Turn the (addressing-stripped) user message into a standalone search query using the recent chat context.
// Returns the raw query when there is no prior history (nothing to resolve), when the switch is off, or when
// the model fails / times out / answers nothing usable. Runs on the hot reply path, hence the tight caps.
export async function rewriteRecallQuery(ctx: Ctx, raw: string): Promise<string> {
  const q = String(raw ?? "").trim();
  if (!q || !ctx.cfg.ragRewrite) return q;
  const myId = ctx.msg?.message_id;
  const prior = (ctx.chatData?.history || []).filter(h => h.meta?.message_id === undefined || h.meta.message_id !== myId);
  if (!prior.length) return q;
  try {
    const out = await withTimeout(
      runLLMWithHistory(
        ctx.cfg,
        t(ctx.cfg.lang, "rag_rewrite"),
        prior.slice(-RAG_REWRITE_HISTORY),
        q,
        ctx.msg,
        { forceAppendUser: true, ctx, modelOverride: ctx.cfg.summaryModel, maxTokens: RAG_REWRITE_MAX_TOKENS, reasoning: false, kind: "rewrite" },
      ),
      RAG_REWRITE_TIMEOUT_MS,
    );
    if (!out || isFallbackMessage(out)) return q;
    const line = out.split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
    const clean = line.replace(/^["'«»`“”]+|["'«»`“”]+$/g, "").trim().slice(0, RAG_REWRITE_MAX_CHARS);
    return clean || q;
  } catch (e: any) {
    console.warn("recall.rewriteRecallQuery failed", { chatId: ctx.chatId, err: e?.message || e });
    return q;
  }
}

// The reply-path entry point: rewrite → hybrid recall. `raw` is the message with the bot addressing stripped.
export async function recallMemories(ctx: Ctx, raw: string): Promise<string[]> {
  if (!ctx.cfg.rag) return [];
  const t0 = Date.now();
  const query = await rewriteRecallQuery(ctx, raw);
  const rewriteMs = Date.now() - t0;
  const dbg: RecallDebug = {};
  const facts = await ragRetrieveMemories(ctx, query, dbg);
  // Left on the ctx for the reply's LLM trace event (what the model was given) and for /memory recall.
  ctx._recall = { raw, query, facts };
  await traceEvent(ctx, "recall", { outcome: facts.length ? "hit" : "miss", elapsedMs: Date.now() - t0, detail: { raw, query, rewriteMs, ...dbg, facts } });
  return facts;
}
