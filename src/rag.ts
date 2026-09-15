/* ================= RAG (long-term memory = CURATED FACTS) ================= */
// Long-term memory is selected FACTS (not every raw message): auto-extracted on the
// bot's reply + added manually via /memory add. The source of truth is the `memories` table
// (storage.ts); here is the vector layer over Cloudflare Vectorize for semantic recall.
//
// Vector per fact: id = `m<chatId>:<memories.id>`, namespace `mem:<chatId>` (hard chat
// isolation, filtering before metadata, no metadata index). The fact text is carried in metadata.text.
//
// Gating: vector WRITE/DELETE always runs when the bindings are present (so the index stays
// consistent with the table regardless of the flag and needs no backfill) — /memory add embeds
// the fact even when RAG is disabled. RECALL (recall.ts, over ragQueryMemories here) and AUTO-CURATION are under cfg.rag.
// Everything is BEST-EFFORT: an AI/Vectorize error is logged and swallowed, never breaks the reply/history.

import { RAG_EMBED_MODEL, RAG_MAX_EMBED_CHARS, RAG_META_TEXT_CAP, RAG_TIMEOUT_MS } from "./constants";
import type { Ctx, Env } from "./types";

// Vector id and chat namespace are deterministic from chatId/memories.id.
export function memVectorId(chatId: number | string, memId: number | string): string {
  return `m${chatId}:${memId}`;
}
export function memNamespace(chatId: number | string): string {
  return `mem:${chatId}`;
}

// Race a promise against a timeout: on the hot reply path we don't wait for AI/Vectorize longer than ms (return null).
// .catch silences a LATE reject from a "hung" call (the timeout already won the race) — otherwise it would become
// an unhandledRejection; .finally(clearTimeout) clears the timer on any outcome (no dangling timers).
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded: Promise<T | null> = Promise.resolve(p).catch(() => null);
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

// Embed strings via Workers AI bge-m3. Returns an array of vectors (one per input) or
// null on error/unavailability/timeout. The input is truncated to RAG_MAX_EMBED_CHARS (~512 tokens).
export async function embedTexts(env: Env, texts: string[]): Promise<number[][] | null> {
  if (!env.AI || !texts.length) return null;
  try {
    const input = texts.map(t => String(t ?? "").slice(0, RAG_MAX_EMBED_CHARS));
    const res = await withTimeout(
      env.AI.run(RAG_EMBED_MODEL, { text: input }) as Promise<{ data?: number[][] }>,
      RAG_TIMEOUT_MS,
    );
    const data = res?.data;
    if (!Array.isArray(data) || data.length !== input.length) return null;
    return data;
  } catch (e: any) {
    console.warn("rag.embedTexts failed", { err: e?.message || e });
    return null;
  }
}

// Embed + upsert a single fact into the chat namespace. Gated on bindings only (NOT cfg.rag): /memory add
// always embeds the fact so it's ready for recall when long-term memory is enabled (without a backfill).
export async function ragUpsertMemory(ctx: Ctx, mem: { id: number; text: string; source: string }): Promise<void> {
  if (!ctx.env.VECTORIZE || !ctx.env.AI || !mem.text) return;
  try {
    const vectors = await embedTexts(ctx.env, [mem.text]);
    if (!vectors) return;
    await withTimeout(ctx.env.VECTORIZE.upsert([{
      id: memVectorId(ctx.chatId, mem.id),
      values: vectors[0],
      namespace: memNamespace(ctx.chatId),
      metadata: {
        chat_id: String(ctx.chatId),
        mem_id: mem.id,
        text: String(mem.text).slice(0, RAG_META_TEXT_CAP),
        source: mem.source,
      },
    }]), RAG_TIMEOUT_MS); // bounded: a hung Vectorize mutation must not stall the caller
  } catch (e: any) {
    console.warn("rag.ragUpsertMemory failed", { chatId: ctx.chatId, err: e?.message || e });
  }
}

