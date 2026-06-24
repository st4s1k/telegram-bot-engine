/* ================= CONFIG ================= */
// Config layering: getGlobalConfig (env + defaults) → mergeConfig (per-chat overrides by
// CONFIG_SCHEMA keys) → effectiveCfg. CONFIG_SCHEMA is the source of truth for configurable
// keys and their validation. The help/status/config-reference builders also live here.

import { escapeRegExp, historyChars } from "./utils";
import { t, tList, DEFAULT_LANG, LOCALES } from "./i18n";
import { saveChatConfig } from "./storage";
import { getPersona, getPersonaConfig, getAllCommands, getPersonaTexts } from "./persona/registry";
import type { BotConfig, ChatConfig, CmdRegexEntry, ConfigMeta, Ctx, Env } from "./types";

type ConfigParseResult =
  | { ok: true; value: string | number | boolean }
  | { ok: false; error: string };

// desc is a locale KEY (t(lang, meta.desc)); the texts live in src/i18n/*.json. A persona schema may
// supply desc as a literal — t() returns it as-is (fallback), so both forms work.
const ENGINE_CONFIG_SCHEMA: Record<string, ConfigMeta> = {
  // --- MAIN ---
  "random":         { type: "bool",  desc: "cfg_desc_random" },
  "answer_prob":    { type: "float", desc: "cfg_desc_answer_prob" },
  "history_chars":  { type: "int",   desc: "cfg_desc_history_chars", min: 500, max: 100000 },
  "model":          { type: "string", desc: "cfg_desc_model", max: 100 },
  "vision_model":    { type: "string", desc: "cfg_desc_vision_model", max: 100 },
  "summary_model":   { type: "string", desc: "cfg_desc_summary_model", max: 100 },
  "reasoning":      { type: "bool",  desc: "cfg_desc_reasoning" },
  "max_tokens":     { type: "int",   desc: "cfg_desc_max_tokens", min: 256, max: 65536 },

  // --- LONG-TERM MEMORY (RAG) ---
  "rag":            { type: "bool",  desc: "cfg_desc_rag" },
  "rag_top_k":      { type: "int",   desc: "cfg_desc_rag_top_k", min: 1, max: 20 },
  "rag_min_score":  { type: "float", desc: "cfg_desc_rag_min_score" },

  // --- DAILY SUMMARY ---
  "daily_summary":  { type: "bool",  desc: "cfg_desc_daily_summary" },

  // --- VISION ---
  "vision":   { type: "bool",  desc: "cfg_desc_vision" },

  // --- LANGUAGE (UI) ---
  "lang":     { type: "string", desc: "cfg_desc_lang", max: 5 },
};

// CONFIG_SCHEMA = engine ∪ persona (switches/probabilities come from the pack). Key order does not
// matter: this is a lookup map (mergeConfig/setConfigParam by key); the help order is set by CONFIG_GROUPS.
export const CONFIG_SCHEMA: Record<string, ConfigMeta> = { ...ENGINE_CONFIG_SCHEMA, ...(getPersonaConfig().schema || {}) };

// Help-output groups: engine keys + (appended) persona groups. Without a persona (personaless)
// only the engine ones remain — buildConfigHelp guards against references to missing keys.
// The group key is a locale KEY (t(lang, gName) in buildConfigHelp). Persona groups may be
// a literal label — t() returns them as-is (fallback).
const ENGINE_CONFIG_GROUPS: Record<string, string[]> = {
  "cfg_group_main": ["random", "answer_prob"],
  "cfg_group_vision": ["vision"],
  "cfg_group_thinking": ["reasoning", "max_tokens"],
  "cfg_group_rag": ["rag", "rag_top_k", "rag_min_score"],
  "cfg_group_daily": ["daily_summary"],
  "cfg_group_lang": ["lang"],
};
export const CONFIG_GROUPS: Record<string, string[]> = { ...ENGINE_CONFIG_GROUPS, ...(getPersonaConfig().groups || {}) };

// Config presets (modes) are persona content (switch bundles); they live in the persona pack, the engine
// just exposes them (engine-base empty ∪ pack). `/config preset <name>` applies one in a single step.
export const CONFIG_PRESETS: Record<string, { desc: string; config: ChatConfig }> = { ...(getPersonaConfig().presets || {}) };

// The env-derived config is immutable for the lifetime of the isolate (env does not change between requests),
// so we memoize by env identity (WeakMap → we don't keep env alive). This avoids the CSV splits
// (adminUsernames/visionHdWords/adminChatIds) and the literal allocation on every update.
// IMPORTANT: mergeConfig must keep cloning (`{ ...globalCfg }`) so per-chat overlays
// don't mutate the cached object.
const _globalCfgCache = new WeakMap<Env, BotConfig>();

