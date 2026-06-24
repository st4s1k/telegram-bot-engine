/* ================= LLM ================= */
// Requests to OpenRouter: always streaming SSE, two timers (overall cap + idle),
// cost deduction from the final usage chunk, graceful degradation to fallbacks.

import {
  GETFILE_TIMEOUT_MS, LLM_IDLE_TIMEOUT_MS, LLM_TIMEOUT_MS,
} from "./constants";
import { newReqId, formatWithMeta, getUserMeta } from "./utils";
import { addSpend } from "./storage";
import { getPersonaTexts } from "./persona/registry";
import { t } from "./i18n";
import type { BotConfig, Ctx, HistoryItem, LLMMessage, TgMessage } from "./types";

// Requests the model's price and modalities from OpenRouter (GET /model/<author>/<slug>).
// Returns a string to show in /model, or "" on error. We strip a leading tilde from the id.
export async function fetchModelPrice(cfg: BotConfig, modelId: string): Promise<string> {
  const id = String(modelId || "").replace(/^~/, "");
  if (!id) return "";
  try {
    // Model ids look like author/slug — the slash is a path separator, so it must not be encoded.
    // We encode only the individual segments in case of unusual characters.
    const pathId = id.split("/").map(encodeURIComponent).join("/");
    const headers: Record<string, string> = {};
    if (cfg.openrouterApiKey) headers.Authorization = "Bearer " + cfg.openrouterApiKey;
    // IMPORTANT: a single model uses the /model/ endpoint (singular), not /models/.
    const res = await fetch(cfg.openrouterHost + "/model/" + pathId, {
      headers,
      signal: AbortSignal.timeout(GETFILE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn("openrouter model price http", { status: res.status, id });
      return "";
    }
    const rawText = await res.text();
    let json: any = null;
    try { json = JSON.parse(rawText); } catch { /* not json */ }
    const d = json?.data;
    const p = d?.pricing;
    if (!p) {
      // Diagnostics: show what the endpoint actually returned (first 400 characters).
      console.warn("openrouter model price: no pricing", { id, body: rawText.slice(0, 400) });
      return "";
    }

    // Prices are in $/token (strings). We convert them to $/million tokens for readability.
    // IMPORTANT: empty/missing field (null/undefined/"") means "no data", NOT zero. Previously
    // Number(null)===0 and Number("")===0 → a missing price was shown as "free".
    const perM = (v: unknown): number | null => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n * 1_000_000 : null;
    };
    const inp = perM(p.prompt);
    const out = perM(p.completion);
    const img = Number(p.image);
    // null → "no data", a real 0 → "free", >0 → the amount.
    const fmtM = (n: number | null): string =>
      n === null ? t(cfg.lang, "price_nodata") : n === 0 ? t(cfg.lang, "price_free") : `$${n.toFixed(2)}${t(cfg.lang, "price_per_mil")}`;

    const lines: string[] = [];
    // Whether the model can see images (based on its input modalities).
    const modal = d?.architecture?.input_modalities;
    if (Array.isArray(modal)) {
      lines.push(t(cfg.lang, "price_sees_photo", modal.includes("image") ? t(cfg.lang, "adm_yes") : t(cfg.lang, "adm_no")));
    }
    let price = t(cfg.lang, "price_line", fmtM(inp), fmtM(out));
    if (Number.isFinite(img) && img > 0) price += t(cfg.lang, "price_image", img.toFixed(4));
    lines.push(price);
    return lines.join("\n");
  } catch (e: any) {
    console.warn("openrouter model price error", { err: e?.message || e });
    return "";
  }
}

// Requests the balance from OpenRouter to show in /model. On any error — a soft placeholder.
// If a management key is set (env OPENROUTER_PROVISIONING_KEY) — we get the full account
// balance via /credits (total topped up / spent / remaining). Otherwise we fall back
// to /key (only "spent" for the current API key).
export async function fetchOpenRouterUsage(cfg: BotConfig): Promise<string> {
  const fmt = (n: unknown): string => `$${Number(n).toFixed(2)}`;

  // 1) Full account balance via the management key.
  if (cfg.openrouterProvisioningKey) {
    try {
      const res = await fetch(cfg.openrouterHost + "/credits", {
        headers: { Authorization: "Bearer " + cfg.openrouterProvisioningKey },
        signal: AbortSignal.timeout(GETFILE_TIMEOUT_MS),
      });
      if (res.ok) {
        const json: any = await res.json().catch(() => null);
        const d = json?.data;
        if (d) {
          const total = Number(d.total_credits) || 0; // total topped up, $
          const used = Number(d.total_usage) || 0;    // total spent, $
          const left = Math.max(0, total - used);
          return t(cfg.lang, "bal_spent_of", fmt(used), fmt(total), fmt(left));
        }
      } else {
        console.warn("openrouter /credits failed", { status: res.status });
      }
      // if /credits did not work — fall back to /key below
    } catch (e: any) {
      console.warn("openrouter /credits error", { err: e?.message || e });
    }
  }

  // 2) Fallback: usage for the current API key.
  if (!cfg.openrouterApiKey) return t(cfg.lang, "bal_no_key");
  try {
    const res = await fetch(cfg.openrouterHost + "/key", {
      headers: { Authorization: "Bearer " + cfg.openrouterApiKey },
      signal: AbortSignal.timeout(GETFILE_TIMEOUT_MS),
    });
    if (!res.ok) return t(cfg.lang, "bal_http_err", res.status);
    const json: any = await res.json().catch(() => null);
    const d = json?.data;
    if (!d) return t(cfg.lang, "bal_nodata");

    const usage = Number(d.usage) || 0;
    const limit = d.limit;
    if (limit === null || limit === undefined) {
      return t(cfg.lang, "bal_spent_only", fmt(usage));
    }
    const left = Math.max(0, limit - usage);
    return t(cfg.lang, "bal_spent_of", fmt(usage), fmt(limit), fmt(left));
  } catch (e: any) {
    console.warn("openrouter usage error", { err: e?.message || e });
    return t(cfg.lang, "bal_fetch_err");
  }
}

// An HTTP header value must be ASCII. Non-ASCII characters (e.g. a Cyrillic X-Title)
// are percent-encoded so that fetch does not fail/complain.
export function asciiHeader(v: string): string {
  const s = String(v || "");
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(s) ? s : encodeURIComponent(s);
}

// Shared core of the OpenRouter request: headers, timeout, error handling, parsing.
// messages — an already-assembled array (text-only or with image_url). tag — for logs.
export async function callOpenRouter(
  cfg: BotConfig,
  messages: LLMMessage[],
  { tag = "req", extraLog = {}, ctx = null, modelOverride = "" }: {
    tag?: string; extraLog?: Record<string, unknown>; ctx?: Ctx | null; modelOverride?: string;
  } = {},
): Promise<string> {
  const rid = newReqId();
  const model = modelOverride || cfg.openrouterModel;
  const fb = getPersonaTexts(cfg.lang); // persona fallbacks in the needed locale (the pack is already registered)
  const payload = {
    model,
    messages,
    // Streaming: the response arrives in chunks. This lets us cut off not by total time, but by
    // the pause between chunks (idle) — a reasoning model may think for a long time, but as long
    // as it keeps sending tokens, the stream is alive and we don't abort. We concatenate the text
    // and send it as a single message at the end.
    stream: true,
    // Controlling the "thinking" of reasoning models:
    //  - reasoning on (default): it thinks, but we don't send the reasoning tokens (exclude).
    //  - reasoning off: enabled:false disables the generation of reasoning (faster).
    reasoning: cfg.reasoning ? { exclude: true } : { enabled: false },
    // Response length limit. We add the field only for a valid value > 0 — otherwise let
    // the model use its own default. Guards against overly long responses (but not against slow
    // reasoning itself).
    ...(Number.isFinite(cfg.maxTokens) && cfg.maxTokens > 0 ? { max_tokens: cfg.maxTokens } : {}),
    // We ask OpenRouter to return usage with the actual cost (it arrives in the final chunk).
    usage: { include: true },
  };

  const startTs = Date.now();
  logLLM(cfg, tag, { rid, model, ...extraLog });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.openrouterApiKey) headers.Authorization = "Bearer " + cfg.openrouterApiKey;
  if (cfg.openrouterTitle) headers["X-Title"] = asciiHeader(cfg.openrouterTitle);

  // Two timers: the overall cap (a safeguard) and idle (reset on every chunk).
  const ac = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort("idle"), LLM_IDLE_TIMEOUT_MS);
  };
  const hardTimer = setTimeout(() => ac.abort("hard"), LLM_TIMEOUT_MS);

  try {
    armIdle();
    const res = await fetch(cfg.openrouterHost + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ac.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const elapsed = Date.now() - startTs;
      logLLM(cfg, tag + "_err", { rid, status: res.status, elapsed, body: body.slice(0, 500) });
      llmStat({ rid, tag, model, elapsed, outcome: "http_" + res.status });
      if (res.status === 402) return fb.fallbackNoCredits;
      return fb.fallbackError;
    }
    if (!res.body) return fb.fallbackError;

    // We read the SSE stream: lines of the form `data: {json}`. We concatenate delta.content; usage —
    // in one of the final chunks. On every received piece we re-arm the idle timer.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let cost = NaN;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // data arrived — the stream is alive
      buffer += decoder.decode(value, { stream: true });

      // We process complete lines; the incomplete tail is left in buffer.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s || !s.startsWith("data:")) continue;
        const data = s.slice(5).trim();
        if (data === "[DONE]") continue;
        let json: any;
        try { json = JSON.parse(data); } catch { continue; } // incomplete/service line — skip it
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") content += delta;
        // usage can arrive either in the chunks or in the final object.
        const c = json?.usage?.cost;
        if (Number.isFinite(Number(c))) cost = Number(c);
      }
    }

    const elapsed = Date.now() - startTs;
    if (!content || !content.trim()) {
      console.warn("LLM empty stream", { rid, tag, elapsed });
      llmStat({ rid, tag, model, elapsed, outcome: "empty" });
      return fb.fallbackError;
    }
    logLLM(cfg, tag + "_ok", { rid, elapsed, len: content.length, cost });
    llmStat({ rid, tag, model, elapsed, outcome: "ok", cost });
    if (ctx && Number.isFinite(cost) && cost > 0) addSpend(ctx, cost);
    return content;
  } catch (e: any) {
    const elapsed = Date.now() - startTs;
    // Our timers abort the request via ac.abort(reason). On abort WITH an argument, fetch
    // rejects with the reason itself (the string "idle"/"hard"), and NOT a DOMException with name==="AbortError" —
    // so we detect the timeout by ac.signal.aborted (e.name is kept as a fallback).
    if (ac.signal.aborted || e?.name === "AbortError" || e?.name === "TimeoutError") {
      const reason = ac.signal.reason === "idle" ? "idle" : "hard";
      console.warn("LLM timeout", { rid, tag, elapsed, model, reason });
      llmStat({ rid, tag, model, elapsed, outcome: "timeout_" + reason });
      return fb.fallbackError;
    }
    console.error("LLM fetch error:", { rid, tag, elapsed, msg: e?.message || e });
    llmStat({ rid, tag, model, elapsed, outcome: "error" });
    return fb.fallbackError;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(hardTimer);
  }
}

