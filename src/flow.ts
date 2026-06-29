/* ================= FLOW (routing) ================= */
// Main update handler + routing: edits → visual → log → pause →
// quick-replies → commands → regular chat. The only write to KV happens in finally.

import {
  makeCtx, shouldAnswer, parseCommandAndArg, chatTitleFromMsg, buildUserItem, visualLabel,
  lastToken, pickOne, getReplyText, tzParts, chatAliases, messageMentionsBot, unknownCommandName,
} from "./utils";
import { getChatData, flushChatData, updateHistoryMessage, appendHistory, parseJson, purgeExpiredData } from "./storage";
import { getGlobalConfig, mergeConfig } from "./config";
import { sendAndStore, sendTyping, reportError } from "./telegram";
import { runLLMWithHistory } from "./llm";
import { buildReplyPrompt, buildDefaultPrompt } from "./prompts";
import { isCommand, tryCommand, TECH_COMMANDS } from "./commands";
import { t, tList } from "./i18n";
import { runIncrementalSummary } from "./summary";
import { runMemoryCuration } from "./curation";
import { getPersonaQuickReplies, getPersonaThrows } from "./persona/registry";
import { handlePhotoMessage } from "./vision";
import { ragRetrieveMemories } from "./rag";
import type { BotConfig, Ctx, Env, TgMessage } from "./types";

export async function handleTelegramMessage(msg: TgMessage, env: Env, isEdit: boolean = false): Promise<void> {
  const globalCfg = getGlobalConfig(env);
  const chatData = await getChatData(msg.chat.id, env);
  // State read failed → we reply with defaults and do NOT write (see _loadFailed). This is a "silent"
  // DB-level failure — raise an alert, otherwise we'd only learn about it from tail.
  if (chatData._loadFailed) await reportError(env, "getChatData", new Error("D1 read failed — replying on defaults, not persisting state"), { critical: true });
  const effectiveCfg = mergeConfig(globalCfg, chatData.config);

  const ctx = makeCtx(msg, env, effectiveCfg, chatData);

  // Keep the chat name up to date (for /admin): the group title or the interlocutor's name.
  // Update only if it changed — so we don't needlessly mark the record _dirty.
  const title = chatTitleFromMsg(msg);
  if (title && title !== ctx.chatData._name) {
    ctx.chatData._name = title;
    ctx.chatData._dirty = true;
  }

  try {
    // Edit: update the already-stored message in history and do NOT reply again.
    // (Telegram sends edited_message on an edit; it does not send deletions to bots.)
    if (isEdit) {
      await updateHistoryMessage(ctx, msg);
      return;
    }

    const mode = parseCommandAndArg(ctx.textRaw, ctx.cfg);

    // Commands take priority over the visual branch: if it's a command (including in a reply
    // to a photo/sticker, e.g. a content command from the pack), we handle it as a command in the normal flow.
    if (ctx.hasVisual && !isCommand(mode.type)) {
      await handlePhotoMessage(ctx);
      return;
    }

    // /retry: re-run the user's LAST message (see handleRetry). Handled before the normal dispatch so the
    // re-run drives the full flow on the SAME ctx; the `/retry` call itself isn't logged (skipHistory).
    if (mode.type === "retry") {
      await handleRetry(ctx);
      return;
    }

    // An unknown `/command` addressed to us (private chat, `/cmd@ourbot`, or an @mention/wakeword) — we'll
    // reply with a hint instead of feeding "/foobar" to the LLM. Computed here so we also skip logging it
    // to history (like a tech command) — its hint reply isn't stored either, so no dangling user line.
    // A bare `/foo` in a group (not addressed) is left to the normal flow: it may be another bot's command.
    const unknownCmd = !isCommand(mode.type) ? unknownCommandName(ctx.textRaw, ctx.cfg) : null;
    const unknownCmdAddressed = !!unknownCmd
      && (ctx.msg.chat?.type === "private" || messageMentionsBot(ctx.textRaw, ctx.msg, ctx.cfg));

    // 0) Log the incoming message to history (in memory) — EXCEPT for technical (TECH) commands.
    // TECH-command replies aren't stored (skipHistory), so the call itself doesn't need logging either:
    // otherwise the history accumulates "dangling" user utterances with no reply (/config, /help, /admin, …),
    // cluttering the model's context. Content LLM commands (whose replies are stored)
    // and regular messages are logged as before.
    // If the command arrived with its own visual (photo/sticker) — mark that in the log.
    const ownVisual = ctx.hasVisual && !ctx.photoFromReply;
    const logged = ownVisual ? `[${visualLabel(ctx)}] ${ctx.textRaw}`.trim() : ctx.textRaw;
    if (!TECH_COMMANDS.has(mode.type) && !unknownCmdAddressed) {
      await appendHistory(ctx, [buildUserItem(msg, logged, chatAliases(ctx))]);
    }

    // If paused — react only to commands
    if (ctx.chatData.paused && !isCommand(mode.type)) return;

    // 1) Quick replies → 2) Commands → 3) Regular chat
    if (!ctx.chatData.paused && ctx.cfg.random && await tryQuickReply(ctx)) return;
    if (await tryCommand(mode, ctx)) return;
    // Unknown but addressed `/command` → a short hint (with the command list pointer), not an LLM turn.
    // After the pause gate, so a paused chat stays quiet; after quick-replies/commands, so a real match wins.
    if (unknownCmdAddressed) {
      await sendAndStore(ctx, t(ctx.cfg.lang, "cmd_unknown", "/" + unknownCmd), { skipHistory: true });
      return;
    }
    await handleChatMessage(ctx);
  } finally {
    // The only state write for the entire update (history is written write-through separately).
    // _loadFailed → state didn't load, must not flush (we'd overwrite the row with defaults).
    if (ctx.chatData._dirty && !ctx.chatData._loadFailed) {
      try {
        await flushChatData(ctx.chatId, ctx.env, ctx.chatData);
      } catch (e: any) {
        // Critical: state stopped being written (all chat persistence silently grinds to a halt).
        await reportError(ctx.env, "flushChatData", e, { critical: true });
      }
    }
  }
}

