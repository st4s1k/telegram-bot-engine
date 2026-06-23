/* ================= SUMMARY ================= */
// Incremental chat summary: summarizes ONLY new messages (id > sinceId), mixing in
// the previous summary (_summary) as "already known — don't repeat". Shared core for the /summary command
// and the daily cron. On success it updates _summary (+_dirty); the caller advances the BOUNDARY.

import { messagesSince } from "./storage";
import { runLLMWithHistory } from "./llm";
import { buildSummaryPrompt } from "./prompts";
import { isFallbackMessage } from "./utils";
import { t } from "./i18n";
import type { Ctx } from "./types";

// Returns text + maxId + whether there was new material (hadNew=false → nothing new / refusal, LLM was not called).
export async function runIncrementalSummary(
  ctx: Ctx, sinceId: number
): Promise<{ text: string; maxId: number; hadNew: boolean }> {
  const { items, maxId } = await messagesSince(ctx.env, ctx.chatId, sinceId);
  if (!items.length) {
    // Nothing new since the last boundary: return the previous summary (if any) or a refusal.
    const cached = ctx.chatData._summary;
    return { text: cached || t(ctx.cfg.lang, "sum_nothing_new"), maxId: sinceId, hadNew: false };
  }
  // The very first summary ever with a really short history — preserves the prior UX.
  if (!ctx.chatData._summary && items.length < 3) {
    return { text: t(ctx.cfg.lang, "sum_too_few"), maxId: sinceId, hadNew: false };
  }

  const summary = await runLLMWithHistory(
    ctx.cfg,
    buildSummaryPrompt(ctx, ctx.chatData._summary || undefined),
    items, // only the new slice, NOT the entire history window
    t(ctx.cfg.lang, "sum_user_turn"),
    ctx.msg,
    // A separate model for the summary (if set) — usually a fast one. Empty → the main model.
    { forceAppendUser: true, ctx, modelOverride: ctx.cfg.summaryModel }
  );

  if (isFallbackMessage(summary)) return { text: summary, maxId: sinceId, hadNew: false };
  ctx.chatData._summary = summary;
  ctx.chatData._dirty = true;
  return { text: summary, maxId, hadNew: true };
}
