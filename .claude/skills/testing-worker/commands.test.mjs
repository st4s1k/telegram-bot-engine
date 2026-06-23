import * as H from "./harness.mjs";
const {
  test, describe, assert, WORKER,
  // worker.js — функции и константы
  toMarkdownV2, sendTelegramMessage, sendAndStore, isFallbackMessage,
  dedupeHistory, collapseConsecutiveDuplicates, trimHistoryByChars, historyChars,
  appendHistory, updateHistoryMessage,
  getGlobalConfig, mergeConfig, parseConfigValue, setConfigParam, buildConfigHelp,
  buildHelp, buildInfoStatus, CONFIG_SCHEMA, CONFIG_GROUPS,
  parseCommandAndArg, isCommand, stripBotMentions, parseRoots, escapeRegExp, lastToken,
  pickOne, newReqId, messageMentionsBot, resolveUserName, pickTargetName, pickRandomUserText,
  getReplyText, getUserName, chatTitleFromMsg, getUserMeta, buildUserItem, buildAssistantItem,
  buildCommandRegex,
  makeCtx, visualFromMsg, visualLabel, visualNote, photoCacheKey, pickVisionDetail, albumContext,
  assemblePrompt, buildDefaultPrompt,
  buildReplyPrompt, buildVisionPrompt, buildPhotoFromCachePrompt, buildSummaryPrompt,
  PHOTO_DELIM,
  DEFAULT_CHAT_DATA, getChatData, flushChatData, updatePersonaState, getPersonaStateDefaults, setRole, setPaused, saveChatConfig,
  addSpend, cachePhotoDesc, PHOTO_CACHE_CAP,
  callOpenRouter, runLLMWithHistory, toLLMMessages, formatWithMeta, asciiHeader,
  fetchModelPrice, fetchOpenRouterUsage,
  getTelegramPhotoUrl, runVision, handlePhotoMessage, describeCtxPhoto, getReplySource,
  logIgnoredPhoto,
  shouldAnswer, pickRandomRandomKind, tryQuickReply, tryCommand, handleChatMessage,
  handleTelegramMessage, COMMANDS, LLM_COMMANDS, TECH_COMMANDS,
  RANDOM_HANDLERS,
  TELEGRAM_MSG_LIMIT, HISTORY_HARD_CAP_ITEMS, FALLBACK_LLM_ERROR, FALLBACK_NO_CREDITS,
  // харнесс
  makeEnv, makeMsg, makeKV, makeCtxFor, photoSizes, sse, jsonResp, streamResp,
  stubRandom, restoreRandom, CONSOLE, clearConsole, FETCH, newFetch,
  seedChat, dbChat, dbHistory, dbMemories,
} = H;


/* ====================================================================== */
/* =====================  ОТДЕЛЬНЫЕ КОМАНДЫ  ========================== */
/* ====================================================================== */

describe("COMMANDS.rp / stop / resume / info", () => {
  test("rp задаёт/сбрасывает/показывает роль", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.rp(ctx, { argText: "ты грубый зек" }), /принята/i);
    assert.equal(ctx.chatData.role, "ты грубый зек");
    assert.match(await COMMANDS.rp(ctx, { argText: "" }), /ты грубый зек/);
    assert.match(await COMMANDS.rp(ctx, { argText: "off" }), /сброшена/i);
    assert.equal(ctx.chatData.role, null);
  });
  test("stop/resume переключают паузу", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    await COMMANDS.stop(ctx, { argText: "" });
    assert.equal(ctx.chatData.paused, true);
    await COMMANDS.resume(ctx, { argText: "" });
    assert.equal(ctx.chatData.paused, false);
  });
  test("info → статус", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.info(ctx, { argText: "" }), /🎭/); // info panel role line — locale-neutral marker
  });
});


