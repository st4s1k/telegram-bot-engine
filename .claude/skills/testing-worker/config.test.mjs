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
/* =====================  КОНФИГ  ====================================== */
/* ====================================================================== */

describe("getGlobalConfig", () => {
  test("дефолты", () => {
    const cfg = getGlobalConfig(makeEnv());
    assert.equal(cfg.random, true);
    assert.equal(cfg.answer_prob, 0.1);
    assert.equal(cfg.history_chars, 8000);
    assert.equal(cfg.vision, false);      // по умолчанию выкл
    assert.equal(cfg.reasoning, true);    // по умолчанию вкл
    assert.equal(cfg.visionDetail, "low");
    assert.equal(cfg.botName, "Bot");
    assert.equal(cfg.botId, 123456);      // из токена
    assert.deepEqual(cfg.visionHdWords, ["присмотрись"]);
  });

  test("парсинг env: bool/число/vision/reasoning/detail/hd-слова", () => {
    const cfg = getGlobalConfig(makeEnv({
      ENABLE_VISION: "true",
      ENABLE_REASONING: "false",
      VISION_DETAIL: "HIGH",
      VISION_HD_WORDS: "детально, увеличь ,,",
      ANSWER_PROB: "0.42",
      MAX_HISTORY_CHARS: "12345",
    }));
    assert.equal(cfg.vision, true);
    assert.equal(cfg.reasoning, false);
    assert.equal(cfg.visionDetail, "high");
    assert.deepEqual(cfg.visionHdWords, ["детально", "увеличь"]);
    assert.equal(cfg.answer_prob, 0.42);
    assert.equal(cfg.history_chars, 12345);
  });

  test("невалидный VISION_DETAIL → low", () => {
    assert.equal(getGlobalConfig(makeEnv({ VISION_DETAIL: "ultra" })).visionDetail, "low");
  });

  test("мемоизация по env: тот же env → та же ссылка, другой env → другой конфиг", () => {
    const env = makeEnv();
    const a = getGlobalConfig(env);
    assert.equal(getGlobalConfig(env), a);          // повторный вызов с тем же env — из кэша
    assert.notEqual(getGlobalConfig(makeEnv()), a); // другой env → отдельный конфиг
  });
});


describe("mergeConfig", () => {
  test("накладывает только ключи схемы; model/vision_model/summary_model маппятся в camelCase", () => {
    const g = getGlobalConfig(makeEnv());
    const merged = mergeConfig(g, { random: false, model: "anthropic/x", vision_model: "v/y", summary_model: "s/z", notInSchema: 1 });
    assert.equal(merged.random, false);
    assert.equal(merged.openrouterModel, "anthropic/x");
    assert.equal(merged.visionModel, "v/y");
    assert.equal(merged.summaryModel, "s/z");
    assert.equal(merged.notInSchema, undefined);
  });

  test("summary_model: дефолт пустой, env OPENROUTER_SUMMARY_MODEL переопределяет", () => {
    assert.equal(getGlobalConfig(makeEnv()).summaryModel, "");
    assert.equal(getGlobalConfig(makeEnv({ OPENROUTER_SUMMARY_MODEL: "google/gemini-3.5-flash" })).summaryModel, "google/gemini-3.5-flash");
  });

  test("без override возвращает копию глобального", () => {
    const g = getGlobalConfig(makeEnv());
    const merged = mergeConfig(g, null);
    assert.equal(merged.random, g.random);
    assert.notEqual(merged, g);
  });
});


describe("max_tokens (лимит длины ответа)", () => {
  test("getGlobalConfig: дефолт 4000, env MAX_TOKENS переопределяет, мусор → дефолт", () => {
    assert.equal(getGlobalConfig(makeEnv()).maxTokens, 4000);
    assert.equal(getGlobalConfig(makeEnv({ MAX_TOKENS: "1500" })).maxTokens, 1500);
    assert.equal(getGlobalConfig(makeEnv({ MAX_TOKENS: "notanumber" })).maxTokens, 4000);
  });

  test("mergeConfig: override max_tokens → cfg.maxTokens; snake-ключ синхронен", () => {
    const g = getGlobalConfig(makeEnv());
    const m = mergeConfig(g, { max_tokens: 8000 });
    assert.equal(m.maxTokens, 8000);
    assert.equal(m.max_tokens, 8000); // snake = эффективное (для buildConfigHelp)
    const def = mergeConfig(g, {});
    assert.equal(def.maxTokens, 4000);
    assert.equal(def.max_tokens, 4000); // без override — дефолт, не undefined
  });

  test("границы схемы 256–65536 (parseConfigValue)", () => {
    const meta = CONFIG_SCHEMA.max_tokens;
    assert.equal(parseConfigValue(meta, "4000").ok, true);
    assert.equal(parseConfigValue(meta, "256").ok, true);
    assert.equal(parseConfigValue(meta, "65536").ok, true);
    assert.equal(parseConfigValue(meta, "100").ok, false);   // < min
    assert.equal(parseConfigValue(meta, "70000").ok, false); // > max
  });

  test("/config max_tokens <N>: валидное сохраняется, вне границ — ошибка", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(setConfigParam(ctx, "max_tokens", "8000"), /установлен/i);
    assert.equal(ctx.chatData.config.max_tokens, 8000);
    assert.match(setConfigParam(ctx, "max_tokens", "100"), /Ошибка/i);
  });

  test("buildConfigHelp показывает max_tokens со значением", () => {
    const out = buildConfigHelp(getGlobalConfig(makeEnv()), {});
    assert.ok(out.includes("max_tokens"));
    assert.ok(out.includes("4000"));
  });
});


