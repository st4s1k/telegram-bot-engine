/* ================= PHOTO (VISION) ================= */
// Handles photos and stickers. Descriptions are cached by file_unique_id (photoCache) —
// a re-seen image is answered from the cache via a text-only request, without vision.

import { PHOTO_DELIM, GETFILE_TIMEOUT_MS } from "./constants";
import { getPersonaTexts } from "./persona/registry";
import { t } from "./i18n";
import {
  photoCacheKey, visualLabel, visualNote, buildUserItem, messageMentionsBot, shouldAnswer,
} from "./utils";
import { appendHistory, cachePhotoDesc } from "./storage";
import { callOpenRouter, runLLMWithHistory } from "./llm";
import { sendTyping, sendAndStore } from "./telegram";
import { buildVisionPrompt, buildPhotoFromCachePrompt } from "./prompts";
import type { Ctx, LLMMessage } from "./types";

// Log "bot does not react to the visual": we write the note only for our OWN visual
// (someone else's from a reply is already in history as its author's message).
// If a description of this visual is already in the cache, we add it for free (the bot
// "recognizes" a familiar sticker/photo and remembers what's on it even while staying silent).
export async function logIgnoredPhoto(ctx: Ctx, caption: string): Promise<void> {
  if (ctx.photoFromReply) return;
  const key = photoCacheKey(ctx.photo);
  const cachedDesc = (key && ctx.chatData.photoCache?.[key]) || "";
  await appendHistory(ctx, [buildUserItem(ctx.msg, visualNote(visualLabel(ctx), caption, cachedDesc))]);
}

// Parse the vision model's reply per the "<description> ||| <reply>" contract. Without the delimiter the whole text
// is the reply (desc is empty, reply is NOT trimmed); hasDelim distinguishes "empty description" from "no delimiter".
export function splitVisionReply(raw: string): { desc: string; reply: string; hasDelim: boolean } {
  const idx = raw.indexOf(PHOTO_DELIM);
  if (idx === -1) return { desc: "", reply: raw, hasDelim: false };
  return { desc: raw.slice(0, idx).trim(), reply: raw.slice(idx + PHOTO_DELIM.length).trim(), hasDelim: true };
}