describe("COMMANDS.memory", () => {
  test("статус по умолчанию", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.memory(ctx, { argText: "" }), /Память чата/);
  });
  test("forget стирает историю/кэш/роль/настроение/расход, настройки остаются", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), history: [{ content: "x" }], photoCache: { k: "d" }, role: "зек", personaState: { arousal: 4 }, spend: 1, spendCount: 5, config: { random: false } };
    const ctx = makeCtxFor(makeMsg(), makeEnv(), cd);
    await COMMANDS.memory(ctx, { argText: "forget" });
    assert.deepEqual(ctx.chatData.history, []);
    assert.deepEqual(ctx.chatData.photoCache, {});
    assert.equal(ctx.chatData.role, null);
    assert.deepEqual(ctx.chatData.personaState, getPersonaStateDefaults());
    assert.equal(ctx.chatData.spend, 0);
    assert.deepEqual(ctx.chatData.config, { random: false }); // настройки целы
  });
  test("dedupe убирает подряд идущие повторы", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), history: [
      { role: "user", content: "a", meta: { message_id: 1 } },
      { role: "user", content: "a", meta: { message_id: 2 } },
      { role: "user", content: "b", meta: { message_id: 3 } },
    ] };
    await seedChat(env, 555, cd); // chatId по умолчанию из makeMsg
    const ctx = makeCtxFor(makeMsg(), env, cd);
    const out = await COMMANDS.memory(ctx, { argText: "dedupe" });
    assert.match(out, /Убрано повторов: 1/);
    assert.equal(ctx.chatData.history.length, 2);
  });
  test("size_chars задаёт размер памяти", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    await COMMANDS.memory(ctx, { argText: "size_chars 9000" });
    assert.equal(ctx.chatData.config.history_chars, 9000);
  });
});


describe("COMMANDS.config", () => {
  test("без аргумента → справка", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.config(ctx, { argText: "" }), /Управление настройками/);
  });
  test("reset сбрасывает всё", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), config: { random: false } };
    const ctx = makeCtxFor(makeMsg(), makeEnv(), cd);
    await COMMANDS.config(ctx, { argText: "reset" });
    assert.deepEqual(ctx.chatData.config, {});
  });
  test("неизвестный ключ → ошибка", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.config(ctx, { argText: "nope 1" }), /не найден/i);
  });
});


describe("COMMANDS.model", () => {
  test("без аргумента → показ модели, цены, баланса", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = await COMMANDS.model(ctx, { argText: "" });
    assert.ok(out.includes("Текст"));
    assert.ok(out.includes("💳"));
  });
  test("смена основной модели", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = await COMMANDS.model(ctx, { argText: "vendor/new" });
    assert.equal(ctx.chatData.config.model, "vendor/new");
    assert.ok(out.includes("vendor/new"));
  });
  test("vision-подкоманда задаёт отдельную модель для фото", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    await COMMANDS.model(ctx, { argText: "vision vis/model" });
    assert.equal(ctx.chatData.config.vision_model, "vis/model");
  });
  test("summary-подкоманда задаёт отдельную модель для /summary", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = await COMMANDS.model(ctx, { argText: "summary google/gemini-3.5-flash" });
    assert.equal(ctx.chatData.config.summary_model, "google/gemini-3.5-flash");
    assert.match(out, /установлен/i);
  });
});