export function getGlobalConfig(env: Env): BotConfig {
  const cached = _globalCfgCache.get(env);
  if (cached) return cached;
  const num = (v: unknown, d: number): number => Number.isFinite(Number(v)) ? Number(v) : d;
  const bool = (v: unknown): boolean => ["1", "true", "yes", "on"].includes(String(v || "").toLowerCase());
  const botUsername = (env.BOT_USERNAME || "bot").toLowerCase();
  const lang = String(env.BOT_LANG || "en").toLowerCase(); // UI language; default en, per-chat via /config lang

  const cfg: BotConfig = {
    // System
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    openrouterApiKey: env.OPENROUTER_API_KEY,
    openrouterProvisioningKey: env.OPENROUTER_PROVISIONING_KEY || "",
    openrouterHost: env.OPENROUTER_HOST || "https://openrouter.ai/api/v1",
    openrouterModel: env.OPENROUTER_MODEL || "openrouter/free",
    openrouterTitle: env.OPENROUTER_TITLE || "",
    model: "", // per-chat model override (empty = openrouterModel from env is used)
    visionModel: env.OPENROUTER_VISION_MODEL || "", // model for photos (empty = same as the main one)
    summaryModel: env.OPENROUTER_SUMMARY_MODEL || "", // model for /summary (empty = same as the main one)
    history_chars: num(env.MAX_HISTORY_CHARS, 8000),
    // Cap on the model's response length (tokens). Default 4000 (~10–15k Cyrillic chars).
    // 0/invalid → max_tokens is not sent in the request (the model uses its own default).
    maxTokens: num(env.MAX_TOKENS, 4000),
    // Long-term memory (RAG, Vectorize). OFF by default — enabled via /config rag on
    // (or globally with env ENABLE_RAG=true). top_k — how many facts to recall,
    // min_score — the cosine-similarity threshold (0–1).
    rag: bool(env.ENABLE_RAG),
    rag_top_k: num(env.RAG_TOP_K, 5),
    rag_min_score: num(env.RAG_MIN_SCORE, 0.5),
    // Daily summary via cron (08:00 in the configured timezone) — opt-in per chat via /config daily_summary on.
    // OFF by default: the bot sends nothing on its own until the chat has subscribed.
    daily_summary: false,
    botUsername,
    botName: env.BOT_NAME || "Bot",
    botId: Number((env.TELEGRAM_BOT_TOKEN || "").split(":")[0]) || null,
    // List of admin usernames (without @, lowercase) from the CSV env ADMIN_USERNAMES. Empty → NO admins
    // (the engine hardcodes no personal username; the deployment sets ADMIN_USERNAMES in vars).
    adminUsernames: String(env.ADMIN_USERNAMES || "")
      .toLowerCase().split(",").map(s => s.trim()).filter(Boolean),
    llmLog: bool(env.LLM_LOG),
    lang, // language of the engine's UI strings (ru/en), per-chat via /config lang
    // IANA timezone for history timestamps and the daily-summary cron gate. Default UTC. Deployment-wide
    // (env only, not per-chat): the cron schedule in wrangler.jsonc is chosen to align with this TZ + the 08:00 gate.
    timezone: String(env.BOT_TZ || "UTC").trim() || "UTC",

    // Defaults for Configurable keys
    random: true,
    answer_prob: num(env.ANSWER_PROB, 0.1),

    // Switches for quick replies/throws and their probabilities — defaults come from the persona pack (spread below).

    // Vision. OFF by default — enabled with the /config vision on command
    // (or globally via env ENABLE_VISION=true).
    vision: bool(env.ENABLE_VISION),
    // The model's "reasoning". ON by default. reasoning models
    // generate an internal chain of thought (smarter, but slower and more expensive).
    // Disabled with /config reasoning off (or env ENABLE_REASONING=false) — then the model
    // responds faster. Non-reasoning models ignore this parameter.
    reasoning: env.ENABLE_REASONING === undefined ? true : bool(env.ENABLE_REASONING),
    // Default vision detail: low (cheap) or high (expensive, sees details).
    visionDetail: ["low", "high"].includes(String(env.VISION_DETAIL || "").toLowerCase())
      ? String(env.VISION_DETAIL).toLowerCase()
      : "low",
    // Caption words that bump the vision detail to high. Default from the active locale
    // (vision_hd_default) — the engine carries no hardcoded language; a deployment overrides via env.
    visionHdWords: (env.VISION_HD_WORDS ? String(env.VISION_HD_WORDS).split(",") : tList(lang, "vision_hd_default"))
      .map(s => s.trim().toLowerCase()).filter(Boolean),

    _cmdRegex: buildCommandRegex(env, botUsername),
    // Persona defaults: switches + probabilities (*_prob) from the pack. Read dynamically via cfg[key].
    ...(getPersonaConfig().defaults?.(env) || {}),
  };

  // max_tokens is a schema key (snake), while the cfg field is camelCase maxTokens. We keep the snake alias
  // equal to maxTokens so buildConfigHelp shows the value even for an unmerged cfg.
  cfg.max_tokens = cfg.maxTokens;
  _globalCfgCache.set(env, cfg);
  return cfg;
}

