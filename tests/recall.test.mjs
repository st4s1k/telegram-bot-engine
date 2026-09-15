// Hybrid recall (src/recall.ts): query rewrite from chat context → vector + lexical (RRF) → dated facts.
import {
  test, describe, assert,
  makeEnv, makeCtxFor, makeMsg, seedMemories, dbMemories,
  FETCH, sse, DEFAULT_CHAT_DATA,
  addMemory, updateMemory, handleChatMessage,
  ragRetrieveMemories, recallMemories, rewriteRecallQuery, lexStems, lexicalRank,
} from "./harness.mjs";

const ragEnv = (over = {}) => makeEnv({ ENABLE_RAG: "true", ...over });
const DATE_RE = /^\[\d{4}-\d{2}-\d{2}\] /;

describe("recall · lexical side", () => {
  test("lexStems: ≥3-char words cut to 4, lower-cased, stop-words dropped, names KEPT", () => {
    assert.deepEqual([...lexStems("Где Алёна была в отпуске? и что там")].sort(), ["алён", "отпу"].sort());
    assert.deepEqual([...lexStems("Стас водомут")].sort(), ["водо", "стас"].sort());
    assert.deepEqual([...lexStems("What does the cat do")].sort(), ["cat"]);
  });

  test("lexicalRank: a fact needs 2 shared stems (all of them for a 1-stem query); rarer stems weigh more; newer first on a tie", () => {
    const facts = [
      { id: 1, text: "Алёна в отпуске в Полоцке", created_at: 10 },
      { id: 2, text: "Алёна любит сыр", created_at: 20 },
      { id: 3, text: "Стас работает разработчиком промышленных программ", created_at: 30 },
      { id: 4, text: "Алёна в отпуске, вернётся в сентябре", created_at: 40 },
    ];
    assert.deepEqual(lexicalRank("где Алёна в отпуске", facts), [4, 1]); // both stems; tie → newer first
    assert.deepEqual(lexicalRank("работа", facts), [3]);                 // 1-stem query: 1 match is enough
    assert.deepEqual(lexicalRank("что нового", facts), []);              // nothing but stop-words / no hit
  });
});

describe("recall · hybrid retrieval + dates", () => {
  test("a recalled fact carries the date it was noted: `[YYYY-MM-DD] text`", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 300, text: "котик" }), env, { ...DEFAULT_CHAT_DATA(), config: { rag_min_score: 0 } });
    await addMemory(ctx, "котик спит на батарее", "manual");
    const out = await ragRetrieveMemories(ctx, "котик");
    assert.equal(out.length, 1);
    assert.match(out[0], DATE_RE);
    assert.ok(out[0].endsWith("котик спит на батарее"), out[0]);
  });

  test("a vector-only fact (no D1 row) still comes back, without a date", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 301, text: "котик" }), env);
    seedMemories(env, 301, [{ mem_id: 1, text: "котик" }]);
    assert.deepEqual(await ragRetrieveMemories(ctx, "котик"), ["котик"]);
  });

  test("lexical rescue: a name/jargon fact the vector side misses is found by stems", async () => {
    const env = ragEnv();
    // rag_min_score above 1 → the vector side returns nothing; only the lexical ranking can find anything
    const ctx = makeCtxFor(makeMsg({ chatId: 302, text: "x" }), env, { ...DEFAULT_CHAT_DATA(), config: { rag_min_score: 1.01 } });
    await addMemory(ctx, "Алёна в отпуске в Полоцке", "auto");
    await addMemory(ctx, "Стас работает разработчиком промышленных программ", "auto");
    const out = await ragRetrieveMemories(ctx, "где Алёна в отпуске");
    assert.equal(out.length, 1);
    assert.ok(out[0].endsWith("Алёна в отпуске в Полоцке"), out[0]);
  });

  test("fusion: a fact found by BOTH sides ranks first; each fact appears once; cut to rag_top_k", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 303, text: "x" }), env, { ...DEFAULT_CHAT_DATA(), config: { rag_min_score: 0, rag_top_k: 2 } });
    await addMemory(ctx, "Алёна любит сыр", "auto");
    await addMemory(ctx, "Стас любит сыр", "auto");
    await addMemory(ctx, "Алёна в отпуске в Полоцке", "auto");
    const out = await ragRetrieveMemories(ctx, "где Алёна в отпуске");
    assert.equal(out.length, 2); // rag_top_k
    assert.ok(out[0].endsWith("Алёна в отпуске в Полоцке"), out.join(" | ")); // vector hit + 2 lexical stems
    assert.equal(new Set(out).size, out.length);
  });

  test("updateMemory bumps created_at — the recalled date is the date of the CURRENT state", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 304, text: "x" }), env, { ...DEFAULT_CHAT_DATA(), config: { rag_min_score: 0 } });
    const id = await addMemory(ctx, "Лиза планирует коррекцию зрения", "auto");
    await env.DB.prepare("UPDATE memories SET created_at=? WHERE id=?").bind(Date.UTC(2020, 0, 1), id).run();
    assert.match((await ragRetrieveMemories(ctx, "Лиза коррекция зрения"))[0], /^\[2020-01-01\] /);
    await updateMemory(ctx, id, "Лиза сделала коррекцию зрения");
    const row = await env.DB.prepare("SELECT created_at FROM memories WHERE id=?").bind(id).first();
    assert.ok(Number(row.created_at) > Date.UTC(2021, 0, 1));
    assert.ok(!/^\[2020-01-01\] /.test((await ragRetrieveMemories(ctx, "Лиза коррекция зрения"))[0]));
  });

  test("RAG off → nothing, no D1/AI work", async () => {
    const env = makeEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 305, text: "котик" }), env);
    await addMemory(ctx, "котик", "manual");
    const before = env._ai.calls.length;
    assert.deepEqual(await ragRetrieveMemories(ctx, "котик"), []);
    assert.equal(env._ai.calls.length, before);
  });
});

