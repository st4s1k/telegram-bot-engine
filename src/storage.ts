/* ================= STORAGE (D1) ================= */
// Chat state is a row in `chats`; history is rows in `messages`. The key difference from
// the former KV blob: history is written PER-ROW and immediately (write-through), so concurrent
// messages to the same chat don't overwrite each other (the read-modify-write race is gone).
//
// ctx.chatData is the in-memory working copy (window of recent messages + state), loaded at
// the start (getChatData). State is mutated via mutators (_dirty) and written in a single UPSERT
// at the end (flushChatData). History is written immediately via appendHistory/updateHistoryMessage.

import { PHOTO_CACHE_CAP, HISTORY_HARD_CAP_ITEMS, SUMMARY_BACKLOG_CAP } from "./constants";
import { photoCacheKey, visualNote, visualLabel } from "./utils";
import { ragUpsertMemory, deleteChatMemoryVectors, ragDeleteIdsEnv, memVectorId } from "./rag";
import { getPersonaStateDefaults } from "./persona/registry";
import type { ChatConfig, ChatData, Ctx, Env, HistoryItem, HistoryMeta, Memory, PersonaState, TgMessage } from "./types";

export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

// Message aggregate (count + total length) for a single chat or for all chats (chatId not given). For /admin.
export async function messageStats(env: Env, chatId?: number | string): Promise<{ msgs: number; chars: number }> {
  const sql = "SELECT COUNT(*) AS msgs, COALESCE(SUM(LENGTH(content)),0) AS chars FROM messages"
    + (chatId != null ? " WHERE chat_id=?" : "");
  const stmt = env.DB.prepare(sql);
  const row: any = await (chatId != null ? stmt.bind(String(chatId)) : stmt).first();
  return { msgs: Number(row?.msgs) || 0, chars: Number(row?.chars) || 0 };
}

export function rowToHistoryItem(r: any): HistoryItem {
  const meta = parseJson<HistoryMeta | undefined>(r.meta, undefined);
  const ts = r.created_at != null ? (Number(r.created_at) || undefined) : undefined; // message time for rendering
  if (!meta && !ts) return { role: r.role, content: r.content };
  return { role: r.role, content: r.content, meta: { ...(meta || {}), ...(ts ? { ts } : {}) } };
}

// Chat messages with id > afterId (chronologically) + the maximum id among them (0 if none).
// Needed by the incremental summary: the getChatData window doesn't carry messages.id and may not contain all of them.
export async function messagesSince(
  env: Env, chatId: number | string, afterId: number
): Promise<{ items: HistoryItem[]; maxId: number }> {
  const r = await env.DB.prepare(
    "SELECT id, role, content, meta, created_at FROM messages WHERE chat_id=? AND id>? ORDER BY id ASC"
  ).bind(String(chatId), afterId || 0).all();
  const rows = (r?.results as any[]) || [];
  if (!rows.length) return { items: [], maxId: 0 };
  return { items: rows.map(rowToHistoryItem), maxId: Number(rows[rows.length - 1].id) || 0 };
}

export const DEFAULT_CHAT_DATA = (): ChatData => ({
  history: [],
  personaState: getPersonaStateDefaults(), // defaults from the active pack's schema (neutral → {})
  role: null,
  paused: false,
  config: {},
  photoCache: {}, // file_unique_id → image description (so it isn't described again)
  spend: 0,        // total spent in this chat, $
  spendCount: 0,   // number of paid requests
  _name: "",       // chat name: group title or interlocutor's name (for /admin)
  _summary: "",    // text of the last /summary digest (the «already known» context for the next one)
  _summaryMsgId: 0, // Telegram message_id of the last summary we posted (0 = none) — the «previous summary» deep-link target
  _dailyUptoId: 0, // boundary of the last daily (cron) summary
  _cmdUptoId: 0,   // boundary of the last command-issued /summary
  _cmdDay: "",     // date (configured timezone) of the last command summary (daily reset of _cmdUptoId)
  _memUptoId: 0,   // boundary of the last fact curation (on a bot reply)
});