export async function runLLMWithHistory(
  cfg: BotConfig,
  systemPrompt: string,
  history: HistoryItem[],
  userContent: string,
  msg: TgMessage,
  { forceAppendUser = false, ctx = null, modelOverride = "" }: { forceAppendUser?: boolean; ctx?: Ctx | null; modelOverride?: string } = {},
): Promise<string> {
  const messages = toLLMMessages(systemPrompt, history, userContent, msg, { forceAppendUser, tz: cfg.timezone });
  // modelOverride empty → callOpenRouter takes cfg.openrouterModel (normal behavior).
  return callOpenRouter(cfg, messages, { tag: "req", extraLog: { count: messages.length }, ctx, modelOverride });
}

export function toLLMMessages(
  systemPrompt: string,
  history: HistoryItem[],
  userContent: string,
  msg: TgMessage | null,
  { forceAppendUser, tz = "UTC" }: { forceAppendUser: boolean; tz?: string },
): LLMMessage[] {
  const msgs: LLMMessage[] = [{ role: "system", content: systemPrompt }];
  for (const h of history) msgs.push({ role: h.role, content: formatWithMeta(h, tz) });

  let needAppend = true;
  if (!forceAppendUser && msg && history.length) {
    const last = history[history.length - 1];
    if (last.role === "user" && last.meta?.message_id === msg.message_id) needAppend = false;
  }
  if (forceAppendUser || (needAppend && msg)) {
    msgs.push({
      role: "user",
      content: formatWithMeta({ role: "user", content: userContent, meta: getUserMeta(msg as TgMessage) }, tz),
    });
  }
  return msgs;
}

export function logLLM(cfg: BotConfig, phase: string, payload: Record<string, unknown>): void {
  if (cfg.llmLog) console.log(JSON.stringify({ ts: Date.now(), phase, ...payload }));
}

// Always-on one-line telemetry for the TERMINAL phase of an LLM call — independent of LLM_LOG (which is
// off by default and floods every phase). Lets `wrangler tail`/logpush answer "how slow / how expensive /
// how often failing" without enabling verbose logging. `console.log` so it doesn't trip warn/error checks.
function llmStat(o: { rid: string; tag: string; model: string; elapsed: number; outcome: string; cost?: number }): void {
  console.log(JSON.stringify({ llm: o.outcome, rid: o.rid, tag: o.tag, model: o.model, ms: o.elapsed, ...(typeof o.cost === "number" ? { cost: o.cost } : {}) }));
}