describe("parseConfigValue", () => {
  const bool = CONFIG_SCHEMA.random;       // bool
  const flt = CONFIG_SCHEMA.answer_prob;   // float
  const intt = CONFIG_SCHEMA.history_chars; // int 500..100000
  const str = CONFIG_SCHEMA.model;          // string

  test("bool: on/off/вкл/выкл/1/0 + ошибка", () => {
    assert.deepEqual(parseConfigValue(bool, "on"), { ok: true, value: true });
    assert.deepEqual(parseConfigValue(bool, "ВЫКЛ"), { ok: true, value: false });
    assert.deepEqual(parseConfigValue(bool, "1"), { ok: true, value: true });
    assert.deepEqual(parseConfigValue(bool, "0"), { ok: true, value: false });
    assert.equal(parseConfigValue(bool, "maybe").ok, false);
  });

  test("float: диапазон 0..1", () => {
    assert.deepEqual(parseConfigValue(flt, "0.5"), { ok: true, value: 0.5 });
    assert.equal(parseConfigValue(flt, "1.5").ok, false);
    assert.equal(parseConfigValue(flt, "-0.1").ok, false);
    assert.equal(parseConfigValue(flt, "abc").ok, false);
  });

  test("int: границы min/max", () => {
    assert.deepEqual(parseConfigValue(intt, "8000"), { ok: true, value: 8000 });
    assert.equal(parseConfigValue(intt, "100").ok, false);     // < 500
    assert.equal(parseConfigValue(intt, "200000").ok, false);  // > 100000
  });

  test("string: reset/off/- → пусто; пробелы и длина — ошибка", () => {
    assert.deepEqual(parseConfigValue(str, "reset"), { ok: true, value: "" });
    assert.deepEqual(parseConfigValue(str, "сброс"), { ok: true, value: "" });
    assert.deepEqual(parseConfigValue(str, "a/b"), { ok: true, value: "a/b" });
    assert.equal(parseConfigValue(str, "a b").ok, false);          // пробел
    assert.equal(parseConfigValue(str, "x".repeat(200)).ok, false); // длина
    assert.equal(parseConfigValue(str, "").ok, false);              // пусто
  });
});


describe("setConfigParam", () => {
  test("неизвестный ключ → сообщение об ошибке", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(setConfigParam(ctx, "nope", "1"), /не найден/i);
  });

  test("string reset возвращает сообщение о сбросе", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = setConfigParam(ctx, "model", "reset");
    assert.match(out, /сброшен/i);
    assert.equal(ctx.chatData.config.model, "");
  });
});


/* ====================================================================== */
/* =====================  ПАРСИНГ КОМАНД  =============================== */
/* ====================================================================== */

describe("parseCommandAndArg / buildCommandRegex", () => {
  const cfg = getGlobalConfig(makeEnv());

  test("не-команда → {type:'llm'}; частичное совпадение не считается командой", () => {
    assert.equal(parseCommandAndArg("просто текст", cfg).type, "llm");
    assert.equal(parseCommandAndArg("/helpme", cfg).type, "llm"); // нет границы \\s|$
    assert.equal(parseCommandAndArg("", cfg).type, "llm");
  });

  test("buildCommandRegex кэширует по botUsername", () => {
    const env = makeEnv();
    const a = buildCommandRegex(env, "testbot");
    const b = buildCommandRegex(env, "testbot");
    assert.equal(a, b); // тот же объект из кэша
  });
});


