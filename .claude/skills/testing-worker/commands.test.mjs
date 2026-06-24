import * as H from "./harness.mjs";
const {
  test, describe, assert, WORKER,
  // worker.js — functions and constants
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
  // harness
  makeEnv, makeMsg, makeKV, makeCtxFor, photoSizes, sse, jsonResp, streamResp,
  stubRandom, restoreRandom, CONSOLE, clearConsole, FETCH, newFetch,
  seedChat, dbChat, dbHistory, dbMemories,
} = H;


/* ====================================================================== */
/* =====================  INDIVIDUAL COMMANDS  ========================== */
/* ====================================================================== */

describe("COMMANDS.rp / stop / resume / info", () => {
  test("rp sets/resets/shows the role", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.rp(ctx, { argText: "ты грубый зек" }), /принята/i);
    assert.equal(ctx.chatData.role, "ты грубый зек");
    assert.match(await COMMANDS.rp(ctx, { argText: "" }), /ты грубый зек/);
    assert.match(await COMMANDS.rp(ctx, { argText: "off" }), /сброшена/i);
    assert.equal(ctx.chatData.role, null);
  });
  test("stop/resume toggle the pause", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    await COMMANDS.stop(ctx, { argText: "" });
    assert.equal(ctx.chatData.paused, true);
    await COMMANDS.resume(ctx, { argText: "" });
    assert.equal(ctx.chatData.paused, false);
  });
  test("info → status", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.info(ctx, { argText: "" }), /🎭/); // info panel role line — locale-neutral marker
  });
  test("lang shows + switches the UI language; rejects an unknown one", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const status = await COMMANDS.lang(ctx, { argText: "" });
    assert.match(status, /en/); assert.match(status, /ru/);     // available locales, discovered from the folder
    await COMMANDS.lang(ctx, { argText: "en" });
    assert.equal(ctx.chatData.config.lang, "en");               // switched
    assert.match(await COMMANDS.lang(ctx, { argText: "zz" }), /Неизвестн|Unknown/); // not a discovered locale
  });
});


describe("COMMANDS.memory", () => {
  test("default status", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.memory(ctx, { argText: "" }), /Память чата/);
  });
  test("forget wipes history/cache/role/mood/spend, settings remain", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), history: [{ content: "x" }], photoCache: { k: "d" }, role: "зек", personaState: { arousal: 4 }, spend: 1, spendCount: 5, config: { random: false } };
    const ctx = makeCtxFor(makeMsg(), makeEnv(), cd);
    await COMMANDS.memory(ctx, { argText: "forget all" });
    assert.deepEqual(ctx.chatData.history, []);
    assert.deepEqual(ctx.chatData.photoCache, {});
    assert.equal(ctx.chatData.role, null);
    assert.deepEqual(ctx.chatData.personaState, getPersonaStateDefaults());
    assert.equal(ctx.chatData.spend, 0);
    assert.deepEqual(ctx.chatData.config, { random: false }); // settings intact
  });
  test("forget targets: bare → usage (no wipe); per-target wipes only its slice", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), history: [{ content: "x" }], role: "зек" };
    const ctx = makeCtxFor(makeMsg(), makeEnv(), cd);
    const help = await COMMANDS.memory(ctx, { argText: "forget" });   // bare → usage, nothing wiped
    assert.match(help, /forget all/);
    assert.equal(ctx.chatData.history.length, 1);
    assert.equal(ctx.chatData.role, "зек");
    await COMMANDS.memory(ctx, { argText: "forget history" });        // history only
    assert.deepEqual(ctx.chatData.history, []);
    assert.equal(ctx.chatData.role, "зек");                           // role kept
    await COMMANDS.memory(ctx, { argText: "forget role" });           // role only
    assert.equal(ctx.chatData.role, null);
  });
  test("dedupe removes consecutive duplicates", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), history: [
      { role: "user", content: "a", meta: { message_id: 1 } },
      { role: "user", content: "a", meta: { message_id: 2 } },
      { role: "user", content: "b", meta: { message_id: 3 } },
    ] };
    await seedChat(env, 555, cd); // default chatId from makeMsg
    const ctx = makeCtxFor(makeMsg(), env, cd);
    const out = await COMMANDS.memory(ctx, { argText: "dedupe" });
    assert.match(out, /Убрано повторов: 1/);
    assert.equal(ctx.chatData.history.length, 2);
  });
  test("size_chars sets the memory size", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    await COMMANDS.memory(ctx, { argText: "size_chars 9000" });
    assert.equal(ctx.chatData.config.history_chars, 9000);
  });
});


