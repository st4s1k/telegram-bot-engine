// Long-term memory = CURATED FACTS: appendHistory no longer embeds messages; facts come
// via addMemory (/memory add) and runMemoryCuration (on the bot's reply); recall — from the mem: namespace.
// env.AI / env.VECTORIZE mocks — from the harness (makeAI/makeVectorize/seedMemories).
import {
  test, describe, assert,
  makeEnv, makeCtxFor, makeMsg, seedChat, seedMemories, dbMemories, dbHistory,
  FETCH, sse, DEFAULT_CHAT_DATA,
  appendHistory, handleChatMessage,
  ragRetrieveMemories, addMemory, listMemories, runMemoryCuration, parseExtractedFacts,
  memVectorId, memNamespace, COMMANDS, parseCommandAndArg,
} from "./harness.mjs";

// Run /memory through REAL parsing (parseCommandAndArg → stripBotMentions), not directly —
// to catch bugs like collapsing newlines in bulk-add.
const runMemory = async (ctx, text) => COMMANDS.memory(ctx, parseCommandAndArg(text, ctx.cfg));

const ragEnv = () => makeEnv({ ENABLE_RAG: "true" });

describe("Memory · writing facts (not messages)", () => {
  test("appendHistory does NOT write vectors even with ENABLE_RAG", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 6 }), env);
    await appendHistory(ctx, [{ role: "user", content: "привет", meta: { message_id: 1 } }]);
    assert.equal(env._vec.store.size, 0);
    assert.equal(env._ai.calls.length, 0);
  });

  test("addMemory(manual) → row in memories + vector in mem:<id>", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 5 }), env);
    const id = await addMemory(ctx, "любит котов", "manual");
    const rows = await dbMemories(env, 5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "manual");
    assert.equal(rows[0].text, "любит котов");
    const v = env._vec.store.get(memVectorId(5, id));
    assert.ok(v);
    assert.equal(v.namespace, memNamespace(5));
    assert.equal(v.metadata.text, "любит котов");
    assert.equal(v.metadata.source, "manual");
  });

  test("/memory add with rag OFF: fact saved/embedded + warning on how to enable", async () => {
    const env = makeEnv(); // RAG off (cfg.rag=false)
    const ctx = makeCtxFor(makeMsg({ chatId: 77, text: "/memory add важный факт" }), env);
    const reply = await COMMANDS.memory(ctx, { argText: "add важный факт" });
    assert.match(reply, /Запомнил/);
    assert.match(reply, /заметк/i);                  // neutral hint (works like notes)
    assert.match(reply, /config rag on/);            // how to enable recall
    assert.equal((await dbMemories(env, 77)).length, 1); // fact recorded anyway
    assert.equal(env._vec.store.size, 1);            // and embedded (ready for recall)
  });

  test("/memory add with rag ON — no hint about rag", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 79, text: "/memory add важный факт" }), env);
    const reply = await COMMANDS.memory(ctx, { argText: "add важный факт" });
    assert.match(reply, /Запомнил/);
    assert.ok(!/config rag on/.test(reply));
  });

  test("/memory del <N> deletes a single fact (row + vector)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 92 }), env);
    const id1 = await addMemory(ctx, "факт раз", "manual");
    await addMemory(ctx, "факт два", "manual");
    const reply = await COMMANDS.memory(ctx, { argText: "del 1" }); // delete the first
    assert.match(reply, /Удалил/);
    const rows = await dbMemories(env, 92);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, "факт два");          // the second remains
    assert.ok(!env._vec.store.has(memVectorId(92, id1))); // the deleted one's vector is wiped too
  });

  test("/memory del with a wrong number → error, deletes nothing", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 93 }), env);
    await addMemory(ctx, "единственный", "manual");
    const reply = await COMMANDS.memory(ctx, { argText: "del 5" });
    assert.match(reply, /Нет факта/);
    assert.equal((await dbMemories(env, 93)).length, 1);
  });

  test("/memory add multi-line → bulk add (via real parsing)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 95 }), env);
    // specifically via parseCommandAndArg: newlines must survive to the handler (stripBotMentions doesn't eat them)
    const reply = await runMemory(ctx, "/memory add\nфакт A\nфакт B\nфакт C");
    assert.match(reply, /Добавлено фактов: 3/);
    assert.equal((await dbMemories(env, 95)).length, 3);
  });

  test("/memory add bulk: duplicates are skipped", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 96 }), env);
    await addMemory(ctx, "уже есть", "manual");
    const reply = await runMemory(ctx, "/memory add\nновый\nуже есть");
    assert.match(reply, /Добавлено фактов: 1/);
    assert.match(reply, /дублей пропущено: 1/);
    assert.equal((await dbMemories(env, 96)).length, 2);
  });

  test("/admin chat_cmd <id> memory add — multi-line bulk into the target chat", async () => {
    const env = ragEnv();
    const adminCtx = makeCtxFor(makeMsg({ chatId: 555, chatType: "private", username: "admin", text: "x" }), env);
    const mode = parseCommandAndArg("/admin chat_cmd 555 memory add\nфакт один\nфакт два", adminCtx.cfg);
    const reply = await COMMANDS.admin(adminCtx, mode);
    assert.match(reply, /Добавлено фактов: 2/);
    assert.equal((await dbMemories(env, 555)).length, 2); // facts went to the target chat 555
  });

  test("/memory add with no text → hint, save nothing", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 78, text: "/memory add" }), env);
    const reply = await COMMANDS.memory(ctx, { argText: "add" });
    assert.match(reply, /Что запомнить/);
    assert.equal((await dbMemories(env, 78)).length, 0);
    assert.equal(env._vec.store.size, 0);
  });

  test("/memory list: ✍️ before manual, 🤖 before auto", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 8 }), env);
    await addMemory(ctx, "факт1", "manual");
    await addMemory(ctx, "факт2", "auto");
    const out = await COMMANDS.memory(ctx, { argText: "list" });
    assert.match(out, /✍️ факт1/); // icon before the text
    assert.match(out, /🤖 факт2/);
  });

  test("an exact duplicate fact doesn't spawn a row/vector (UNIQUE chat_id,text)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 50 }), env);
    const id1 = await addMemory(ctx, "любит котов", "manual");
    const id2 = await addMemory(ctx, "любит котов", "auto"); // same text
    assert.ok(id1 > 0);
    assert.equal(id2, 0);                          // duplicate ignored (changes===0)
    assert.equal((await dbMemories(env, 50)).length, 1);
    assert.equal(env._vec.store.size, 1);          // the second vector is not written
  });

  test("/memory add of a duplicate → «уже помню», not «запомнил»", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 51 }), env);
    assert.match(await COMMANDS.memory(ctx, { argText: "add пьёт кофе" }), /Запомнил/);
    assert.match(await COMMANDS.memory(ctx, { argText: "add пьёт кофе" }), /уже помню/);
    assert.equal((await dbMemories(env, 51)).length, 1);
  });

  test("best-effort: a VECTORIZE.upsert failure doesn't break the fact row in D1", async () => {
    const env = ragEnv();
    env._vec.upsert = async () => { throw new Error("vectorize down"); };
    const ctx = makeCtxFor(makeMsg({ chatId: 35 }), env);
    const id = await addMemory(ctx, "выживет", "manual");
    assert.ok(id > 0);
    assert.equal((await dbMemories(env, 35)).length, 1);
  });
});

