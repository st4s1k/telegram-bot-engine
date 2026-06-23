/**
 * Shared harness for the `*.test.mjs` test files in this folder.
 *
 * Re-exports src/index.ts (the barrel, via `export *`) + Vitest (test/describe/beforeEach) and
 * an assert-shim over `expect`, plus mocks (in-memory KV, a stubbed globalThis.fetch,
 * an SSE builder) and factories (makeEnv/makeMsg/makeCtxFor/...). Each `*.test.mjs` imports
 * everything from here in one line; test bodies use the familiar `assert.*` unchanged.
 *
 * Tests are plain Vitest (node environment), offline on mocks. The assert-shim avoids
 * rewriting ~530 assertions: `assert.equal/ok/deepEqual/match/notEqual/throws` → `expect`.
 *
 * FETCH is a stable singleton: its state (_calls/_responders) is reset in beforeEach,
 * but the object itself is not recreated, so `const { FETCH } = ...` in test files is safe.
 */

import { beforeEach, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import * as W from "../../../src/index.ts";

// --- re-export for test files ---
export { test, describe, beforeEach } from "vitest";
// assert-shim: maps node:assert/strict → vitest expect (only the methods actually needed).
export const assert = {
  equal: (a, b, msg) => expect(a, msg).toBe(b),
  strictEqual: (a, b, msg) => expect(a, msg).toBe(b),
  deepEqual: (a, b, msg) => expect(a, msg).toEqual(b),
  ok: (x, msg) => expect(x, msg).toBeTruthy(),
  match: (s, re, msg) => expect(s, msg).toMatch(re),
  notEqual: (a, b, msg) => expect(a, msg).not.toBe(b),
  throws: (fn, msg) => expect(fn, msg).toThrow(),
};
export * from "../../../src/index.ts";
export { default as WORKER } from "../../../src/index.ts";
// The engine (src/index.ts) is persona-free — the harness does not re-export pack content. Persona-specific
// tests (which live in the pack repo and are staged alongside) import pack symbols directly from src/persona/_pack/.
// The engine no longer exports fallback strings as constants — they live in the ACTIVE persona. The
// reference test deployment runs in Russian (makeEnv defaults BOT_LANG="ru", like the «Фасол» bot), so we
// resolve the fallbacks at "ru" — exactly what callOpenRouter returns at the default test cfg.lang.
export const FALLBACK_LLM_ERROR = W.getPersonaTexts("ru").fallbackError;
export const FALLBACK_NO_CREDITS = W.getPersonaTexts("ru").fallbackNoCredits;

// --- console: silence the worker's expected noise, collect it into a buffer for checks ---
export const CONSOLE = { log: [], warn: [], error: [] };
console.log = (...a) => CONSOLE.log.push(a.map(String).join(" "));
console.warn = (...a) => CONSOLE.warn.push(a.map(String).join(" "));
console.error = (...a) => CONSOLE.error.push(a.map(String).join(" "));
export function clearConsole() { CONSOLE.log = []; CONSOLE.warn = []; CONSOLE.error = []; }

// --- Math.random stub: a queue of values, then the last one repeats ---
const _randOrig = Math.random;
export function stubRandom(...values) {
  let i = 0;
  Math.random = () => (i < values.length ? values[i++] : (values.length ? values[values.length - 1] : 0));
}
export function restoreRandom() { Math.random = _randOrig; }

// --- fetch-mock responses ---
export function jsonResp(obj, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return obj; }, async text() { return JSON.stringify(obj); } };
}
function concatBytes(chunks) {
  let len = 0; for (const c of chunks) len += c.length;
  const out = new Uint8Array(len); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
// A stream of predefined Uint8Array chunks (to test buffering of incomplete SSE lines).
export function streamResp(chunks, { ok = true, status = 200 } = {}) {
  let i = 0;
  return {
    ok, status,
    body: { getReader: () => ({ async read() { return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }; } }) },
    async text() { return new TextDecoder().decode(concatBytes(chunks)); },
  };
}
// An SSE chat/completions response built from deltas + optional usage.cost. raw — replace the whole body.
export function sse(deltas, { cost, ok = true, status = 200, raw, splitAcrossChunks = false } = {}) {
  const lines = [];
  for (const d of deltas) {
    const content = typeof d === "string" ? d : d.content;
    lines.push("data: " + JSON.stringify({ choices: [{ delta: { content } }] }));
  }
  if (cost !== undefined) lines.push("data: " + JSON.stringify({ usage: { cost } }));
  lines.push("data: [DONE]");
  const text = (raw !== undefined ? raw : lines.join("\n")) + "\n";
  const bytes = new TextEncoder().encode(text);
  if (splitAcrossChunks) {
    const mid = Math.floor(bytes.length / 2); // split exactly in the middle: an SSE line spans two read() calls
    return streamResp([bytes.slice(0, mid), bytes.slice(mid)], { ok, status });
  }
  return streamResp([bytes], { ok, status });
}

