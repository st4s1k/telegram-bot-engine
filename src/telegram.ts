/* ================= TELEGRAM ================= */
// Telegram output: converting our "lightweight" markup to MarkdownV2, sending with a
// fallback to plain, the "typing" indicator, splitting long messages, writing to history.

import { TELEGRAM_MSG_LIMIT, GETFILE_TIMEOUT_MS } from "./constants";
import { t, DEFAULT_LANG } from "./i18n";
import { isFallbackMessage, buildAssistantItem } from "./utils";
import { appendHistory } from "./storage";
import type { Ctx, Env, TgSendResult } from "./types";

// All MarkdownV2 special characters that require escaping in plain text.
export const MDV2_SPECIALS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

// Converts our "lightweight" Markdown into valid MarkdownV2, preserving intentional
// markup and escaping everything else (stray special characters in text/names/LLM output).
// Supported: *bold*, _italic_, ~strikethrough~, ||spoiler||, `code`, ```block```,
// [text](link). We don't touch command templates — the converter works transparently on send.
export function toMarkdownV2(text: string): string {
  const src = String(text ?? "");
  let out = "";
  let i = 0;

  const escPlain = (s: string): string => s.replace(MDV2_SPECIALS, "\\$&"); // plain text
  const escCode = (s: string): string => s.replace(/[`\\]/g, "\\$&");        // inside code
  const escLinkUrl = (s: string): string => s.replace(/[)\\]/g, "\\$&");     // inside link url

  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);

    // Multi-line code block: ```...```
    if (rest.startsWith("```")) {
      const end = src.indexOf("```", i + 3);
      if (end > i) {
        out += "```" + escCode(src.slice(i + 3, end)) + "```";
        i = end + 3;
        continue;
      }
    }

    // Spoiler: ||...||
    if (rest.startsWith("||")) {
      const end = src.indexOf("||", i + 2);
      const inner = end > i ? src.slice(i + 2, end) : "";
      if (end > i && inner.length > 0 && !inner.includes("\n")) {
        out += "||" + escPlain(inner) + "||";
        i = end + 2;
        continue;
      }
    }

    // Link: [text](url)
    if (ch === "[") {
      const m = rest.match(/^\[([^\]\n]+)\]\(([^)\n]+)\)/);
      if (m) {
        out += "[" + escPlain(m[1]) + "](" + escLinkUrl(m[2]) + ")";
        i += m[0].length;
        continue;
      }
    }

    // Inline code: `...`
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        out += "`" + escCode(src.slice(i + 1, end)) + "`";
        i = end + 1;
        continue;
      }
    }

    // Bold *...*, italic _..._, strikethrough ~...~ — a paired marker on a single line.
    if (ch === "*" || ch === "_" || ch === "~") {
      const end = src.indexOf(ch, i + 1);
      const inner = end > i ? src.slice(i + 1, end) : "";
      if (end > i && inner.length > 0 && !inner.includes("\n")) {
        out += ch + escPlain(inner) + ch;
        i = end + 1;
        continue;
      }
    }

    // Ordinary character — escape it if it's a special character.
    out += escPlain(ch);
    i++;
  }
  return out;
}

// Shows the "bot is typing…" indicator in the chat. An instant reaction while the model thinks.
// The action lives ~5s in Telegram; for long replies that's enough as a "bot is alive" signal.
export async function sendTyping(ctx: Ctx): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${ctx.cfg.telegramToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ctx.chatId, action: "typing" }),
      signal: AbortSignal.timeout(GETFILE_TIMEOUT_MS),
    });
  } catch (e: any) {
    console.warn("sendChatAction failed", { err: e?.message || e });
  }
}