// Loads chat state + a WINDOW of recent messages (up to HISTORY_HARD_CAP_ITEMS, chronologically).
export async function getChatData(chatId: number | string, env: Env): Promise<ChatData> {
  const id = String(chatId);
  let row: any = null;
  let msgRows: any[] = [];
  try {
    const [r, m] = await Promise.all([
      env.DB.prepare("SELECT * FROM chats WHERE chat_id = ?").bind(id).first(),
      env.DB.prepare(
        "SELECT role, content, meta, message_id, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?"
      ).bind(id, HISTORY_HARD_CAP_ITEMS).all(),
    ]);
    row = r;
    msgRows = (m?.results as any[]) || [];
  } catch (e: any) {
    console.error("getChatData: D1 read failed", { chatId, err: e?.message || e });
    // Mark a stub: we do NOT flush it afterwards, otherwise the UPSERT would overwrite the real chat row
    // (role/config/spend/summary/boundaries) with defaults. Better to skip the reply than to lose state.
    return { ...DEFAULT_CHAT_DATA(), _loadFailed: true };
  }
  // The window arrived newest-first — reverse it into chronological order.
  const history = dedupeHistory(msgRows.reverse().map(rowToHistoryItem));
  if (!row) return { ...DEFAULT_CHAT_DATA(), history };
  return {
    history,
    personaState: { ...getPersonaStateDefaults(), ...parseJson<PersonaState>(row.persona_state, {}) },
    role: row.role || null,
    paused: !!row.paused,
    config: parseJson<ChatConfig>(row.config, {}),
    photoCache: parseJson<Record<string, string>>(row.photo_cache, {}),
    spend: Number(row.spend) || 0,
    spendCount: Number(row.spend_count) || 0,
    _name: typeof row.name === "string" ? row.name : "",
    _summary: typeof row.summary === "string" ? row.summary : "",
    _summaryMsgId: Number(row.summary_msg_id) || 0,
    _dailyUptoId: Number(row.daily_upto_id) || 0,
    _cmdUptoId: Number(row.cmd_upto_id) || 0,
    _cmdDay: typeof row.cmd_day === "string" ? row.cmd_day : "",
    _memUptoId: Number(row.mem_upto_id) || 0,
  };
}

// Flush of chat STATE in a single UPSERT (history is written separately, write-through). Called
// once at the end of handleTelegramMessage if ctx.chatData._dirty. It also guarantees the
// existence of the chats row (for a new chat, the first message creates it here).
export async function flushChatData(chatId: number | string, env: Env, data: ChatData): Promise<void> {
  // Guard: if the state is a stub after a failed read, do NOT overwrite the real row
  // with defaults (a safeguard in case the caller forgot to check _loadFailed).
  if (data._loadFailed) return;
  const id = String(chatId);
  await env.DB.prepare(
    `INSERT INTO chats (chat_id, name, persona_state, role, paused, config, photo_cache, spend, spend_count, summary, summary_msg_id, daily_upto_id, cmd_upto_id, cmd_day, mem_upto_id, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(chat_id) DO UPDATE SET
       name=excluded.name, persona_state=excluded.persona_state, role=excluded.role, paused=excluded.paused,
       config=excluded.config, photo_cache=excluded.photo_cache, spend=excluded.spend,
       spend_count=excluded.spend_count, summary=excluded.summary, summary_msg_id=excluded.summary_msg_id,
       daily_upto_id=excluded.daily_upto_id, cmd_upto_id=excluded.cmd_upto_id, cmd_day=excluded.cmd_day,
       mem_upto_id=excluded.mem_upto_id, updated_at=excluded.updated_at`
  ).bind(
    id,
    data._name || "",
    JSON.stringify(data.personaState || {}),
    data.role ?? null,
    data.paused ? 1 : 0,
    JSON.stringify(data.config || {}),
    JSON.stringify(data.photoCache || {}),
    data.spend || 0,
    data.spendCount || 0,
    data._summary || "",
    data._summaryMsgId || 0,
    data._dailyUptoId || 0,
    data._cmdUptoId || 0,
    data._cmdDay || "",
    data._memUptoId || 0,
    Date.now(),
  ).run();
}

// --- State mutators: operate ON ctx.chatData in memory, mark _dirty (flushed at the end). ---

// Generic persona-state mutator: shallow-merge patch into personaState (+_dirty). The pack itself
// decides which keys to write (its schema); the engine doesn't know the semantics.
export function updatePersonaState(ctx: Ctx, patch: PersonaState): void {
  ctx.chatData.personaState = { ...(ctx.chatData.personaState || {}), ...patch };
  ctx.chatData._dirty = true;
}
export function setRole(ctx: Ctx, v: string | null): void { ctx.chatData.role = v;     ctx.chatData._dirty = true; }
export function setPaused(ctx: Ctx, v: boolean): void      { ctx.chatData.paused = v;   ctx.chatData._dirty = true; }
export function saveChatConfig(ctx: Ctx, v: ChatConfig): void { ctx.chatData.config = v; ctx.chatData._dirty = true; }