// /retry — re-run the user's LAST message through the NORMAL flow, on the SAME ctx/chatData (so storage is
// native and the caller's single flush persists it — no second getChatData/flush, no double-counting). The
// last real user message is still in history (a failed/fallback reply is never stored; /retry itself is
// skipHistory), so we replay it: a content command (e.g. /anek) re-runs as that command and its reply is
// stored just like the first time; a normal message gets a fresh reply stored as chat; a technical command
// reply stays unstored. message_id of the original → appendHistory dedups the re-logged incoming. Nothing to
// replay (or it would recurse into /retry) → a short, unstored notice.
async function handleRetry(ctx: Ctx): Promise<void> {
  const lang = ctx.cfg.lang;
  const lastUser = [...(ctx.chatData.history || [])].reverse().find((m) => m.role === "user");
  const rmode = lastUser ? parseCommandAndArg(lastUser.content, ctx.cfg) : null;
  if (!lastUser || !rmode || rmode.type === "retry") {
    await sendAndStore(ctx, t(lang, "retry_nothing"), { skipHistory: true });
    return;
  }
  const rmsg: TgMessage = { ...ctx.msg, text: lastUser.content, message_id: lastUser.meta?.message_id ?? ctx.msg.message_id };
  const rctx = makeCtx(rmsg, ctx.env, ctx.cfg, ctx.chatData); // SAME chatData object → one flush by the caller
  // Replay the dispatch (mirrors handleTelegramMessage): log the incoming unless TECH (deduped by
  // message_id), honor pause, quick replies, then command or chat.
  if (!TECH_COMMANDS.has(rmode.type)) await appendHistory(rctx, [buildUserItem(rmsg, lastUser.content, chatAliases(rctx))]);
  if (rctx.chatData.paused && !isCommand(rmode.type)) return;
  if (!rctx.chatData.paused && rctx.cfg.random && await tryQuickReply(rctx)) return;
  if (await tryCommand(rmode, rctx)) return;
  await handleChatMessage(rctx);
}

/* ================= QUICK REPLIES ================= */