// --- fetch router: a stable FETCH singleton, state reset in beforeEach ---
let _msgIdSeq = 5000;
let _calls = [];
let _responders = defaultResponders();
function defaultResponders() {
  return {
    chat: () => sse(["ответ ", "бота"]),
    model: () => jsonResp({ data: { pricing: { prompt: "0.000001", completion: "0.000002", image: "0" }, architecture: { input_modalities: ["text", "image"] } } }),
    key: () => jsonResp({ data: { usage: 1.5, limit: 10 } }),
    credits: () => jsonResp({ data: { total_credits: 20, total_usage: 5 } }),
    send: () => jsonResp({ ok: true, result: { message_id: ++_msgIdSeq } }),
    chatAction: () => jsonResp({ ok: true, result: true }),
    getFile: () => jsonResp({ ok: true, result: { file_path: "photos/f.jpg" } }),
    getChat: () => jsonResp({ ok: true, result: { title: "Группа" } }),
  };
}
function resetFetch() { _calls = []; _responders = defaultResponders(); }
export const FETCH = {
  get calls() { return _calls; },
  set(name, responder) { _responders[name] = responder; return this; },
  of(substr) { return _calls.filter(c => c.url.includes(substr)); },
  sends() { return _calls.filter(c => c.url.includes("/sendMessage")); },
  chatBody() { return _calls.find(c => c.url.includes("/chat/completions"))?.body; },
};
// newFetch() resets state and returns the same stable FETCH (for resetting inside a test).
export function newFetch() { resetFetch(); return FETCH; }
globalThis.fetch = async (url, opts = {}) => {
  const u = String(typeof url === "string" ? url : url?.url ?? url);
  const method = (opts.method || "GET").toUpperCase();
  let body;
  if (opts.body !== undefined) { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
  const call = { url: u, method, body, headers: opts.headers || {} };
  _calls.push(call);
  const respond = () => {
    if (u.includes("/chat/completions")) return _responders.chat(call);
    if (u.includes("/model/")) return _responders.model(call);
    if (u.endsWith("/key")) return _responders.key(call);
    if (u.endsWith("/credits")) return _responders.credits(call);
    if (u.includes("/sendMessage")) return _responders.send(call);
    if (u.includes("/sendChatAction")) return _responders.chatAction(call);
    if (u.includes("/getFile")) return _responders.getFile(call);
    if (u.includes("/getChat")) return _responders.getChat(call);
    throw new Error("unexpected fetch: " + method + " " + u);
  };
  // Like real fetch: ac.abort(reason) → the promise rejects with that reason. Racing the response
  // against the abort makes the idle/hard timeout testable (see llm.test "idle timeout").
  const sig = opts.signal;
  if (!sig) return respond();
  if (sig.aborted) throw sig.reason;
  return await Promise.race([
    Promise.resolve().then(respond),
    new Promise((_, reject) => sig.addEventListener("abort", () => reject(sig.reason), { once: true })),
  ]);
};

// --- in-memory KV ---
export function makeKV(initial = {}, { pageSize = Infinity } = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  return {
    store, puts,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { puts.push({ key, value, opts }); store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "", cursor } = {}) {
      const all = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
      if (!Number.isFinite(pageSize)) {
        return { keys: all.map(name => ({ name })), list_complete: true, cursor: undefined };
      }
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + pageSize);
      const next = start + pageSize;
      const complete = next >= all.length;
      return { keys: slice.map(name => ({ name })), list_complete: complete, cursor: complete ? undefined : String(next) };
    },
  };
}

// --- D1 (DB) over node:sqlite: a real SQLite engine (the same one D1 uses in prod), shimming the D1Database API. ---
// Apply ALL migrations in name order (0001, 0002, …) — like `wrangler d1 migrations apply`,
// so the tests see the same schema as prod (new columns from 0002+, etc.).
const MIG_DIR = new URL("../../../migrations/", import.meta.url);
const D1_MIGRATIONS = readdirSync(MIG_DIR)
  .filter(f => f.endsWith(".sql"))
  .sort()
  .map(f => readFileSync(new URL(f, MIG_DIR), "utf8"));
