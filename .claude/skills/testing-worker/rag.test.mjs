// Долгая память = КУРИРОВАННЫЕ ФАКТЫ: appendHistory больше не эмбедит сообщения; факты приходят
// через addMemory (/memory add) и runMemoryCuration (на ответе бота); recall — из namespace mem:.
// Моки env.AI / env.VECTORIZE — из harness (makeAI/makeVectorize/seedMemories).
import {
  test, describe, assert,
  makeEnv, makeCtxFor, makeMsg, seedChat, seedMemories, dbMemories, dbHistory,
  FETCH, sse, DEFAULT_CHAT_DATA,
  appendHistory, handleChatMessage,
  ragRetrieveMemories, addMemory, listMemories, runMemoryCuration, parseExtractedFacts,
  memVectorId, memNamespace, COMMANDS, parseCommandAndArg,
} from "./harness.mjs";

// Прогон /memory через РЕАЛЬНЫЙ парсинг (parseCommandAndArg → stripBotMentions), а не напрямую —
// чтобы ловить баги вроде схлопывания переносов строк в bulk-add.
const runMemory = async (ctx, text) => COMMANDS.memory(ctx, parseCommandAndArg(text, ctx.cfg));

const ragEnv = () => makeEnv({ ENABLE_RAG: "true" });

