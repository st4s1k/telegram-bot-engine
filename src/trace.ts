/* ================= TRACE (observability: every stage of every request, in D1) ================= */
// One row per STAGE EVENT in `trace_events` (migration 0003). Every incoming Telegram update gets a trace id
// (`u<update_id>`), every cron job per chat gets one (`cron-<date>-<chat>`), and each stage on the way
// appends an event to it: webhook → dedup → route → recall → llm (one per model call, with the prompt, the
// last user message, the memory block and the response) → command → send; errors and cron steps too. So a
// «bot answered nonsense / didn't answer» is reconstructed after the fact from `/admin trace <chat>` →
// `/admin trace <traceId>` → `/admin event <id>`, and `/admin trace` gives 24 h metrics per LLM kind.
//
// Write-through (each event is inserted as it happens, best-effort): a request killed mid-way — the
// interesting case — still leaves the stages it reached. Bounded by TIME only: the daily cron purges rows
// older than TRACE_DAYS. Env TRACE_LOG=false turns the journal off. Detail JSON is capped per event.

import { TRACE_DETAIL_CAP, TRACE_SYSTEM_CAP, TRACE_TEXT_CAP, TRACE_RESPONSE_CAP } from "./constants";
import { newReqId } from "./utils";
import type { Ctx, Env, LLMMessage } from "./types";

export interface Trace { id: string; t0: number }

export interface TraceOpts {
  kind?: string;
  outcome?: string;
  elapsedMs?: number;
  cost?: number;
  detail?: unknown;
}

export interface TraceEventRow {
  id: number; ts: number; chat_id: string; trace: string; ms: number; stage: string;
  kind: string | null; outcome: string | null; elapsed_ms: number | null; cost: number | null; detail: string;
}

export interface TraceStat { kind: string; n: number; ok: number; avg_ms: number; max_ms: number; cost: number }

export function startTrace(id?: string): Trace {
  return { id: id || "t" + newReqId(), t0: Date.now() };
}

const traceEnabled = (env: Env): boolean => !!env.DB && String(env.TRACE_LOG ?? "").toLowerCase() !== "false";

// Append one event. `trace` undefined → a one-off trace (an error with no request context).
export async function traceRaw(env: Env, chatId: number | string, trace: Trace | undefined, stage: string, o: TraceOpts = {}): Promise<void> {
  if (!traceEnabled(env)) return;
  const tr = trace || startTrace();
  try {
    let detail = "{}";
    try { detail = JSON.stringify(o.detail ?? {}) ?? "{}"; } catch { detail = "{\"unserializable\":true}"; }
    if (detail.length > TRACE_DETAIL_CAP) detail = detail.slice(0, TRACE_DETAIL_CAP);
    await env.DB.prepare(
      "INSERT INTO trace_events (ts, chat_id, trace, ms, stage, kind, outcome, elapsed_ms, cost, detail) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      Date.now(), String(chatId), tr.id, Math.max(0, Date.now() - tr.t0), stage,
      o.kind ?? null, o.outcome ?? null,
      Number.isFinite(o.elapsedMs) ? Math.round(o.elapsedMs as number) : null,
      Number.isFinite(o.cost) ? o.cost : null,
      detail,
    ).run();
  } catch (e: any) {
    console.warn("trace.write failed", { stage, err: e?.message || e });
  }
}

// The usual form: the ctx carries the trace (created on first use) and the chat.
export async function traceEvent(ctx: Ctx, stage: string, o: TraceOpts = {}): Promise<void> {
  if (!ctx.env || !traceEnabled(ctx.env)) return;
  if (!ctx._trace) ctx._trace = startTrace();
  await traceRaw(ctx.env, ctx.chatId, ctx._trace, stage, o);
}

/* ---------- the LLM event ---------- */

export interface LLMTraceInput {
  rid: string; kind: string; model: string; outcome: string; elapsedMs: number;
  cost?: number; finish?: string; messages: LLMMessage[]; response: string;
}

// Message content may be a string or (vision) an array of parts — flatten to text for the journal.
const contentText = (c: unknown): string => typeof c === "string" ? c : JSON.stringify(c ?? "");

// One event per OpenRouter call: what was sent (system prompt, last user message, the recalled memory block
// of a reply — recallMemories leaves it on ctx._recall) and what came back. Written by callOpenRouter.
export async function traceLLM(ctx: Ctx, r: LLMTraceInput): Promise<void> {
  const system = r.messages.find(m => m.role === "system");
  let lastUser: LLMMessage | undefined;
  for (let i = r.messages.length - 1; i >= 0; i--) if (r.messages[i].role === "user") { lastUser = r.messages[i]; break; }
  const promptChars = r.messages.reduce((n, m) => n + contentText(m.content).length, 0);
  const recall = ctx._recall && (r.kind === "reply" || r.kind === "preview") ? ctx._recall : undefined;
  await traceEvent(ctx, "llm", {
    kind: r.kind, outcome: r.outcome, elapsedMs: r.elapsedMs, cost: r.cost,
    detail: {
      rid: r.rid, model: r.model, finish: r.finish ?? null, msg_count: r.messages.length, prompt_chars: promptChars,
      system: contentText(system?.content).slice(0, TRACE_SYSTEM_CAP),
      user_text: contentText(lastUser?.content).slice(0, TRACE_TEXT_CAP),
      response: String(r.response ?? "").slice(0, TRACE_RESPONSE_CAP),
      ...(recall ? { recall } : {}),
    },
  });
}