describe("Memory · recall of facts from mem:", () => {
  test("finds a relevant fact, returns CLEAN text (without a role label)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 9, text: "котик" }), env);
    seedMemories(env, 9, [{ mem_id: 1, text: "котик" }]);
    const mem = await ragRetrieveMemories(ctx, "котик");
    assert.equal(mem.length, 1);
    assert.equal(mem[0], "котик");
  });

  test("windowed dedup by message_id is gone: a fact is returned even with history in the window", async () => {
    const env = ragEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), history: [{ role: "user", content: "котик", meta: { message_id: 1 } }] };
    const ctx = makeCtxFor(makeMsg({ chatId: 10, text: "котик" }), env, cd);
    seedMemories(env, 10, [{ mem_id: 1, text: "котик" }]);
    assert.equal((await ragRetrieveMemories(ctx, "котик")).length, 1);
  });

  test("namespace isolation: a fact from chat A is not visible in chat B", async () => {
    const env = ragEnv();
    seedMemories(env, 20, [{ mem_id: 1, text: "секрет" }]);
    const ctxB = makeCtxFor(makeMsg({ chatId: 21, text: "секрет" }), env);
    assert.equal((await ragRetrieveMemories(ctxB, "секрет")).length, 0);
  });

  test("below the similarity threshold → empty", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 22, text: "aaaa" }), env);
    seedMemories(env, 22, [{ mem_id: 1, text: "bbbb" }]);
    assert.equal((await ragRetrieveMemories(ctx, "aaaa")).length, 0);
  });

  test("orphan without metadata.text — skipped without crashing", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 23, text: "x" }), env);
    const vid = memVectorId(23, 1);
    env._vec.store.set(vid, { id: vid, values: env._ai.embed("x"), namespace: memNamespace(23), metadata: { chat_id: "23", mem_id: 1 } });
    assert.equal((await ragRetrieveMemories(ctx, "x")).length, 0);
  });

  test("RAG off → recall empty, AI not called", async () => {
    const env = makeEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 24, text: "котик" }), env);
    seedMemories(env, 24, [{ mem_id: 1, text: "котик" }]);
    assert.equal((await ragRetrieveMemories(ctx, "котик")).length, 0);
    assert.equal(env._ai.calls.length, 0);
  });

  test("a found fact goes into the system prompt, but not into history/the reply", async () => {
    const env = ragEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { rag_min_score: 0 } };
    const ctx = makeCtxFor(makeMsg({ chatId: 110, chatType: "private", text: "что по отпуску" }), env, cd);
    seedMemories(env, 110, [{ mem_id: 1, text: "УНИКМАРКЕР отпуск в Сочи" }]);
    FETCH.set("chat", () => sse(["ладно"]));
    await handleChatMessage(ctx);
    const body = FETCH.chatBody(); // the first /chat/completions — that's the reply
    const sys = body.messages.find(m => m.role === "system").content;
    assert.ok(sys.includes("УНИКМАРКЕР"));
    const nonSys = body.messages.filter(m => m.role !== "system").map(m => JSON.stringify(m.content)).join(" ");
    assert.ok(!nonSys.includes("УНИКМАРКЕР"));
  });
});