describe("Память · запись фактов (не сообщений)", () => {
  test("appendHistory НЕ пишет векторы даже при ENABLE_RAG", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 6 }), env);
    await appendHistory(ctx, [{ role: "user", content: "привет", meta: { message_id: 1 } }]);
    assert.equal(env._vec.store.size, 0);
    assert.equal(env._ai.calls.length, 0);
  });

  test("addMemory(manual) → строка в memories + вектор в mem:<id>", async () => {
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

  test("/memory add при rag OFF: факт сохранён/заэмбежен + предупреждение как включить", async () => {
    const env = makeEnv(); // RAG off (cfg.rag=false)
    const ctx = makeCtxFor(makeMsg({ chatId: 77, text: "/memory add важный факт" }), env);
    const reply = await COMMANDS.memory(ctx, { argText: "add важный факт" });
    assert.match(reply, /Запомнил/);
    assert.match(reply, /заметк/i);                  // нейтральная подсказка (работает как заметки)
    assert.match(reply, /config rag on/);            // как включить вспоминание
    assert.equal((await dbMemories(env, 77)).length, 1); // факт всё равно записан
    assert.equal(env._vec.store.size, 1);            // и заэмбежен (готов к recall)
  });

  test("/memory add при rag ON — без подсказки про rag", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 79, text: "/memory add важный факт" }), env);
    const reply = await COMMANDS.memory(ctx, { argText: "add важный факт" });
    assert.match(reply, /Запомнил/);
    assert.ok(!/config rag on/.test(reply));
  });

  test("/memory del <N> удаляет один факт (строку + вектор)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 92 }), env);
    const id1 = await addMemory(ctx, "факт раз", "manual");
    await addMemory(ctx, "факт два", "manual");
    const reply = await COMMANDS.memory(ctx, { argText: "del 1" }); // удаляем первый
    assert.match(reply, /Удалил/);
    const rows = await dbMemories(env, 92);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, "факт два");          // остался второй
    assert.ok(!env._vec.store.has(memVectorId(92, id1))); // вектор удалённого тоже стёрт
  });

  test("/memory del с неверным номером → ошибка, ничего не удаляет", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 93 }), env);
    await addMemory(ctx, "единственный", "manual");
    const reply = await COMMANDS.memory(ctx, { argText: "del 5" });
    assert.match(reply, /Нет факта/);
    assert.equal((await dbMemories(env, 93)).length, 1);
  });

  test("/memory add многострочный → массовое добавление (через реальный парсинг)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 95 }), env);
    // именно через parseCommandAndArg: переносы строк должны дожить до обработчика (stripBotMentions их не съедает)
    const reply = await runMemory(ctx, "/memory add\nфакт A\nфакт B\nфакт C");
    assert.match(reply, /Добавлено фактов: 3/);
    assert.equal((await dbMemories(env, 95)).length, 3);
  });

  test("/memory add bulk: дубли пропускаются", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 96 }), env);
    await addMemory(ctx, "уже есть", "manual");
    const reply = await runMemory(ctx, "/memory add\nновый\nуже есть");
    assert.match(reply, /Добавлено фактов: 1/);
    assert.match(reply, /дублей пропущено: 1/);
    assert.equal((await dbMemories(env, 96)).length, 2);
  });

  test("/admin chat_cmd <id> memory add — многострочный bulk в целевой чат", async () => {
    const env = ragEnv();
    const adminCtx = makeCtxFor(makeMsg({ chatId: 555, chatType: "private", username: "admin", text: "x" }), env);
    const mode = parseCommandAndArg("/admin chat_cmd 555 memory add\nфакт один\nфакт два", adminCtx.cfg);
    const reply = await COMMANDS.admin(adminCtx, mode);
    assert.match(reply, /Добавлено фактов: 2/);
    assert.equal((await dbMemories(env, 555)).length, 2); // факты ушли в целевой чат 555
  });

  test("/memory add без текста → подсказка, ничего не сохраняем", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 78, text: "/memory add" }), env);
    const reply = await COMMANDS.memory(ctx, { argText: "add" });
    assert.match(reply, /Что запомнить/);
    assert.equal((await dbMemories(env, 78)).length, 0);
    assert.equal(env._vec.store.size, 0);
  });

  test("/memory list: ✍️ перед ручными, 🤖 перед авто", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 8 }), env);
    await addMemory(ctx, "факт1", "manual");
    await addMemory(ctx, "факт2", "auto");
    const out = await COMMANDS.memory(ctx, { argText: "list" });
    assert.match(out, /✍️ факт1/); // иконка перед текстом
    assert.match(out, /🤖 факт2/);
  });

  test("точный дубль факта не плодит строку/вектор (UNIQUE chat_id,text)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 50 }), env);
    const id1 = await addMemory(ctx, "любит котов", "manual");
    const id2 = await addMemory(ctx, "любит котов", "auto"); // тот же текст
    assert.ok(id1 > 0);
    assert.equal(id2, 0);                          // дубль проигнорирован (changes===0)
    assert.equal((await dbMemories(env, 50)).length, 1);
    assert.equal(env._vec.store.size, 1);          // второй вектор не записан
  });

  test("/memory add дубля → «уже помню», не «запомнил»", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 51 }), env);
    assert.match(await COMMANDS.memory(ctx, { argText: "add пьёт кофе" }), /Запомнил/);
    assert.match(await COMMANDS.memory(ctx, { argText: "add пьёт кофе" }), /уже помню/);
    assert.equal((await dbMemories(env, 51)).length, 1);
  });

  test("best-effort: падение VECTORIZE.upsert не ломает строку факта в D1", async () => {
    const env = ragEnv();
    env._vec.upsert = async () => { throw new Error("vectorize down"); };
    const ctx = makeCtxFor(makeMsg({ chatId: 35 }), env);
    const id = await addMemory(ctx, "выживет", "manual");
    assert.ok(id > 0);
    assert.equal((await dbMemories(env, 35)).length, 1);
  });
});

