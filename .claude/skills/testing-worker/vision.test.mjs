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
  buildReplyPrompt, buildVisionPrompt, buildPhotoFromCachePrompt,
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
/* =====================  VISION / ФОТО  ============================== */
/* ====================================================================== */

describe("getTelegramPhotoUrl", () => {
  test("high → крупнейший размер; возвращает прямой file-URL", async () => {
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K") }), makeEnv());
    const url = await getTelegramPhotoUrl(ctx, "high");
    assert.ok(FETCH.of("/getFile")[0].url.includes("file_id=f_big"));
    assert.ok(url.includes("/file/bot"));
    assert.ok(url.includes("photos/f.jpg"));
  });

  test("low → средний размер", async () => {
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K") }), makeEnv());
    await getTelegramPhotoUrl(ctx, "low");
    assert.ok(FETCH.of("/getFile")[0].url.includes("file_id=f_mid"));
  });

  test("getFile без file_path → null", async () => {
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K") }), makeEnv());
    FETCH.set("getFile", () => jsonResp({ ok: true, result: {} }));
    assert.equal(await getTelegramPhotoUrl(ctx, "low"), null);
  });

  test("нет фото → null без запроса", async () => {
    const ctx = makeCtxFor(makeMsg({ text: "x" }), makeEnv());
    assert.equal(await getTelegramPhotoUrl(ctx, "low"), null);
    assert.equal(FETCH.of("/getFile").length, 0);
  });
});


describe("runVision", () => {
  test("шлёт image_url + detail, использует vision-модель если задана", async () => {
    const env = makeEnv({ OPENROUTER_VISION_MODEL: "vis/model" });
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K") }), env);
    FETCH.set("chat", () => sse(["опис ||| реакция"]));
    const out = await runVision(ctx, "http://img/x.jpg", "подпись", "high");
    assert.equal(out, "опис ||| реакция");
    const body = FETCH.chatBody();
    assert.equal(body.model, "vis/model");
    const userContent = body.messages[1].content;
    const img = userContent.find(p => p.type === "image_url");
    assert.equal(img.image_url.url, "http://img/x.jpg");
    assert.equal(img.image_url.detail, "high");
  });
});


describe("describeCtxPhoto", () => {
  test("кэш-хит → описание без сети", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), photoCache: { K: "кот" } };
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K") }), env, cd);
    const desc = await describeCtxPhoto(ctx);
    assert.equal(desc, "кот");
    assert.equal(FETCH.of("/getFile").length, 0);
  });

  test("зрение выкл и нет кэша → null", async () => {
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K") }), makeEnv()); // vision off по умолчанию
    assert.equal(await describeCtxPhoto(ctx), null);
  });

  test("зрение вкл, нет кэша → vision-запрос, парсит описание до |||, кэширует", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true } };
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K") }), env, cd);
    FETCH.set("chat", () => sse(["рыжий кот ||| мяу"]));
    const desc = await describeCtxPhoto(ctx);
    assert.equal(desc, "рыжий кот");
    assert.equal(ctx.chatData.photoCache.K, "рыжий кот");
  });
});


describe("getReplySource", () => {
  test("текст реплая без фото", async () => {
    const m = makeMsg({ text: "опиши", reply_to_message: { text: "исходный текст" } });
    const ctx = makeCtxFor(m, makeEnv());
    assert.equal(await getReplySource(ctx), "исходный текст");
  });

  test("текст реплая + описание фото из кэша", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), photoCache: { RK: "пейзаж" } };
    const m = makeMsg({ text: "опиши", reply_to_message: { text: "глянь", photo: photoSizes("RK") } });
    const ctx = makeCtxFor(m, env, cd);
    const out = await getReplySource(ctx);
    assert.ok(out.includes("глянь"));
    assert.ok(out.includes("пейзаж"));
  });

  test("нет источника → null", async () => {
    const ctx = makeCtxFor(makeMsg({ text: "опиши" }), makeEnv());
    assert.equal(await getReplySource(ctx), null);
  });
});


describe("handlePhotoMessage", () => {
  test("зрение выкл → бесплатная пометка в историю, без сети", async () => {
    const env = makeEnv();
    const m = makeMsg({ photo: photoSizes("K"), caption: "смотри" });
    const ctx = makeCtxFor(m, env); // vision off
    await handlePhotoMessage(ctx);
    assert.equal(FETCH.of("/chat/completions").length, 0);
    assert.equal(FETCH.sends().length, 0);
    assert.ok(ctx.chatData.history.at(-1).content.includes("[фото"));
  });

  test("зрение вкл, личка → vision, парсит desc|||reply, кэширует, отвечает", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true } };
    const m = makeMsg({ chatType: "private", photo: photoSizes("K"), caption: "" });
    const ctx = makeCtxFor(m, env, cd);
    FETCH.set("chat", () => sse(["рыжий кот ||| мяу, красавчик"]));
    await handlePhotoMessage(ctx);
    assert.equal(ctx.chatData.photoCache.K, "рыжий кот");
    assert.equal(FETCH.sends()[0].body.text.includes("мяу"), true);
    assert.ok(ctx.chatData.history.some(h => h.content.includes("[фото: рыжий кот]")));
  });

  test("кэш описания → текстовый путь, без getFile", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true }, photoCache: { K: "кот" } };
    const m = makeMsg({ chatType: "private", photo: photoSizes("K"), caption: "" });
    const ctx = makeCtxFor(m, env, cd);
    FETCH.set("chat", () => sse(["ну кот и кот"]));
    await handlePhotoMessage(ctx);
    assert.equal(FETCH.of("/getFile").length, 0);
    assert.equal(FETCH.sends()[0].body.text.includes("кот"), true);
  });

  test("зрение вкл, группа без обращения → пометка, без ответа", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true, answer_prob: 0 } };
    const m = makeMsg({ chatType: "group", chatId: -100, photo: photoSizes("K"), caption: "просто фото" });
    const ctx = makeCtxFor(m, env, cd);
    stubRandom(0.99);
    await handlePhotoMessage(ctx);
    assert.equal(FETCH.sends().length, 0);
    assert.ok(ctx.chatData.history.at(-1).content.includes("[фото"));
  });
});