export async function sendTelegramMessage(token: string | undefined, chatId: number, text: string, replyToId: number | undefined): Promise<TgSendResult | null> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const baseBody = {
    chat_id: chatId,
    reply_to_message_id: replyToId,
    allow_sending_without_reply: true,
  };

  // Normalize our lightweight markup before conversion: ** → * (bold),
  // headings ##/###/#### → bold (Telegram has no concept of headings).
  const normalized = String(text || "")
    .replace(/\*\*/g, "*")
    .replace(/^#{2,4} /gm, "*");

  if (!normalized.trim()) {
    console.warn("Telegram send: empty text after normalize", { chatId, original: String(text).slice(0, 200) });
    return null;
  }

  // Attempt 1: MarkdownV2 (via the converter — it escapes everything except paired markup).
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, text: toMarkdownV2(normalized), parse_mode: "MarkdownV2" }),
    });
    const data: any = await res.json().catch(() => null);
    if (data?.ok) return data;
    console.warn("Telegram MarkdownV2 send failed, falling back to plain", {
      chatId,
      status: res.status,
      description: data?.description,
    });
  } catch (e: any) {
    console.warn("Telegram MarkdownV2 send threw, falling back to plain", { chatId, err: e?.message });
  }

  // Attempt 2: plain text without parse_mode (in case the converter missed something).
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, text: normalized }),
    });
    const data: any = await res.json().catch(() => null);
    if (!data?.ok) {
      console.error("Telegram plain send failed", {
        chatId,
        status: res.status,
        description: data?.description,
        textPreview: normalized.slice(0, 200),
      });
    }
    return data;
  } catch (e: any) {
    console.error("Telegram plain send error:", e?.message || e);
    return null;
  }
}

export async function sendAndStore(ctx: Ctx, content: string, { skipHistory = false }: { skipHistory?: boolean } = {}): Promise<TgSendResult | null> {
  const clean = String(content)
    // Remove [from:...] prefixes wherever they appear
    .replace(/\[from:[^\]\n]*\]\s*/gi, "")
    // Collapse triple+ line breaks into double ones
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!clean) {
    console.warn("sendAndStore: empty content after cleanup", {
      chatId: ctx.chatId,
      original: String(content).slice(0, 300),
    });
    return null;
  }

  // Split by the Telegram limit. The common single-chunk reply — without extra allocation/copy.
  // We cut on UTF-16 code units (the same way Telegram measures the limit), but we don't break a
  // surrogate pair — otherwise the boundary yields "lone" surrogates and the emoji turns into U+FFFD.
  const parts: string[] = [];
  if (clean.length <= TELEGRAM_MSG_LIMIT) {
    parts.push(clean);
  } else {
    let i = 0;
    while (i < clean.length) {
      let end = Math.min(i + TELEGRAM_MSG_LIMIT, clean.length);
      if (end < clean.length) {
        const c = clean.charCodeAt(end - 1);
        if (c >= 0xD800 && c <= 0xDBFF) end--; // the boundary landed on a high surrogate → its pair moves to the next chunk
      }
      parts.push(clean.slice(i, end));
      i = end;
    }
  }
  let lastSent: TgSendResult | null = null;
  for (let i = 0; i < parts.length; i++) {
    lastSent = await sendTelegramMessage(ctx.cfg.telegramToken, ctx.chatId, parts[i], i === 0 ? ctx.replyTargetId : undefined);
  }
  // We do NOT write to history: technical replies (status of /config, /info commands, etc.) and
  // fallback errors — otherwise the model later "picks them up" as its own utterance.
  if (!skipHistory && !isFallbackMessage(clean)) {
    await appendHistory(ctx, [buildAssistantItem(clean, ctx.cfg, ctx.replyTargetId, lastSent)]);
  }
  return lastSent;
}

// Single point for reporting internal failures. The worker always returns 200 and swallows errors, so
// without this, failures are INVISIBLE (e.g. flushChatData silently stops writing state). Always — a structured
// console.error (visible in `wrangler tail`/logpush). For critical ones — also a ping to admins in Telegram,
// if ADMIN_CHAT_IDS is set (CSV, like ADMIN_USERNAMES); throttling via KV (1 alert per `where` in
// 10 min) so a systemic failure doesn't flood the admins. Best-effort: the report itself never throws.
export async function reportError(env: Env, where: string, err: any, opts: { critical?: boolean } = {}): Promise<void> {
  const msg = err?.message || String(err);
  console.error(`${where} failed`, { err: msg });
  if (!opts.critical) return;
  // CSV list of chat_id (negative ones — groups — are valid). Empty/no valid ones → log only.
  const adminChats = String(env.ADMIN_CHAT_IDS || "")
    .split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n !== 0);
  if (!adminChats.length) return;
  try {
    const key = "errnotify:" + where;
    if (env.KV && await env.KV.get(key)) return;     // already alerted recently — stay silent
    if (env.KV) await env.KV.put(key, "1", { expirationTtl: 600 });
    const text = t(env.BOT_LANG || DEFAULT_LANG, "err_admin_alert", env.BOT_NAME || "Bot", where, msg);
    await Promise.all(adminChats.map(id => sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, id, text, undefined)));
  } catch (e: any) {
    console.error("reportError: notify failed", { err: e?.message || e });
  }
}
