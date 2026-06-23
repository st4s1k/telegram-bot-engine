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

describe("утилиты", () => {
  test("escapeRegExp экранирует спецсимволы regex", () => {
    assert.equal(escapeRegExp("a.b*c+?"), "a\\.b\\*c\\+\\?");
    assert.equal(escapeRegExp("[x](y)"), "\\[x\\]\\(y\\)");
  });

  test("lastToken берёт последнее слово (с юникодом), игнорит хвостовую пунктуацию", () => {
    assert.equal(lastToken("привет да"), "да");
    assert.equal(lastToken("это 300!"), "300");
    assert.equal(lastToken("ну, пока..."), "пока");
    assert.equal(lastToken(""), "");
    assert.equal(lastToken("!!!"), "");
  });

  test("pickOne возвращает элемент массива (детерминированно через random)", () => {
    stubRandom(0);
    assert.equal(pickOne(["a", "b", "c"]), "a");
    stubRandom(0.99);
    assert.equal(pickOne(["a", "b", "c"]), "c");
    assert.equal(pickOne("scalar"), "scalar"); // не массив — возвращает как есть
  });

  test("newReqId длиной REQ_ID_LEN (8)", () => {
    const id = newReqId();
    assert.equal(id.length, 8);
    assert.match(id, /^[0-9a-f]{8}$/);
  });

  test("asciiHeader percent-кодирует не-ASCII, ASCII оставляет", () => {
    assert.equal(asciiHeader("Hello"), "Hello");
    assert.equal(asciiHeader("Бот"), encodeURIComponent("Бот"));
    assert.equal(asciiHeader(""), "");
  });

  test("stripBotMentions убирает @bot и схлопывает пробелы", () => {
    const cfg = getGlobalConfig(makeEnv());
    assert.equal(stripBotMentions("привет   @testbot пока", cfg), "привет пока");
    assert.equal(stripBotMentions("  раз два  ", cfg), "раз два");
  });

  test("parseRoots: lowercase, дедуп, разбиение по запятой/пробелу, лимит 8", () => {
    const cfg = getGlobalConfig(makeEnv());
    assert.deepEqual(parseRoots("Иван, иван  Пётр", cfg), ["иван", "пётр"]);
    assert.deepEqual(parseRoots("", cfg), []);
    const many = parseRoots("a b c d e f g h i j", cfg);
    assert.equal(many.length, 8);
  });

  test("isCommand распознаёт только существующие команды", () => {
    assert.equal(isCommand("help"), true);
    assert.equal(isCommand("config"), true);
    assert.equal(isCommand("llm"), false);
    assert.equal(isCommand("nope"), false);
  });

  test("isFallbackMessage ловит фолбэки и игнорит обычный текст", () => {
    assert.equal(isFallbackMessage(FALLBACK_LLM_ERROR), true);
    assert.equal(isFallbackMessage(FALLBACK_NO_CREDITS), true);
    assert.equal(isFallbackMessage("  " + FALLBACK_LLM_ERROR + "  "), true); // trim
    assert.equal(isFallbackMessage("обычный ответ"), false);
  });
});


/* ====================================================================== */
/* =====================  ИМЕНА / META  ================================= */
/* ====================================================================== */