// Cache of compiled command regexes (they depend only on botUsername + the env command names,
// which are in practice constant for the entire lifetime of the worker).
const _cmdRegexCache = new Map<string, CmdRegexEntry[]>();

export function buildCommandRegex(env: Env, botUsername: string): CmdRegexEntry[] {
  const cached = _cmdRegexCache.get(botUsername);
  if (cached) return cached;

  const mkCmd = (cmd: string): RegExp => new RegExp(
    `^${escapeRegExp(cmd.toLowerCase())}(?:@${escapeRegExp(botUsername)})?(?:\\s|$)`,
    "i"
  );
  // A single list of plugins: the engine core + the persona (one RegisteredCommand contract).
  // Command name = c.defaultCmd (fixed). Order: engine first, then the pack.
  const list: CmdRegexEntry[] = [];
  for (const c of getAllCommands()) {
    list.push({ type: c.type, re: mkCmd(c.defaultCmd) });
  }
  _cmdRegexCache.set(botUsername, list);
  return list;
}

export function mergeConfig(globalCfg: BotConfig, chatOverrides: ChatConfig | null | undefined): BotConfig {
  const result: BotConfig = { ...globalCfg };
  if (chatOverrides) {
    for (const key of Object.keys(CONFIG_SCHEMA)) {
      if (chatOverrides[key] !== undefined) {
        result[key] = chatOverrides[key];
      }
    }
    // The model from the chat config (if set non-empty) overrides the env default.
    if (result.model) result.openrouterModel = result.model;
    // Vision model: config key vision_model → camelCase visionModel.
    if (result.vision_model) result.visionModel = result.vision_model;
    // Summary model: config key summary_model → camelCase summaryModel.
    if (result.summary_model) result.summaryModel = result.summary_model;
    // max_tokens (the /config key, snake) → maxTokens (camelCase, read in callOpenRouter).
    if (result.max_tokens !== undefined) result.maxTokens = Number(result.max_tokens);
  }
  // Keep the snake key max_tokens equal to the effective maxTokens — so /config shows it
  // (the global cfg only has camelCase maxTokens).
  result.max_tokens = result.maxTokens;
  return result;
}

export function parseConfigValue(meta: ConfigMeta, rawVal: string, lang: string = DEFAULT_LANG): ConfigParseResult {
  if (meta.type === "bool") {
    const v = (rawVal || "").toLowerCase();
    if (["on", "true", "1", "yes"].includes(v) || tList(lang, "cfg_true_words").includes(v)) return { ok: true, value: true };
    if (["off", "false", "0", "no"].includes(v) || tList(lang, "cfg_false_words").includes(v)) return { ok: true, value: false };
    return { ok: false, error: t(lang, "cfg_err_bool") };
  }
  if (meta.type === "float") {
    const num = parseFloat(rawVal);
    if (isNaN(num) || num < 0 || num > 1) {
      return { ok: false, error: t(lang, "cfg_err_float") };
    }
    return { ok: true, value: num };
  }
  if (meta.type === "int") {
    const num = parseInt(rawVal, 10);
    const min = meta.min ?? 0;
    const max = meta.max ?? Number.MAX_SAFE_INTEGER;
    if (isNaN(num) || num < min || num > max) {
      return { ok: false, error: t(lang, "cfg_err_int", min, max) };
    }
    return { ok: true, value: num };
  }
  if (meta.type === "string") {
    const v = (rawVal || "").trim();
    // reset/off/«-» → reset to default (empty string = taken from env).
    if (["reset", "off", "default", "-"].includes(v.toLowerCase()) || tList(lang, "cfg_reset_words").includes(v.toLowerCase())) {
      return { ok: true, value: "" };
    }
    if (!v) return { ok: false, error: t(lang, "cfg_err_empty") };
    if (/\s/.test(v)) return { ok: false, error: t(lang, "cfg_err_spaces") };
    if (v.length > (meta.max ?? 100)) return { ok: false, error: t(lang, "cfg_err_toolong", meta.max ?? 100) };
    return { ok: true, value: v };
  }
  return { ok: false, error: t(lang, "cfg_err_unknown") };
}