export async function handlePhotoMessage(ctx: Ctx): Promise<void> {
  const caption = ctx.textRaw; // text/caption (empty for stickers)
  const label = visualLabel(ctx);

  // Vision is off → a free note into history, without a vision request.
  if (!ctx.cfg.vision) {
    await logIgnoredPhoto(ctx, caption);
    return;
  }

  // Decide whether to react.
  // Visual from a reply — react ONLY to an explicit mention (wake-word/@username),
  // so the bot doesn't butt into random replies to old pictures/stickers.
  // Own visual — the usual logic (private chat / mention / random).
  const mentioned = messageMentionsBot(caption, ctx.msg, ctx.cfg);
  const decision = ctx.photoFromReply
    ? { answer: mentioned, reason: "addressed" }
    : shouldAnswer(caption, ctx.msg, ctx.cfg);

  if (!decision.answer || ctx.chatData.paused) {
    await logIgnoredPhoto(ctx, caption);
    return;
  }

  await sendTyping(ctx); // "bot is typing" while the vision/text request runs

  // Stable image key. If a description is already in the cache — we do NOT download and do NOT
  // re-send the image to the model: we generate the reply via a text request from the description.
  const key = photoCacheKey(ctx.photo);
  const cachedDesc = key && ctx.chatData.photoCache?.[key];

  // Album context (if this is a photo from an album): "photo X of Y" + descriptions of already known
  // frames of the same group. Only for a reply to an album photo.
  const album = ctx.photoFromReply ? albumContext(ctx, key) : "";

  let desc = "";
  let reply = "";

  if (cachedDesc) {
    // Cheap: a text request from the known description, without vision and without getFile.
    desc = cachedDesc;
    const userMsg = [caption || t(ctx.cfg.lang, "vis_no_caption"), album].filter(Boolean).join("\n");
    reply = await runLLMWithHistory(
      ctx.cfg,
      buildPhotoFromCachePrompt(cachedDesc, ctx),
      ctx.chatData.history,
      userMsg,
      ctx.msg,
      { forceAppendUser: true, ctx }
    );
  } else if (ctx.photo) {
    // First time seeing the image → vision request (description + reply together).
    const detail = pickVisionDetail(caption, ctx.cfg);
    const imageUrl = await getTelegramPhotoUrl(ctx, detail);
    if (!imageUrl) {
      await logIgnoredPhoto(ctx, caption);
      console.warn("visual: failed to resolve file url", { chatId: ctx.chatId });
      return;
    }

    // Mix the album context into the caption passed to vision.
    const visionCaption = [caption, album].filter(Boolean).join("\n");
    const raw = await runVision(ctx, imageUrl, visionCaption, detail);

    // Parse "description ||| reply" (no delimiter → the whole text is the reply).
    ({ desc, reply } = splitVisionReply(raw));

    // Remember the description by the image key so we don't describe it again next time.
    if (desc) cachePhotoDesc(ctx, key, desc);
  } else {
    // No image (e.g. an animated sticker without a thumbnail) — react based on the emoji.
    desc = ctx.stickerEmoji ? t(ctx.cfg.lang, "vis_sticker_emoji", ctx.stickerEmoji) : t(ctx.cfg.lang, "vis_sticker");
    reply = await runLLMWithHistory(
      ctx.cfg,
      buildPhotoFromCachePrompt(desc, ctx),
      ctx.chatData.history,
      caption || t(ctx.cfg.lang, "vis_sticker_paren"),
      ctx.msg,
      { forceAppendUser: true, ctx }
    );
  }

  // Into history — the user's current message with a note about the visual's description.
  // Own: "[photo: ...] caption" / "[sticker 😂: ...]". Reply: "[in reply to photo: ...] text".
  const lang = ctx.cfg.lang;
  let note: string;
  if (ctx.photoFromReply) {
    note = desc
      ? (caption ? `${t(lang, "vis_reply_to_desc", label, desc)} ${caption}` : t(lang, "vis_reply_to_desc", label, desc))
      : (caption || t(lang, "vis_reply_to", label));
  } else {
    note = visualNote(label, caption, desc);
  }
  await appendHistory(ctx, [buildUserItem(ctx.msg, note)]);

  // Reply to the chat (sendAndStore itself adds the bot's reply to history).
  await sendAndStore(ctx, reply || getPersonaTexts(ctx.cfg.lang).fallbackError);
}

// Vision detail for a specific photo: high if the caption contains an hd-word,
// otherwise the default from config (low).
export function pickVisionDetail(caption: string, cfg: Ctx["cfg"]): string {
  const c = String(caption || "").toLowerCase();
  if (cfg.visionHdWords.some((w: string) => c.includes(w))) return "high";
  return cfg.visionDetail;
}

// Album (media group) context for a photo from a reply. Telegram sends an album as separate
// messages with a shared media_group_id — we accumulated them in history with notes. Here, by
// group, we gather: how many frames in total we've seen and which are already described (from cache) — for free.
// Returns a hint string for the model or "" (if this is not an album or a group of one).
export function albumContext(ctx: Ctx, currentKey: string | null): string {
  const r = ctx.msg.reply_to_message;
  const groupId = r?.media_group_id ? String(r.media_group_id) : null;
  if (!groupId) return "";

  // Collect the unique frames of this group from history (by meta.media_group_id).
  const keys: string[] = [];
  for (const item of ctx.chatData.history || []) {
    const m = item?.meta;
    if (m?.media_group_id === groupId && m.photo_key && !keys.includes(m.photo_key)) {
      keys.push(m.photo_key);
    }
  }
  if (keys.length <= 1) return ""; // not an album, or we've only seen one frame

  const idx = currentKey ? keys.indexOf(currentKey) : -1;
  const position = idx >= 0 ? t(ctx.cfg.lang, "vis_album_pos", idx + 1, keys.length) : t(ctx.cfg.lang, "vis_album_pos_alt", keys.length);

  // Descriptions of the remaining frames that are ALREADY in the cache (without new vision requests).
  const others: string[] = [];
  for (const k of keys) {
    if (k === currentKey) continue;
    const d = ctx.chatData.photoCache?.[k];
    if (d) others.push(d);
  }

  let ctxLine = t(ctx.cfg.lang, "vis_album_ctx", position);
  if (others.length) ctxLine += t(ctx.cfg.lang, "vis_album_others", others.join("; "));
  ctxLine += ")";
  return ctxLine;
}