export function makeD1() {
  const db = new DatabaseSync(":memory:");
  for (const sql of D1_MIGRATIONS) db.exec(sql);
  const stmt = (sql) => {
    let params = [];
    const api = {
      bind(...args) { params = args; return api; },
      async first() { return db.prepare(sql).get(...params) ?? null; },
      async all() { return { results: db.prepare(sql).all(...params), success: true }; },
      async run() { const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
    return api;
  };
  return {
    _db: db,
    prepare(sql) { return stmt(sql); },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    async exec(sql) { db.exec(sql); },
  };
}

// --- Workers AI (env.AI): a deterministic embedding for tests ---
// The vector = a histogram of character codes across `dim` buckets, L2-normalized: similar texts →
// close vectors (cosine), which is enough to check top-K ordering. dim=8 is independent of
// the prod dimension (1024) — in tests only the relative ordering matters, not the semantics.
export function makeAI({ dim = 8 } = {}) {
  const embed = (text) => {
    const v = new Array(dim).fill(0);
    const s = String(text ?? "");
    for (let i = 0; i < s.length; i++) v[s.charCodeAt(i) % dim] += 1;
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map(x => x / norm);
  };
  const calls = [];
  return {
    embed, calls,
    async run(model, inputs) {
      calls.push({ model, inputs });
      const text = inputs?.text;
      // bge-m3 prod contract: the `text` field is required. A regression to a different key ({prompt:...})
      // should fail in tests, not return a garbage embedding of an empty string.
      if (text === undefined || text === null) throw new Error("makeAI: missing inputs.text");
      const arr = Array.isArray(text) ? text : [text];
      return { shape: [arr.length, dim], data: arr.map(embed) };
    },
  };
}

// --- Vectorize (env.VECTORIZE): an in-memory index with cosine search ---
// Faithfully reproduces prod semantics: namespace filter BEFORE metadata, top-K by cosine,
// metadata returned only when returnMetadata ('all'/'indexed'/true), values — when returnValues
// (a forgotten flag surfaces as a failing test). insert throws on a duplicate id, upsert overwrites.
export function makeVectorize(seed = []) {
  const store = new Map(); // id → { id, values, metadata, namespace }
  for (const v of seed) store.set(v.id, v);
  const cos = (a, b) => {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
  };
  return {
    store,
    async upsert(vectors) { for (const v of vectors) store.set(v.id, v); return { mutationId: "m" + store.size }; },
    async insert(vectors) {
      for (const v of vectors) if (store.has(v.id)) throw new Error("duplicate id " + v.id);
      for (const v of vectors) store.set(v.id, v);
      return { mutationId: "m" + store.size };
    },
    async query(vector, { topK = 5, namespace, filter, returnMetadata, returnValues } = {}) {
      let items = [...store.values()];
      if (namespace !== undefined) items = items.filter(v => v.namespace === namespace);
      if (filter) items = items.filter(v => Object.entries(filter).every(([k, cond]) => {
        const val = v.metadata?.[k];
        if (cond && typeof cond === "object") {
          if ("$eq" in cond) return val === cond.$eq;
          if ("$ne" in cond) return val !== cond.$ne;
        }
        return val === cond;
      }));
      const wantMeta = returnMetadata === true || returnMetadata === "all" || returnMetadata === "indexed";
      const matches = items
        .map(v => ({ v, score: cos(vector, v.values) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(({ v, score }) => ({
          id: v.id, score, namespace: v.namespace ?? null,
          ...(wantMeta ? { metadata: v.metadata } : {}),
          ...(returnValues ? { values: v.values } : {}),
        }));
      return { matches, count: matches.length };
    },
    async deleteByIds(ids) { let count = 0; for (const id of ids) if (store.delete(id)) count++; return { mutationId: "d" + count }; },
    async getByIds(ids) { return ids.map(id => store.get(id)).filter(Boolean); },
  };
}

// Seed curated chat FACTS (parallel to addMemory) — for long-term-memory recall tests.
// items: [{ mem_id, text, source? }]. The vector id and namespace follow the prod rules (mem:/m<id>:).
export function seedMemories(env, id, items = []) {
  for (const it of items) {
    const vid = W.memVectorId(id, it.mem_id);
    env._vec.store.set(vid, {
      id: vid,
      values: env._ai.embed(it.text),
      namespace: W.memNamespace(id),
      metadata: { chat_id: String(id), mem_id: it.mem_id, text: it.text, source: it.source || "manual" },
    });
  }
}

// Read chat facts from D1 (for assertions).
export async function dbMemories(env, id) {
  const r = await env.DB.prepare("SELECT id, text, source FROM memories WHERE chat_id=? ORDER BY id").bind(String(id)).all();
  return (r.results || []).map(x => ({ id: Number(x.id), text: x.text, source: x.source }));
}

// Seed a chat into D1 (state + history rows) — a replacement for the old kvInit for storage tests.
export async function seedChat(env, id, cd = {}) {
  await W.flushChatData(id, env, { ...W.DEFAULT_CHAT_DATA(), ...cd });
  const hist = cd.history || [];
  for (let i = 0; i < hist.length; i++) {
    const it = hist[i];
    await env.DB.prepare(
      "INSERT OR IGNORE INTO messages (chat_id, role, content, meta, message_id, created_at) VALUES (?,?,?,?,?,?)"
    ).bind(String(id), it.role, it.content, it.meta ? JSON.stringify(it.meta) : null, it.meta?.message_id ?? null, i + 1).run();
  }
}

// Read chat history/state from D1 (for assertions).
export async function dbHistory(env, id) {
  const r = await env.DB.prepare("SELECT role, content, meta FROM messages WHERE chat_id=? ORDER BY id").bind(String(id)).all();
  return (r.results || []).map(x => ({ role: x.role, content: x.content, ...(x.meta ? { meta: JSON.parse(x.meta) } : {}) }));
}
export async function dbChat(env, id) {
  return env.DB.prepare("SELECT * FROM chats WHERE chat_id=?").bind(String(id)).first();
}

// --- factories ---
export function makeEnv(over = {}, kvInit = {}, kvOpts = {}) {
  const kv = makeKV(kvInit, kvOpts);
  const env = {
    KV: kv,
    DB: makeD1(),
    AI: makeAI(),
    VECTORIZE: makeVectorize(),
    TELEGRAM_BOT_TOKEN: "123456:TESTTOKEN",
    OPENROUTER_API_KEY: "sk-test",
    OPENROUTER_MODEL: "test/model",
    BOT_USERNAME: "testbot",
    BOT_NAME: "Bot",
    ADMIN_USERNAMES: "admin", // the engine doesn't hardcode a default admin; we set a generic one in the test env
    BOT_LANG: "ru", // reference test deployment runs in Russian (like the «Фасол» bot); the en default is covered separately
    ...over,
  };
  env._kv = kv;
  env._db = env.DB;
  env._ai = env.AI;   // points to the current AI (including one overridden via over)
  env._vec = env.VECTORIZE;
  return env;
}

let _mid = 1000;
export function makeMsg(o = {}) {
  const chat = o.chat || {
    id: o.chatId ?? 555,
    type: o.chatType ?? "private",
    ...(o.chatTitle ? { title: o.chatTitle } : {}),
  };
  const from = o.from || {
    id: o.fromId ?? 42,
    first_name: o.firstName ?? "Вася",
    ...(o.lastName ? { last_name: o.lastName } : {}),
    username: o.username ?? "vasya",
  };
  const m = { message_id: o.message_id ?? (++_mid), chat, from };
  if (o.text !== undefined) m.text = o.text;
  if (o.caption !== undefined) m.caption = o.caption;
  if (o.photo) m.photo = o.photo;
  if (o.sticker) m.sticker = o.sticker;
  if (o.reply_to_message) m.reply_to_message = o.reply_to_message;
  if (o.media_group_id) m.media_group_id = o.media_group_id;
  if (o.date !== undefined) m.date = o.date;
  return m;
}

export function makeCtxFor(m, env, chatData) {
  const cd = chatData || W.DEFAULT_CHAT_DATA();
  const g = W.getGlobalConfig(env);
  const eff = W.mergeConfig(g, cd.config);
  return W.makeCtx(m, env, eff, cd);
}

export function photoSizes(uidBig = "big", { sameUid = false } = {}) {
  return [
    { file_id: "f_small", file_unique_id: sameUid ? uidBig : "small", width: 90, height: 90 },
    { file_id: "f_mid", file_unique_id: sameUid ? uidBig : "mid", width: 320, height: 320 },
    { file_id: "f_big", file_unique_id: uidBig, width: 800, height: 800 },
  ];
}

// Shared setup before each test: a fresh fetch-mock, a clean console, the default Math.random.
beforeEach(() => { resetFetch(); clearConsole(); restoreRandom(); });
