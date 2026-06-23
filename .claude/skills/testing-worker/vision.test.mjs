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
  // harness
  makeEnv, makeMsg, makeKV, makeCtxFor, photoSizes, sse, jsonResp, streamResp,
  stubRandom, restoreRandom, CONSOLE, clearConsole, FETCH, newFetch,
} = H;


/* ====================================================================== */
/* =====================  VISION / PHOTO  ============================== */
/* ====================================================================== */

describe("getTelegramPhotoUrl", () => {
  test("high → largest size; returns a direct file-URL", async () => {
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K") }), makeEnv());
    const url = await getTelegramPhotoUrl(ctx, "high");
    assert.ok(FETCH.of("/getFile")[0].url.includes("file_id=f_big"));
    assert.ok(url.includes("/file/bot"));
    assert.ok(url.includes("photos/f.jpg"));
  });

  test("low → medium size", async () => {
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K") }), makeEnv());
    await getTelegramPhotoUrl(ctx, "low");
    assert.ok(FETCH.of("/getFile")[0].url.includes("file_id=f_mid"));
  });

  test("getFile without file_path → null", async () => {
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K") }), makeEnv());
    FETCH.set("getFile", () => jsonResp({ ok: true, result: {} }));
    assert.equal(await getTelegramPhotoUrl(ctx, "low"), null);
  });

  test("no photo → null without a request", async () => {
    const ctx = makeCtxFor(makeMsg({ text: "x" }), makeEnv());
    assert.equal(await getTelegramPhotoUrl(ctx, "low"), null);
    assert.equal(FETCH.of("/getFile").length, 0);
  });
});


describe("runVision", () => {
  test("sends image_url + detail, uses the vision model if one is set", async () => {
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
  test("cache hit → description without network", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), photoCache: { K: "кот" } };
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K") }), env, cd);
    const desc = await describeCtxPhoto(ctx);
    assert.equal(desc, "кот");
    assert.equal(FETCH.of("/getFile").length, 0);
  });

  test("vision off and no cache → null", async () => {
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K") }), makeEnv()); // vision off by default
    assert.equal(await describeCtxPhoto(ctx), null);
  });

  test("vision on, no cache → vision request, parses the description before |||, caches it", async () => {
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
  test("reply text without a photo", async () => {
    const m = makeMsg({ text: "опиши", reply_to_message: { text: "исходный текст" } });
    const ctx = makeCtxFor(m, makeEnv());
    assert.equal(await getReplySource(ctx), "исходный текст");
  });

  test("reply text + photo description from cache", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), photoCache: { RK: "пейзаж" } };
    const m = makeMsg({ text: "опиши", reply_to_message: { text: "глянь", photo: photoSizes("RK") } });
    const ctx = makeCtxFor(m, env, cd);
    const out = await getReplySource(ctx);
    assert.ok(out.includes("глянь"));
    assert.ok(out.includes("пейзаж"));
  });

  test("no source → null", async () => {
    const ctx = makeCtxFor(makeMsg({ text: "опиши" }), makeEnv());
    assert.equal(await getReplySource(ctx), null);
  });
});