describe("Память · recall фактов из mem:", () => {
  test("находит релевантный факт, отдаёт ЧИСТЫЙ текст (без ярлыка роли)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 9, text: "котик" }), env);
    seedMemories(env, 9, [{ mem_id: 1, text: "котик" }]);
    const mem = await ragRetrieveMemories(ctx, "котик");
    assert.equal(mem.length, 1);
    assert.equal(mem[0], "котик");
  });

  test("оконного дедупа по message_id больше нет: факт возвращается даже при истории в окне", async () => {
    const env = ragEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), history: [{ role: "user", content: "котик", meta: { message_id: 1 } }] };
    const ctx = makeCtxFor(makeMsg({ chatId: 10, text: "котик" }), env, cd);
    seedMemories(env, 10, [{ mem_id: 1, text: "котик" }]);
    assert.equal((await ragRetrieveMemories(ctx, "котик")).length, 1);
  });

  test("изоляция по namespace: факт чата A не виден в чате B", async () => {
    const env = ragEnv();
    seedMemories(env, 20, [{ mem_id: 1, text: "секрет" }]);
    const ctxB = makeCtxFor(makeMsg({ chatId: 21, text: "секрет" }), env);
    assert.equal((await ragRetrieveMemories(ctxB, "секрет")).length, 0);
  });

  test("ниже порога похожести → пусто", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 22, text: "aaaa" }), env);
    seedMemories(env, 22, [{ mem_id: 1, text: "bbbb" }]);
    assert.equal((await ragRetrieveMemories(ctx, "aaaa")).length, 0);
  });

  test("orphan без metadata.text — пропуск без падения", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 23, text: "x" }), env);
    const vid = memVectorId(23, 1);
    env._vec.store.set(vid, { id: vid, values: env._ai.embed("x"), namespace: memNamespace(23), metadata: { chat_id: "23", mem_id: 1 } });
    assert.equal((await ragRetrieveMemories(ctx, "x")).length, 0);
  });

  test("RAG выключен → recall пуст, AI не зовётся", async () => {
    const env = makeEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 24, text: "котик" }), env);
    seedMemories(env, 24, [{ mem_id: 1, text: "котик" }]);
    assert.equal((await ragRetrieveMemories(ctx, "котик")).length, 0);
    assert.equal(env._ai.calls.length, 0);
  });

  test("найденный факт идёт в system-промпт, но не в историю/реплику", async () => {
    const env = ragEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { rag_min_score: 0 } };
    const ctx = makeCtxFor(makeMsg({ chatId: 110, chatType: "private", text: "что по отпуску" }), env, cd);
    seedMemories(env, 110, [{ mem_id: 1, text: "УНИКМАРКЕР отпуск в Сочи" }]);
    FETCH.set("chat", () => sse(["ладно"]));
    await handleChatMessage(ctx);
    const body = FETCH.chatBody(); // первый /chat/completions — это ответ
    const sys = body.messages.find(m => m.role === "system").content;
    assert.ok(sys.includes("УНИКМАРКЕР"));
    const nonSys = body.messages.filter(m => m.role !== "system").map(m => JSON.stringify(m.content)).join(" ");
    assert.ok(!nonSys.includes("УНИКМАРКЕР"));
  });
});

