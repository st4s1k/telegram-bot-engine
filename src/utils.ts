/* ================= UTILS ================= */
// Pure helpers with no domain dependencies (only constants + types). The pure
// visual helpers (visualFromMsg/visualLabel/visualNote/photoCacheKey), the context
// constructor makeCtx and the shouldAnswer decision also live here — they are needed by
// the lower layers (storage/flow/vision), so they can't live in the "heavy" vision layer.

import { ROOTS_LIMIT, REQ_ID_LEN } from "./constants";
import { getPersona, getPersonaTexts, getAllFallbackTexts } from "./persona/registry";
import { t, DEFAULT_LANG } from "./i18n";
import type {
  BotConfig, ChatData, CommandMode, Ctx, Env, HistoryItem, HistoryMeta,
  TgMessage, TgPhotoSize, TgSendResult, TgUser, Visual, VisualKind,
} from "./types";

// --- Visual (pure helpers) ---

// Extracts the visual source from a message: a photo or a sticker.
// For a static sticker we take the file itself (.webp); for an animated/video one — the thumbnail
// (the static first frame that Telegram provides on its own). photos is an array of "sizes"
// in PhotoSize format (for a sticker it's a single element).
export function visualFromMsg(m: TgMessage | null | undefined): Visual | null {
  if (!m) return null;
  if (Array.isArray(m.photo) && m.photo.length) {
    return { kind: "photo", photos: m.photo, emoji: "" };
  }
  if (m.sticker) {
    const s = m.sticker;
    const src = (s.is_animated || s.is_video) ? (s.thumbnail || s.thumb) : s;
    const photos: TgPhotoSize[] | null = src?.file_id
      ? [{ file_id: src.file_id, file_unique_id: src.file_unique_id || s.file_unique_id }]
      : null; // rare: an animated sticker without a thumbnail — there's no image, only the emoji remains
    return { kind: "sticker", photos, emoji: s.emoji || "" };
  }
  return null;
}

export function makeCtx(msg: TgMessage, env: Env, effectiveCfg: BotConfig, chatData: ChatData): Ctx {
  // For a photo, the caption is treated as the text. Stickers have no text/caption.
  const text = msg.text || msg.caption || "";

  // The visual may be in the message itself OR in the message being replied to (reply).
  const own = visualFromMsg(msg);
  const rep = visualFromMsg(msg.reply_to_message);
  const v = own || rep;               // priority — the own visual, otherwise the one from the reply

  return {
    cfg: effectiveCfg,
    chatData,
    env,
    msg,
    chatId: msg.chat.id,
    replyTargetId: msg.message_id,
    textRaw: text,
    textLower: text.toLowerCase(),
    photo: v?.photos || null,         // image source (photo sizes or a sticker frame)
    hasPhoto: !!(v && v.photos),      // whether there's an image that can be shown to the model
    hasVisual: !!v,                   // whether there's any visual at all (incl. a sticker without an image)
    visualKind: (v?.kind || null) as VisualKind | null, // 'photo' | 'sticker'
    stickerEmoji: v?.kind === "sticker" ? v.emoji : "",
    photoFromReply: !own && !!rep,
  };
}

// Human-readable visual label: "photo" or "sticker 😂".
export function visualLabel(ctx: Ctx): string {
  if (ctx.visualKind === "sticker") {
    return ctx.stickerEmoji ? t(ctx.cfg.lang, "vis_sticker_emoji", ctx.stickerEmoji) : t(ctx.cfg.lang, "vis_sticker");
  }
  return t(ctx.cfg.lang, "vis_photo");
}

// A visual annotation for the history. label — "photo"/"sticker 😂", desc — the description, caption — the caption.
export function visualNote(label: string, caption: string, desc: string): string {
  if (desc) return caption ? `[${label}: ${desc}] ${caption}` : `[${label}: ${desc}]`;
  return caption ? `[${label}] ${caption}` : `[${label}]`;
}