describe("имена и метаданные", () => {
  test("pickTargetName: автор реплая → автор → fallback", () => {
    const m = makeMsg({ from: { first_name: "Аня" }, reply_to_message: { from: { first_name: "Боря" } } });
    assert.equal(pickTargetName(m), "Боря");
    assert.equal(pickTargetName(makeMsg({ from: { first_name: "Аня" } })), "Аня");
    assert.ok(pickTargetName(makeMsg({ from: {} }))); // no name → persona targetNameFallback (locale-dependent)
  });

  test("getUserName: имя автора или 'User'", () => {
    assert.equal(getUserName(makeMsg({ from: { first_name: "Аня" } })), "Аня");
    assert.equal(getUserName(makeMsg({ from: {} })), "User");
  });

  test("chatTitleFromMsg: title группы / имя+@username лички", () => {
    assert.equal(chatTitleFromMsg(makeMsg({ chatTitle: "Чат" })), "Чат");
    const m = makeMsg({ from: { first_name: "Аня", last_name: "К", username: "anya" }, chat: { id: 1, type: "private" } });
    assert.equal(chatTitleFromMsg(m), "Аня К @anya");
    assert.equal(chatTitleFromMsg({ chat: {}, from: {} }), "");
  });

  test("pickRandomUserText фильтрует сообщения с @упоминанием бота", () => {
    stubRandom(0);
    const hist = [
      { role: "user", content: "@testbot эй" },
      { role: "user", content: "просто текст" },
      { role: "assistant", content: "ответ" },
    ];
    assert.equal(pickRandomUserText(hist, "testbot"), "просто текст");
    assert.equal(pickRandomUserText([], "testbot"), "");
  });

  test("getUserMeta собирает поля + media_group_id + photo_key", () => {
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
    assert.equal(meta.photo_key, "PK"); // file_unique_id крупнейшего размера
  });

  test("buildUserItem / buildAssistantItem формируют корректные элементы истории", () => {
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

  test("formatWithMeta: [from:Имя] + метка времени (ts) в заданном TZ, без msg:N", () => {
    // без ts — только имя (никаких внутренних id)
    assert.equal(formatWithMeta({ role: "user", content: "текст", meta: { name: "Аня", message_id: 9 } }), "[from:Аня]\nтекст");
    assert.equal(formatWithMeta({ content: "x" }), "[from:user]\nx");
    const ts = Date.UTC(2026, 4, 31, 17, 48, 1);
    // дефолтный TZ — UTC (2026-05-31 17:48 UTC)
    assert.equal(formatWithMeta({ role: "user", content: "т", meta: { name: "Сергей", ts } }), "[from:Сергей; 2026-05-31 17:48]\nт");
    // явный TZ-параметр (Europe/Chisinau): 17:48 UTC = 20:48 EEST
    assert.equal(formatWithMeta({ role: "user", content: "т", meta: { name: "Сергей", ts } }, "Europe/Chisinau"), "[from:Сергей; 2026-05-31 20:48]\nт");
  });
});


/* ====================================================================== */
/* =====================  MARKDOWN V2  ================================== */
/* ====================================================================== */

describe("toMarkdownV2", () => {
  test("экранирует спецсимволы обычного текста", () => {
    assert.equal(toMarkdownV2("a.b!c-d"), "a\\.b\\!c\\-d");
    assert.equal(toMarkdownV2("(x) [y] {z}"), "\\(x\\) \\[y\\] \\{z\\}");
  });

  test("сохраняет парную разметку *жирный* _курсив_ ~зачёркнутый~", () => {
    assert.equal(toMarkdownV2("*bold*"), "*bold*");
    assert.equal(toMarkdownV2("_it_"), "_it_");
    assert.equal(toMarkdownV2("~s~"), "~s~");
    // спецсимвол внутри жирного экранируется
    assert.equal(toMarkdownV2("*a.b*"), "*a\\.b*");
  });

  test("спойлер ||...|| и инлайн-код `...`", () => {
    assert.equal(toMarkdownV2("||секрет!||"), "||секрет\\!||");
    assert.equal(toMarkdownV2("`code.x`"), "`code.x`"); // внутри кода точка НЕ экранируется
    assert.equal(toMarkdownV2("`a\\b`"), "`a\\\\b`");   // бэкслеш внутри кода удваивается
  });

  test("блок кода ```...``` экранирует только ` и \\", () => {
    assert.equal(toMarkdownV2("```a.b!```"), "```a.b!```");
  });

  test("ссылка [текст](url): экранирует текст и ) в url", () => {
    assert.equal(toMarkdownV2("[a.b](http://x/y)"), "[a\\.b](http://x/y)");
  });

  test("незакрытые маркеры трактуются как обычный текст (экранируются)", () => {
    assert.equal(toMarkdownV2("*непарный"), "\\*непарный");
    // перенос строки внутри инлайн-маркера → не разметка
    assert.equal(toMarkdownV2("*a\nb*"), "\\*a\nb\\*");
  });

  test("пустой/нестроковый ввод не падает", () => {
    assert.equal(toMarkdownV2(""), "");
    assert.equal(toMarkdownV2(null), "");
    assert.equal(toMarkdownV2(undefined), "");
  });
});


/* ====================================================================== */
/* =====================  ИСТОРИЯ  ====================================== */
/* ====================================================================== */

describe("история — обслуживание", () => {
  test("dedupeHistory убирает дубли по role:message_id, без id оставляет все", () => {
    const h = [
      { role: "user", content: "a", meta: { message_id: 1 } },
      { role: "user", content: "a2", meta: { message_id: 1 } }, // дубль
      { role: "assistant", content: "b", meta: { message_id: 1 } }, // другая роль — не дубль
      { role: "user", content: "noid" },
      { role: "user", content: "noid2" },
    ];
    const out = dedupeHistory(h);
    assert.equal(out.length, 4);
    assert.equal(out[0].content, "a");
    assert.equal(out[1].content, "b");
  });

  test("collapseConsecutiveDuplicates схлопывает подряд идущие одинаковые", () => {
    const h = [
      { role: "user", content: "Привет" },
      { role: "assistant", content: " привет " }, // тот же текст (норм.) — схлоп
      { role: "user", content: "пока" },
      { role: "user", content: "пока" },
      { role: "user", content: "пока?" },
    ];
    const out = collapseConsecutiveDuplicates(h);
    assert.deepEqual(out.map(x => x.content), ["Привет", "пока", "пока?"]);
  });

  test("historyChars суммирует длины content", () => {
    assert.equal(historyChars([{ content: "abc" }, { content: "de" }, {}]), 5);
    assert.equal(historyChars(null), 0);
  });

  test("trimHistoryByChars оставляет хвост в пределах бюджета, целыми сообщениями", () => {
    const h = [
      { content: "a".repeat(100) },
      { content: "b".repeat(100) },
      { content: "c".repeat(100) },
    ];
    const out = trimHistoryByChars(h, 150);
    // идём с конца: c(100) → total 100 < 150; b(100) → total 200 >= 150, включаем и стоп
    assert.deepEqual(out.map(x => x.content[0]), ["b", "c"]);
  });

  test("trimHistoryByChars: невалидный лимит → дефолт 8000; жёсткий потолок по числу", () => {
    const many = Array.from({ length: HISTORY_HARD_CAP_ITEMS + 50 }, (_, i) => ({ content: "x" }));
    const out = trimHistoryByChars(many, 0); // 0 → дефолт 8000, но потолок по числу сработает
    assert.ok(out.length <= HISTORY_HARD_CAP_ITEMS);
  });
});


describe("аудит: telegram/markdown/utils", () => {
  test("toMarkdownV2: спойлер с переносом → текст; незакрытый ``` → жадный инлайн-код", () => {
    assert.equal(toMarkdownV2("||a\nb||"), "\\|\\|a\nb\\|\\|");
    // незакрытый блок: первые два ` схлопываются в пустой инлайн-код ``, третий ` экранируется
    assert.equal(toMarkdownV2("```abc"), "``\\`abc");
  });
  test("sendTelegramMessage: обе попытки провалились → null", async () => {
    let n = 0;
    FETCH.set("send", () => { n++; if (n === 1) return jsonResp({ ok: false, description: "bad" }); throw new Error("network"); });
    assert.equal(await sendTelegramMessage("123:T", 1, "текст", undefined), null);
  });
  test("sendAndStore: 3 части отправлены, в историю один ответ целиком", async () => {
    const ctx = makeCtxFor(makeMsg({ message_id: 1 }), makeEnv());
    const big = "a".repeat(Math.floor(TELEGRAM_MSG_LIMIT * 2.5));
    await sendAndStore(ctx, big);
    assert.equal(FETCH.sends().length, 3);
    assert.equal(ctx.chatData.history.length, 1);
    assert.equal(ctx.chatData.history[0].content.length, big.length);
  });
  test("getUserMeta: без фото нет photo_key", () => {
    assert.ok(!("photo_key" in getUserMeta(makeMsg({ text: "plain" }))));
  });
  test("lastToken: эмодзи-суффикс игнорируется", () => {
    assert.equal(lastToken("привет мир🎉"), "мир");
  });
});

