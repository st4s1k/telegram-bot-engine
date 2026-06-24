/**
 * Domain types for the worker. Described according to their actual use in the code.
 * Telegram types are intentionally partial — we take only the fields we actually read.
 */

/* ===================== Cloudflare env ===================== */

// All environment variables the worker reads (getGlobalConfig + buildCommandRegex).
// KVNamespace — global type from worker-configuration.d.ts (wrangler types).
export interface Env {
  KV: KVNamespace; // general-purpose KV: update dedup flags, etc. (keys namespaced by prefix)
  DB: D1Database;
  AI: Ai;             // Workers AI — embeddings for long-term memory (RAG)
  VECTORIZE: Vectorize; // Vectorize index for semantic memory
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string; // if set, the fetch handler requires Telegram's X-Telegram-Bot-Api-Secret-Token header to match
  OPENROUTER_API_KEY?: string;
  OPENROUTER_PROVISIONING_KEY?: string;
  OPENROUTER_HOST?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_TITLE?: string;
  OPENROUTER_VISION_MODEL?: string;
  OPENROUTER_SUMMARY_MODEL?: string;
  MAX_HISTORY_CHARS?: string;
  MAX_TOKENS?: string;
  ENABLE_RAG?: string;
  RAG_TOP_K?: string;
  RAG_MIN_SCORE?: string;
  BOT_USERNAME?: string;
  BOT_NAME?: string;
  ADMIN_USERNAMES?: string; // CSV list of admin usernames (without @); empty — no admins
  ADMIN_CHAT_IDS?: string;  // CSV list of chat_id for failure alerts (reportError critical); empty — log only
  ADMIN_USER_IDS?: string;  // CSV list of admin Telegram user ids (immutable account ids) — preferred over ADMIN_USERNAMES
  LLM_LOG?: string;
  ANSWER_PROB?: string;
  ENABLE_VISION?: string;
  ENABLE_REASONING?: string;
  VISION_DETAIL?: string;
  VISION_HD_WORDS?: string;
  BOT_LANG?: string; // default language of the engine's UI strings (ru/en); defaults to ru
  BOT_TZ?: string;   // IANA timezone for history timestamps + the daily-summary cron gate; defaults to UTC
  // The persona pack reads ITS OWN env variables (switches/probabilities) via a cast of env —
  // the engine neither types nor names them.
}

/* ===================== Telegram (partial) ===================== */

export interface TgUser {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
}

export interface TgSticker {
  file_id?: string;
  file_unique_id?: string;
  emoji?: string;
  is_animated?: boolean;
  is_video?: boolean;
  thumbnail?: TgPhotoSize;
  thumb?: TgPhotoSize;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  sticker?: TgSticker;
  reply_to_message?: TgMessage;
  media_group_id?: string | number;
  date?: number; // message unix time (sec) — for the daily /summary boundary in the configured timezone
}

export interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

// Telegram sendMessage response (what we actually read).
export interface TgSendResult {
  ok?: boolean;
  description?: string;
  result?: { message_id?: number };
}

/* ===================== Chat history and state ===================== */

export type Role = "user" | "assistant";

export interface HistoryMeta {
  message_id?: number;
  reply_message_id?: number;
  user_id?: number | null;
  username?: string;
  name?: string;
  media_group_id?: string;
  photo_key?: string;
  ts?: number; // send time in unix ms (created_at) — for showing the time in history; set on load
}

export interface HistoryItem {
  role: Role;
  content: string;
  meta?: HistoryMeta;
}

// A curated long-term-memory fact (a row of the memories table).
export interface Memory {
  id: number;
  chat_id: string;
  text: string;
  source: string; // 'auto' | 'manual'
  created_at: number;
}

// A message in an OpenRouter request. content — a string (text) or an array of parts
// (text + image_url) for vision requests.
export interface LLMContentPart {
  type: string;
  text?: string;
  image_url?: { url: string; detail?: string };
}
export interface LLMMessage {
  role: string;
  content: string | LLMContentPart[];
}

// Per-chat setting overrides (scalar keys from CONFIG_SCHEMA), accessed dynamically by key. Plus the
// reserved `aliases` key — a per-chat username(lowercase)→display-name map set by /alias. It is NOT a
// /config scalar: mergeConfig copies only CONFIG_SCHEMA keys, so `aliases` never leaks into the effective
// BotConfig; the name resolvers read it straight off chatData.config (see chatAliases() in utils.ts).
export interface ChatConfig {
  [key: string]: string | number | boolean | Record<string, string> | undefined;
  aliases?: Record<string, string>;
}

