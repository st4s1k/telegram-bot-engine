/* ================= COMMANDS ================= */
// COMMANDS: type → async (ctx, mode) => string|null (null/empty = stay silent). TECH_COMMANDS —
// their output is NOT written to history; LLM_COMMANDS — content commands (with "typing", stored).

import { MEM_MAX_FACT_CHARS } from "./constants";
import { t, tList, LOCALES } from "./i18n";
import {
  makeCtx, parseCommandAndArg, historyChars, tzParts, tzStamp, stripBotAddressing,
} from "./utils";
import {
  getChatData, flushChatData, saveChatConfig, setPaused, setRole,
  clearChatHistory, dedupeChatHistory, addMemory, listMemories, clearMemories, deleteMemory, parseJson, messageStats,
} from "./storage";
import { ragReindexMemories } from "./rag";
import { CONFIG_SCHEMA, CONFIG_PRESETS, getGlobalConfig, mergeConfig, buildHelp, buildConfigHelp, buildConfigGroupHelp, findConfigGroup, buildInfoStatus, setConfigParam } from "./config";
import { fetchModelPrice, fetchOpenRouterUsage, runLLMWithHistory } from "./llm";
import { recallMemories, rewriteRecallQuery, ragRetrieveMemories } from "./recall";
import { traceEvent, listTraces, getTrace, getTraceEvent, traceLLMStats, traceStageStats } from "./trace";
import type { TraceEventRow } from "./trace";
import { buildDefaultPrompt } from "./prompts";
import { sendTyping, sendAndStore, syncBotCommands } from "./telegram";
import { runIncrementalSummary } from "./summary";
import { runMemoryCuration } from "./curation";
import { getPersona, getPersonaStateDefaults, getAllCommands, setEngineCommands } from "./persona/registry";
import type { RegisteredCommand } from "./persona/registry";
import type { CommandMode, Ctx, TgMessage } from "./types";

type CommandHandler = (ctx: Ctx, mode: CommandMode) => Promise<string | null>;