describe("Memory · curation on reply", () => {
  const h3 = () => [
    { role: "user", content: "я живу в Кишинёве" },
    { role: "assistant", content: "ок" },
    { role: "user", content: "люблю вино" },
  ];

  test("extracts facts from the delta, writes auto + advances _memUptoId", async () => {
    const env = ragEnv();
    await seedChat(env, 30, { history: h3() }); // id 1,2,3
    const ctx = makeCtxFor(makeMsg({ chatId: 30 }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse(["живёт в Кишинёве\nлюбит вино"]));
    await runMemoryCuration(ctx);
    const rows = await dbMemories(env, 30);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.source === "auto"));
    assert.equal(env._vec.store.size, 2);
    assert.equal(ctx.chatData._memUptoId, 3);
  });

  test("handleChatMessage NO longer curates (curation — in the daily cron)", async () => {
    const env = ragEnv();
    await seedChat(env, 40, { history: [
      { role: "user", content: "меня зовут Стас", meta: { message_id: 1 } },
      { role: "user", content: "я из Кишинёва", meta: { message_id: 2 } },
    ] });
    const ctx = makeCtxFor(makeMsg({ chatId: 40, chatType: "private", text: "привет" }), env);
    FETCH.set("chat", () => sse(["ответ"]));
    await handleChatMessage(ctx);
    assert.ok(FETCH.sends().length >= 1);             // the reply went out
    assert.equal((await dbMemories(env, 40)).length, 0); // but facts are NOT extracted on reply
  });

  test("extraction happens only from the interlocutor's messages, not from the bot's reply", async () => {
    const env = ragEnv();
    await seedChat(env, 41, { history: [
      { role: "assistant", content: "БОТМАРКЕР это моя реплика", meta: { message_id: 1 } },
      { role: "assistant", content: "ещё реплика бота", meta: { message_id: 2 } },
    ] });
    const ctx = makeCtxFor(makeMsg({ chatId: 41 }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse(["факт"]));
    await runMemoryCuration(ctx);
    // all new messages are assistant ones → nothing to extract, we don't call the LLM, but we advance the boundary
    assert.equal(FETCH.of("/chat/completions").length, 0);
    assert.equal((await dbMemories(env, 41)).length, 0);
    assert.equal(ctx.chatData._memUptoId, 2);
  });

  test("gate: too few new messages → no LLM, no facts", async () => {
    const env = ragEnv();
    await seedChat(env, 31, { history: [{ role: "user", content: "привет" }] }); // 1 < MEM_CURATION_MIN_NEW
    const ctx = makeCtxFor(makeMsg({ chatId: 31 }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse(["факт"]));
    await runMemoryCuration(ctx);
    assert.equal((await dbMemories(env, 31)).length, 0);
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });

  test("RAG off → curation is a no-op", async () => {
    const env = makeEnv();
    await seedChat(env, 32, { history: h3() });
    const ctx = makeCtxFor(makeMsg({ chatId: 32 }), env, { ...DEFAULT_CHAT_DATA() });
    await runMemoryCuration(ctx);
    assert.equal((await dbMemories(env, 32)).length, 0);
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });

  test("best-effort: extraction fallback → no facts, boundary doesn't advance, no throw", async () => {
    const env = ragEnv();
    await seedChat(env, 33, { history: h3() });
    const ctx = makeCtxFor(makeMsg({ chatId: 33 }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse([], { ok: false, status: 500 }));
    await runMemoryCuration(ctx);
    assert.equal((await dbMemories(env, 33)).length, 0);
    assert.equal(ctx.chatData._memUptoId, 0);
  });

  test("dedup: an already-known fact is not duplicated", async () => {
    const env = ragEnv();
    await seedChat(env, 34, { history: h3() });
    const ctx = makeCtxFor(makeMsg({ chatId: 34 }), env, { ...DEFAULT_CHAT_DATA() });
    await addMemory(ctx, "факт один", "manual");
    FETCH.set("chat", () => sse(["факт один\nфакт три"]));
    await runMemoryCuration(ctx);
    const texts = (await dbMemories(env, 34)).map(r => r.text);
    assert.ok(texts.includes("факт три"));
    assert.equal(texts.filter(t => t === "факт один").length, 1);
  });
});

describe("Memory · /memory forget", () => {
  test("clears facts + vectors + the boundary of only its own chat", async () => {
    const env = ragEnv();
    const ctxA = makeCtxFor(makeMsg({ chatId: 1 }), env);
    const idA = await addMemory(ctxA, "факт А", "manual");
    const ctxB = makeCtxFor(makeMsg({ chatId: 2 }), env);
    const idB = await addMemory(ctxB, "факт Б", "manual");
    ctxA.chatData._memUptoId = 5;

    await COMMANDS.memory(ctxA, { argText: "forget all" });

    assert.equal((await dbMemories(env, 1)).length, 0);
    assert.ok(!env._vec.store.has(memVectorId(1, idA)));
    assert.ok(env._vec.store.has(memVectorId(2, idB))); // the other chat is intact
    assert.equal(ctxA.chatData._memUptoId, 0);
  });
});

describe("parseExtractedFacts", () => {
  test("strips markers/numbering, cuts the preamble and empties", () => {
    assert.deepEqual(parseExtractedFacts("- факт1\n2. факт2\n\nфакт3"), ["факт1", "факт2", "факт3"]);
    assert.deepEqual(parseExtractedFacts("Вот факты:\n- альфа\nнет", [], "ru"), ["альфа"]);
    assert.deepEqual(parseExtractedFacts(""), []);
  });
  test("dedup normalized + against existing ones", () => {
    assert.deepEqual(parseExtractedFacts("дубль\nДУБЛЬ\nдубль "), ["дубль"]);
    assert.deepEqual(parseExtractedFacts("новый", ["новый"]), []);
  });
  test("caps the number of facts", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    assert.equal(parseExtractedFacts(many).length, 5); // MEM_MAX_FACTS_PER_RUN
  });
  test("doesn't mangle a fact that starts with a number", () => {
    assert.deepEqual(parseExtractedFacts("1990 год рождения"), ["1990 год рождения"]);
    assert.deepEqual(parseExtractedFacts("5 минут опоздания норма"), ["5 минут опоздания норма"]);
  });
  test("filters out various forms of refusals and headings", () => {
    assert.deepEqual(parseExtractedFacts("Извлечённые факты:\n- альфа"), ["альфа"]);
    assert.deepEqual(parseExtractedFacts("новых фактов нет", [], "ru"), []);
    assert.deepEqual(parseExtractedFacts("устойчивых фактов нет", [], "ru"), []);
    assert.deepEqual(parseExtractedFacts("ничего не нашёл", [], "ru"), []);
  });
  test("doesn't drop a fact starting with «Вот» without a colon", () => {
    assert.deepEqual(parseExtractedFacts("Вот его зовут Стас"), ["Вот его зовут Стас"]);
  });
  test("refusal markers are locale-aware (lang param)", () => {
    // Universal English forms filtered regardless of lang:
    assert.deepEqual(parseExtractedFacts("No facts.", [], "en"), []);
    assert.deepEqual(parseExtractedFacts("none", [], "en"), []);
    // RU markers live in the ru locale: filtered under ru, NOT under en (proves locale-specificity).
    assert.deepEqual(parseExtractedFacts("ничего не нашёл", [], "ru"), []);
    assert.deepEqual(parseExtractedFacts("ничего полезного", [], "en"), ["ничего полезного"]);
  });
});
