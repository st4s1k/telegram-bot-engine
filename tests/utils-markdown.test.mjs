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
  callOpenRouter, runLLMWithHistory, toLLMMessages, formatWithMeta, linkifySummaryTimes, asciiHeader,
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

describe("utilities", () => {
  test("escapeRegExp escapes regex special characters", () => {
    assert.equal(escapeRegExp("a.b*c+?"), "a\\.b\\*c\\+\\?");
    assert.equal(escapeRegExp("[x](y)"), "\\[x\\]\\(y\\)");
  });

  test("lastToken takes the last word (with unicode), ignores trailing punctuation", () => {
    assert.equal(lastToken("привет да"), "да");
    assert.equal(lastToken("это 300!"), "300");
    assert.equal(lastToken("ну, пока..."), "пока");
    assert.equal(lastToken(""), "");
    assert.equal(lastToken("!!!"), "");
  });

  test("linkifySummaryTimes: supergroup HH:MM → message deep-link; unmapped/non-supergroup stay plain", () => {
    const items = [
      { role: "user", content: "a", meta: { message_id: 11, ts: Date.UTC(2026, 5, 24, 10, 25) } },
      { role: "user", content: "b", meta: { message_id: 12, ts: Date.UTC(2026, 5, 24, 10, 40) } },
    ];
    const out = linkifySummaryTimes("обсуждали 10:25–10:40, а 09:00 — нет", items, -1001234567890, "UTC");
    assert.match(out, /\[10:25\]\(https:\/\/t\.me\/c\/1234567890\/11\)/);
    assert.match(out, /\[10:40\]\(https:\/\/t\.me\/c\/1234567890\/12\)/); // interval — both ends linked
    assert.ok(!/\[09:00\]\(/.test(out)); // not in the summarized window → left plain
    // non-supergroup (private id / basic group -id without -100) → no per-message links → unchanged
    assert.equal(linkifySummaryTimes("в 10:25 что-то", items, 555, "UTC"), "в 10:25 что-то");
    assert.equal(linkifySummaryTimes("в 10:25 что-то", items, -123456, "UTC"), "в 10:25 что-то");
  });

  test("pickOne returns an array element (deterministically via random)", () => {
    stubRandom(0);
    assert.equal(pickOne(["a", "b", "c"]), "a");
    stubRandom(0.99);
    assert.equal(pickOne(["a", "b", "c"]), "c");
    assert.equal(pickOne("scalar"), "scalar"); // not an array — returns as is
  });

  test("newReqId has length REQ_ID_LEN (8)", () => {
    const id = newReqId();
    assert.equal(id.length, 8);
    assert.match(id, /^[0-9a-f]{8}$/);
  });

  test("asciiHeader percent-encodes non-ASCII, leaves ASCII as is", () => {
    assert.equal(asciiHeader("Hello"), "Hello");
    assert.equal(asciiHeader("Бот"), encodeURIComponent("Бот"));
    assert.equal(asciiHeader(""), "");
  });

  test("stripBotMentions removes @bot and collapses spaces", () => {
    const cfg = getGlobalConfig(makeEnv());
    assert.equal(stripBotMentions("привет   @testbot пока", cfg), "привет пока");
    assert.equal(stripBotMentions("  раз два  ", cfg), "раз два");
  });

  test("parseRoots: lowercase, dedup, split by comma/space, limit 8", () => {
    const cfg = getGlobalConfig(makeEnv());
    assert.deepEqual(parseRoots("Иван, иван  Пётр", cfg), ["иван", "пётр"]);
    assert.deepEqual(parseRoots("", cfg), []);
    const many = parseRoots("a b c d e f g h i j", cfg);
    assert.equal(many.length, 8);
  });

  test("isCommand recognizes only existing commands", () => {
    assert.equal(isCommand("help"), true);
    assert.equal(isCommand("config"), true);
    assert.equal(isCommand("llm"), false);
    assert.equal(isCommand("nope"), false);
  });

  test("isFallbackMessage catches fallbacks and ignores ordinary text", () => {
    assert.equal(isFallbackMessage(FALLBACK_LLM_ERROR), true);
    assert.equal(isFallbackMessage(FALLBACK_NO_CREDITS), true);
    assert.equal(isFallbackMessage("  " + FALLBACK_LLM_ERROR + "  "), true); // trim
    assert.equal(isFallbackMessage("обычный ответ"), false);
  });
});


/* ====================================================================== */
/* =====================  NAMES / META  ================================= */
/* ====================================================================== */

describe("names and metadata", () => {
  test("pickTargetName: reply author → author → fallback", () => {
    const m = makeMsg({ from: { first_name: "Аня" }, reply_to_message: { from: { first_name: "Боря" } } });
    assert.equal(pickTargetName(m), "Боря");
    assert.equal(pickTargetName(makeMsg({ from: { first_name: "Аня" } })), "Аня");
    assert.ok(pickTargetName(makeMsg({ from: {} }))); // no name → persona targetNameFallback (locale-dependent)
  });

  test("getUserName: author name or 'User'", () => {
    assert.equal(getUserName(makeMsg({ from: { first_name: "Аня" } })), "Аня");
    assert.equal(getUserName(makeMsg({ from: {} })), "User");
  });

  test("chatTitleFromMsg: group title / name+@username for private chat", () => {
    assert.equal(chatTitleFromMsg(makeMsg({ chatTitle: "Чат" })), "Чат");
    const m = makeMsg({ from: { first_name: "Аня", last_name: "К", username: "anya" }, chat: { id: 1, type: "private" } });
    assert.equal(chatTitleFromMsg(m), "Аня К @anya");
    assert.equal(chatTitleFromMsg({ chat: {}, from: {} }), "");
  });

  test("pickRandomUserText filters out messages with an @mention of the bot", () => {
    stubRandom(0);
    const hist = [
      { role: "user", content: "@testbot эй" },
      { role: "user", content: "просто текст" },
      { role: "assistant", content: "ответ" },
    ];
    assert.equal(pickRandomUserText(hist, "testbot"), "просто текст");
    assert.equal(pickRandomUserText([], "testbot"), "");
  });

  test("getUserMeta gathers fields + media_group_id + photo_key", () => {
    const m = makeMsg({
      from: { id: 7, first_name: "Аня", username: "anya" },
      photo: photoSizes("PK"),
      media_group_id: 999,
      reply_to_message: { message_id: 11 },
    });
    const meta = getUserMeta(m);
    assert.equal(meta.user_id, 7);
    assert.equal(meta.name, "Аня");
    assert.equal(meta.username, "anya");
    assert.equal(meta.reply_message_id, 11);
    assert.equal(meta.media_group_id, "999");
    assert.equal(meta.photo_key, "PK"); // file_unique_id of the largest size
  });

  test("buildUserItem / buildAssistantItem form correct history items", () => {
    const u = buildUserItem(makeMsg({ from: { first_name: "Аня", id: 7 } }), "привет");
    assert.equal(u.role, "user");
    assert.equal(u.content, "привет");
    assert.equal(u.meta.name, "Аня");

    const cfg = getGlobalConfig(makeEnv());
    const a = buildAssistantItem("ответ", cfg, 50, { result: { message_id: 777 } });
    assert.equal(a.role, "assistant");
    assert.equal(a.meta.message_id, 777);
    assert.equal(a.meta.reply_message_id, 50);
    assert.equal(a.meta.name, "Bot");
    assert.equal(a.meta.username, "@testbot");
  });

  test("formatWithMeta: [from:Name] + timestamp (ts) in the given TZ, without msg:N", () => {
    // without ts — name only (no internal ids)
    assert.equal(formatWithMeta({ role: "user", content: "текст", meta: { name: "Аня", message_id: 9 } }), "[from:Аня]\nтекст");
    assert.equal(formatWithMeta({ content: "x" }), "[from:user]\nx");
    const ts = Date.UTC(2026, 4, 31, 17, 48, 1);
    // default TZ — UTC (2026-05-31 17:48 UTC)
    assert.equal(formatWithMeta({ role: "user", content: "т", meta: { name: "Сергей", ts } }), "[from:Сергей; 2026-05-31 17:48]\nт");
    // explicit TZ parameter (Europe/Chisinau): 17:48 UTC = 20:48 EEST
    assert.equal(formatWithMeta({ role: "user", content: "т", meta: { name: "Сергей", ts } }, "Europe/Chisinau"), "[from:Сергей; 2026-05-31 20:48]\nт");
  });
});


/* ====================================================================== */
/* =====================  MARKDOWN V2  ================================== */
/* ====================================================================== */

describe("toMarkdownV2", () => {
  test("escapes special characters in ordinary text", () => {
    assert.equal(toMarkdownV2("a.b!c-d"), "a\\.b\\!c\\-d");
    assert.equal(toMarkdownV2("(x) [y] {z}"), "\\(x\\) \\[y\\] \\{z\\}");
  });

  test("preserves paired markup *bold* _italic_ ~strikethrough~", () => {
    assert.equal(toMarkdownV2("*bold*"), "*bold*");
    assert.equal(toMarkdownV2("_it_"), "_it_");
    assert.equal(toMarkdownV2("~s~"), "~s~");
    // a special character inside bold is escaped
    assert.equal(toMarkdownV2("*a.b*"), "*a\\.b*");
  });

  test("spoiler ||...|| and inline code `...`", () => {
    assert.equal(toMarkdownV2("||секрет!||"), "||секрет\\!||");
    assert.equal(toMarkdownV2("`code.x`"), "`code.x`"); // inside code the dot is NOT escaped
    assert.equal(toMarkdownV2("`a\\b`"), "`a\\\\b`");   // a backslash inside code is doubled
  });

  test("code block ```...``` escapes only ` and \\", () => {
    assert.equal(toMarkdownV2("```a.b!```"), "```a.b!```");
  });

  test("link [text](url): escapes the text and ) in the url", () => {
    assert.equal(toMarkdownV2("[a.b](http://x/y)"), "[a\\.b](http://x/y)");
  });

  test("a nested link inside a styled span is PRESERVED (not rendered raw)", () => {
    // The /summary header is bold and linkifySummaryTimes injects time deep-links INTO it; the link must
    // survive (Telegram allows a text_link inside bold). Regression: previously the brackets got escaped
    // and Telegram showed a literal `[17:04](url)`.
    assert.equal(
      toMarkdownV2("*[17:04](https://t.me/c/1/2)*"),
      "*[17:04](https://t.me/c/1/2)*"
    );
    // surrounding plain text inside the bold is still escaped; the link stays intact
    assert.equal(
      toMarkdownV2("*Новое (a.b [10:25](http://x/y) c)*"),
      "*Новое \\(a\\.b [10:25](http://x/y) c\\)*"
    );
    // same for a spoiler span
    assert.equal(toMarkdownV2("||[t](http://x/y)||"), "||[t](http://x/y)||");
    // a stray marker / backtick inside the span keeps escaping as before (code may not nest in bold)
    assert.equal(toMarkdownV2("*a`b*"), "*a\\`b*");
  });

  test("unclosed markers are treated as ordinary text (escaped)", () => {
    assert.equal(toMarkdownV2("*непарный"), "\\*непарный");
    // a line break inside an inline marker → not markup
    assert.equal(toMarkdownV2("*a\nb*"), "\\*a\nb\\*");
  });

  test("empty/non-string input does not crash", () => {
    assert.equal(toMarkdownV2(""), "");
    assert.equal(toMarkdownV2(null), "");
    assert.equal(toMarkdownV2(undefined), "");
  });
});


/* ====================================================================== */
/* =====================  HISTORY  ====================================== */
/* ====================================================================== */

describe("history — maintenance", () => {
  test("dedupeHistory removes duplicates by role:message_id, keeps all without id", () => {
    const h = [
      { role: "user", content: "a", meta: { message_id: 1 } },
      { role: "user", content: "a2", meta: { message_id: 1 } }, // duplicate
      { role: "assistant", content: "b", meta: { message_id: 1 } }, // different role — not a duplicate
      { role: "user", content: "noid" },
      { role: "user", content: "noid2" },
    ];
    const out = dedupeHistory(h);
    assert.equal(out.length, 4);
    assert.equal(out[0].content, "a");
    assert.equal(out[1].content, "b");
  });

  test("collapseConsecutiveDuplicates collapses consecutive identical items", () => {
    const h = [
      { role: "user", content: "Привет" },
      { role: "assistant", content: " привет " }, // same text (normalized) — collapsed
      { role: "user", content: "пока" },
      { role: "user", content: "пока" },
      { role: "user", content: "пока?" },
    ];
    const out = collapseConsecutiveDuplicates(h);
    assert.deepEqual(out.map(x => x.content), ["Привет", "пока", "пока?"]);
  });

  test("historyChars sums up content lengths", () => {
    assert.equal(historyChars([{ content: "abc" }, { content: "de" }, {}]), 5);
    assert.equal(historyChars(null), 0);
  });

  test("trimHistoryByChars keeps the tail within budget, whole messages only", () => {
    const h = [
      { content: "a".repeat(100) },
      { content: "b".repeat(100) },
      { content: "c".repeat(100) },
    ];
    const out = trimHistoryByChars(h, 150);
    // go from the end: c(100) → total 100 < 150; b(100) → total 200 >= 150, include and stop
    assert.deepEqual(out.map(x => x.content[0]), ["b", "c"]);
  });

  test("trimHistoryByChars: invalid limit → default 8000; hard item-count cap", () => {
    const many = Array.from({ length: HISTORY_HARD_CAP_ITEMS + 50 }, (_, i) => ({ content: "x" }));
    const out = trimHistoryByChars(many, 0); // 0 → default 8000, but the item-count cap kicks in
    assert.ok(out.length <= HISTORY_HARD_CAP_ITEMS);
  });
});


describe("audit: telegram/markdown/utils", () => {
  test("toMarkdownV2: spoiler with a line break → text; unclosed ``` → greedy inline code", () => {
    assert.equal(toMarkdownV2("||a\nb||"), "\\|\\|a\nb\\|\\|");
    // unclosed block: the first two ` collapse into empty inline code ``, the third ` is escaped
    assert.equal(toMarkdownV2("```abc"), "``\\`abc");
  });
  test("sendTelegramMessage: both attempts failed → null", async () => {
    let n = 0;
    FETCH.set("send", () => { n++; if (n === 1) return jsonResp({ ok: false, description: "bad" }); throw new Error("network"); });
    assert.equal(await sendTelegramMessage("123:T", 1, "текст", undefined), null);
  });
  test("sendAndStore: 3 parts sent, one whole reply in history", async () => {
    const ctx = makeCtxFor(makeMsg({ message_id: 1 }), makeEnv());
    const big = "a".repeat(Math.floor(TELEGRAM_MSG_LIMIT * 2.5));
    await sendAndStore(ctx, big);
    assert.equal(FETCH.sends().length, 3);
    assert.equal(ctx.chatData.history.length, 1);
    assert.equal(ctx.chatData.history[0].content.length, big.length);
  });
  test("getUserMeta: no photo_key without a photo", () => {
    assert.ok(!("photo_key" in getUserMeta(makeMsg({ text: "plain" }))));
  });
  test("lastToken: emoji suffix is ignored", () => {
    assert.equal(lastToken("привет мир🎉"), "мир");
  });
});