// Per-chat PERSONA state — a generic JSON slot whose schema is defined by the pack itself (PersonaPack.stateSchema).
// The engine stores/loads it as opaque JSON and applies defaults from the schema; what's inside (levels,
// counters, any plugin state) is unknown to the engine.
export type PersonaState = Record<string, unknown>;

// PERSISTED chat state — exactly the columns of the `chats` table (written with a single UPSERT in flushChatData,
// read in getChatData). The underscore on some fields is historical, it does NOT mean «private/runtime».
export interface ChatState {
  /** generic persona state (JSON slot; schema comes from the pack). The engine does not interpret the contents. */
  personaState: PersonaState;
  role: string | null;
  paused: boolean;
  config: ChatConfig;
  photoCache: Record<string, string>;
  spend: number;
  spendCount: number;
  _name: string;
  /** text of the last /summary digest (mixed into the prompt as «already known — do not repeat») */
  _summary: string;
  /** boundary of the last DAILY (cron) summary: the max messages.id included in it */
  _dailyUptoId: number;
  /** boundary of the last COMMAND /summary: max messages.id (reset every day) */
  _cmdUptoId: number;
  /** Date (YYYY-MM-DD, configured timezone) of the last command summary — for the daily reset of _cmdUptoId */
  _cmdDay: string;
  /** boundary of the last FACT CURATION: the max messages.id that went through extraction (on reply) */
  _memUptoId: number;
}

// In-memory working copy for the duration of an update: persisted state + history window + transient flags.
// The history window is NOT persisted from here — messages are written write-through to the `messages` table.
export interface ChatData extends ChatState {
  history: HistoryItem[];
  /** transient: the state has changed and must be flushed at the end of the update */
  _dirty?: boolean;
  /** transient: reading state from D1 failed → this is a default stub; do NOT flush (otherwise we'd overwrite the row with defaults) */
  _loadFailed?: boolean;
  /** legacy chat-name field (migrated into _name) */
  title?: string;
}

/* ===================== Config and context ===================== */

export interface CmdRegexEntry {
  type: string;
  re: RegExp;
}

// Merged config (getGlobalConfig + mergeConfig). The index signature is for dynamic
// cfg[key] access in buildConfigHelp/setConfigParam.
export interface BotConfig {
  telegramToken?: string;
  openrouterApiKey?: string;
  openrouterProvisioningKey: string;
  openrouterHost: string;
  openrouterModel: string;
  openrouterTitle: string;
  model: string;
  visionModel: string;
  summaryModel: string;
  history_chars: number;
  maxTokens: number;
  rag: boolean;
  rag_top_k: number;
  rag_min_score: number;
  daily_summary: boolean;
  botUsername: string;
  botName: string;
  botId: number | null;
  adminUsernames: string[];
  adminUserIds: number[];
  llmLog: boolean;
  lang: string; // language of the engine's UI strings (ru/en); the persona localizes its own texts separately
  timezone: string; // IANA timezone (env BOT_TZ, default UTC) for history timestamps + the daily-summary cron gate
  random: boolean;
  answer_prob: number;
  // Persona switches and probabilities (*_prob) are provided by the persona pack (getGlobalConfig mixes in
  // defaults); they are read dynamically via cfg[key] through the index signature below.
  vision: boolean;
  reasoning: boolean;
  visionDetail: string;
  visionHdWords: string[];
  _cmdRegex: CmdRegexEntry[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export type VisualKind = "photo" | "sticker";

export interface Ctx {
  cfg: BotConfig;
  chatData: ChatData;
  env: Env;
  msg: TgMessage;
  chatId: number;
  replyTargetId: number;
  textRaw: string;
  textLower: string;
  photo: TgPhotoSize[] | null;
  hasPhoto: boolean;
  hasVisual: boolean;
  visualKind: VisualKind | null;
  stickerEmoji: string;
  photoFromReply: boolean;
  /** transient: ctx is an /admin chat_cmd preview in ANOTHER chat; write-through side effects (memory
   *  curation, etc.) must be suppressed so we don't write into the target chat (flush is skipped anyway) */
  _preview?: boolean;
}

export interface CommandMode {
  type: string;
  argText: string;
}

// Metadata of a config-schema entry.
export interface ConfigMeta {
  type: "bool" | "float" | "int" | "string";
  desc: string;
  min?: number;
  max?: number;
}

// A visual extracted from a message (photo/sticker).
export interface Visual {
  kind: VisualKind;
  photos: TgPhotoSize[] | null;
  emoji: string;
}