// A stable photo key for the description cache. file_unique_id is the same for one and the same
// file in Telegram (including when a photo is answered with a reply), unlike file_id.
// We take the largest size — its unique id is stable for this image.
export function photoCacheKey(photos: TgPhotoSize[] | null | undefined): string | null {
  if (!Array.isArray(photos) || !photos.length) return null;
  const largest = photos[photos.length - 1];
  return largest?.file_unique_id || largest?.file_id || null;
}

// --- Decision: whether to answer ---

export function shouldAnswer(text: string, msg: TgMessage, cfg: BotConfig): { answer: boolean; reason: string } {
  if (msg.chat && msg.chat.type === "private") return { answer: true, reason: "addressed" };
  if (messageMentionsBot(text, msg, cfg)) return { answer: true, reason: "addressed" };
  if (!cfg.random) return { answer: false, reason: "random_disabled" };
  const ok = Math.random() < cfg.answer_prob;
  return { answer: ok, reason: ok ? "random" : "skip" };
}

// --- Commands / parsing ---

export function parseCommandAndArg(text: string, cfg: BotConfig): CommandMode {
  for (const { type, re } of cfg._cmdRegex) {
    const m = String(text || "").match(re);
    if (m) return { type, argText: stripBotMentions(String(text).slice(m[0].length), cfg) };
  }
  return { type: "llm", argText: "" };
}

// A message shaped like a Telegram bot command (`/name` or `/name@bot`) that NO registered command
// matched. Returns the bare command name (lowercase, no slash, no @bot suffix) when the command is for
// US (or targets no specific bot); returns null for plain text or a `/cmd@otherbot` meant for another bot.
// Telegram's own command grammar is ASCII `/[a-zA-Z0-9_]{1,32}`, so a cyrillic "/привет" is treated as text.
export function unknownCommandName(text: string, cfg: BotConfig): string | null {
  const m = String(text || "").trim().match(/^\/([a-z0-9_]{1,32})(?:@([a-z0-9_]+))?(?:\s|$)/i);
  if (!m) return null;
  const target = (m[2] || "").toLowerCase();
  if (target && target !== cfg.botUsername.toLowerCase()) return null; // addressed to another bot — not ours
  return m[1].toLowerCase();
}

export function stripBotMentions(s: string, cfg: BotConfig): string {
  return s
    .replace(new RegExp(`@${escapeRegExp(cfg.botUsername)}\\b`, "gi"), "")
    .replace(/[^\S\n]+/g, " ") // collapse HORIZONTAL whitespace, but PRESERVE line breaks
    .trim();                    // (needed for multi-line /memory add — effectively one fact per line)
}

export function parseRoots(s: string, cfg: BotConfig): string[] {
  return Array.from(new Set(
    stripBotMentions(s, cfg).toLowerCase().split(/[,\s]+/).filter(Boolean)
  )).slice(0, ROOTS_LIMIT);
}

// Total history length in characters (by the content field). A single point of counting.
export function historyChars(history: HistoryItem[] | undefined | null): number {
  return (history || []).reduce((sum, m) => sum + (m?.content || "").length, 0);
}

export function lastToken(t: string): string {
  return (String(t).toLowerCase().match(/[\p{L}\p{N}]+(?=[^\p{L}\p{N}]*$)/u) || [""])[0];
}