describe("аудит: getGlobalConfig краевые", () => {
  test("botId = null при токене без двоеточия и при пустом токене", () => {
    assert.equal(getGlobalConfig(makeEnv({ TELEGRAM_BOT_TOKEN: "NOCOLON" })).botId, null);
    assert.equal(getGlobalConfig(makeEnv({ TELEGRAM_BOT_TOKEN: "" })).botId, null);
  });
  test("answer_prob = 0 (валидный 0, не дефолт 0.1)", () => {
    assert.equal(getGlobalConfig(makeEnv({ ANSWER_PROB: "0" })).answer_prob, 0);
  });
  test("нечисловой MAX_HISTORY_CHARS → дефолт 8000", () => {
    assert.equal(getGlobalConfig(makeEnv({ MAX_HISTORY_CHARS: "notanumber" })).history_chars, 8000);
  });
  test("OPENROUTER_HOST / TITLE override, botUsername → lowercase, llmLog('yes')", () => {
    const cfg = getGlobalConfig(makeEnv({ OPENROUTER_HOST: "https://h/api", OPENROUTER_TITLE: "Bot", BOT_USERNAME: "MyBot_UP", LLM_LOG: "yes" }));
    assert.equal(cfg.openrouterHost, "https://h/api");
    assert.equal(cfg.openrouterTitle, "Bot");
    assert.equal(cfg.botUsername, "mybot_up");
    assert.equal(cfg.llmLog, true);
  });
  test("buildCommandRegex для разных botUsername даёт разные списки", () => {
    const env = makeEnv();
    const a = buildCommandRegex(env, "bot_a");
    const b = buildCommandRegex(env, "bot_b");
    assert.notEqual(a, b);
  });
});


describe("аудит: mergeConfig краевые", () => {
  test("пустая строка model НЕ перетирает openrouterModel", () => {
    const g = getGlobalConfig(makeEnv()); // openrouterModel = test/model
    const m = mergeConfig(g, { model: "" });
    assert.equal(m.model, "");
    assert.equal(m.openrouterModel, "test/model");
  });
  test("пустая строка vision_model НЕ перетирает visionModel", () => {
    const g = getGlobalConfig(makeEnv({ OPENROUTER_VISION_MODEL: "v/env" }));
    const m = mergeConfig(g, { vision_model: "" });
    assert.equal(m.visionModel, "v/env");
  });
});


describe("аудит: setConfigParam форматы сообщений", () => {
  test("float устанавливается, сообщение содержит meta.desc", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = setConfigParam(ctx, "answer_prob", "0.25");
    assert.equal(ctx.chatData.config.answer_prob, 0.25);
    assert.match(out, /установлен в/);
    assert.ok(out.includes("Шанс ответа"));
  });
  test("int устанавливается", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    setConfigParam(ctx, "history_chars", "5000");
    assert.equal(ctx.chatData.config.history_chars, 5000);
  });
  test("string set: формат без meta.desc", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = setConfigParam(ctx, "model", "vendor/x");
    assert.match(out, /установлен:/);
    assert.ok(out.includes("vendor/x"));
  });
  test("vision_model reset → fallback 'дефолт' (не openrouterModel)", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = setConfigParam(ctx, "vision_model", "reset");
    assert.ok(out.includes("дефолт"));
  });
});


describe("аудит: parseConfigValue границы и варианты", () => {
  test("границы float/int", () => {
    const flt = CONFIG_SCHEMA.answer_prob, intt = CONFIG_SCHEMA.history_chars;
    assert.deepEqual(parseConfigValue(flt, "0.0"), { ok: true, value: 0 });
    assert.deepEqual(parseConfigValue(flt, "1.0"), { ok: true, value: 1 });
    assert.deepEqual(parseConfigValue(intt, "500"), { ok: true, value: 500 });
    assert.deepEqual(parseConfigValue(intt, "100000"), { ok: true, value: 100000 });
  });
  test("bool-ветка НЕ тримит пробелы; string reset-варианты off/default/-", () => {
    const b = CONFIG_SCHEMA.random, s = CONFIG_SCHEMA.model;
    assert.equal(parseConfigValue(b, " on ").ok, false); // bool делает только toLowerCase, без trim
    assert.equal(parseConfigValue(b, "on").ok, true);
    for (const v of ["off", "default", "-"]) assert.deepEqual(parseConfigValue(s, v), { ok: true, value: "" });
  });
});

describe("i18n: /config lang (UI-строки движка)", () => {
  test("дефолт ru — лейблы /info по-русски", () => {
    const ctx = makeCtxFor(makeMsg({ chatType: "private" }), makeEnv(), { ...DEFAULT_CHAT_DATA(), paused: true });
    const out = buildInfoStatus(ctx);
    assert.ok(out.includes("🎭 Роль:"));
    assert.ok(out.includes("На паузе"));
    assert.ok(out.includes("Настройки: /config"));
  });
  test("lang=en (per-chat) — лейблы движка по-английски, без русских", () => {
    const ctx = makeCtxFor(makeMsg({ chatType: "private" }), makeEnv(), { ...DEFAULT_CHAT_DATA(), config: { lang: "en" }, paused: true });
    const out = buildInfoStatus(ctx);
    assert.ok(out.includes("🎭 Role:"));
    assert.ok(out.includes("Paused"));
    assert.ok(out.includes("Settings: /config"));
    assert.ok(!out.includes("🎭 Роль:")); // русский лейбл движка не протекает
  });
  test("BOT_LANG задаёт язык по умолчанию", () => {
    const ctx = makeCtxFor(makeMsg({ chatType: "private" }), makeEnv({ BOT_LANG: "en" }), DEFAULT_CHAT_DATA());
    assert.ok(buildInfoStatus(ctx).includes("🎭 Role:"));
  });
});