describe("COMMANDS.summary", () => {
  const hist3 = () => [
    { role: "user", content: "обсуждаем котов" },
    { role: "assistant", content: "коты топ" },
    { role: "user", content: "и собак" },
  ];

  // Сводка теперь читает НОВЫЕ сообщения из D1 (messagesSince по границе), а не из окна в памяти,
  // поэтому чат сидируем в D1 (seedChat → строки messages с id 1..N).
  test("меньше 3 сообщений (первая сводка) → отказ, без LLM", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: [{ role: "user", content: "привет" }, { role: "assistant", content: "ну" }] });
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, { ...DEFAULT_CHAT_DATA() });
    assert.match(await COMMANDS.summary(ctx, { argText: "" }), /меньше 3/);
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });

  test("генерация сводки → _summary записан, граница _cmdUptoId двинулась к max id", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: hist3() }); // строки с id 1,2,3
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse(["сводка чата"]));
    assert.equal(await COMMANDS.summary(ctx, { argText: "" }), "сводка чата");
    assert.equal(ctx.chatData._summary, "сводка чата");
    assert.equal(ctx.chatData._cmdUptoId, 3);
    assert.ok(ctx.chatData._dirty);
    assert.match(FETCH.chatBody().messages[0].content, /сводк/i); // системный промпт про сводку
  });

  test("нового с прошлой границы нет → отдаём кэш без LLM (хард-граница = ежедневная)", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: hist3() }); // id 1..3
    const cd = { ...DEFAULT_CHAT_DATA(), _summary: "старая сводка", _dailyUptoId: 3 };
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, cd);
    assert.equal(await COMMANDS.summary(ctx, { argText: "" }), "старая сводка");
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });

  test("новые сообщения после границы → LLM по ДЕЛЬТЕ (старое не уходит)", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: [...hist3(), { role: "user", content: "НОВОЕ_СООБ" }] }); // id 1..4
    const cd = { ...DEFAULT_CHAT_DATA(), _summary: "старая", _dailyUptoId: 3 }; // граница на id 3
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, cd);
    FETCH.set("chat", () => sse(["новая сводка"]));
    assert.equal(await COMMANDS.summary(ctx, { argText: "" }), "новая сводка");
    assert.equal(FETCH.of("/chat/completions").length, 1);
    assert.equal(ctx.chatData._cmdUptoId, 4);
    const joined = FETCH.chatBody().messages.map(m => JSON.stringify(m.content)).join(" ");
    assert.ok(joined.includes("НОВОЕ_СООБ"));       // новый срез (id>3) ушёл
    assert.ok(!joined.includes("обсуждаем котов"));  // старое (id<=3) НЕ ушло
  });

  test("фолбэк LLM не кэшируется, граница не двигается", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: hist3() });
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse([], { ok: false, status: 500 }));
    assert.equal(await COMMANDS.summary(ctx, { argText: "" }), FALLBACK_LLM_ERROR);
    assert.equal(ctx.chatData._summary, "");
    assert.equal(ctx.chatData._cmdUptoId, 0);
  });

  test("summary ∈ LLM_COMMANDS и TECH_COMMANDS", () => {
    assert.ok(LLM_COMMANDS.has("summary"));
    assert.ok(TECH_COMMANDS.has("summary"));
  });

  test("/memory forget чистит сводку и ВСЕ границы", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), _summary: "s", _dailyUptoId: 10, _cmdUptoId: 8, _cmdDay: "2026-06-20" };
    const ctx = makeCtxFor(makeMsg(), makeEnv(), cd);
    await COMMANDS.memory(ctx, { argText: "forget" });
    assert.equal(ctx.chatData._summary, "");
    assert.equal(ctx.chatData._dailyUptoId, 0);
    assert.equal(ctx.chatData._cmdUptoId, 0);
    assert.equal(ctx.chatData._cmdDay, "");
  });

  test("summary использует summary_model (modelOverride), если задана", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: hist3() });
    const cd = { ...DEFAULT_CHAT_DATA(), config: { summary_model: "google/gemini-3.5-flash" } };
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, cd);
    FETCH.set("chat", () => sse(["сводка"]));
    await COMMANDS.summary(ctx, { argText: "" });
    assert.equal(FETCH.chatBody().model, "google/gemini-3.5-flash");
  });

  test("/summary тоже курирует факты перед сводкой (rag вкл)", async () => {
    const env = makeEnv({ ENABLE_RAG: "true" });
    await seedChat(env, 560, { history: [
      { role: "user", content: "меня зовут Лиза" },
      { role: "assistant", content: "ок" },
      { role: "user", content: "я люблю сыр" },
    ] });
    const ctx = makeCtxFor(makeMsg({ chatId: 560, text: "/summary" }), env, { ...DEFAULT_CHAT_DATA() });
    let n = 0; // 1-й chat-вызов — извлечение фактов (перед сводкой), 2-й — сама сводка
    FETCH.set("chat", () => (++n === 1 ? sse(["Лиза любит сыр"]) : sse(["сводка"])));
    await COMMANDS.summary(ctx, { argText: "" });
    const rows = await dbMemories(env, 560);
    assert.ok(rows.length >= 1);
    assert.ok(rows.some(r => r.source === "auto"));
  });

  test("/summary без rag НЕ курирует (один LLM-вызов — только сводка)", async () => {
    const env = makeEnv(); // rag off
    await seedChat(env, 561, { history: hist3() });
    const ctx = makeCtxFor(makeMsg({ chatId: 561, text: "/summary" }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse(["сводка"]));
    await COMMANDS.summary(ctx, { argText: "" });
    assert.equal((await dbMemories(env, 561)).length, 0);
    assert.equal(FETCH.of("/chat/completions").length, 1); // только сводка, без извлечения
  });

  test("summary без summary_model → основная модель", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: hist3() });
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, { ...DEFAULT_CHAT_DATA() }); // OPENROUTER_MODEL=test/model
    FETCH.set("chat", () => sse(["сводка"]));
    await COMMANDS.summary(ctx, { argText: "" });
    assert.equal(FETCH.chatBody().model, "test/model");
  });

  // Суточный сброс командной границы. «Сегодня» (в TZ из cfg.timezone, по умолчанию UTC) берём из msg.date:
  // 2026-07-15 05:00 UTC → день "2026-07-15" (тест-env без BOT_TZ → UTC).
  const m5 = () => [
    { role: "user", content: "m1" }, { role: "assistant", content: "m2" }, { role: "user", content: "m3" },
    { role: "assistant", content: "m4" }, { role: "user", content: "m5" },
  ]; // id 1..5
  const DAY_SEC = Math.floor(Date.UTC(2026, 6, 15, 5, 0) / 1000);

  test("та же дата (TZ бота) → копим от cmd-границы, без сброса", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: m5() });
    const cd = { ...DEFAULT_CHAT_DATA(), _summary: "было", _cmdDay: "2026-07-15", _cmdUptoId: 4, _dailyUptoId: 2 };
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary", date: DAY_SEC }), env, cd);
    FETCH.set("chat", () => sse(["свежее"]));
    await COMMANDS.summary(ctx, { argText: "" });
    assert.equal(ctx.chatData._cmdUptoId, 5); // since=max(4,2)=4 → ушёл только id 5
    const joined = FETCH.chatBody().messages.map(m => JSON.stringify(m.content)).join(" ");
    assert.ok(joined.includes("m5"));
    assert.ok(!joined.includes("m3")); // без сброса к daily-границе (иначе ушли бы m3,m4)
  });

  test("новый день (TZ бота) → сброс cmd-границы, since падает к daily-границе (хард-флор)", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: m5() });
    const cd = { ...DEFAULT_CHAT_DATA(), _summary: "было", _cmdDay: "2026-07-14", _cmdUptoId: 4, _dailyUptoId: 2 };
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary", date: DAY_SEC }), env, cd);
    FETCH.set("chat", () => sse(["свежее"]));
    await COMMANDS.summary(ctx, { argText: "" });
    assert.equal(ctx.chatData._cmdDay, "2026-07-15");
    assert.equal(ctx.chatData._cmdUptoId, 5);
    const joined = FETCH.chatBody().messages.map(m => JSON.stringify(m.content)).join(" ");
    assert.ok(joined.includes("m3")); // since=max(0,2)=2 → ушли m3,m4,m5
    assert.ok(joined.includes("m5"));
    assert.ok(!joined.includes("m1")); // но не глубже daily-границы (id<=2)
  });
});