// Quick replies without an LLM come from the persona pack (rhymes/reactions). The engine merely iterates
// the rules in order: gating cfg[cfgFlag], then either the test mode (+ optional probKey) or tokenTable.
export async function tryQuickReply(ctx: Ctx): Promise<boolean> {
  for (const r of getPersonaQuickReplies()) {
    if (!ctx.cfg[r.cfgFlag]) continue;
    if (r.test) {
      if (r.test(ctx.textLower) && (!r.probKey || Math.random() < Number(ctx.cfg[r.probKey]))) {
        await sendAndStore(ctx, pickOne(r.responses ? tList(ctx.cfg.lang, r.responses) : []));
        return true;
      }
    } else if (r.tokenTable) {
      const key = r.tokenTable[lastToken(ctx.textRaw)];
      if (key) {
        await sendAndStore(ctx, pickOne(tList(ctx.cfg.lang, key)));
        return true;
      }
    }
  }
  return false;
}

/* ================= DECISION & CHAT FLOW ================= */

// default — the engine's regular reply; content throws come from the persona pack.
const ENGINE_RANDOM_HANDLERS: Record<string, (ctx: Ctx, memories?: string[]) => Promise<string>> = {
  default: (ctx, memories = []) => {
    const reply = getReplyText(ctx.msg);
    const prompt = reply
      ? buildReplyPrompt(reply, ctx, memories)
      : buildDefaultPrompt(ctx, memories);
    return runLLMWithHistory(ctx.cfg, prompt, ctx.chatData.history, ctx.textRaw, ctx.msg, { ctx });
  },
};

export const RANDOM_HANDLERS: Record<string, (ctx: Ctx, memories?: string[]) => Promise<string>> = {
  ...ENGINE_RANDOM_HANDLERS,
  ...Object.fromEntries(getPersonaThrows().map((t) => [t.name, t.handler])),
};

export async function handleChatMessage(ctx: Ctx): Promise<void> {
  const decision = shouldAnswer(ctx.textRaw, ctx.msg, ctx.cfg);
  if (!decision.answer) return;

  // A random throw — only if the bot itself decided to reply (not addressed) and it's not a reply
  const isReply = !!getReplyText(ctx.msg);
  const kind = (decision.reason === "random" && !isReply)
    ? pickRandomRandomKind(ctx.cfg)
    : "default";
  const handler = RANDOM_HANDLERS[kind] || RANDOM_HANDLERS.default;

  // Long-term memory (RAG): mix in relevant old messages only into the regular reply
  // (default) and only if enabled. Content throws from the pack don't use memory.
  // Skip the embed + vector query for trivially short messages ("ok", an emoji) — they can't clear
  // rag_min_score anyway, so don't pay the Workers-AI embed + Vectorize round-trip on the hot reply path.
  const memories = (kind === "default" && ctx.cfg.rag && (ctx.textRaw || "").trim().length >= 4)
    ? await ragRetrieveMemories(ctx, ctx.textRaw)
    : [];

  await sendTyping(ctx); // instant "bot is typing" feedback while the model thinks
  const out = await handler(ctx, memories);
  await sendAndStore(ctx, out);
  // Fact curation — NOT here: it runs once a day in the daily cron (runDailySummaries), not on every
  // reply. The history window is large; only what gets evicted from it goes into long-term memory —
  // daily curation is enough, and it's cheap (+1 LLM call per day per chat, not per reply).
}