const ENGINE_COMMANDS: Record<string, CommandHandler> = {
  help: async (ctx) => buildHelp(ctx.cfg.lang),

  // /start — first-contact onboarding (Telegram auto-sends it on first open). Localized, no LLM call.
  start: async (ctx) => t(ctx.cfg.lang, "help_start"),

  config: async (ctx, mode) => {
    const lang = ctx.cfg.lang;
    const raw = mode.argText.trim();

    if (!raw) {
      return buildConfigHelp(ctx.cfg, ctx.chatData.config || {});
    }

    // Key is the first word, value is the entire remainder (so that string validation sees spaces
    // and so that values containing separators are not truncated).
    const m = raw.match(/^(\S+)\s*(.*)$/);
    const key = (m ? m[1] : raw).toLowerCase();
    const cmdVal = m ? m[2] : "";

    if (key === "reset") {
      saveChatConfig(ctx, {});
      return t(lang, "cfg_reset_all");
    }

    // /config preset [name] — apply a mode (a batch of settings). Without a name — list the presets.
    if (key === "preset" || tList(lang, "cmd_preset_aliases").includes(key)) {
      const name = cmdVal.trim().toLowerCase();
      if (!name) {
        return [t(lang, "cfg_preset_header"),
          ...Object.entries(CONFIG_PRESETS).map(([n, p]) => `• \`${n}\` — ${t(lang, p.desc)}`),
        ].join("\n");
      }
      const preset = CONFIG_PRESETS[name];
      if (!preset) {
        return t(lang, "cfg_preset_notfound", name, Object.keys(CONFIG_PRESETS).map(n => `\`${n}\``).join(", "));
      }
      saveChatConfig(ctx, { ...ctx.chatData.config, ...preset.config });
      return t(lang, "cfg_preset_applied", name, t(lang, preset.desc));
    }

    // /config <group> (no value) — show just that section, e.g. `/config rag`. A trailing value means
    // "set this key", so only match a group when no value was given. Keeps `/config rag on` on the set path.
    if (!cmdVal.trim()) {
      const g = findConfigGroup(lang, key);
      if (g) return buildConfigGroupHelp(ctx.cfg, ctx.chatData.config || {}, g);
    }

    if (!CONFIG_SCHEMA[key]) {
      return t(lang, "cfg_unknown_key", key);
    }

    return setConfigParam(ctx, key, cmdVal);
  },

  // /admin — HIDDEN command for admins (env ADMIN_USERNAMES). Subcommand router:
  //   /admin               — list of subcommands (help)
  //   /admin chats         — list of all sessions
  //   /admin stats         — aggregate across all sessions
  //   /admin chat <id>     — details of a single session
  //   /admin chat <id> /<command> — run a command in another chat (reply to the admin)
  //   /admin chat <id> <text>     — preview the bot's reply to that text in that chat (nothing sent/stored)
  admin: async (ctx, mode) => {
    const isPrivate = ctx.msg?.chat?.type === "private";
    // Admins = ADMIN_USERNAMES (mutable @handle) OR ADMIN_USER_IDS (immutable account id — preferred), AND
    // only in private chats (don't expose it in groups). Otherwise behave as an ordinary message (no hint).
    if (!isPrivate || !isAdminUser(ctx)) {
      return null;
    }
    const lang = ctx.cfg.lang;
    // The persona state flag for the dumps is produced by the pack itself from its own persona-state (adminFlags) —
    // the engine does not expose someone else's mechanics; without a pack/hook there simply is no flag.
    const personaAdminFlags = getPersona().adminFlags;
    const raw = mode.argText.trim();
    const m = raw.match(/^(\S+)\s*([\s\S]*)$/); // [\s\S]* — don't lose a multiline argument (bulk /memory add via /admin chat <id> /…)
    const sub = (m ? m[1] : "").toLowerCase();
    const subArg = m ? m[2].trim() : "";

    // Subcommand help (for /admin without an argument).
    if (!sub) {
      return t(lang, "adm_help");
    }

    if (sub === "chats") {
      const res = await ctx.env.DB.prepare(
        `SELECT c.chat_id, c.name, c.role, c.paused, c.config, c.spend, c.spend_count, c.persona_state,
                COUNT(msg.id) AS msgs, COALESCE(SUM(LENGTH(msg.content)),0) AS chars
         FROM chats c LEFT JOIN messages msg ON msg.chat_id = c.chat_id
         GROUP BY c.chat_id ORDER BY c.updated_at DESC`
      ).all();
      const rows = (res?.results as any[]) || [];
      if (!rows.length) return t(lang, "adm_no_sessions");
      const lines = [t(lang, "adm_sessions_header", rows.length)];
      let totalSpend = 0;
      for (const r of rows) {
        const cfg = parseJson<Record<string, any>>(r.config, {});
        const spend = Number(r.spend) || 0;
        totalSpend += spend;
        const flags = [];
        if (r.paused) flags.push("⏸");
        if (r.role) flags.push("🎭");
        if (cfg.model) flags.push("🧠`" + cfg.model + "`");
        const persFlag = personaAdminFlags?.(parseJson<Record<string, unknown>>(r.persona_state, {})) || "";
        if (persFlag) flags.push(persFlag);
        const spendStr = spend > 0 ? ` · $${spend.toFixed(4)}(${r.spend_count || 0})` : "";
        const titleStr = r.name ? ` «${r.name}»` : "";
        lines.push(`\`${r.chat_id}\`${titleStr} — ${r.msgs}msg/${r.chars}c${spendStr}${flags.length ? " · " + flags.join(" ") : ""}`);
      }
      lines.push("", t(lang, "adm_total_spend", totalSpend.toFixed(4)));
      return lines.join("\n");
    }

    // /admin commands — force-refresh the native command menu now (the cron auto-syncs on a change, but
    // this gives instant feedback right after a deploy). Reports how many setMyCommands calls succeeded.
    if (sub === "commands") {
      const n = await syncBotCommands(ctx.env);
      return t(lang, "adm_commands_synced", n);
    }

    if (sub === "stats") {
      const c: any = await ctx.env.DB.prepare(
        `SELECT COUNT(*) AS chats,
                SUM(CASE WHEN CAST(chat_id AS INTEGER) < 0 THEN 1 ELSE 0 END) AS groups,
                COALESCE(SUM(spend),0) AS spend, COALESCE(SUM(spend_count),0) AS reqs,
                COALESCE(SUM(paused),0) AS paused,
                SUM(CASE WHEN role IS NOT NULL AND role <> '' THEN 1 ELSE 0 END) AS with_role
         FROM chats`
      ).first();
      const mm = await messageStats(ctx.env);
      const chats = Number(c?.chats) || 0, groups = Number(c?.groups) || 0;
      return t(lang, "adm_stats", chats, chats - groups, groups, mm.msgs, mm.chars, Number(c?.reqs) || 0, Number(c?.paused) || 0, Number(c?.with_role) || 0, (Number(c?.spend) || 0).toFixed(4));
    }

    // /admin chat <id>              — session details
    // /admin chat <id> /<command>   — run the command in that chat (adminRunInChat)
    // /admin chat <id> <text>       — preview the bot's reply to that text in that chat (adminPreviewInChat)
    if (sub === "chat") {
      // [\s\S]* — the tail may be multiline (bulk /memory add, a long message)
      const cm = subArg.match(/^(\S+)\s*([\s\S]*)$/);
      const chatArg = cm ? cm[1] : "";
      const rest = cm ? cm[2].trim() : "";
      if (!chatArg) return t(lang, "adm_chat_need_id");
      if (rest) {
        if (!/^-?\d+$/.test(chatArg)) return t(lang, "adm_cmd_need_id");
        return rest.startsWith("/") ? adminRunInChat(ctx, chatArg, rest) : adminPreviewInChat(ctx, chatArg, rest);
      }
      const row: any = await ctx.env.DB.prepare("SELECT * FROM chats WHERE chat_id=?").bind(chatArg).first();
      const mm = await messageStats(ctx.env, chatArg);
      const msgs = mm.msgs;
      if (!row && !msgs) return t(lang, "adm_chat_notfound", chatArg);
      const cfg = parseJson<Record<string, any>>(row?.config, {});
      const cfgKeys = Object.keys(cfg);
      const photo = parseJson<Record<string, string>>(row?.photo_cache, {});
      const detailFlag = personaAdminFlags?.(parseJson<Record<string, unknown>>(row?.persona_state, {})) || "";
      return [
        t(lang, "adm_chat_title", chatArg),
        row?.name ? t(lang, "adm_chat_name", row.name) : t(lang, "adm_chat_name_unknown"),
        t(lang, "adm_chat_history", msgs, mm.chars),
        t(lang, "adm_chat_photos", Object.keys(photo).length),
        t(lang, "adm_chat_role", row?.role ? `"${row.role}"` : t(lang, "adm_chat_role_none")),
        (detailFlag ? detailFlag + " · " : "") + t(lang, "adm_chat_pause", row?.paused ? t(lang, "adm_yes") : t(lang, "adm_no")),
        t(lang, "adm_chat_spend", (Number(row?.spend) || 0).toFixed(4), row?.spend_count || 0),
        t(lang, "adm_chat_model", cfg.model || t(lang, "adm_model_default")) + (cfg.vision_model ? ` · 👁 \`${cfg.vision_model}\`` : ""),
        cfgKeys.length ? t(lang, "adm_chat_settings", cfgKeys.map((k) => `\`${k}\``).join(", ")) : t(lang, "adm_chat_settings_default"),
      ].join("\n");
    }

    // /admin trace                — 24 h metrics (LLM per kind + stage counts)
    // /admin trace <chatId> [n]   — the newest n traces of a chat, one line each (stages in order)
    // /admin trace <traceId>      — one trace in full: every event with its offset, outcome and a detail summary
    if (sub === "trace") {
      const parts = subArg.split(/\s+/).filter(Boolean);
      const tz = ctx.cfg.timezone;
      if (!parts[0]) {
        const since = Date.now() - 86_400_000;
        const [llm, stages] = await Promise.all([traceLLMStats(ctx.env, since), traceStageStats(ctx.env, since)]);
        if (!llm.length && !stages.length) return t(lang, "adm_trace_stats_none");
        const lines = [t(lang, "adm_trace_stats_header")];
        for (const r of llm) lines.push(t(lang, "adm_trace_stats_llm", r.kind, r.n, r.n - r.ok, Math.round(r.avg_ms), Math.round(r.max_ms), r.cost.toFixed(4)));
        for (const r of stages) lines.push(t(lang, "adm_trace_stats_stage", r.stage, r.kind ? ":" + r.kind : "", r.n));
        return lines.join("\n");
      }
      if (/^-?\d+$/.test(parts[0])) {
        const n = Math.min(30, Math.max(1, parseInt(parts[1] || "10", 10) || 10));
        const traces = await listTraces(ctx.env, parts[0], n);
        if (!traces.length) return t(lang, "adm_trace_none", parts[0]);
        const lines = [t(lang, "adm_trace_list_header", parts[0], traces.length)];
        for (const tr of traces) lines.push("`" + tr.trace + "` " + tzStamp(tr.events[0].ts, tz).slice(5) + "\n   " + tr.events.map(traceEventBrief).join(" → "));
        lines.push(t(lang, "adm_trace_hint"));
        return lines.join("\n");
      }
      const events = await getTrace(ctx.env, parts[0]);
      if (!events.length) return t(lang, "adm_trace_notfound", parts[0]);
      const lines = [t(lang, "adm_trace_header", parts[0], events[0].chat_id, tzStamp(events[0].ts, tz))];
      for (const e of events) lines.push(`#${e.id} +${e.ms}ms ${traceEventBrief(e)}` + (e.detail && e.detail !== "{}" ? " — " + e.detail.slice(0, 160) : ""));
      lines.push(t(lang, "adm_event_hint"));
      return lines.join("\n");
    }

    // /admin event <id> — one event in full (an LLM event: system prompt, last user message, memory block, response).
    if (sub === "event") {
      if (!/^\d+$/.test(subArg)) return t(lang, "adm_event_usage");
      const e = await getTraceEvent(ctx.env, Number(subArg));
      if (!e) return t(lang, "adm_event_notfound", subArg);
      const d = parseJson<Record<string, any>>(e.detail, {});
      const lines = [t(lang, "adm_event_header", e.id, e.trace, traceEventBrief(e), e.ms, e.cost != null ? " · $" + e.cost.toFixed(4) : "")];
      if (e.stage === "llm") {
        lines.push(t(lang, "adm_event_llm_meta", d.model ?? "", d.finish ?? "—", d.msg_count ?? 0, d.prompt_chars ?? 0));
        if (d.recall) lines.push(t(lang, "adm_event_recall", d.recall.raw === d.recall.query ? d.recall.query : d.recall.raw + " ⟶ " + d.recall.query, (d.recall.facts || []).length), ...(d.recall.facts || []).map((f: string) => "— " + f));
        lines.push(t(lang, "adm_event_user", d.user_text ?? ""), t(lang, "adm_event_response", d.response ?? ""), t(lang, "adm_event_system", d.system ?? ""));
      } else {
        lines.push(JSON.stringify(d, null, 1));
      }
      return lines.join("\n");
    }

    return t(lang, "adm_unknown_sub", sub);
  },

  // /memory — manage the chat's memory.
  //   /memory                       — show status (history/cache/size)
  //   /memory forget [target]       — wipe a slice (all|history|memory|role|state|cache|spend); bare → usage help
  //   /memory dedupe                — remove consecutive identical messages
  //   /memory size_chars <N>        — set the history size in characters (the bot's memory)
  memory: async (ctx, mode) => {
    const lang = ctx.cfg.lang;
    const raw = mode.argText.trim();
    const sub = raw.toLowerCase();
    // A fact is saved/embedded even when rag is off (ready for recall without a backfill). With rag off
    // memory works like notes, but the bot does not recall facts in replies — hint about this neutrally.
    const ragHint = ctx.cfg.rag ? "" : t(lang, "mem_hint_notes");

    // /memory forget [target] — wipe a chosen slice (or `all`). Bare `forget` → usage help (no wipe),
    // since the unqualified command used to nuke everything. The forget-word may be localized (mem_sub_forget).
    const fParts = raw.split(/\s+/);
    const fHead = (fParts[0] || "").toLowerCase();
    if (fHead === "forget" || fHead === "clear" || tList(lang, "mem_sub_forget").includes(fHead)) {
      const target = (fParts[1] || "").toLowerCase();
      if (!target) return t(lang, "mem_forget_usage");
      const all = target === "all";
      // target → aliases. A target wipes its own slice; `all` wipes every slice.
      const TARGETS: Record<string, string[]> = {
        history: ["history"], memory: ["memory", "facts"], role: ["role"],
        state: ["state", "mood"], cache: ["cache", "photos"], spend: ["spend"],
      };
      const known = all || Object.values(TARGETS).some(a => a.includes(target));
      if (!known) return t(lang, "mem_forget_usage");
      const hit = (k: string): boolean => all || TARGETS[k].includes(target);

      if (hit("history")) {
        ctx.chatData._summary = "";
        ctx.chatData._dailyUptoId = 0; // reset the summary boundaries (the id autoincrement is not reused)
        ctx.chatData._cmdUptoId = 0;
        ctx.chatData._cmdDay = "";
        ctx.chatData._memUptoId = 0;   // history gone → re-curate facts from scratch
        await clearChatHistory(ctx);   // history=[] + _dirty + DELETE rows from D1
      }
      if (hit("memory")) {
        ctx.chatData._memUptoId = 0;
        await clearMemories(ctx);      // facts + their vectors mem:<chatId>
      }
      if (hit("role")) ctx.chatData.role = null;
      if (hit("state")) ctx.chatData.personaState = getPersonaStateDefaults();
      if (hit("cache")) ctx.chatData.photoCache = {};
      if (hit("spend")) { ctx.chatData.spend = 0; ctx.chatData.spendCount = 0; }
      ctx.chatData._dirty = true;      // persist the chats-row resets (clear* set it only for history/facts)

      return t(lang,
        all ? "mem_forgotten" :
        target === "history" ? "mem_forget_history" :
        (target === "memory" || target === "facts") ? "mem_forget_memory" :
        target === "role" ? "mem_forget_role" :
        (target === "state" || target === "mood") ? "mem_forget_state" :
        (target === "cache" || target === "photos") ? "mem_forget_cache" :
        "mem_forget_spend");
    }

    // /memory add <text> — memorize a fact manually (raw, to preserve the text's case).
    // Also catch a bare `add` (without text) → a hint, rather than falling through to the status panel.
    if (sub === "add" || /^add\s/i.test(raw)) {
      // One line → one fact; multiple lines → bulk add (one fact per line).
      const body = raw.replace(/^add\s*/i, "");
      const facts = body.split("\n").map(s => s.trim().slice(0, MEM_MAX_FACT_CHARS)).filter(Boolean);
      if (!facts.length) return t(lang, "mem_add_empty");
      let added = 0, dup = 0;
      for (const f of facts) {
        if (await addMemory(ctx, f, "manual")) added++; else dup++;
      }
      if (facts.length === 1) return (added ? t(lang, "mem_add_one", facts[0]) : t(lang, "mem_add_dup_one")) + ragHint;
      return t(lang, "mem_add_many", added, dup ? t(lang, "mem_add_dup_suffix", dup) : "") + ragHint;
    }

    if (sub === "list" || tList(lang, "mem_sub_list").includes(sub)) {
      const rows = await listMemories(ctx.env, ctx.chatId);
      if (!rows.length) return t(lang, "mem_list_empty") + ragHint;
      // Source icon BEFORE the text: ✍️ — added manually, 🤖 — the bot memorized it itself (auto).
      const lines = rows.map((m, i) => `${i + 1}. ${m.source === "manual" ? "✍️" : "🤖"} ${m.text}`);
      return [t(lang, "mem_list_header"), ...lines].join("\n") + ragHint;
    }

    // /memory del <N> — delete a single fact by its number from /memory list (1-based).
    const delParts = raw.split(/\s+/);
    const delWords = ["del", "delete", ...tList(lang, "mem_sub_del")];
    if (delParts.length === 2 && delWords.includes(delParts[0].toLowerCase()) && /^\d+$/.test(delParts[1])) {
      const n = parseInt(delParts[1], 10);
      const rows = await listMemories(ctx.env, ctx.chatId);
      if (n < 1 || n > rows.length) {
        return t(lang, "mem_del_oor", n, rows.length);
      }
      const m = rows[n - 1];
      await deleteMemory(ctx, m.id);
      return t(lang, "mem_del_ok", n, m.text);
    }

    // /memory reindex — ADMIN ONLY (hidden from help): re-embed every fact of the chat from its D1 row, so the
    // vectors (embedding + metadata.text) match the store again after a direct database repair. Works through
    // `/admin chat <id> /memory reindex` (the target ctx keeps the admin's `from`). Non-admins fall through.
    if (sub === "reindex" && isAdminUser(ctx)) {
      const rows = await listMemories(ctx.env, ctx.chatId);
      if (!rows.length) return t(lang, "mem_list_empty");
      const r = await ragReindexMemories(ctx, rows);
      return t(lang, "mem_reindex_ok", r.done, r.total);
    }

    // /memory recall <text> — ADMIN ONLY (hidden from help): the recall DIAGNOSTIC — what the reply path would
    // look up for this text in this chat: the query after the context rewrite (rewriteRecallQuery over the chat's
    // history) and the dated facts the hybrid search returns, in rank order. Nothing is written. Works through
    // `/admin chat <id> /memory recall <text>`. Tells apart "the fact was never recalled" from "the model ignored it".
    const rc = raw.match(/^recall\s+([\s\S]+)$/i);
    if (rc && isAdminUser(ctx)) {
      const q = stripBotAddressing(rc[1].trim(), ctx.cfg);
      const query = await rewriteRecallQuery(ctx, q);
      const facts = await ragRetrieveMemories(ctx, query);
      const lines = [t(lang, "mem_recall_head", query === q ? q : q + " ⟶ " + query, facts.length), ...facts.map(f => "— " + f)];
      if (!ctx.cfg.rag) lines.push(t(lang, "mem_hint_notes")); // recall never runs with rag off — say so instead of a silent 0
      return lines.join("\n");
    }

    if (sub === "dedupe" || tList(lang, "mem_sub_dedupe").includes(sub)) {
      const removed = await dedupeChatHistory(ctx);
      if (!removed) return t(lang, "mem_dedupe_none");
      return t(lang, "mem_dedupe_ok", removed);
    }

    // /memory size_chars [N] — show/set the history size (in characters).
    const sizeMatch = raw.match(/^size_chars\s*(.*)$/i);
    if (sizeMatch) {
      const val = sizeMatch[1].trim();
      if (!val) {
        return t(lang, "mem_size_show", ctx.cfg.history_chars);
      }
      // Use the shared schema validator (history_chars: int 500–100000).
      return setConfigParam(ctx, "history_chars", val);
    }

    // Without an argument (or unknown) — memory status + hints.
    const histLen = ctx.chatData.history?.length || 0;
    const histChars = historyChars(ctx.chatData.history);
    const cacheLen = Object.keys(ctx.chatData.photoCache || {}).length;
    const memCount = (await listMemories(ctx.env, ctx.chatId)).length;
    return t(lang, "mem_status", histLen, histChars, ctx.cfg.history_chars, memCount, cacheLen) + ragHint;
  },

  // /model — show the models (text/photo/summary) + price + balance.
  // /model <id> — change the main one. /model reset — reset ALL models (main + vision + summary).
  // /model vision <id> — model for photos.
  // /model summary <id> — model for /summary.
  // (/model vision reset / /model summary reset — reset just that one).
  model: async (ctx, mode) => {
    const lang = ctx.cfg.lang;
    const arg = mode.argText.trim();

    // /model reset (or a localized reset word) — reset ALL models at once: main + vision + summary.
    // (`/model vision reset` / `… summary reset` still reset just one — they're caught below.)
    if (["reset", ...tList(lang, "cfg_reset_words")].includes(arg.toLowerCase())) {
      const newConf = { ...ctx.chatData.config };
      delete newConf.model;
      delete newConf.vision_model;
      delete newConf.summary_model;
      saveChatConfig(ctx, newConf);
      return t(lang, "model_reset_all");
    }

    // The vision/summary subcommands — a separate model for photos / for /summary. They differ only
    // in the word and the config key; the labels (scope/notSet) are taken from the locale by word.
    const SUBMODELS = [
      { word: "vision",  key: "vision_model",  emoji: "👁" },
      { word: "summary", key: "summary_model", emoji: "📝" },
    ];
    for (const sm of SUBMODELS) {
      const m = arg.match(new RegExp(`^${sm.word}\\s*(.*)$`, "i"));
      if (!m) continue;
      const val = m[1].trim();
      if (!val) {
        // Show the current model (or a hint if not set).
        const cur = ctx.chatData.config?.[sm.key] as string | undefined;
        if (cur) {
          const info = await fetchModelPrice(ctx.cfg, cur);
          return t(lang, "model_sub_current", sm.emoji, t(lang, "model_scope_" + sm.word), cur, info ? `\n${info}` : "", sm.word);
        }
        return t(lang, "model_sub_unset", sm.emoji, t(lang, "model_scope_" + sm.word), t(lang, "model_notset_" + sm.word), sm.word);
      }
      const res = setConfigParam(ctx, sm.key, val);
      const cur = ctx.chatData.config?.[sm.key] as string | undefined;
      const info = cur ? await fetchModelPrice(ctx.cfg, cur) : "";
      return info ? `${res}\n${info}` : res;
    }

    if (!arg) {
      const chatModel = ctx.chatData.config?.model as string | undefined;
      const active = ctx.cfg.openrouterModel;
      const visionModel = ctx.cfg.visionModel;
      const summaryModel = ctx.cfg.summaryModel;

      // Request the model cards and the balance in parallel.
      const [textInfo, visInfo, sumInfo, usage] = await Promise.all([
        fetchModelPrice(ctx.cfg, active),
        visionModel ? fetchModelPrice(ctx.cfg, visionModel) : Promise.resolve(""),
        summaryModel ? fetchModelPrice(ctx.cfg, summaryModel) : Promise.resolve(""),
        fetchOpenRouterUsage(ctx.cfg),
      ]);

      // The main (text) model block: name + its price/vision.
      const textHeader = chatModel
        ? t(lang, "model_text", chatModel)
        : t(lang, "model_text_default", active);
      let out = textHeader + (textInfo ? `\n${textInfo}` : "");

      // The vision-model block (only if a separate one is set) — with its own price/vision.
      if (visionModel) {
        out += "\n\n" + t(lang, "model_photo", visionModel) + (visInfo ? `\n${visInfo}` : "");
      }
      // The summary-model block (only if a separate one is set).
      if (summaryModel) {
        out += "\n\n" + t(lang, "model_summary_line", summaryModel) + (sumInfo ? `\n${sumInfo}` : "");
      }

      // Account balance and chat spend.
      out += `\n\n${usage}`;
      const spend = Number(ctx.chatData.spend) || 0;
      if (spend > 0) {
        out += "\n" + t(lang, "model_spent", spend.toFixed(4), ctx.chatData.spendCount);
      }

      out += "\n\n" + t(lang, "model_change_hint");
      return out;
    }
    // Changing the main model: save it and immediately show info about the new one (vision, price).
    const result = setConfigParam(ctx, "model", arg);
    // Which model becomes active: the one set in the chat, otherwise the env default (not the current
    // merged cfg.openrouterModel — it could have pointed to the chat's previous model).
    const chatModel = ctx.chatData.config?.model as string | undefined;
    const envDefault = ctx.env.OPENROUTER_MODEL || "openrouter/free";
    const active = chatModel || envDefault;
    const info = await fetchModelPrice(ctx.cfg, active);
    return info ? `${result}\n${info}` : result;
  },

  stop: async (ctx) => {
    setPaused(ctx, true);
    return t(ctx.cfg.lang, "cmd_stop");
  },

  resume: async (ctx) => {
    setPaused(ctx, false);
    return t(ctx.cfg.lang, "cmd_resume");
  },

  rp: async (ctx, mode) => {
    const lang = ctx.cfg.lang;
    const arg = mode.argText.trim();
    const argLower = arg.toLowerCase();

    if (!arg || ["info", "off", "reset"].includes(argLower)) {
      if (["off", "reset"].includes(argLower)) {
        setRole(ctx, null);
        return t(lang, "rp_reset");
      }
      return ctx.chatData.role
        ? t(lang, "rp_current", ctx.chatData.role)
        : t(lang, "rp_unset");
    }
    setRole(ctx, arg);
    return t(lang, "rp_accepted", arg);
  },

  info: async (ctx) => {
    return buildInfoStatus(ctx);
  },

  // /summary — incremental "what's new" digest. Command boundary = max(_cmdUptoId, _dailyUptoId)
  // (hard boundary: no deeper than the last daily summary). _cmdUptoId is reset every day
  // (by the date from msg.date in the configured timezone) — the first /summary of a new day = "since the last daily summary".
  summary: async (ctx) => {
    // Curate facts BEFORE the summary (just like the daily cron) — the single principle of "before every summary".
    // no-op if rag is off. Best-effort inside.
    await runMemoryCuration(ctx);

    const today = tzParts((ctx.msg?.date ? ctx.msg.date * 1000 : Date.now()), ctx.cfg.timezone).day;
    if (ctx.chatData._cmdDay !== today) {
      ctx.chatData._cmdUptoId = 0; // daily reset; the hard boundary below will pull it up to the daily one
      ctx.chatData._cmdDay = today;
      ctx.chatData._dirty = true;
    }
    const since = Math.max(ctx.chatData._cmdUptoId || 0, ctx.chatData._dailyUptoId || 0);
    const { text, maxId, hadNew } = await runIncrementalSummary(ctx, since);
    if (hadNew) {
      ctx.chatData._cmdUptoId = maxId;
      ctx.chatData._cmdDay = today;
      ctx.chatData._dirty = true;
    }
    // On a FRESH digest, ask tryCommand to remember the sent message_id as the "previous summary" pointer
    // (so the next /summary deep-links back to this one). A cache/refusal (hadNew=false) doesn't move it.
    // We send via the normal command path (tryCommand) — NOT here — so the /admin preview keeps returning the
    // text to the admin without ever posting into the target chat (the handler stays send-free).
    ctx._trackSummaryMsg = hadNew;
    return text;
  },

  // /lang [code] — switch the UI language, or (no arg) show the current + available ones. The locale set
  // is DISCOVERED from the i18n folders (LOCALES) — no language is hardcoded. Reply is in the new language.
  lang: async (ctx, mode) => {
    const cur = ctx.cfg.lang;
    const arg = (mode.argText || "").trim().toLowerCase();
    if (!arg) return t(cur, "lang_status", cur, LOCALES.join(", "));
    if (!LOCALES.includes(arg)) return t(cur, "lang_unknown", arg, LOCALES.join(", "));
    saveChatConfig(ctx, { ...ctx.chatData.config, lang: arg });
    return t(arg, "lang_set", arg);
  },

  // /alias @user Name — set a per-chat display-name alias (username → name). /alias — list them.
  // /alias del @user — remove one. Stored in chats.config.aliases; the name resolvers merge it OVER the
  // pack-static usernameAliases, so it also fixes the [from:Name] history tag the model sees.
  alias: async (ctx, mode) => {
    const lang = ctx.cfg.lang;
    const raw = (mode.argText || "").trim();
    const cur: Record<string, string> = { ...(ctx.chatData.config.aliases ?? {}) };
    const norm = (u: string): string => u.replace(/^@+/, "").toLowerCase();
    const save = (): void => { saveChatConfig(ctx, { ...ctx.chatData.config, aliases: cur }); };

    if (!raw) {
      const entries = Object.entries(cur);
      if (!entries.length) return t(lang, "alias_empty");
      return [t(lang, "alias_list_header"), ...entries.map(([u, n]) => `@${u} → ${n}`)].join("\n");
    }
    const parts = raw.split(/\s+/);
    if (["del", "delete", "remove"].includes(parts[0].toLowerCase())) {
      const u = norm(parts[1] || "");
      if (!u) return t(lang, "alias_usage");
      if (!cur[u]) return t(lang, "alias_del_oor", u);
      const name = cur[u];
      delete cur[u];
      save();
      return t(lang, "alias_del_ok", u, name);
    }
    // set: first token = @username, the rest = the display name.
    const u = norm(parts[0]);
    const name = raw.slice(parts[0].length).trim();
    if (!u || !name) return t(lang, "alias_usage");
    cur[u] = name;
    save();
    return t(lang, "alias_set", u, name);
  },

  // /retry — re-run the user's LAST message (ANY kind: a normal message OR a content command like /anek)
  // through its NATIVE path, so the reply is generated AND stored exactly as the original would be (chat
  // reply → stored; technical command reply → not). The real work is done in flow.ts `handleRetry`, which
  // has the dispatch + the live ctx/history without a module cycle. This stub is never reached:
  // handleTelegramMessage intercepts mode.type === "retry" before tryCommand. It exists only so /retry is a
  // real registered command (regex / native menu / help). Its own invocation isn't stored (skipHistory).
  retry: async () => null,
};