describe("аудит: memory и model ветки", () => {
  test("memory алиасы forget (стереть/clear) и dedupe (повторы)", async () => {
    for (const alias of ["стереть", "clear"]) {
      const cd = { ...DEFAULT_CHAT_DATA(), history: [{ content: "x" }], role: "r" };
      const ctx = makeCtxFor(makeMsg(), makeEnv(), cd);
      await COMMANDS.memory(ctx, { argText: alias });
      assert.deepEqual(ctx.chatData.history, []);
    }
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), history: [
      { role: "user", content: "a", meta: { message_id: 1 } },
      { role: "user", content: "a", meta: { message_id: 2 } },
    ] };
    await seedChat(env, 555, cd);
    const ctx = makeCtxFor(makeMsg(), env, cd);
    assert.match(await COMMANDS.memory(ctx, { argText: "повторы" }), /Убрано повторов/);
  });
  test("memory dedupe без повторов → сообщение 'нет', не dirty", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), history: [{ content: "a" }, { content: "b" }] };
    const ctx = makeCtxFor(makeMsg(), makeEnv(), cd);
    const out = await COMMANDS.memory(ctx, { argText: "dedupe" });
    assert.match(out, /повторов в истории нет/);
    assert.ok(!ctx.chatData._dirty);
  });
  test("memory size_chars без значения → показ текущего", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.memory(ctx, { argText: "size_chars" }), /8000/);
  });
  test("model vision: показ когда не задана / задана / reset", async () => {
    const ctx1 = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.model(ctx1, { argText: "vision" }), /не задана/);

    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision_model: "v/m" } };
    const ctx2 = makeCtxFor(makeMsg(), makeEnv(), cd);
    assert.ok((await COMMANDS.model(ctx2, { argText: "vision" })).includes("v/m"));

    const ctx3 = makeCtxFor(makeMsg(), makeEnv(), { ...DEFAULT_CHAT_DATA(), config: { vision_model: "v/m" } });
    await COMMANDS.model(ctx3, { argText: "vision reset" });
    assert.equal(ctx3.chatData.config.vision_model, "");
  });
  test("model без аргумента: блок vision-модели и строка расхода", async () => {
    const env = makeEnv({ OPENROUTER_VISION_MODEL: "v/env" });
    const cd = { ...DEFAULT_CHAT_DATA(), spend: 0.0052, spendCount: 3 };
    const ctx = makeCtxFor(makeMsg(), env, cd);
    const out = await COMMANDS.model(ctx, { argText: "" });
    assert.ok(out.includes("v/env"));
    assert.ok(out.includes("0.0052"));
    assert.ok(out.includes("3 запр"));
  });
});