// Add the actual request cost (usage.cost) to the chat's spend counter.
export function addSpend(ctx: Ctx, cost: number): void {
  ctx.chatData.spend = (Number(ctx.chatData.spend) || 0) + cost;
  ctx.chatData.spendCount = (Number(ctx.chatData.spendCount) || 0) + 1;
  ctx.chatData._dirty = true;
}

// Save an image description by its stable key (file_unique_id).
// A JS object keeps keys in insertion order — on overflow we delete the oldest ones.
export function cachePhotoDesc(ctx: Ctx, key: string | null, desc: string): void {
  if (!key || !desc) return;
  const cache = ctx.chatData.photoCache || (ctx.chatData.photoCache = {});
  delete cache[key];        // move it to the end (as "most recently used")
  cache[key] = desc;
  const keys = Object.keys(cache);
  if (keys.length > PHOTO_CACHE_CAP) {
    for (const k of keys.slice(0, keys.length - PHOTO_CACHE_CAP)) delete cache[k];
  }
  ctx.chatData._dirty = true;
}

// Write-through append to history: INSERT new rows (OR IGNORE = dedup by UNIQUE
// (chat_id,role,message_id)) + trim excess rows in D1 (item-cap and char-budget — like
// trimHistoryByChars). Concurrent updates insert their own rows independently → no losses.
export async function appendHistory(ctx: Ctx, items: HistoryItem[]): Promise<void> {
  let merged = dedupeHistory([...ctx.chatData.history, ...items]);
  merged = collapseConsecutiveDuplicates(merged);
  const newHistory = trimHistoryByChars(merged, ctx.cfg.history_chars);
  // Which of the new items actually made it into the window (not a dupe, not collapsed) — those are what we write.
  const toInsert = items.filter(it => newHistory.includes(it));
  ctx.chatData.history = newHistory;
  ctx.chatData._dirty = true; // guarantee an UPSERT of the chats row (especially for a new chat)
  if (!toInsert.length) return;

  const id = String(ctx.chatId);
  const now = Date.now();
  const limit = Number.isFinite(ctx.cfg.history_chars) && ctx.cfg.history_chars > 0 ? ctx.cfg.history_chars : 8000;
  // Protection of un-summarized/un-curated rows: do NOT trim anything that hasn't yet passed through
  // the daily summary (daily_upto_id) or fact curation (mem_upto_id) — otherwise an active chat
  // would lose material and the boundary would leap past the deleted rows. We preserve id > min(active boundaries).
  // Without both features protectId=+inf → trimming as before. The backlog cap is below (SUMMARY_BACKLOG_CAP).
  const guards: number[] = [];
  if (ctx.cfg.daily_summary) guards.push(ctx.chatData._dailyUptoId || 0);
  if (ctx.cfg.rag) guards.push(ctx.chatData._memUptoId || 0);
  const protectId = guards.length ? Math.min(...guards) : Number.MAX_SAFE_INTEGER;
  const stmts = toInsert.map(it => ctx.env.DB.prepare(
    "INSERT OR IGNORE INTO messages (chat_id, role, content, meta, message_id, created_at) VALUES (?,?,?,?,?,?)"
  ).bind(id, it.role, it.content, it.meta ? JSON.stringify(it.meta) : null, it.meta?.message_id ?? null, now));
  // Trimming: item-cap, then char-budget (running-sum from newest, like trimHistoryByChars).
  // `id <= protectId` preserves un-summarized rows (for daily_summary).
  stmts.push(ctx.env.DB.prepare(
    "DELETE FROM messages WHERE chat_id=? AND id<=? AND id NOT IN (SELECT id FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT ?)"
  ).bind(id, protectId, id, HISTORY_HARD_CAP_ITEMS));
  stmts.push(ctx.env.DB.prepare(
    `DELETE FROM messages WHERE chat_id=? AND id<=? AND id IN (
       SELECT id FROM (
         SELECT id, (SUM(LENGTH(content)) OVER (ORDER BY id DESC) - LENGTH(content)) AS rb
         FROM messages WHERE chat_id=?
       ) WHERE rb >= ?
     )`
  ).bind(id, protectId, id, limit));
  // Absolute backlog cap when protection is on (summary/facts): even protected rows
  // beyond SUMMARY_BACKLOG_CAP (a stuck cron/curation) are trimmed, so the table doesn't grow forever.
  if (ctx.cfg.daily_summary || ctx.cfg.rag) {
    stmts.push(ctx.env.DB.prepare(
      "DELETE FROM messages WHERE chat_id=? AND id NOT IN (SELECT id FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT ?)"
    ).bind(id, id, SUMMARY_BACKLOG_CAP));
  }
  await ctx.env.DB.batch(stmts);
  // Long-term memory no longer embeds every message — it stores curated FACTS
  // (see addMemory / runMemoryCuration). Raw messages live only in `messages`.
}

