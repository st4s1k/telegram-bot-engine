import * as H from "./harness.mjs";
const {
  test, describe, assert, WORKER,
  // worker.js — functions and constants
  toMarkdownV2, sendTelegramMessage, sendAndStore, isFallbackMessage, reportError,
  buildBotCommands, syncBotCommands, botCommandsFingerprint, maybeSyncBotCommands,
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
  // harness
  makeEnv, makeMsg, makeKV, makeCtxFor, photoSizes, sse, jsonResp, streamResp,
  stubRandom, restoreRandom, CONSOLE, clearConsole, FETCH, newFetch,
} = H;


/* ====================================================================== */
/* =====================  TELEGRAM I/O  =============================== */
/* ====================================================================== */

describe("sendTelegramMessage", () => {
  test("normalizes ** → * and ## → bold; successful MarkdownV2 send", async () => {
    const data = await sendTelegramMessage("123:T", 1, "**жир** и\n## Заголовок", 50);
    assert.ok(data?.ok);
    const body = FETCH.sends()[0].body;
    assert.equal(body.parse_mode, "MarkdownV2");
    assert.equal(body.reply_to_message_id, 50);
    assert.ok(body.text.includes("*жир*"));
  });

  test("empty text after normalization → null, no request", async () => {
    const data = await sendTelegramMessage("123:T", 1, "   ", undefined);
    assert.equal(data, null);
    assert.equal(FETCH.sends().length, 0);
  });

  test("MarkdownV2 error → fallback to plain without parse_mode", async () => {
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
  test("strips [from:...], collapses newlines, stores the assistant reply", async () => {
    const ctx = makeCtxFor(makeMsg({ message_id: 200 }), makeEnv());
    await sendAndStore(ctx, "[from:Bot] привет\n\n\n\nкак дела");
    const sent = FETCH.sends()[0].body.text;
    assert.ok(!sent.includes("[from:"));
    const last = ctx.chatData.history.at(-1);
    assert.equal(last.role, "assistant");
    assert.ok(!last.content.includes("[from:"));
    assert.ok(!/\n{3,}/.test(last.content));
  });

  test("empty after stripping → null", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.equal(await sendAndStore(ctx, "[from:X] "), null);
  });

  test("long text is split into chunks ≤ the limit; reply_to only on the first", async () => {
    const ctx = makeCtxFor(makeMsg({ message_id: 300 }), makeEnv());
    await sendAndStore(ctx, "a".repeat(TELEGRAM_MSG_LIMIT + 500));
    const sends = FETCH.sends();
    assert.equal(sends.length, 2);
    assert.equal(sends[0].body.reply_to_message_id, 300);
    assert.equal(sends[1].body.reply_to_message_id, undefined);
  });

  test("splitting does not break a surrogate pair (emoji on the boundary → no U+FFFD)", async () => {
    const ctx = makeCtxFor(makeMsg({ message_id: 301 }), makeEnv());
    const text = "a".repeat(TELEGRAM_MSG_LIMIT - 1) + "😀"; // emoji (2 code units) right on the seam
    await sendAndStore(ctx, text);
    const sends = FETCH.sends();
    assert.equal(sends.length, 2);
    assert.ok(!sends.some(s => s.body.text.includes("�"))); // not a single "broken" surrogate half
    assert.equal(sends.map(s => s.body.text).join(""), text);    // joined chunks = original text
  });

  test("skipHistory does not write to history", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    await sendAndStore(ctx, "технический ответ", { skipHistory: true });
    assert.equal(ctx.chatData.history.length, 0);
  });

  test("fallback messages are not stored in history", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    await sendAndStore(ctx, FALLBACK_LLM_ERROR);
    assert.equal(ctx.chatData.history.length, 0);
  });

  test("a fallback gets a tappable /retry hint appended to the sent text (but not to history)", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    await sendAndStore(ctx, FALLBACK_LLM_ERROR);
    assert.ok(FETCH.sends()[0].body.text.includes("/retry")); // hint appended for one-tap re-run
    assert.equal(ctx.chatData.history.length, 0);              // still nothing stored
  });

  test("a failed send is NOT stored in history (no phantom turn)", async () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    FETCH.set("send", () => H.jsonResp({ ok: false, description: "bot was blocked by the user" }));
    const res = await sendAndStore(ctx, "привет");
    assert.ok(!res?.result?.message_id);          // both send attempts reported failure
    assert.equal(ctx.chatData.history.length, 0); // a reply the user never got isn't recorded
  });
});