describe("COMMANDS.config", () => {
  test("no argument → help", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.config(ctx, { argText: "" }), /Управление настройками/);
  });
  test("reset clears everything", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), config: { random: false } };
    const ctx = makeCtxFor(makeMsg(), makeEnv(), cd);
    await COMMANDS.config(ctx, { argText: "reset" });
    assert.deepEqual(ctx.chatData.config, {});
  });
  test("unknown key → error", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.config(ctx, { argText: "nope 1" }), /не найден/i);
  });
});


describe("COMMANDS.model", () => {
  test("no argument → shows model, price, balance", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = await COMMANDS.model(ctx, { argText: "" });
    assert.ok(out.includes("Текст"));
    assert.ok(out.includes("💳"));
  });
  test("changing the main model", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = await COMMANDS.model(ctx, { argText: "vendor/new" });
    assert.equal(ctx.chatData.config.model, "vendor/new");
    assert.ok(out.includes("vendor/new"));
  });
  test("vision subcommand sets a separate model for photos", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    await COMMANDS.model(ctx, { argText: "vision vis/model" });
    assert.equal(ctx.chatData.config.vision_model, "vis/model");
  });
  test("summary subcommand sets a separate model for /summary", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = await COMMANDS.model(ctx, { argText: "summary google/gemini-3.5-flash" });
    assert.equal(ctx.chatData.config.summary_model, "google/gemini-3.5-flash");
    assert.match(out, /установлен/i);
  });
  test("/model reset clears ALL models (main + vision + summary), keeps other settings", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), config: { model: "a/b", vision_model: "v/m", summary_model: "s/m", random: false } };
    const ctx = makeCtxFor(makeMsg(), makeEnv(), cd);
    await COMMANDS.model(ctx, { argText: "reset" });
    assert.equal(ctx.chatData.config.model, undefined);
    assert.equal(ctx.chatData.config.vision_model, undefined);
    assert.equal(ctx.chatData.config.summary_model, undefined);
    assert.equal(ctx.chatData.config.random, false); // other settings kept
  });
});