// Updates an already-stored user message when it's edited (by message_id) — in memory
// and in D1. If the row is absent (evicted/never logged) — we do nothing.
export async function updateHistoryMessage(ctx: Ctx, msg: TgMessage): Promise<void> {
  const id = msg.message_id;
  if (!id) return;
  const item = ctx.chatData.history.find(h => h.role === "user" && h.meta?.message_id === id);
  if (!item) return;

  const text = msg.text || msg.caption || "";
  const hasVisual = (Array.isArray(msg.photo) && msg.photo.length) || !!msg.sticker;
  let content = text;
  if (hasVisual) {
    const key = photoCacheKey(ctx.photo);
    const desc = (key && ctx.chatData.photoCache?.[key]) || "";
    content = visualNote(visualLabel(ctx), text, desc);
  }
  item.content = content; // in memory — for the current update
  ctx.chatData._dirty = true;
  await ctx.env.DB.prepare("UPDATE messages SET content=? WHERE chat_id=? AND role='user' AND message_id=?")
    .bind(content, String(ctx.chatId), id).run();
}

// /memory forget — wipe the chat history (messages rows). State is reset by mutators
// in the command; here it's only the D1 deletion of history + memory synchronization.
export async function clearChatHistory(ctx: Ctx): Promise<void> {
  ctx.chatData.history = [];
  ctx.chatData._dirty = true;
  // We clear only raw messages. Curated facts are wiped separately (clearMemories),
  // because long-term memory is the memories table + mem: vectors, not messages rows.
  await ctx.env.DB.prepare("DELETE FROM messages WHERE chat_id=?").bind(String(ctx.chatId)).run();
}

// /memory dedupe — remove consecutive duplicates from the chat history (in D1 and in memory).
// Returns the number of deleted rows.
export async function dedupeChatHistory(ctx: Ctx): Promise<number> {
  const id = String(ctx.chatId);
  const all = await ctx.env.DB.prepare(
    "SELECT id, content FROM messages WHERE chat_id=? ORDER BY id"
  ).bind(id).all();
  const rows = (all?.results as any[]) || [];
  const dropIds: number[] = [];
  let prevKey: string | null = null;
  for (const r of rows) {
    const key = String(r.content ?? "").trim().toLowerCase();
    if (key && key === prevKey) { dropIds.push(Number(r.id)); continue; }
    prevKey = key;
  }
  if (dropIds.length) {
    const placeholders = dropIds.map(() => "?").join(",");
    await ctx.env.DB.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).bind(...dropIds).run();
    ctx.chatData.history = collapseConsecutiveDuplicates(ctx.chatData.history);
  }
  return dropIds.length;
}

/* ===== Curated long-term-memory facts (memories table + mem: vectors) ===== */

// Add a fact: a row in `memories` + embed/upsert of the vector (mem:<chatId>). Returns the fact's id.
// The vector is always written when bindings are present (even if RAG is off) — so the fact is ready
// for recall once long-term memory is enabled, without a backfill. Best-effort on the vector part.
export async function addMemory(ctx: Ctx, text: string, source: "auto" | "manual"): Promise<number> {
  const clean = String(text ?? "").trim();
  if (!clean) return 0;
  // OR IGNORE against UNIQUE(chat_id, lower(text)): a dupe → changes===0, last_row_id is stale,
  // so we embed ONLY a row that was actually inserted (like the gate in appendHistory).
  const r = await ctx.env.DB.prepare(
    "INSERT OR IGNORE INTO memories (chat_id, text, source, created_at) VALUES (?,?,?,?)"
  ).bind(String(ctx.chatId), clean, source, Date.now()).run();
  if (Number((r as any)?.meta?.changes) !== 1) return 0; // dupe — the row and vector already exist
  const memId = Number((r as any)?.meta?.last_row_id) || 0;
  if (memId) await ragUpsertMemory(ctx, { id: memId, text: clean, source });
  return memId;
}