// The engine's core commands — self-describing plugins (the SAME RegisteredCommand contract as the persona):
// name (defaultCmd) + flags (llm/skipHistory) + handler in a single object. Order = priority in the regex
// (the core names do not overlap by prefix). They are all tech (skipHistory) — service output, not the bot's speech;
// summary is additionally llm (we show "typing"), but its output is not written to history either.
// menuDesc → the native command-menu description (i18n key); a command WITHOUT it is hidden from the menu
// (e.g. /admin). The menu order follows this list (engine), then the pack's commands.
const ENGINE_COMMAND_PLUGINS: RegisteredCommand[] = [
  { type: "admin",   defaultCmd: "/admin",   skipHistory: true, handler: ENGINE_COMMANDS.admin },
  { type: "start",   defaultCmd: "/start",   skipHistory: true, menuDesc: "menu_start",   handler: ENGINE_COMMANDS.start },
  { type: "help",    defaultCmd: "/help",    skipHistory: true, menuDesc: "menu_help",    handler: ENGINE_COMMANDS.help },
  { type: "info",    defaultCmd: "/info",    skipHistory: true, menuDesc: "menu_info",    handler: ENGINE_COMMANDS.info },
  { type: "config",  defaultCmd: "/config",  skipHistory: true, menuDesc: "menu_config",  handler: ENGINE_COMMANDS.config },
  { type: "model",   defaultCmd: "/model",   skipHistory: true, menuDesc: "menu_model",   handler: ENGINE_COMMANDS.model },
  { type: "memory",  defaultCmd: "/memory",  skipHistory: true, menuDesc: "menu_memory",  handler: ENGINE_COMMANDS.memory },
  { type: "summary", defaultCmd: "/summary", llm: true, skipHistory: true, menuDesc: "menu_summary", handler: ENGINE_COMMANDS.summary },
  { type: "rp",      defaultCmd: "/rp",      skipHistory: true, menuDesc: "menu_rp",      handler: ENGINE_COMMANDS.rp },
  // /retry shows a "typing" indicator (llm) and is skipHistory so its own invocation isn't logged; the
  // handler itself sends + stores the regenerated reply, so its return is null (no second send by tryCommand).
  { type: "retry",   defaultCmd: "/retry",   llm: true, skipHistory: true, menuDesc: "menu_retry", handler: ENGINE_COMMANDS.retry },
  { type: "lang",    defaultCmd: "/lang",    skipHistory: true, menuDesc: "menu_lang",    handler: ENGINE_COMMANDS.lang },
  { type: "alias",   defaultCmd: "/alias",   skipHistory: true, menuDesc: "menu_alias",   handler: ENGINE_COMMANDS.alias },
  { type: "stop",    defaultCmd: "/stop",    skipHistory: true, menuDesc: "menu_stop",    handler: ENGINE_COMMANDS.stop },
  { type: "resume",  defaultCmd: "/resume",  skipHistory: true, menuDesc: "menu_resume",  handler: ENGINE_COMMANDS.resume },
];
// Register the core in the registry — now the engine and the pack are a single plugin list (getAllCommands).
setEngineCommands(ENGINE_COMMAND_PLUGINS);