describe("COMMANDS.summary", () => {
  const hist3 = () => [
    { role: "user", content: "обсуждаем котов" },
    { role: "assistant", content: "коты топ" },
    { role: "user", content: "и собак" },
  ];

  // The summary now reads NEW messages from D1 (messagesSince past the boundary) rather than from the in-memory window,
  // so we seed the chat into D1 (seedChat → messages rows with id 1..N).
  test("fewer than 3 messages (first summary) → refusal, no LLM", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: [{ role: "user", content: "привет" }, { role: "assistant", content: "ну" }] });
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, { ...DEFAULT_CHAT_DATA() });
    assert.match(await COMMANDS.summary(ctx, { argText: "" }), /меньше 3/);
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });

  test("summary generation → _summary written, _cmdUptoId boundary moved to max id", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: hist3() }); // rows with id 1,2,3
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse(["сводка чата"]));
    assert.equal(await COMMANDS.summary(ctx, { argText: "" }), "сводка чата");
    assert.equal(ctx.chatData._summary, "сводка чата");
    assert.equal(ctx.chatData._cmdUptoId, 3);
    assert.ok(ctx.chatData._dirty);
    assert.match(FETCH.chatBody().messages[0].content, /сводк/i); // system prompt about the summary
  });

  test("nothing new since the last boundary → return cache without LLM (hard boundary = daily)", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: hist3() }); // id 1..3
    const cd = { ...DEFAULT_CHAT_DATA(), _summary: "старая сводка", _dailyUptoId: 3 };
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, cd);
    assert.equal(await COMMANDS.summary(ctx, { argText: "" }), "старая сводка");
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });

  test("new messages after the boundary → LLM over the DELTA (old stays out)", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: [...hist3(), { role: "user", content: "НОВОЕ_СООБ" }] }); // id 1..4
    const cd = { ...DEFAULT_CHAT_DATA(), _summary: "старая", _dailyUptoId: 3 }; // boundary at id 3
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, cd);
    FETCH.set("chat", () => sse(["новая сводка"]));
    assert.equal(await COMMANDS.summary(ctx, { argText: "" }), "новая сводка");
    assert.equal(FETCH.of("/chat/completions").length, 1);
    assert.equal(ctx.chatData._cmdUptoId, 4);
    const joined = FETCH.chatBody().messages.map(m => JSON.stringify(m.content)).join(" ");
    assert.ok(joined.includes("НОВОЕ_СООБ"));       // the new slice (id>3) was sent
    assert.ok(!joined.includes("обсуждаем котов"));  // the old part (id<=3) was NOT sent
  });

  test("LLM fallback is not cached, the boundary does not move", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: hist3() });
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse([], { ok: false, status: 500 }));
    assert.equal(await COMMANDS.summary(ctx, { argText: "" }), FALLBACK_LLM_ERROR);
    assert.equal(ctx.chatData._summary, "");
    assert.equal(ctx.chatData._cmdUptoId, 0);
  });

  test("summary ∈ LLM_COMMANDS and TECH_COMMANDS", () => {
    assert.ok(LLM_COMMANDS.has("summary"));
    assert.ok(TECH_COMMANDS.has("summary"));
  });

  test("/memory forget clears the summary and ALL boundaries", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), _summary: "s", _dailyUptoId: 10, _cmdUptoId: 8, _cmdDay: "2026-06-20" };
    const ctx = makeCtxFor(makeMsg(), makeEnv(), cd);
    await COMMANDS.memory(ctx, { argText: "forget all" });
    assert.equal(ctx.chatData._summary, "");
    assert.equal(ctx.chatData._dailyUptoId, 0);
    assert.equal(ctx.chatData._cmdUptoId, 0);
    assert.equal(ctx.chatData._cmdDay, "");
  });

  test("summary uses summary_model (modelOverride) when set", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: hist3() });
    const cd = { ...DEFAULT_CHAT_DATA(), config: { summary_model: "google/gemini-3.5-flash" } };
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, cd);
    FETCH.set("chat", () => sse(["сводка"]));
    await COMMANDS.summary(ctx, { argText: "" });
    assert.equal(FETCH.chatBody().model, "google/gemini-3.5-flash");
  });

  test("/summary also curates facts before the summary (rag on)", async () => {
    const env = makeEnv({ ENABLE_RAG: "true" });
    await seedChat(env, 560, { history: [
      { role: "user", content: "меня зовут Лиза" },
      { role: "assistant", content: "ок" },
      { role: "user", content: "я люблю сыр" },
    ] });
    const ctx = makeCtxFor(makeMsg({ chatId: 560, text: "/summary" }), env, { ...DEFAULT_CHAT_DATA() });
    let n = 0; // 1st chat call — fact extraction (before the summary), 2nd — the summary itself
    FETCH.set("chat", () => (++n === 1 ? sse(["Лиза любит сыр"]) : sse(["сводка"])));
    await COMMANDS.summary(ctx, { argText: "" });
    const rows = await dbMemories(env, 560);
    assert.ok(rows.length >= 1);
    assert.ok(rows.some(r => r.source === "auto"));
  });

  test("/summary without rag does NOT curate (one LLM call — summary only)", async () => {
    const env = makeEnv(); // rag off
    await seedChat(env, 561, { history: hist3() });
    const ctx = makeCtxFor(makeMsg({ chatId: 561, text: "/summary" }), env, { ...DEFAULT_CHAT_DATA() });
    FETCH.set("chat", () => sse(["сводка"]));
    await COMMANDS.summary(ctx, { argText: "" });
    assert.equal((await dbMemories(env, 561)).length, 0);
    assert.equal(FETCH.of("/chat/completions").length, 1); // summary only, no extraction
  });

  test("summary without summary_model → main model", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: hist3() });
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary" }), env, { ...DEFAULT_CHAT_DATA() }); // OPENROUTER_MODEL=test/model
    FETCH.set("chat", () => sse(["сводка"]));
    await COMMANDS.summary(ctx, { argText: "" });
    assert.equal(FETCH.chatBody().model, "test/model");
  });

  // Daily reset of the command boundary. "Today" (in the TZ from cfg.timezone, default UTC) is taken from msg.date:
  // 2026-07-15 05:00 UTC → day "2026-07-15" (test env without BOT_TZ → UTC).
  const m5 = () => [
    { role: "user", content: "m1" }, { role: "assistant", content: "m2" }, { role: "user", content: "m3" },
    { role: "assistant", content: "m4" }, { role: "user", content: "m5" },
  ]; // id 1..5
  const DAY_SEC = Math.floor(Date.UTC(2026, 6, 15, 5, 0) / 1000);

  test("same date (bot TZ) → accumulate from the cmd boundary, no reset", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: m5() });
    const cd = { ...DEFAULT_CHAT_DATA(), _summary: "было", _cmdDay: "2026-07-15", _cmdUptoId: 4, _dailyUptoId: 2 };
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary", date: DAY_SEC }), env, cd);
    FETCH.set("chat", () => sse(["свежее"]));
    await COMMANDS.summary(ctx, { argText: "" });
    assert.equal(ctx.chatData._cmdUptoId, 5); // since=max(4,2)=4 → only id 5 was sent
    const joined = FETCH.chatBody().messages.map(m => JSON.stringify(m.content)).join(" ");
    assert.ok(joined.includes("m5"));
    assert.ok(!joined.includes("m3")); // no reset to the daily boundary (otherwise m3,m4 would be sent)
  });

  test("new day (bot TZ) → reset cmd boundary, since drops to the daily boundary (hard floor)", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: m5() });
    const cd = { ...DEFAULT_CHAT_DATA(), _summary: "было", _cmdDay: "2026-07-14", _cmdUptoId: 4, _dailyUptoId: 2 };
    const ctx = makeCtxFor(makeMsg({ chatId: 555, text: "/summary", date: DAY_SEC }), env, cd);
    FETCH.set("chat", () => sse(["свежее"]));
    await COMMANDS.summary(ctx, { argText: "" });
    assert.equal(ctx.chatData._cmdDay, "2026-07-15");
    assert.equal(ctx.chatData._cmdUptoId, 5);
    const joined = FETCH.chatBody().messages.map(m => JSON.stringify(m.content)).join(" ");
    assert.ok(joined.includes("m3")); // since=max(0,2)=2 → m3,m4,m5 were sent
    assert.ok(joined.includes("m5"));
    assert.ok(!joined.includes("m1")); // but no deeper than the daily boundary (id<=2)
  });
});