export function escapeRegExp(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pickOne<T>(a: T[]): T {
  return Array.isArray(a) ? a[Math.floor(Math.random() * a.length)] : a;
}

export function newReqId(): string {
  return crypto.randomUUID().slice(0, REQ_ID_LEN);
}

export function messageMentionsBot(text: string, _msg: TgMessage, cfg: BotConfig): boolean {
  const s = String(text).toLowerCase();
  // The substring check already covers @mentions (an entity-mention is the same
  // "@username" text in the string), so separate parsing of msg.entities isn't needed.
  // wakeWords — words addressing the bot from the persona pack. Substring, any case
  // (the pack itself decides which substrings wake the bot).
  return s.includes("@" + cfg.botUsername) || (getPersona().wakeWords ?? []).some(w => s.includes(w));
}

// --- User names ---

// The private username→name mapping is persona identity (non-localized), on the pack object:
// read per call via getPersona().usernameAliases.

export function resolveUserName(user: TgUser | null | undefined, chatAliases: Record<string, string> = {}): string | null {
  if (!user) return null;
  const uname = user.username && user.username.toLowerCase();
  // pack-static aliases (getPersona().usernameAliases) ∪ per-chat /alias overrides (the latter win).
  const aliases = { ...(getPersona().usernameAliases ?? {}), ...chatAliases };
  if (uname && aliases[uname]) return aliases[uname];
  return user.first_name || null;
}

// targetNameFallback is localized (a PersonaTexts field) — pass the chat's lang so the placeholder name
// matches the UI language; defaults to DEFAULT_LANG when a caller has no lang in hand.
export function pickTargetName(msg: TgMessage, lang: string = DEFAULT_LANG, chatAliases: Record<string, string> = {}): string {
  return resolveUserName(msg.reply_to_message?.from, chatAliases)
      || resolveUserName(msg.from, chatAliases)
      || getPersonaTexts(lang).targetNameFallback;
}

export function pickRandomUserText(h: HistoryItem[], bot: string): string {
  const user = h.filter(m => m.role === "user" && !m.content.includes("@" + bot));
  return pickOne(user)?.content || "";
}

export function getReplyText(msg: TgMessage): string | null {
  return msg.reply_to_message?.text || null;
}

export function getUserName(msg: TgMessage, lang: string = DEFAULT_LANG, chatAliases: Record<string, string> = {}): string {
  return resolveUserName(msg.from, chatAliases) || t(lang, "name_user_fallback");
}

// Per-chat display-name aliases (username→name), set via /alias and stored in the chat config. The name
// resolvers merge these over the pack-static usernameAliases. Call sites with a ctx pass chatAliases(ctx).
export function chatAliases(ctx: Ctx): Record<string, string> {
  return ctx.chatData.config.aliases ?? {};
}

// Human-readable chat name for /admin: the group title (chat.title) or the
// interlocutor's name in a private chat (first_name + @username). Empty if nothing can be extracted.
export function chatTitleFromMsg(msg: TgMessage): string {
  const chat = msg.chat || {};
  if (chat.title) return chat.title; // groups/supergroups/channels
  const f = msg.from || {};
  const name = [f.first_name, f.last_name].filter(Boolean).join(" ");
  const uname = f.username ? `@${f.username}` : "";
  return [name, uname].filter(Boolean).join(" ").trim();
}

// Per-timezone Intl formatter (both Workers and Node ship full ICU) — DST-correct for any IANA zone.
// Cached per TZ string: constructing an Intl.DateTimeFormat is expensive, and formatWithMeta parses
// for every item of the history window (up to HISTORY_HARD_CAP_ITEMS per one LLM reply). The TZ is
// deployment-wide (one value per isolate), so this cache holds one entry in practice.
const _tzFmtCache = new Map<string, Intl.DateTimeFormat>();
function tzFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = _tzFmtCache.get(tz);
  if (!fmt) {
    const opts: Intl.DateTimeFormatOptions = {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    };
    try {
      fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, ...opts });
    } catch {
      // Invalid TZ id (bad BOT_TZ) → fall back to UTC rather than throwing on every history format.
      fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...opts });
    }
    _tzFmtCache.set(tz, fmt);
  }
  return fmt;
}

// Parse unix time (ms) into calendar fields for `tz`. hour is normalized to 0–23 (ICU sometimes gives 24 for midnight).
function tzFields(unixMs: number, tz: string): { year: string; month: string; day: string; hour: number; minute: string } {
  const parts = tzFormatter(tz).formatToParts(new Date(unixMs));
  const g = (t: string): string => parts.find(p => p.type === t)?.value || "";
  let hour = Number(g("hour"));
  if (!Number.isFinite(hour) || hour === 24) hour = 0;
  return { year: g("year"), month: g("month"), day: g("day"), hour, minute: g("minute") };
}

// Hour (0–23) and date (YYYY-MM-DD) in `tz`. For the cron gate of the daily summary (08:00) and
// the daily reset of the /summary command boundary.
export function tzParts(unixMs: number, tz: string = "UTC"): { hour: number; day: string } {
  const f = tzFields(unixMs, tz);
  return { hour: f.hour, day: `${f.year}-${f.month}-${f.day}` };
}