// Description of a photo from the context (own attached OR from a reply — ctx.photo points
// to the right one). First from the cache, otherwise (if vision is on) — a vision description with caching.
export async function describeCtxPhoto(ctx: Ctx): Promise<string | null> {
  const photos = ctx.photo;
  if (!Array.isArray(photos) || !photos.length) return null;

  const key = photoCacheKey(photos);
  const cached = key && ctx.chatData.photoCache?.[key];
  if (cached) return cached;            // the cache works even if vision was turned off afterward
  if (!ctx.cfg.vision) return null;     // we don't make a new description if vision is off

  const detail = ctx.cfg.visionDetail;
  const imageUrl = await getTelegramPhotoUrl(ctx, detail);
  if (!imageUrl) return null;

  // Caption: own (the current message's caption) or the caption of the photo from the reply.
  const capt = ctx.photoFromReply ? (ctx.msg.reply_to_message?.caption || "") : (ctx.msg.caption || "");
  const raw = await runVision(ctx, imageUrl, capt, detail);
  // Description = the part before the delimiter; without a delimiter — the whole text.
  const v = splitVisionReply(raw);
  const desc = v.hasDelim ? v.desc : raw.trim();
  if (desc) cachePhotoDesc(ctx, key, desc);
  return desc || null;
}

// "Source text" for content commands from the pack. Takes BOTH into account:
// the text/caption from the reply AND the photo description (own attached or from the reply).
// If there's both text and a photo — we concatenate them.
export async function getReplySource(ctx: Ctx): Promise<string | null> {
  const parts: string[] = [];

  // The reply's text or its caption.
  const r = ctx.msg.reply_to_message;
  if (r?.text) parts.push(r.text);

  // The photo description (if there is one — own or from the reply).
  const desc = await describeCtxPhoto(ctx);
  if (desc) {
    // The photo's caption (own or from the reply), if any.
    const capt = ctx.photoFromReply ? r?.caption : ctx.msg.caption;
    parts.push(capt ? t(ctx.cfg.lang, "vis_album_desc_capt", desc, capt) : t(ctx.cfg.lang, "vis_photo_desc", desc));
  } else if (r?.caption) {
    parts.push(r.caption);
  }

  return parts.length ? parts.join("\n") : null;
}

// Pick the photo size depending on the detail level, get a direct URL via getFile.
// low → medium size (cheap on traffic), high → the largest (details are visible).
export async function getTelegramPhotoUrl(ctx: Ctx, detail: string): Promise<string | null> {
  const photos = ctx.photo || [];
  if (!photos.length) return null;
  // photo is sorted by ascending size.
  const pick = detail === "high"
    ? photos[photos.length - 1]
    : photos[Math.min(photos.length - 1, Math.floor(photos.length / 2))];
  const fileId = pick?.file_id;
  if (!fileId) return null;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${ctx.cfg.telegramToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: AbortSignal.timeout(GETFILE_TIMEOUT_MS) }
    );
    const data: any = await res.json().catch(() => null);
    const path = data?.result?.file_path;
    if (!path) return null;
    return `https://api.telegram.org/file/bot${ctx.cfg.telegramToken}/${path}`;
  } catch (e: any) {
    console.warn("getFile error", { err: e?.message });
    return null;
  }
}

// Vision request: one image + an instruction. detail controls the cost.
export async function runVision(ctx: Ctx, imageUrl: string, caption: string, detail: string = "low"): Promise<string> {
  const systemPrompt = buildVisionPrompt(ctx);
  const userText = caption
    ? t(ctx.cfg.lang, "vis_runvision_capt", caption)
    : t(ctx.cfg.lang, "vis_runvision");

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: imageUrl, detail } },
      ],
    },
  ];

  // If a separate vision model is set — use it, otherwise the main one.
  const modelOverride = ctx.cfg.visionModel || "";
  return callOpenRouter(ctx.cfg, messages, { tag: "vision", extraLog: { detail }, ctx, modelOverride });
}
