/**
 * Общий харнесс для тест-файлов `*.test.mjs` в этой папке.
 *
 * Реэкспортит src/index.ts (баррель, через `export *`) + Vitest (test/describe/beforeEach) и
 * assert-shim поверх `expect`, плюс моки (in-memory KV, подменённый globalThis.fetch,
 * SSE-строитель) и фабрики (makeEnv/makeMsg/makeCtxFor/...). Каждый `*.test.mjs` импортит
 * всё отсюда одной строкой; тела тестов используют привычный `assert.*` без изменений.
 *
 * Тесты — обычный Vitest (node-окружение), оффлайн на моках. assert-shim позволяет не
 * переписывать ~530 ассертов: `assert.equal/ok/deepEqual/match/notEqual/throws` → `expect`.
 *
 * FETCH — стабильный синглтон: его состояние (_calls/_responders) сбрасывается в beforeEach,
 * а сам объект не пересоздаётся, поэтому `const { FETCH } = ...` в тест-файлах безопасен.
 */

import { beforeEach, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import * as W from "../../../src/index.ts";

// --- реэкспорт для тест-файлов ---
export { test, describe, beforeEach } from "vitest";
// assert-shim: маппинг node:assert/strict → vitest expect (только методы, что реально нужны).
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
// Движок (src/index.ts) persona-free — харнесс не реэкспортит контент пака. Persona-специфичные
// тесты (живут в репо пака, стейджятся рядом) импортят символы пака напрямую из src/persona/_pack/.
// Фолбэк-строки движок больше не экспортит как константы — они в АКТИВНОЙ персоне. Берём их из
// реестра, РАЗРЕШЁННЫЕ для языка по умолчанию (getPersonaTexts(DEFAULT_LANG)) — ровно то, что вернёт
// callOpenRouter при cfg.lang по умолчанию. Без localeTexts (нейтраль/fasol) это совпадает с базовыми
// текстами; с мультиязычным паком (как демо) — берётся локаль по умолчанию, и тесты не падают.
export const FALLBACK_LLM_ERROR = W.getPersonaTexts(W.DEFAULT_LANG).fallbackError;
export const FALLBACK_NO_CREDITS = W.getPersonaTexts(W.DEFAULT_LANG).fallbackNoCredits;

// --- console: глушим ожидаемый шум воркера, складываем в буфер для проверок ---
export const CONSOLE = { log: [], warn: [], error: [] };
console.log = (...a) => CONSOLE.log.push(a.map(String).join(" "));
console.warn = (...a) => CONSOLE.warn.push(a.map(String).join(" "));
console.error = (...a) => CONSOLE.error.push(a.map(String).join(" "));
export function clearConsole() { CONSOLE.log = []; CONSOLE.warn = []; CONSOLE.error = []; }

// --- Math.random stub: очередь значений, затем последнее повторяется ---
const _randOrig = Math.random;
export function stubRandom(...values) {
  let i = 0;
  Math.random = () => (i < values.length ? values[i++] : (values.length ? values[values.length - 1] : 0));
}
export function restoreRandom() { Math.random = _randOrig; }

// --- ответы fetch-мока ---
export function jsonResp(obj, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return obj; }, async text() { return JSON.stringify(obj); } };
}
function concatBytes(chunks) {
  let len = 0; for (const c of chunks) len += c.length;
  const out = new Uint8Array(len); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
// Поток из заранее заданных Uint8Array-чанков (для проверки буферизации неполных строк SSE).
export function streamResp(chunks, { ok = true, status = 200 } = {}) {
  let i = 0;
  return {
    ok, status,
    body: { getReader: () => ({ async read() { return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }; } }) },
    async text() { return new TextDecoder().decode(concatBytes(chunks)); },
  };
}
// SSE-ответ chat/completions из дельт + опц. usage.cost. raw — подменить тело целиком.
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
    const mid = Math.floor(bytes.length / 2); // рвём ровно посередине: строка SSE между двумя read()
    return streamResp([bytes.slice(0, mid), bytes.slice(mid)], { ok, status });
  }
  return streamResp([bytes], { ok, status });
}