// --- History: metadata and items ---

export function getUserMeta(msg: TgMessage, chatAliases: Record<string, string> = {}): HistoryMeta {
  const f = msg.from || {};
  const meta: HistoryMeta = {
    message_id: msg.message_id,
    reply_message_id: msg.reply_to_message?.message_id,
    user_id: f.id,
    username: f.username,
    name: resolveUserName(msg.from, chatAliases) ?? f.first_name,
  };
  // For a photo we remember the group (album) and the stable frame key — so that we can later
  // link frames of the same album by media_group_id.
  if (msg.media_group_id) meta.media_group_id = String(msg.media_group_id);
  const pk = photoCacheKey(msg.photo);
  if (pk) meta.photo_key = pk;
  return meta;
}

export function buildUserItem(msg: TgMessage, content: string, chatAliases: Record<string, string> = {}): HistoryItem {
  return { role: "user", content, meta: getUserMeta(msg, chatAliases) };
}

export function buildAssistantItem(content: string, cfg: BotConfig, replyId: number | undefined, sent: TgSendResult | null | undefined): HistoryItem {
  return {
    role: "assistant",
    content,
    meta: {
      message_id: sent?.result?.message_id,
      reply_message_id: replyId,
      user_id: cfg.botId,
      username: "@" + cfg.botUsername,
      name: cfg.botName,
    },
  };
}

// A «YYYY-MM-DD HH:MM» timestamp in `tz` from unix-ms (created_at). For display in the history,
// so the bot references the DATE/TIME rather than internal message_id.
export function tzStamp(unixMs: number, tz: string = "UTC"): string {
  const f = tzFields(unixMs, tz);
  return `${f.year}-${f.month}-${f.day} ${String(f.hour).padStart(2, "0")}:${f.minute}`;
}

export function formatWithMeta(item: HistoryItem, tz: string = "UTC"): string {
  const m: HistoryMeta = item.meta || {};
  // Timestamp (in `tz`) instead of msg:N — so the model cites the date/time, not Telegram ids.
  const when = m.ts ? `; ${tzStamp(m.ts, tz)}` : "";
  return `[from:${m.name || "user"}${when}]\n${item.content || ""}`;
}

// Make HH:MM timestamps inside a /summary digest clickable: each maps to a Telegram message deep-link
// (t.me/c/<id>/<msg_id>) jumping to the message sent at that minute. Telegram message links only exist in
// SUPERGROUPS (chat_id like -100…) — in private chats / basic groups there are none, so the text is
// returned unchanged. The minute→message_id map is built from `items` (the summarized messages, same `tz`
// the model saw); a time with no message at that minute stays plain. Output is lightweight Markdown links
// that sendTelegramMessage's toMarkdownV2 preserves.
export function linkifySummaryTimes(text: string, items: HistoryItem[], chatId: number | string, tz: string = "UTC"): string {
  const sg = String(chatId).match(/^-100(\d+)$/);
  if (!sg) return text;                       // not a supergroup → no per-message deep-links
  const internal = sg[1];
  const byMinute: Record<string, number> = {}; // "HH:MM" → first message_id at that minute
  for (const it of items) {
    const id = it.meta?.message_id;
    const ts = it.meta?.ts;
    if (!id || !ts) continue;
    const hhmm = tzStamp(ts, tz).slice(11);     // "YYYY-MM-DD HH:MM" → "HH:MM"
    if (!(hhmm in byMinute)) byMinute[hhmm] = id;
  }
  if (!Object.keys(byMinute).length) return text;
  // Link each HH:MM (1–2 digit hour); intervals like "10:25–10:40" linkify both ends independently.
  return text.replace(/\b(\d{1,2}):(\d{2})\b/g, (whole, h: string, mm: string) => {
    const id = byMinute[`${h.padStart(2, "0")}:${mm}`];
    return id ? `[${whole}](https://t.me/c/${internal}/${id})` : whole;
  });
}

// The bot's technical fallbacks (LLM errors). We don't save them to the history.
export function isFallbackMessage(text: string): boolean {
  return getAllFallbackTexts().includes(String(text).trim());
}