// COMMANDS/TECH/LLM are derived from a SINGLE list (core + persona). Adding a command = one object
// in ENGINE_COMMAND_PLUGINS (core) or in the pack — names/flags are no longer duplicated anywhere else.
// One trace event on one line: `stage:kind outcome 1.2s` (the list views).
function traceEventBrief(e: TraceEventRow): string {
  return e.stage + (e.kind ? ":" + e.kind : "") + (e.outcome ? " " + e.outcome : "") + (e.elapsed_ms != null ? " " + (e.elapsed_ms / 1000).toFixed(1) + "s" : "");
}

/* ---------- admin: acting inside ANOTHER chat ---------- */

// A temporary ctx on top of another chat's data: the TARGET chat's effective config (not the admin's — otherwise
// model/info/config would show the admin's settings), the admin as `from` (for /rp etc.), message_id 0.
async function adminTargetCtx(ctx: Ctx, targetId: string, text: string): Promise<Ctx> {
  const targetData = await getChatData(targetId, ctx.env);
  const targetMsg: TgMessage = {
    chat: { id: Number(targetId), type: Number(targetId) < 0 ? "group" : "private" },
    message_id: 0,
    from: ctx.msg.from,
    text,
  };
  const targetCfg = mergeConfig(getGlobalConfig(ctx.env), targetData.config);
  const tctx = makeCtx(targetMsg, ctx.env, targetCfg, targetData);
  tctx._trace = ctx._trace; // the admin's request keeps one trace across both chats
  return tctx;
}