describe("recall · query rewrite from chat context", () => {
  const history = () => [
    { role: "user", content: "у Стаса опять болят зубы", meta: { message_id: 1 } },
    { role: "assistant", content: "ага", meta: { message_id: 2 } },
  ];

  test("with prior history: the rewriter runs first (summary model, reasoning off) and its line becomes the search query", async () => {
    const env = ragEnv({ OPENROUTER_SUMMARY_MODEL: "cheap/model" });
    const cd = { ...DEFAULT_CHAT_DATA(), history: history(), config: { rag_min_score: 0 } };
    const ctx = makeCtxFor(makeMsg({ chatId: 310, chatType: "private", text: "а что у него с зубами?", message_id: 3 }), env, cd);
    await addMemory(ctx, "Стас проходил лечение у стоматолога: два импланта", "auto");
    let n = 0;
    FETCH.set("chat", () => (++n === 1 ? sse(["«Стас зубы стоматолог»"]) : sse(["ответ"])));
    await handleChatMessage(ctx);
    const calls = FETCH.of("/chat/completions");
    assert.equal(calls.length, 2);
    const rw = calls[0].body;
    assert.ok(rw.messages[0].content.includes("поисковый запрос"), rw.messages[0].content); // the rag_rewrite prompt
    assert.equal(rw.model, "cheap/model");
    assert.equal(rw.max_tokens, 100);
    assert.ok(rw.messages.some(m => m.role === "user" && m.content.includes("болят зубы")));    // context shown
    assert.ok(rw.messages.at(-1).content.includes("а что у него с зубами?"));                   // the message itself
    assert.equal(env._ai.calls.at(-1).inputs.text[0], "Стас зубы стоматолог");                  // quotes stripped, used for the embed
    const sys = calls[1].body.messages[0].content;                                              // the reply saw the dated fact
    assert.ok(/\[\d{4}-\d{2}-\d{2}\] Стас проходил лечение у стоматолога/.test(sys), sys);
  });

  test("no prior history → no rewrite call: the raw query is embedded", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 311, chatType: "private", text: "что у Стаса с зубами" }), env, { ...DEFAULT_CHAT_DATA(), config: { rag_min_score: 0 } });
    await addMemory(ctx, "Стас проходил лечение у стоматолога", "auto");
    FETCH.set("chat", () => sse(["ответ"]));
    await handleChatMessage(ctx);
    assert.equal(FETCH.of("/chat/completions").length, 1);
    assert.equal(env._ai.calls.at(-1).inputs.text[0], "что у Стаса с зубами");
  });

  test("rewriter failure / timeout → the raw query; the reply still happens", async () => {
    const env = ragEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), history: history(), config: { rag_min_score: 0 } };
    const ctx = makeCtxFor(makeMsg({ chatId: 312, chatType: "private", text: "а что у него с зубами?", message_id: 3 }), env, cd);
    let n = 0;
    FETCH.set("chat", () => (++n === 1 ? sse([], { ok: false, status: 500 }) : sse(["ответ"])));
    await handleChatMessage(ctx);
    assert.equal(FETCH.of("/chat/completions").length, 2);
    assert.equal(env._ai.calls.at(-1).inputs.text[0], "а что у него с зубами?");
    assert.equal(FETCH.sends().length, 1);
  });

  test("ENABLE_RAG_REWRITE=false → no rewrite even with history", async () => {
    const env = ragEnv({ ENABLE_RAG_REWRITE: "false" });
    const cd = { ...DEFAULT_CHAT_DATA(), history: history(), config: { rag_min_score: 0 } };
    const ctx = makeCtxFor(makeMsg({ chatId: 313, chatType: "private", text: "а что у него с зубами?", message_id: 3 }), env, cd);
    FETCH.set("chat", () => sse(["ответ"]));
    await handleChatMessage(ctx);
    assert.equal(FETCH.of("/chat/completions").length, 1);
  });

  test("rewriteRecallQuery: first non-empty line, quotes stripped; empty/NONE-ish output → raw", async () => {
    const env = ragEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), history: history() };
    const ctx = makeCtxFor(makeMsg({ chatId: 314, text: "и когда это было?", message_id: 3 }), env, cd);
    FETCH.set("chat", () => sse(["\n\"когда Стас лечил зубы\"\nвторая строка"]));
    assert.equal(await rewriteRecallQuery(ctx, "и когда это было?"), "когда Стас лечил зубы");
    FETCH.set("chat", () => sse([""]));
    assert.equal(await rewriteRecallQuery(ctx, "и когда это было?"), "и когда это было?");
    assert.equal(await rewriteRecallQuery(ctx, ""), "");
  });

  test("recallMemories = rewrite → hybrid; RAG off → [] without any call", async () => {
    const env = makeEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 315, text: "x" }), env, { ...DEFAULT_CHAT_DATA(), history: history() });
    assert.deepEqual(await recallMemories(ctx, "что с зубами"), []);
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });
});