/* ---------- reading ---------- */

// The newest traces of a chat: their events grouped by trace id, newest trace first. `n` traces; each with
// its events in order. Reads a bounded window of recent events (enough for `n` traces of ~a dozen events).
export async function listTraces(env: Env, chatId: number | string, n: number): Promise<{ trace: string; events: TraceEventRow[] }[]> {
  const want = Math.max(1, Math.trunc(n));
  const r = await env.DB.prepare(
    "SELECT * FROM trace_events WHERE chat_id=? ORDER BY id DESC LIMIT ?"
  ).bind(String(chatId), want * 24).all();
  const rows = ((r?.results as any[]) || []).map(rowOf).reverse(); // oldest → newest
  const byTrace = new Map<string, TraceEventRow[]>();
  for (const e of rows) { const list = byTrace.get(e.trace) || []; list.push(e); byTrace.set(e.trace, list); }
  return [...byTrace.entries()].map(([trace, events]) => ({ trace, events })).reverse().slice(0, want);
}

export async function getTrace(env: Env, traceId: string): Promise<TraceEventRow[]> {
  const r = await env.DB.prepare("SELECT * FROM trace_events WHERE trace=? ORDER BY id").bind(traceId).all();
  return ((r?.results as any[]) || []).map(rowOf);
}

export async function getTraceEvent(env: Env, id: number): Promise<TraceEventRow | null> {
  const r = await env.DB.prepare("SELECT * FROM trace_events WHERE id=?").bind(id).first();
  return r ? rowOf(r) : null;
}

// Rows older than cutoffMs are dropped (the daily cron). Returns how many went.
export async function purgeTraces(env: Env, cutoffMs: number): Promise<number> {
  const cnt: any = await env.DB.prepare("SELECT COUNT(*) AS n FROM trace_events WHERE ts < ?").bind(cutoffMs).first();
  const n = Number(cnt?.n) || 0;
  if (n) await env.DB.prepare("DELETE FROM trace_events WHERE ts < ?").bind(cutoffMs).run();
  return n;
}

// LLM metrics since `sinceMs` across all chats, per kind: calls, ok, avg/max latency, cost.
export async function traceLLMStats(env: Env, sinceMs: number): Promise<TraceStat[]> {
  const r = await env.DB.prepare(
    "SELECT kind, COUNT(*) AS n, SUM(CASE WHEN outcome='ok' THEN 1 ELSE 0 END) AS ok, AVG(elapsed_ms) AS avg_ms, MAX(elapsed_ms) AS max_ms, COALESCE(SUM(cost),0) AS cost FROM trace_events WHERE stage='llm' AND ts >= ? GROUP BY kind ORDER BY n DESC"
  ).bind(sinceMs).all();
  return ((r?.results as any[]) || []).map(x => ({
    kind: String(x.kind ?? ""), n: Number(x.n) || 0, ok: Number(x.ok) || 0, avg_ms: Number(x.avg_ms) || 0, max_ms: Number(x.max_ms) || 0, cost: Number(x.cost) || 0,
  }));
}

// Stage counts since `sinceMs` (how many updates, routes by kind, sends, errors) — the second half of the metrics view.
export async function traceStageStats(env: Env, sinceMs: number): Promise<{ stage: string; kind: string; n: number }[]> {
  const r = await env.DB.prepare(
    "SELECT stage, COALESCE(kind,'') AS kind, COUNT(*) AS n FROM trace_events WHERE stage<>'llm' AND ts >= ? GROUP BY stage, kind ORDER BY stage, n DESC"
  ).bind(sinceMs).all();
  return ((r?.results as any[]) || []).map(x => ({ stage: String(x.stage), kind: String(x.kind ?? ""), n: Number(x.n) || 0 }));
}

function rowOf(x: any): TraceEventRow {
  return {
    id: Number(x.id), ts: Number(x.ts), chat_id: String(x.chat_id), trace: String(x.trace), ms: Number(x.ms) || 0, stage: String(x.stage),
    kind: x.kind == null ? null : String(x.kind), outcome: x.outcome == null ? null : String(x.outcome),
    elapsed_ms: x.elapsed_ms == null ? null : Number(x.elapsed_ms), cost: x.cost == null ? null : Number(x.cost), detail: String(x.detail ?? "{}"),
  };
}
