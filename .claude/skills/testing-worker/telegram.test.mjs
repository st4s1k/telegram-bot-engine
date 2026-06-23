import * as H from "./harness.mjs";
const {
  test, describe, assert, WORKER,
  // worker.js — функции и константы
  toMarkdownV2, sendTelegramMessage, sendAndStore, isFallbackMessage, reportError,
  dedupeHistory, collapseConsecutiveDuplicates, trimHistoryByChars, historyChars,
  appendHistory, updateHistoryMessage,
  getGlobalConfig, mergeConfig, parseConfigValue, setConfigParam, buildConfigHelp,
  buildHelp, buildInfoStatus, CONFIG_SCHEMA, CONFIG_GROUPS,
  parseCommandAndArg, isCommand, stripBotMentions, parseRoots, escapeRegExp, lastToken,
  pickOne, newReqId, messageMentionsBot, resolveUserName, pickTargetName, pickRandomUserText,
  getReplyText, getUserName, chatTitleFromMsg, getUserMeta, buildUserItem, buildAssistantItem,
  buildCommandRegex,
  makeCtx, visualFromMsg, visualLabel, visualNote, photoCacheKey, pickVisionDetail, albumContext,
  assemblePrompt, buildDefaultPrompt, buildReplyPrompt, buildVisionPrompt, buildPhotoFromCachePrompt,
  PHOTO_DELIM,
  DEFAULT_CHAT_DATA, getChatData, flushChatData, updatePersonaState, setRole, setPaused, saveChatConfig,
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
} = H;


/* ====================================================================== */
/* =====================  TELEGRAM I/O  =============================== */
/* ====================================================================== */

describe("sendTelegramMessage", () => {
  test("нормализация ** → * и ## → жирный; успешная отправка MarkdownV2", async () => {
    const data = await sendTelegramMessage("123:T", 1, "**жир** и\n## Заголовок", 50);
    assert.ok(data?.ok);
    const body = FETCH.sends()[0].body;
    assert.equal(body.parse_mode, "MarkdownV2");
    assert.equal(body.reply_to_message_id, 50);
    assert.ok(body.text.includes("*жир*"));
  });

  test("пустой текст после нормализации → null, без запроса", async () => {
    const data = await sendTelegramMessage("123:T", 1, "   ", undefined);
    assert.equal(data, null);
    assert.equal(FETCH.sends().length, 0);
  });

  test("ошибка MarkdownV2 → фолбэк на plain без parse_mode", async () => {
    let n = 0;
    FETCH.set("send", () => (++n === 1)
      ? jsonResp({ ok: false, description: "can't parse entities" })
      : jsonResp({ ok: true, result: { message_id: 1 } }));
    await sendTelegramMessage("123:T", 1, "текст с [битой] разметкой", undefined);
    const sends = FETCH.sends();
    assert.equal(sends.length, 2);
    assert.equal(sends[0].body.parse_mode, "MarkdownV2");
    assert.equal(sends[1].body.parse_mode, undefined); // plain
  });
});


describe("sendAndStore", () => {
  test("чистит [from:...], схлопывает переносы, сохраняет ответ ассистента", async () => {
    const ctx = makeCtxFor(makeMsg({ message_id: 200 }), makeEnv());
    await sendAndStore(ctx, "[from:Bot] привет\n\n\n\nкак дела");
    const sent = FETCH.sends()[0].body.text;
    assert.ok(!sent.includes("[from:"));
    const last = ctx.chatData.history.at(-1);
    assert.equal(last.role, "assistant");
    assert.ok(!last.content.includes("[from:"));
    assert.ok(!/\n{3,}/.test(last.content));
  });

  test("пустой после чистки → null", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.equal(await sendAndStore(ctx, "[from:X] "), null);
  });

  test("длинный текст бьётся на части ≤ лимита; reply_to только у первой", async () => {
    const ctx = makeCtxFor(makeMsg({ message_id: 300 }), makeEnv());
    await sendAndStore(ctx, "a".repeat(TELEGRAM_MSG_LIMIT + 500));
    const sends = FETCH.sends();
    assert.equal(sends.length, 2);
    assert.equal(sends[0].body.reply_to_message_id, 300);
    assert.equal(sends[1].body.reply_to_message_id, undefined);
  });

  test("разбиение не рвёт суррогатную пару (эмодзи на границе → нет U+FFFD)", async () => {
    const ctx = makeCtxFor(makeMsg({ message_id: 301 }), makeEnv());
    const text = "a".repeat(TELEGRAM_MSG_LIMIT - 1) + "😀"; // эмодзи (2 код-юнита) ровно на стыке
    await sendAndStore(ctx, text);
    const sends = FETCH.sends();
    assert.equal(sends.length, 2);
    assert.ok(!sends.some(s => s.body.text.includes("�"))); // ни одной «битой» половинки суррогата
    assert.equal(sends.map(s => s.body.text).join(""), text);    // склейка частей = исходный текст
  });

  test("skipHistory не пишет в историю", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    await sendAndStore(ctx, "технический ответ", { skipHistory: true });
    assert.equal(ctx.chatData.history.length, 0);
  });

  test("фолбэк-сообщения не сохраняются в историю", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    await sendAndStore(ctx, FALLBACK_LLM_ERROR);
    assert.equal(ctx.chatData.history.length, 0);
  });
});

describe("reportError", () => {
  test("critical + ADMIN_CHAT_IDS → алерт в Telegram + троттл в KV", async () => {
    const env = makeEnv({ ADMIN_CHAT_IDS: "999" });
    await reportError(env, "flushChatData", new Error("d1 down"), { critical: true });
    const sends = FETCH.sends();
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body.chat_id, 999);
    assert.ok(sends[0].body.text.includes("flushChatData"));
    assert.ok(await env._kv.get("errnotify:flushChatData")); // троттл выставлен
  });

  test("CSV-список: алерт всем chat_id (вкл. группу с отрицательным id)", async () => {
    const env = makeEnv({ ADMIN_CHAT_IDS: "111, -100222" });
    await reportError(env, "scheduled", new Error("boom"), { critical: true });
    const ids = FETCH.sends().map(s => s.body.chat_id).sort((a, b) => a - b);
    assert.deepEqual(ids, [-100222, 111]);
  });

  test("повторный critical в окне троттла → без второго алерта", async () => {
    const env = makeEnv({ ADMIN_CHAT_IDS: "999" });
    await reportError(env, "flushChatData", new Error("x"), { critical: true });
    await reportError(env, "flushChatData", new Error("y"), { critical: true });
    assert.equal(FETCH.sends().length, 1);
  });

  test("critical без ADMIN_CHAT_IDS → только лог, без алерта", async () => {
    const env = makeEnv();
    await reportError(env, "scheduled", new Error("boom"), { critical: true });
    assert.equal(FETCH.sends().length, 0);
    assert.ok(CONSOLE.error.some(s => s.includes("scheduled")));
  });

  test("не-critical → только лог, без алерта даже с ADMIN_CHAT_IDS", async () => {
    const env = makeEnv({ ADMIN_CHAT_IDS: "999" });
    await reportError(env, "runDailySummaries[chat]", new Error("nope"));
    assert.equal(FETCH.sends().length, 0);
  });
});