/* ================= DAILY MAINTENANCE (CRON) ================= */
// Called from scheduled() (index.ts) on each cron fire. The gate fires once a day, at 08:00 in the
// configured timezone (cfg.timezone, env BOT_TZ, default UTC). The cron schedule itself lives in the
// deployment's wrangler.jsonc and is chosen to align with that TZ — e.g. for a DST zone, set two fires
// (one for standard time, one for DST) so exactly one lands on the local 08:00; for UTC, a single 08:00 fire.
// Once a day per chat: (1) curation of long-term-memory facts (if rag is on) — BEFORE the summary;
// (2) an incremental "what's new" summary with sending (if daily_summary is on, NOT written to history).
// We process chats where AT LEAST ONE of the two is enabled. Errors are isolated per chat; the time comes from
// scheduledTime (not Date.now). Curation runs once a day, not per reply — the history window is large,
// only what's evicted from it goes into long-term memory.
export async function runDailySummaries(env: Env, scheduledTimeMs: number): Promise<void> {
  const globalCfg = getGlobalConfig(env);
  if (tzParts(scheduledTimeMs, globalCfg.timezone).hour !== 8) return; // not 08:00 in the configured TZ — this fire isn't ours

  // Retention sweep (deployment-wide RETENTION_DAYS): purge history + facts older than the window across
  // ALL chats — once a day, before the per-chat work. Disabled (kept forever) when RETENTION_DAYS is 0/unset.
  // Non-critical: it's storage hygiene off the request path, so a failure logs without alerting admins.
  if (globalCfg.retentionDays > 0) {
    try {
      const cutoff = scheduledTimeMs - globalCfg.retentionDays * 86400_000;
      const purged = await purgeExpiredData(env, cutoff);
      if (purged.messages || purged.memories) {
        console.log(JSON.stringify({ retention: "purged", days: globalCfg.retentionDays, ...purged }));
      }
    } catch (e: any) {
      await reportError(env, "purgeExpiredData", e);
    }
  }

  const rows = ((await env.DB.prepare("SELECT chat_id, config FROM chats").all())?.results as any[]) || [];
  for (const row of rows) {
    const conf = parseJson<Record<string, unknown>>(row.config, {});
    if (conf?.daily_summary !== true && conf?.rag !== true) continue; // neither summary nor long-term memory — skip

    const chatId = row.chat_id;
    try {
      const chatData = await getChatData(chatId, env);
      const eff = mergeConfig(globalCfg, chatData.config);
      // Synthetic message: the cron has no incoming update, yet toLLMMessages/getUserMeta
      // dereference msg on forceAppendUser. message_id:0 → sending without a reply (allow_sending_without_reply).
      const syntheticMsg: TgMessage = {
        message_id: 0,
        chat: { id: Number(chatId), type: "group" },
        from: { id: eff.botId ?? 0, first_name: eff.botName, username: eff.botUsername },
      };
      const ctx = makeCtx(syntheticMsg, env, eff, chatData);

      // (1) Fact curation BEFORE the summary (no-op if rag is off). We persist the curation
      // boundary IMMEDIATELY: if the summary step below fails, _memUptoId won't be lost and the next
      // cron won't re-extract the same delta. We reset _dirty so as not to flush the same thing twice.
      await runMemoryCuration(ctx);
      if (ctx.chatData._dirty && !ctx.chatData._loadFailed) {
        await flushChatData(chatId, env, ctx.chatData);
        ctx.chatData._dirty = false;
      }

      // (2) Daily summary (if enabled).
      if (ctx.cfg.daily_summary) {
        const { text, maxId, hadNew } = await runIncrementalSummary(ctx, ctx.chatData._dailyUptoId || 0);
        if (hadNew) {
          ctx.chatData._dailyUptoId = maxId;
          ctx.chatData._dirty = true;
          const res = await sendAndStore(ctx, text, { skipHistory: true }); // send, but NOT to history
          // Remember the posted message as the "previous summary" pointer (supergroups deep-link to it next time).
          if (res?.result?.message_id) ctx.chatData._summaryMsgId = res.result.message_id;
        }
      }
      if (ctx.chatData._dirty && !ctx.chatData._loadFailed) await flushChatData(chatId, env, ctx.chatData);
    } catch (e: any) {
      // A single chat's failure is isolated and mostly self-healing (boundaries are persisted
      // along the way) — log without an alert, so one flaky chat doesn't spam the admin.
      await reportError(env, "runDailySummaries[chat]", e);
    }
  }
}

export function pickRandomRandomKind(cfg: BotConfig): string {
  const r = Math.random();
  let acc = 0;
  for (const t of getPersonaThrows()) {
    acc += (cfg[t.cfgFlag] ? Number(cfg[t.probKey]) : 0);
    if (r < acc) return t.name;
  }
  return "default";
}