describe("аудит: photo/vision дополнительные ветки", () => {
  test("logIgnoredPhoto: свой визуал + кэш описания → пометка с описанием", () => {
    const cd = { ...DEFAULT_CHAT_DATA(), photoCache: { K: "кот" } };
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K"), caption: "гляди" }), makeEnv(), cd);
    logIgnoredPhoto(ctx, "гляди");
    assert.equal(ctx.chatData.history.at(-1).content, "[фото: кот] гляди");
  });

  test("photoFromReply + упоминание + первое зрение → ответ + пометка '[в ответ на фото: ...]'", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true } };
    const m = makeMsg({ chatType: "private", text: "@testbot что тут", reply_to_message: makeMsg({ photo: photoSizes("RK") }) });
    const ctx = makeCtxFor(m, env, cd);
    FETCH.set("chat", () => sse(["закат ||| красиво"]));
    await handlePhotoMessage(ctx);
    assert.equal(ctx.chatData.photoCache.RK, "закат");
    assert.ok(FETCH.sends()[0].body.text.includes("красиво"));
    assert.ok(ctx.chatData.history.some(h => h.content.includes("[в ответ на фото: закат]")));
  });

  test("photoFromReply + кэш → текстовый путь без getFile", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true }, photoCache: { RK: "закат" } };
    const m = makeMsg({ chatType: "private", text: "@testbot гля", reply_to_message: makeMsg({ photo: photoSizes("RK") }) });
    const ctx = makeCtxFor(m, env, cd);
    await handlePhotoMessage(ctx);
    assert.equal(FETCH.of("/getFile").length, 0);
    assert.ok(ctx.chatData.history.some(h => h.content.includes("[в ответ на фото: закат]")));
  });

  test("photoFromReply без упоминания → молчит, без пометки", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true } };
    const m = makeMsg({ chatType: "private", text: "просто текст", reply_to_message: makeMsg({ photo: photoSizes("RK") }) });
    const ctx = makeCtxFor(m, env, cd);
    const before = ctx.chatData.history.length;
    await handlePhotoMessage(ctx);
    assert.equal(FETCH.sends().length, 0);
    assert.equal(ctx.chatData.history.length, before); // logIgnoredPhoto для реплая — no-op
  });

  test("стикер без картинки (анимированный без thumbnail) → ответ по эмодзи, без getFile", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true } };
    const m = { chat: { id: 555, type: "private" }, from: { first_name: "A" }, message_id: 1, sticker: { is_animated: true, emoji: "😂", file_unique_id: "U" } };
    const ctx = makeCtxFor(m, env, cd);
    FETCH.set("chat", () => sse(["ха-ха стикер"]));
    await handlePhotoMessage(ctx);
    assert.equal(FETCH.of("/getFile").length, 0);
    assert.ok(FETCH.sends()[0].body.text.includes("стикер"));
  });

  test("vision-ответ без разделителя ||| → весь текст это ответ, описание не кэшируется", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true } };
    const m = makeMsg({ chatType: "private", photo: photoSizes("K"), caption: "" });
    const ctx = makeCtxFor(m, env, cd);
    FETCH.set("chat", () => sse(["просто ответ без разделителя"]));
    await handlePhotoMessage(ctx);
    assert.equal(ctx.chatData.photoCache.K, undefined); // desc пустой → не кэшируем
    assert.ok(FETCH.sends()[0].body.text.includes("просто ответ"));
  });

  test("getReplySource: реплай только с подписью (без text), описание из кэша", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), photoCache: { RK: "пейзаж" } };
    const m = makeMsg({ text: "опиши", reply_to_message: { caption: "вид", photo: photoSizes("RK") } });
    const ctx = makeCtxFor(m, env, cd);
    const out = await getReplySource(ctx);
    assert.ok(out.includes("пейзаж"));
    assert.ok(out.includes("вид"));
  });

  test("describeCtxPhoto: пустой массив photo → null", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true } };
    const ctx = makeCtxFor(makeMsg({ text: "x" }), makeEnv(), cd);
    ctx.photo = []; // принудительно пустой массив
    assert.equal(await describeCtxPhoto(ctx), null);
  });
});
