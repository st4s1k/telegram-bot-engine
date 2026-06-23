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
/* =====================  DECIDING WHETHER TO ANSWER  =========================== */
/* ====================================================================== */

describe("shouldAnswer", () => {
  const cfg = getGlobalConfig(makeEnv());

  test("private chat → always answers", () => {
    const m = makeMsg({ chatType: "private", text: "привет" });
    assert.deepEqual(shouldAnswer("привет", m, cfg), { answer: true, reason: "addressed" });
  });

  test("mention in a group → answers", () => {
    const m = makeMsg({ chatType: "group", text: "эй @testbot" });
    assert.equal(shouldAnswer("эй @testbot", m, cfg).answer, true);
  });

  test("group without a mention and random off → does not answer", () => {
    const cfgOff = mergeConfig(cfg, { random: false });
    const m = makeMsg({ chatType: "group", text: "болтовня" });
    assert.deepEqual(shouldAnswer("болтовня", m, cfgOff), { answer: false, reason: "random_disabled" });
  });

  test("group, random: hit/miss against answer_prob", () => {
    const m = makeMsg({ chatType: "group", text: "болтовня" });
    stubRandom(0.05); // < 0.1
    assert.equal(shouldAnswer("болтовня", m, cfg).answer, true);
    stubRandom(0.5);  // > 0.1
    assert.equal(shouldAnswer("болтовня", m, cfg).answer, false);
  });
});


describe("tryQuickReply", () => {
  test("no triggers → false", async () => {
    const ctx = makeCtxFor(makeMsg({ text: "обычное сообщение" }), makeEnv());
    assert.equal(await tryQuickReply(ctx), false);
  });
});


/* ====================================================================== */
/* =====================  handleChatMessage  ========================== */
/* ====================================================================== */

describe("handleChatMessage", () => {
  test("private chat → answers (default prompt), sends the model's reply", async () => {
    const ctx = makeCtxFor(makeMsg({ chatType: "private", text: "как дела" }), makeEnv());
    FETCH.set("chat", () => sse(["норм, у тебя как"]));
    await handleChatMessage(ctx);
    assert.equal(FETCH.sends()[0].body.text.includes("норм"), true);
    assert.ok(FETCH.of("/sendChatAction").length >= 1); // "typing"
  });

  test("does not answer when shouldAnswer=false", async () => {
    const cd = { ...DEFAULT_CHAT_DATA(), config: { random: false } };
    const ctx = makeCtxFor(makeMsg({ chatType: "group", text: "болтаем" }), makeEnv(), cd);
    await handleChatMessage(ctx);
    assert.equal(FETCH.sends().length, 0);
  });

  test("reply → answers with the reply prompt (not an unprompted message)", async () => {
    const m = makeMsg({ chatType: "private", text: "и что", reply_to_message: { text: "вчера был дождь" } });
    const ctx = makeCtxFor(m, makeEnv());
    FETCH.set("chat", () => sse(["ага"]));
    await handleChatMessage(ctx);
    const sys = FETCH.chatBody().messages[0].content;
    assert.ok(sys.includes("вчера был дождь")); // the reply prompt includes the original
  });
});


/* ====================================================================== */
/* =====================  tryCommand  ================================= */
/* ====================================================================== */

describe("tryCommand", () => {
  test("not a command → false", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.equal(await tryCommand({ type: "llm", argText: "" }, ctx), false);
  });

  test("TECH command: answers, but does NOT write to history", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const ok = await tryCommand({ type: "help", argText: "" }, ctx);
    assert.equal(ok, true);
    assert.equal(FETCH.sends().length, 1);
    assert.equal(ctx.chatData.history.length, 0); // skipHistory
  });

  test("command returned null (e.g. /admin to a non-admin) → stays silent", async () => {
    const ctx = makeCtxFor(makeMsg({ username: "vasya", chatType: "private" }), makeEnv());
    const ok = await tryCommand({ type: "admin", argText: "chats" }, ctx);
    assert.equal(ok, true);          // command handled
    assert.equal(FETCH.sends().length, 0); // but nothing was sent
  });
});


describe("audit: chat flow — random branches", () => {
  test("group: random + reply → default prompt (not an unprompted message)", async () => {
    const m = makeMsg({ chatType: "group", chatId: -100, text: "ну и", reply_to_message: { text: "погода супер" } });
    const ctx = makeCtxFor(m, makeEnv());
    FETCH.set("chat", () => sse(["ага"]));
    stubRandom(0.05); // shouldAnswer: random hit
    await handleChatMessage(ctx);
    assert.ok(FETCH.chatBody().messages[0].content.includes("погода супер"));
  });
});