// `/admin chat <id> /<command>`: run ANY command in another chat; the reply goes to the
// ADMIN, not to the target. Content (LLM) commands are a preview: their side effects (history/memory/state) are NOT
// written to the target chat (flush is skipped + _preview suppresses curation's write-through). Control commands
// (rp/config/memory/…) persist their effect to the target chat. `admin` itself is rejected (no recursion).
async function adminRunInChat(ctx: Ctx, targetId: string, cmdLine: string): Promise<string> {
  const lang = ctx.cfg.lang;
  const subMode = parseCommandAndArg(cmdLine, ctx.cfg);
  if (!isCommand(subMode.type) || subMode.type === "admin") return t(lang, "adm_cmd_bad", subMode.type || cmdLine);
  const targetCtx = await adminTargetCtx(ctx, targetId, cmdLine);
  if (LLM_COMMANDS.has(subMode.type)) targetCtx._preview = true;
  const out = await COMMANDS[subMode.type](targetCtx, subMode);
  if (!LLM_COMMANDS.has(subMode.type) && targetCtx.chatData._dirty) await flushChatData(targetId, ctx.env, targetCtx.chatData);
  return t(lang, "adm_cmd_result", targetId, subMode.type, out || t(lang, "adm_cmd_noreply"));
}

// `/admin chat <id> <text>`: a PREVIEW of the bot's regular reply to `text` as if it were said in that chat — the
// target chat's history, long-term memory (rewrite → hybrid recall → dated facts) and persona/role, exactly the
// default reply path minus the sending. Nothing goes to the target chat and nothing is stored: `_preview` blocks
// write-through, the chats row is never flushed (spend counted on the throwaway ctx is dropped). The way to check
// what the bot knows about a chat without posting there.
async function adminPreviewInChat(ctx: Ctx, targetId: string, text: string): Promise<string> {
  const lang = ctx.cfg.lang;
  const targetCtx = await adminTargetCtx(ctx, targetId, text);
  targetCtx._preview = true;
  const q = stripBotAddressing(text, targetCtx.cfg);
  const memories = q.length >= 4 ? await recallMemories(targetCtx, q) : [];
  const out = await runLLMWithHistory(targetCtx.cfg, buildDefaultPrompt(targetCtx, memories), targetCtx.chatData.history, text, targetCtx.msg, { ctx: targetCtx, kind: "preview" });
  return t(lang, "adm_msg_result", targetId, out);
}