// --- fetch-маршрутизатор: стабильный синглтон FETCH, состояние сбрасывается в beforeEach ---
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
// newFetch() сбрасывает состояние и возвращает тот же стабильный FETCH (для ресета внутри теста).
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
  // Как настоящий fetch: ac.abort(reason) → промис реджектится этим reason. Гонка ответа
  // с прерыванием делает idle/hard-таймаут тестируемым (см. llm.test «idle-таймаут»).
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

// --- D1 (DB) поверх node:sqlite: реальный SQLite-движок (тот же, что в проде D1), шим API D1Database. ---
// Применяем ВСЕ миграции по порядку имён (0001, 0002, …) — как `wrangler d1 migrations apply`,
// чтобы тесты видели ту же схему, что прод (новые колонки из 0002+ и т.д.).
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

// --- Workers AI (env.AI): детерминированный эмбеддинг для тестов ---
// Вектор = гистограмма кодов символов по `dim` корзинам, L2-нормированная: похожие тексты →
// близкие векторы (косинус), чего достаточно для проверки порядка top-K. dim=8 не зависит от
// прод-размерности (1024) — в тестах важен только относительный порядок, не семантика.
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
      // Прод-контракт bge-m3: поле `text` обязательно. Регресс на иной ключ ({prompt:...})
      // должен падать в тестах, а не возвращать мусорный эмбеддинг пустой строки.
      if (text === undefined || text === null) throw new Error("makeAI: missing inputs.text");
      const arr = Array.isArray(text) ? text : [text];
      return { shape: [arr.length, dim], data: arr.map(embed) };
    },
  };
}

// --- Vectorize (env.VECTORIZE): in-memory индекс с косинусным поиском ---
// Достоверно повторяет семантику прода: namespace-фильтр ДО метаданных, top-K по косинусу,
// metadata отдаётся только при returnMetadata ('all'/'indexed'/true), values — при returnValues
// (забытый флаг всплывёт падением теста). insert кидает на дубль id, upsert перезаписывает.
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

// Засеять курированные ФАКТЫ чата (параллель addMemory) — для тестов recall долгой памяти.
// items: [{ mem_id, text, source? }]. id вектора и namespace — по правилам прода (mem:/m<id>:).
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

// Прочитать факты чата из D1 (для ассертов).
export async function dbMemories(env, id) {
  const r = await env.DB.prepare("SELECT id, text, source FROM memories WHERE chat_id=? ORDER BY id").bind(String(id)).all();
  return (r.results || []).map(x => ({ id: Number(x.id), text: x.text, source: x.source }));
}

// Засеять чат в D1 (состояние + строки истории) — замена прежнего kvInit для storage-тестов.
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

// Прочитать историю/состояние чата из D1 (для ассертов).
export async function dbHistory(env, id) {
  const r = await env.DB.prepare("SELECT role, content, meta FROM messages WHERE chat_id=? ORDER BY id").bind(String(id)).all();
  return (r.results || []).map(x => ({ role: x.role, content: x.content, ...(x.meta ? { meta: JSON.parse(x.meta) } : {}) }));
}
export async function dbChat(env, id) {
  return env.DB.prepare("SELECT * FROM chats WHERE chat_id=?").bind(String(id)).first();
}

// --- фабрики ---
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
    ADMIN_USERNAMES: "admin", // движок не хардкодит дефолт-админа; задаём дженерик в тест-env
    ...over,
  };
  env._kv = kv;
  env._db = env.DB;
  env._ai = env.AI;   // указывает на актуальный AI (в т.ч. переопределённый через over)
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

// Общий setup перед каждым тестом: свежий fetch-мок, чистая консоль, дефолтный Math.random.
beforeEach(() => { resetFetch(); clearConsole(); restoreRandom(); });