describe("Память · курирование на ответе", () => {
  const h3 = () => [
    { role: "user", content: "я живу в Кишинёве" },
    { role: "assistant", content: "ок" },
    { role: "user", content: "люблю вино" },
  ];

  test("извлекает факты из дельты, пишет auto + двигает _memUptoId", async () => {
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

  test("handleChatMessage больше НЕ курирует (курация — в дейли-кроне)", async () => {
    const env = ragEnv();
    await seedChat(env, 40, { history: [
      { role: "user", content: "меня зовут Стас", meta: { message_id: 1 } },
      { role: "user", content: "я из Кишинёва", meta: { message_id: 2 } },
    ] });
    const ctx = makeCtxFor(makeMsg({ chatId: 40, chatType: "private", text: "привет" }), env);
    FETCH.set("chat", () => sse(["ответ"]));
    await handleChatMessage(ctx);
    assert.ok(FETCH.sends().length >= 1);             // ответ ушёл
    assert.equal((await dbMemories(env, 40)).length, 0); // но факты на ответе НЕ извлекаются
  });

  test("извлечение идёт только из сообщений собеседника, не из ответа бота", async () => {
    const env = ragEnv();
    await seedChat(env, 41, { history: [
      { role: "assistant", content: "БОТМАРКЕР это моя реплика", meta: { message_id: 1 } },
      { role: "assistant", content: "ещё реплика бота", meta: { message_id: 2 } },
    ] });
    const ctx = makeCtxFor(makeMsg({ chatId: 41 }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse(["факт"]));
    await runMemoryCuration(ctx);
    // все новые сообщения — ассистентские → извлекать не из чего, LLM не зовём, но границу двигаем
    assert.equal(FETCH.of("/chat/completions").length, 0);
    assert.equal((await dbMemories(env, 41)).length, 0);
    assert.equal(ctx.chatData._memUptoId, 2);
  });

  test("гейт: мало новых сообщений → без LLM, без фактов", async () => {
    const env = ragEnv();
    await seedChat(env, 31, { history: [{ role: "user", content: "привет" }] }); // 1 < MEM_CURATION_MIN_NEW
    const ctx = makeCtxFor(makeMsg({ chatId: 31 }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse(["факт"]));
    await runMemoryCuration(ctx);
    assert.equal((await dbMemories(env, 31)).length, 0);
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });

  test("RAG выключен → курирование no-op", async () => {
    const env = makeEnv();
    await seedChat(env, 32, { history: h3() });
    const ctx = makeCtxFor(makeMsg({ chatId: 32 }), env, { ...DEFAULT_CHAT_DATA() });
    await runMemoryCuration(ctx);
    assert.equal((await dbMemories(env, 32)).length, 0);
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });

  test("best-effort: фолбэк извлечения → нет фактов, граница не двигается, без throw", async () => {
    const env = ragEnv();
    await seedChat(env, 33, { history: h3() });
    const ctx = makeCtxFor(makeMsg({ chatId: 33 }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse([], { ok: false, status: 500 }));
    await runMemoryCuration(ctx);
    assert.equal((await dbMemories(env, 33)).length, 0);
    assert.equal(ctx.chatData._memUptoId, 0);
  });

  test("дедуп: уже известный факт не дублируется", async () => {
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

describe("Память · /memory forget", () => {
  test("чистит факты + векторы + границу только своего чата", async () => {
    const env = ragEnv();
    const ctxA = makeCtxFor(makeMsg({ chatId: 1 }), env);
    const idA = await addMemory(ctxA, "факт А", "manual");
    const ctxB = makeCtxFor(makeMsg({ chatId: 2 }), env);
    const idB = await addMemory(ctxB, "факт Б", "manual");
    ctxA.chatData._memUptoId = 5;

    await COMMANDS.memory(ctxA, { argText: "forget" });

    assert.equal((await dbMemories(env, 1)).length, 0);
    assert.ok(!env._vec.store.has(memVectorId(1, idA)));
    assert.ok(env._vec.store.has(memVectorId(2, idB))); // чужой чат цел
    assert.equal(ctxA.chatData._memUptoId, 0);
  });
});

describe("parseExtractedFacts", () => {
  test("снимает маркеры/нумерацию, режет преамбулу и пустое", () => {
    assert.deepEqual(parseExtractedFacts("- факт1\n2. факт2\n\nфакт3"), ["факт1", "факт2", "факт3"]);
    assert.deepEqual(parseExtractedFacts("Вот факты:\n- альфа\nнет"), ["альфа"]);
    assert.deepEqual(parseExtractedFacts(""), []);
  });
  test("дедуп нормализованный + против существующих", () => {
    assert.deepEqual(parseExtractedFacts("дубль\nДУБЛЬ\nдубль "), ["дубль"]);
    assert.deepEqual(parseExtractedFacts("новый", ["новый"]), []);
  });
  test("ограничивает число фактов", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    assert.equal(parseExtractedFacts(many).length, 5); // MEM_MAX_FACTS_PER_RUN
  });
  test("не калечит факт, начинающийся с числа", () => {
    assert.deepEqual(parseExtractedFacts("1990 год рождения"), ["1990 год рождения"]);
    assert.deepEqual(parseExtractedFacts("5 минут опоздания норма"), ["5 минут опоздания норма"]);
  });
  test("отсекает разные формы отказа и заголовков", () => {
    assert.deepEqual(parseExtractedFacts("Извлечённые факты:\n- альфа"), ["альфа"]);
    assert.deepEqual(parseExtractedFacts("новых фактов нет"), []);
    assert.deepEqual(parseExtractedFacts("устойчивых фактов нет"), []);
    assert.deepEqual(parseExtractedFacts("ничего не нашёл"), []);
  });
  test("не дропает факт, начинающийся с «Вот» без двоеточия", () => {
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