// Applies a single config value (shared logic for /config and /model). Returns the reply text.
export function setConfigParam(ctx: Ctx, key: string, rawVal: string): string {
  const lang = ctx.cfg.lang;
  const meta = CONFIG_SCHEMA[key];
  if (!meta) return t(lang, "cfg_set_notfound", key);

  const parsed = parseConfigValue(meta, rawVal, lang);
  if (!parsed.ok) return t(lang, "cfg_set_error", parsed.error, key);

  // `lang` must be a discovered locale — reject an unknown one (don't silently switch). English stays the
  // default in the repo, but changing to a non-existent language is an error, not a silent fallback.
  if (key === "lang" && parsed.value && !LOCALES.includes(String(parsed.value))) {
    return t(lang, "lang_unknown", parsed.value, LOCALES.join(", "));
  }

  const newConf: ChatConfig = { ...ctx.chatData.config, [key]: parsed.value };
  saveChatConfig(ctx, newConf);

  if (meta.type === "string") {
    if (!parsed.value) {
      const fallback = key === "model" ? ctx.cfg.openrouterModel : t(lang, "cfg_default");
      return t(lang, "cfg_set_reset", key, fallback);
    }
    return t(lang, "cfg_set_ok", key, parsed.value);
  }
  return t(lang, "cfg_set_ok_desc", key, parsed.value, t(lang, meta.desc));
}

// /help — the engine renders its OWN base command list, then APPENDS the persona's additions (its own
// commands + notes). The persona's helpText is just its section (it no longer re-lists engine commands);
// without a persona it's empty and only the base shows.
export function buildHelp(lang: string = DEFAULT_LANG): string {
  const base = t(lang, "help_engine");
  const persona = getPersonaTexts(lang).helpText;
  return persona ? `${base}\n\n${persona}` : base;
}

export function buildInfoStatus(ctx: Ctx): string {
  const { cfg, chatData } = ctx;
  const lang = cfg.lang;
  const role = chatData.role ? `"${chatData.role}"` : t(lang, "info_role_unset");
  const status = chatData.paused ? t(lang, "info_paused") : t(lang, "info_active");
  const histLen = (chatData.history || []).length;
  const histChars = historyChars(chatData.history);
  const overrides = Object.keys(chatData.config || {}).length;

  const persona = getPersona();
  let msg = `${getPersonaTexts(lang).infoTitle}\n\n`;
  // Extra persona lines (formerly the arousal line); without a persona/hook — nothing.
  if (persona.infoLines) for (const line of persona.infoLines(ctx)) msg += `${line}\n`;
  msg += t(lang, "info_role", role) + "\n";
  msg += `${status}\n`;
  msg += t(lang, "info_model", cfg.openrouterModel) + "\n";
  msg += t(lang, "info_history", histLen, histChars, cfg.history_chars) + "\n";
  msg += t(lang, "info_overrides", overrides) + "\n\n";
  msg += t(lang, "info_footer");
  return msg;
}

export function buildConfigHelp(cfg: BotConfig, chatConf: ChatConfig): string {
  const lang = cfg.lang;
  let msg = t(lang, "cfg_help_title") + "\n\n";
  msg += t(lang, "cfg_help_howto") + "\n";
  msg += "`/config " + t(lang, "cfg_help_param_value") + "`\n";
  msg += t(lang, "cfg_help_onoff") + "\n";
  msg += t(lang, "cfg_help_numbers") + "\n";
  msg += t(lang, "cfg_help_example") + "\n";
  msg += t(lang, "cfg_help_reset") + "\n";
  // The presets line — only if the pack provides them (without a persona CONFIG_PRESETS is empty).
  const presetNames = Object.keys(CONFIG_PRESETS);
  if (presetNames.length) msg += t(lang, "cfg_help_presets", presetNames.join(", ")) + "\n";
  msg += "\n" + t(lang, "cfg_help_current") + "\n\n";

  for (const [gName, keys] of Object.entries(CONFIG_GROUPS)) {
    msg += `*${t(lang, gName)}*\n`;
    for (const key of keys) {
      const meta = CONFIG_SCHEMA[key];
      if (!meta) continue; // personaless: a group may reference a key from a missing pack
      const val = cfg[key];
      const isCustom = chatConf[key] !== undefined;

      let displayVal = val;
      let icon = "🔹";

      if (meta.type === "bool") {
        displayVal = t(lang, val ? "cfg_on" : "cfg_off");
        icon = val ? "✅" : "❌";
      } else if (meta.type === "float") {
        displayVal = `${(val * 100).toFixed(0)}%`;
        icon = "📈";
      } else if (meta.type === "int") {
        displayVal = String(val);
        icon = "🔢";
      } else if (meta.type === "string") {
        // For the model: if not set in the chat — show the active one (from env).
        displayVal = val || (key === "model" ? cfg.openrouterModel : "—");
        icon = "🧠";
      }

      msg += `\`${key}\`: ${icon} **${displayVal}** ${isCustom ? "✏️" : ""} — _${t(lang, meta.desc)}_\n`;
    }
    msg += "\n";
  }
  return msg;
}