describe("audit: memory and model branches", () => {
  test("memory aliases forget (стереть/clear) and dedupe (повторы)", async () => {
    for (const alias of ["стереть", "clear"]) {
      const cd = { ...DEFAULT_CHAT_DATA(), history: [{ content: "x" }], role: "r" };
      const ctx = makeCtxFor(makeMsg(), makeEnv(), cd);
      await COMMANDS.memory(ctx, { argText: alias + " all" });
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
  test("memory dedupe with no duplicates → 'none' message, not dirty", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), history: [{ content: "a" }, { content: "b" }] };
    const ctx = makeCtxFor(makeMsg(), makeEnv(), cd);
    const out = await COMMANDS.memory(ctx, { argText: "dedupe" });
    assert.match(out, /повторов в истории нет/);
    assert.ok(!ctx.chatData._dirty);
  });
  test("memory size_chars without a value → show current", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.memory(ctx, { argText: "size_chars" }), /8000/);
  });
  test("model vision: show when unset / set / reset", async () => {
    const ctx1 = makeCtxFor(makeMsg(), makeEnv());
    assert.match(await COMMANDS.model(ctx1, { argText: "vision" }), /не задана/);

    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision_model: "v/m" } };
    const ctx2 = makeCtxFor(makeMsg(), makeEnv(), cd);
    assert.ok((await COMMANDS.model(ctx2, { argText: "vision" })).includes("v/m"));

    const ctx3 = makeCtxFor(makeMsg(), makeEnv(), { ...DEFAULT_CHAT_DATA(), config: { vision_model: "v/m" } });
    await COMMANDS.model(ctx3, { argText: "vision reset" });
    assert.equal(ctx3.chatData.config.vision_model, "");
  });
  test("model without an argument: vision-model block and spend line", async () => {
    const env = makeEnv({ OPENROUTER_VISION_MODEL: "v/env" });
    const cd = { ...DEFAULT_CHAT_DATA(), spend: 0.0052, spendCount: 3 };
    const ctx = makeCtxFor(makeMsg(), env, cd);
    const out = await COMMANDS.model(ctx, { argText: "" });
    assert.ok(out.includes("v/env"));
    assert.ok(out.includes("0.0052"));
    assert.ok(out.includes("3 запр"));
  });
});