// Is the sender of ctx.msg an admin (ADMIN_USERNAMES / ADMIN_USER_IDS)? Shared by /admin and the admin-only
// /memory subcommands; an `/admin chat <id> /…` target ctx keeps the admin's `from`, so it passes there too.
export function isAdminUser(ctx: Ctx): boolean {
  const who = (ctx.msg?.from?.username || "").toLowerCase();
  const fromId = ctx.msg?.from?.id;
  return (!!who && ctx.cfg.adminUsernames.includes(who)) || (fromId != null && ctx.cfg.adminUserIds.includes(Number(fromId)));
}

export const COMMANDS: Record<string, CommandHandler> = Object.fromEntries(
  getAllCommands().map((c) => [c.type, c.handler]),
);
// Commands that call the LLM (slow) — we show "typing" before them.
export const LLM_COMMANDS: Set<string> = new Set(getAllCommands().filter((c) => c.llm).map((c) => c.type));
// Technical commands: their output is NOT written to history (statuses/config/info/confirmations) — service output, not the bot's speech.
export const TECH_COMMANDS: Set<string> = new Set(getAllCommands().filter((c) => c.skipHistory).map((c) => c.type));

export function isCommand(t: string): boolean {
  return Object.prototype.hasOwnProperty.call(COMMANDS, t);
}

export async function tryCommand(mode: CommandMode, ctx: Ctx): Promise<boolean> {
  if (!isCommand(mode.type)) return false;
  if (LLM_COMMANDS.has(mode.type)) await sendTyping(ctx);
  const cmdT0 = Date.now();
  const out = await COMMANDS[mode.type](ctx, mode);
  await traceEvent(ctx, "command", { kind: mode.type, outcome: out != null && String(out).trim() ? "reply" : "silent", elapsedMs: Date.now() - cmdT0, detail: { argLen: (mode.argText || "").length, replyLen: out ? String(out).length : 0 } });
  // The handler may return null/empty (e.g. /admin for a non-admin) — then we stay silent.
  if (out != null && String(out).trim()) {
    const res = await sendAndStore(ctx, out, { skipHistory: TECH_COMMANDS.has(mode.type) });
    // /summary on a fresh digest: remember the message we just posted as the "previous summary" pointer,
    // so the next summary can deep-link back to it (the handler set _trackSummaryMsg; see ENGINE_COMMANDS.summary).
    if (ctx._trackSummaryMsg && res?.result?.message_id) {
      ctx.chatData._summaryMsgId = res.result.message_id;
      ctx.chatData._dirty = true;
    }
  }
  return true;
}