describe("reportError", () => {
  test("critical + ADMIN_CHAT_IDS → alert to Telegram + throttle in KV", async () => {
    const env = makeEnv({ ADMIN_CHAT_IDS: "999" });
    await reportError(env, "flushChatData", new Error("d1 down"), { critical: true });
    const sends = FETCH.sends();
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body.chat_id, 999);
    assert.ok(sends[0].body.text.includes("flushChatData"));
    assert.ok(await env._kv.get("errnotify:flushChatData")); // throttle is set
  });

  test("CSV list: alert to every chat_id (incl. a group with a negative id)", async () => {
    const env = makeEnv({ ADMIN_CHAT_IDS: "111, -100222" });
    await reportError(env, "scheduled", new Error("boom"), { critical: true });
    const ids = FETCH.sends().map(s => s.body.chat_id).sort((a, b) => a - b);
    assert.deepEqual(ids, [-100222, 111]);
  });

  test("repeated critical within the throttle window → no second alert", async () => {
    const env = makeEnv({ ADMIN_CHAT_IDS: "999" });
    await reportError(env, "flushChatData", new Error("x"), { critical: true });
    await reportError(env, "flushChatData", new Error("y"), { critical: true });
    assert.equal(FETCH.sends().length, 1);
  });

  test("critical without ADMIN_CHAT_IDS → log only, no alert", async () => {
    const env = makeEnv();
    await reportError(env, "scheduled", new Error("boom"), { critical: true });
    assert.equal(FETCH.sends().length, 0);
    assert.ok(CONSOLE.error.some(s => s.includes("scheduled")));
  });

  test("non-critical → log only, no alert even with ADMIN_CHAT_IDS", async () => {
    const env = makeEnv({ ADMIN_CHAT_IDS: "999" });
    await reportError(env, "runDailySummaries[chat]", new Error("nope"));
    assert.equal(FETCH.sends().length, 0);
  });

  test("KV throttle read failure is fail-open → the critical alert is still sent", async () => {
    const env = makeEnv({ ADMIN_CHAT_IDS: "999" });
    env.KV = { get: async () => { throw new Error("kv down"); }, put: async () => {} };
    await reportError(env, "flushChatData", new Error("d1 down"), { critical: true });
    assert.equal(FETCH.sends().filter(s => s.body.chat_id === 999).length, 1); // not suppressed by the KV outage
  });
});


describe("native command menu (setMyCommands)", () => {
  test("buildBotCommands: engine commands with menuDesc, /admin excluded, no leading slash", () => {
    const cmds = buildBotCommands("en");
    const names = cmds.map(c => c.command);
    assert.ok(names.includes("help"));
    assert.ok(names.includes("config"));
    assert.ok(!names.includes("admin"));            // hidden — no menuDesc
    assert.ok(cmds.every(c => /^[a-z0-9_]{1,32}$/.test(c.command))); // Telegram-valid
    assert.ok(cmds.every(c => c.description.length > 0 && c.description.length <= 256));
  });

  test("buildBotCommands: descriptions are localized per the passed lang", () => {
    const en = buildBotCommands("en").find(c => c.command === "help");
    const ru = buildBotCommands("ru").find(c => c.command === "help");
    assert.notEqual(en.description, ru.description); // menu_help differs en vs ru
  });

  test("syncBotCommands: a default call + one per discovered locale; counts successes", async () => {
    const env = makeEnv();
    const ok = await syncBotCommands(env);
    const calls = FETCH.of("/setMyCommands");
    // default (no language_code) + one per discovered 2-letter locale (en, ru)
    assert.ok(calls.some(c => c.body.language_code === undefined));
    assert.ok(calls.some(c => c.body.language_code === "en"));
    assert.ok(calls.some(c => c.body.language_code === "ru"));
    assert.equal(ok, calls.length); // all mocked calls succeed
  });

  test("syncBotCommands: no token → no calls", async () => {
    const env = makeEnv({ TELEGRAM_BOT_TOKEN: "" });
    const ok = await syncBotCommands(env);
    assert.equal(ok, 0);
    assert.equal(FETCH.of("/setMyCommands").length, 0);
  });

  test("botCommandsFingerprint is a stable non-empty string", () => {
    assert.equal(botCommandsFingerprint(), botCommandsFingerprint());
    assert.ok(botCommandsFingerprint().length > 0);
  });

  test("maybeSyncBotCommands: syncs once, then the KV fingerprint flag mutes it", async () => {
    const env = makeEnv();
    await maybeSyncBotCommands(env);
    const after1 = FETCH.of("/setMyCommands").length;
    assert.ok(after1 > 0);
    await maybeSyncBotCommands(env); // same fingerprint → flag set → no-op
    assert.equal(FETCH.of("/setMyCommands").length, after1);
  });

  test("maybeSyncBotCommands: a KV read failure is fail-open (still syncs)", async () => {
    const env = makeEnv();
    env.KV = { get: async () => { throw new Error("kv down"); }, put: async () => {} };
    await maybeSyncBotCommands(env);
    assert.ok(FETCH.of("/setMyCommands").length > 0);
  });
});