// Delete vectors by id (on /memory forget). Gated on bindings only (we clean up regardless of the flag,
// otherwise facts embedded while RAG was on would be orphaned after it's turned off). Best-effort.
export async function ragDeleteIds(ctx: Ctx, vectorIds: string[]): Promise<void> {
  if (!ctx.env.VECTORIZE || !vectorIds.length) return;
  try {
    await withTimeout(ctx.env.VECTORIZE.deleteByIds(vectorIds), RAG_TIMEOUT_MS);
  } catch (e: any) {
    console.warn("rag.ragDeleteIds failed", { chatId: ctx.chatId, err: e?.message || e });
  }
}

// Delete a chat's fact vectors by their memories.id (for /memory forget).
export async function deleteChatMemoryVectors(ctx: Ctx, memIds: number[]): Promise<void> {
  if (!memIds.length) return;
  await ragDeleteIds(ctx, memIds.map(id => memVectorId(ctx.chatId, id)));
}

// Env-based vector delete (no Ctx) — for the deployment-wide retention sweep, which spans chats and has
// no single request ctx. Same best-effort semantics as ragDeleteIds; tolerates already-absent ids.
export async function ragDeleteIdsEnv(env: Env, vectorIds: string[]): Promise<void> {
  if (!env.VECTORIZE || !vectorIds.length) return;
  try {
    await withTimeout(env.VECTORIZE.deleteByIds(vectorIds), RAG_TIMEOUT_MS);
  } catch (e: any) {
    console.warn("rag.ragDeleteIdsEnv failed", { err: e?.message || e });
  }
}

interface MemMeta { mem_id?: number; text?: string; source?: string }

export interface MemMatch { memId: number; text: string; score: number }

// The VECTOR side of recall: the facts semantically closest to `queryText` in the chat namespace, best first,
// filtered by rag_min_score — up to `topK` (Vectorize caps topK at 50 with returnMetadata:"all"). The hybrid
// recall (recall.ts) fuses this list with a lexical ranking. Under cfg.rag. Best-effort → [] on any error.
export async function ragQueryMemories(ctx: Ctx, queryText: string, topK: number): Promise<MemMatch[]> {
  if (!ctx.cfg.rag || !ctx.env.VECTORIZE || !ctx.env.AI) return [];
  const q = String(queryText ?? "").trim();
  if (!q) return [];
  try {
    const vecs = await embedTexts(ctx.env, [q]);
    if (!vecs) return [];
    const k = Math.min(50, Math.max(1, Math.trunc(topK) || 1));
    const res = await withTimeout(
      ctx.env.VECTORIZE.query(vecs[0], { topK: k, namespace: memNamespace(ctx.chatId), returnMetadata: "all" }),
      RAG_TIMEOUT_MS,
    );
    const matches = res?.matches || [];
    const minScore = Number.isFinite(ctx.cfg.rag_min_score) ? ctx.cfg.rag_min_score : 0.45; // keep in sync with getGlobalConfig's default
    const out: MemMatch[] = [];
    for (const m of matches) {
      if (typeof m.score !== "number" || m.score < minScore) continue;
      const md = m.metadata as unknown as MemMeta | undefined;
      if (!md || typeof md.text !== "string" || !md.text) continue; // orphan tolerance
      // mem id: from metadata, else from the vector id `m<chat>:<id>` (older vectors); unknown → a negative pseudo id
      const fromId = Number(String(m.id).split(":")[1]);
      const memId = Number.isFinite(md.mem_id) ? Number(md.mem_id) : (Number.isFinite(fromId) && fromId > 0 ? fromId : -(out.length + 1));
      out.push({ memId, text: md.text, score: m.score });
    }
    return out; // Vectorize order is by descending score (most relevant first)
  } catch (e: any) {
    console.warn("rag.ragQueryMemories failed", { chatId: ctx.chatId, err: e?.message || e });
    return [];
  }
}