// List of the chat's facts (chronologically).
export async function listMemories(env: Env, chatId: number | string): Promise<Memory[]> {
  const r = await env.DB.prepare(
    "SELECT id, chat_id, text, source, created_at FROM memories WHERE chat_id=? ORDER BY id"
  ).bind(String(chatId)).all();
  return ((r?.results as any[]) || []).map(x => ({
    id: Number(x.id), chat_id: String(x.chat_id), text: x.text, source: x.source, created_at: Number(x.created_at) || 0,
  }));
}

// Wipe all the chat's facts: collect ids BEFORE deletion (Vectorize deletes only by id) → DELETE → delete vectors.
export async function clearMemories(ctx: Ctx): Promise<void> {
  const id = String(ctx.chatId);
  const rows = ((await ctx.env.DB.prepare("SELECT id FROM memories WHERE chat_id=?").bind(id).all())?.results as any[]) || [];
  const memIds = rows.map(r => Number(r.id));
  await ctx.env.DB.prepare("DELETE FROM memories WHERE chat_id=?").bind(id).run();
  if (memIds.length) await deleteChatMemoryVectors(ctx, memIds);
}

// Delete ONE chat fact by its memories.id (row + the mem:<chatId> vector). For /memory del <N>.
export async function deleteMemory(ctx: Ctx, memId: number): Promise<void> {
  await ctx.env.DB.prepare("DELETE FROM memories WHERE chat_id=? AND id=?").bind(String(ctx.chatId), memId).run();
  await deleteChatMemoryVectors(ctx, [memId]);
}

// Deployment-wide RETENTION sweep (env RETENTION_DAYS): delete history AND facts older than cutoffMs
// across ALL chats — so a configured retention window genuinely expires data (privacy / right-to-be-
// forgotten by time). Facts go row + Vectorize vector; messages are raw history. Best-effort + idempotent.
// Per-chat on-demand erasure stays `/memory forget all` (also runnable on any chat via `/admin chat_cmd`).
// Returns the deleted counts. Summary boundaries (id-based) are unaffected — ids are never reused.
export async function purgeExpiredData(env: Env, cutoffMs: number): Promise<{ messages: number; memories: number }> {
  // Facts first: collect (chat_id, id) BEFORE deleting the rows, so we can drop the matching vectors.
  const memRows = ((await env.DB.prepare("SELECT id, chat_id FROM memories WHERE created_at < ?").bind(cutoffMs).all())?.results as any[]) || [];
  if (memRows.length) {
    await ragDeleteIdsEnv(env, memRows.map(r => memVectorId(String(r.chat_id), Number(r.id))));
    await env.DB.prepare("DELETE FROM memories WHERE created_at < ?").bind(cutoffMs).run();
  }
  // Messages: count first (shim-agnostic), then delete.
  const cnt: any = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE created_at < ?").bind(cutoffMs).first();
  const messages = Number(cnt?.n) || 0;
  if (messages) await env.DB.prepare("DELETE FROM messages WHERE created_at < ?").bind(cutoffMs).run();
  return { messages, memories: memRows.length };
}

// Collapses CONSECUTIVE messages with identical content into one (keeps the first).
// Comparison by normalized text (case-insensitive, ignoring surrounding whitespace).
export function collapseConsecutiveDuplicates(h: HistoryItem[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  let prevKey: string | null = null;
  for (const item of h) {
    const key = String(item?.content ?? "").trim().toLowerCase();
    if (key && key === prevKey) continue;
    out.push(item);
    prevKey = key;
  }
  return out;
}

/**
 * Trims history by total character count, WITHOUT cutting messages apart (for the in-memory window).
 * Goes from the end (recent ones matter more), keeps whole messages. Plus a protective cap by count.
 */
export function trimHistoryByChars(history: HistoryItem[], charLimit: number): HistoryItem[] {
  const limit = Number.isFinite(charLimit) && charLimit > 0 ? charLimit : 8000;
  const capped = history.slice(-HISTORY_HARD_CAP_ITEMS);

  let total = 0;
  const kept: HistoryItem[] = [];
  for (let i = capped.length - 1; i >= 0; i--) {
    const item = capped[i];
    const len = (item?.content || "").length;
    kept.unshift(item);
    total += len;
    if (total >= limit) break; // included the current one in full and stop
  }
  return kept;
}

export function dedupeHistory(h: HistoryItem[]): HistoryItem[] {
  const seen = new Set<string>();
  const out: HistoryItem[] = [];
  for (const item of h) {
    const id = item?.meta?.message_id;
    const key = id ? `${item.role}:${id}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(item);
  }
  return out;
}