describe("handlePhotoMessage", () => {
  test("vision off → free history note, no network", async () => {
    const env = makeEnv();
    const m = makeMsg({ photo: photoSizes("K"), caption: "смотри" });
    const ctx = makeCtxFor(m, env); // vision off
    await handlePhotoMessage(ctx);
    assert.equal(FETCH.of("/chat/completions").length, 0);
    assert.equal(FETCH.sends().length, 0);
    assert.ok(ctx.chatData.history.at(-1).content.includes("[фото"));
  });

  test("vision on, private chat → vision, parses desc|||reply, caches, replies", async () => {
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

  test("cached description → text path, no getFile", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true }, photoCache: { K: "кот" } };
    const m = makeMsg({ chatType: "private", photo: photoSizes("K"), caption: "" });
    const ctx = makeCtxFor(m, env, cd);
    FETCH.set("chat", () => sse(["ну кот и кот"]));
    await handlePhotoMessage(ctx);
    assert.equal(FETCH.of("/getFile").length, 0);
    assert.equal(FETCH.sends()[0].body.text.includes("кот"), true);
  });

  test("vision on, group without an address → note, no reply", async () => {
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


describe("audit: photo/vision additional branches", () => {
  test("logIgnoredPhoto: own visual + cached description → note with the description", () => {
    const cd = { ...DEFAULT_CHAT_DATA(), photoCache: { K: "кот" } };
    const ctx = makeCtxFor(makeMsg({ photo: photoSizes("K"), caption: "гляди" }), makeEnv(), cd);
    logIgnoredPhoto(ctx, "гляди");
    assert.equal(ctx.chatData.history.at(-1).content, "[фото: кот] гляди");
  });

  test("photoFromReply + mention + first vision → reply + note '[в ответ на фото: ...]'", async () => {
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

  test("photoFromReply + cache → text path without getFile", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true }, photoCache: { RK: "закат" } };
    const m = makeMsg({ chatType: "private", text: "@testbot гля", reply_to_message: makeMsg({ photo: photoSizes("RK") }) });
    const ctx = makeCtxFor(m, env, cd);
    await handlePhotoMessage(ctx);
    assert.equal(FETCH.of("/getFile").length, 0);
    assert.ok(ctx.chatData.history.some(h => h.content.includes("[в ответ на фото: закат]")));
  });

  test("photoFromReply without a mention → stays silent, no note", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true } };
    const m = makeMsg({ chatType: "private", text: "просто текст", reply_to_message: makeMsg({ photo: photoSizes("RK") }) });
    const ctx = makeCtxFor(m, env, cd);
    const before = ctx.chatData.history.length;
    await handlePhotoMessage(ctx);
    assert.equal(FETCH.sends().length, 0);
    assert.equal(ctx.chatData.history.length, before); // logIgnoredPhoto for a reply — no-op
  });

  test("sticker without an image (animated without a thumbnail) → reply based on the emoji, no getFile", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true } };
    const m = { chat: { id: 555, type: "private" }, from: { first_name: "A" }, message_id: 1, sticker: { is_animated: true, emoji: "😂", file_unique_id: "U" } };
    const ctx = makeCtxFor(m, env, cd);
    FETCH.set("chat", () => sse(["ха-ха стикер"]));
    await handlePhotoMessage(ctx);
    assert.equal(FETCH.of("/getFile").length, 0);
    assert.ok(FETCH.sends()[0].body.text.includes("стикер"));
  });

  test("vision reply without the ||| separator → the whole text is the reply, the description is not cached", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true } };
    const m = makeMsg({ chatType: "private", photo: photoSizes("K"), caption: "" });
    const ctx = makeCtxFor(m, env, cd);
    FETCH.set("chat", () => sse(["просто ответ без разделителя"]));
    await handlePhotoMessage(ctx);
    assert.equal(ctx.chatData.photoCache.K, undefined); // desc empty → we don't cache
    assert.ok(FETCH.sends()[0].body.text.includes("просто ответ"));
  });

  test("getReplySource: reply with only a caption (no text), description from cache", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), photoCache: { RK: "пейзаж" } };
    const m = makeMsg({ text: "опиши", reply_to_message: { caption: "вид", photo: photoSizes("RK") } });
    const ctx = makeCtxFor(m, env, cd);
    const out = await getReplySource(ctx);
    assert.ok(out.includes("пейзаж"));
    assert.ok(out.includes("вид"));
  });

  test("describeCtxPhoto: empty photo array → null", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), config: { vision: true } };
    const ctx = makeCtxFor(makeMsg({ text: "x" }), makeEnv(), cd);
    ctx.photo = []; // force an empty array
    assert.equal(await describeCtxPhoto(ctx), null);
  });
});
