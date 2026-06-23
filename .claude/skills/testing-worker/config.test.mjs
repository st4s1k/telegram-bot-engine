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
/* =====================  CONFIG  ====================================== */
/* ====================================================================== */

describe("getGlobalConfig", () => {
  test("defaults", () => {
    const cfg = getGlobalConfig(makeEnv());
    assert.equal(cfg.random, true);
    assert.equal(cfg.answer_prob, 0.1);
    assert.equal(cfg.history_chars, 8000);
    assert.equal(cfg.vision, false);      // off by default
    assert.equal(cfg.reasoning, true);    // on by default
    assert.equal(cfg.visionDetail, "low");
    assert.equal(cfg.botName, "Bot");
    assert.equal(cfg.botId, 123456);      // from the token
    assert.deepEqual(cfg.visionHdWords, ["присмотрись"]);
  });

  test("language default: makeEnv is ru (test deployment); unset BOT_LANG → en (engine default)", () => {
    assert.equal(getGlobalConfig(makeEnv()).lang, "ru");                        // reference test deployment
    assert.equal(getGlobalConfig(makeEnv({ BOT_LANG: undefined })).lang, "en"); // engine default = English
    assert.deepEqual(getGlobalConfig(makeEnv({ BOT_LANG: undefined })).visionHdWords, ["zoom"]); // en locale default
  });

  test("env parsing: bool/number/vision/reasoning/detail/hd-words", () => {
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

  test("invalid VISION_DETAIL → low", () => {
    assert.equal(getGlobalConfig(makeEnv({ VISION_DETAIL: "ultra" })).visionDetail, "low");
  });

  test("memoization by env: same env → same reference, different env → different config", () => {
    const env = makeEnv();
    const a = getGlobalConfig(env);
    assert.equal(getGlobalConfig(env), a);          // repeated call with the same env — from cache
    assert.notEqual(getGlobalConfig(makeEnv()), a); // different env → separate config
  });
});


describe("mergeConfig", () => {
  test("applies only schema keys; model/vision_model/summary_model are mapped to camelCase", () => {
    const g = getGlobalConfig(makeEnv());
    const merged = mergeConfig(g, { random: false, model: "anthropic/x", vision_model: "v/y", summary_model: "s/z", notInSchema: 1 });
    assert.equal(merged.random, false);
    assert.equal(merged.openrouterModel, "anthropic/x");
    assert.equal(merged.visionModel, "v/y");
    assert.equal(merged.summaryModel, "s/z");
    assert.equal(merged.notInSchema, undefined);
  });

  test("summary_model: default empty, env OPENROUTER_SUMMARY_MODEL overrides", () => {
    assert.equal(getGlobalConfig(makeEnv()).summaryModel, "");
    assert.equal(getGlobalConfig(makeEnv({ OPENROUTER_SUMMARY_MODEL: "google/gemini-3.5-flash" })).summaryModel, "google/gemini-3.5-flash");
  });

  test("without override returns a copy of the global", () => {
    const g = getGlobalConfig(makeEnv());
    const merged = mergeConfig(g, null);
    assert.equal(merged.random, g.random);
    assert.notEqual(merged, g);
  });
});


describe("max_tokens (response-length limit)", () => {
  test("getGlobalConfig: default 4000, env MAX_TOKENS overrides, garbage → default", () => {
    assert.equal(getGlobalConfig(makeEnv()).maxTokens, 4000);
    assert.equal(getGlobalConfig(makeEnv({ MAX_TOKENS: "1500" })).maxTokens, 1500);
    assert.equal(getGlobalConfig(makeEnv({ MAX_TOKENS: "notanumber" })).maxTokens, 4000);
  });

  test("mergeConfig: override max_tokens → cfg.maxTokens; snake key stays in sync", () => {
    const g = getGlobalConfig(makeEnv());
    const m = mergeConfig(g, { max_tokens: 8000 });
    assert.equal(m.maxTokens, 8000);
    assert.equal(m.max_tokens, 8000); // snake = effective (for buildConfigHelp)
    const def = mergeConfig(g, {});
    assert.equal(def.maxTokens, 4000);
    assert.equal(def.max_tokens, 4000); // without override — default, not undefined
  });

  test("schema bounds 256–65536 (parseConfigValue)", () => {
    const meta = CONFIG_SCHEMA.max_tokens;
    assert.equal(parseConfigValue(meta, "4000").ok, true);
    assert.equal(parseConfigValue(meta, "256").ok, true);
    assert.equal(parseConfigValue(meta, "65536").ok, true);
    assert.equal(parseConfigValue(meta, "100").ok, false);   // < min
    assert.equal(parseConfigValue(meta, "70000").ok, false); // > max
  });

  test("/config max_tokens <N>: valid is saved, out of bounds — error", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(setConfigParam(ctx, "max_tokens", "8000"), /установлен/i);
    assert.equal(ctx.chatData.config.max_tokens, 8000);
    assert.match(setConfigParam(ctx, "max_tokens", "100"), /Ошибка/i);
  });

  test("buildConfigHelp shows max_tokens with its value", () => {
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

  test("bool: on/off/вкл/выкл/1/0 + error", () => {
    assert.deepEqual(parseConfigValue(bool, "on"), { ok: true, value: true });
    assert.deepEqual(parseConfigValue(bool, "ВЫКЛ"), { ok: true, value: false });
    assert.deepEqual(parseConfigValue(bool, "1"), { ok: true, value: true });
    assert.deepEqual(parseConfigValue(bool, "0"), { ok: true, value: false });
    assert.equal(parseConfigValue(bool, "maybe").ok, false);
  });

  test("value aliases are locale-specific (RU aliases only under ru)", () => {
    assert.deepEqual(parseConfigValue(bool, "вкл", "ru"), { ok: true, value: true });
    assert.equal(parseConfigValue(bool, "вкл", "en").ok, false);          // RU bool-alias rejected in en
    assert.deepEqual(parseConfigValue(bool, "on", "en"), { ok: true, value: true }); // universal works everywhere
    assert.deepEqual(parseConfigValue(str, "сброс", "ru"), { ok: true, value: "" });  // RU reset-alias → reset
    assert.equal(parseConfigValue(str, "сброс", "en").value, "сброс");    // in en it is just a literal value
    assert.deepEqual(parseConfigValue(str, "reset", "en"), { ok: true, value: "" });  // universal reset everywhere
  });

  test("float: range 0..1", () => {
    assert.deepEqual(parseConfigValue(flt, "0.5"), { ok: true, value: 0.5 });
    assert.equal(parseConfigValue(flt, "1.5").ok, false);
    assert.equal(parseConfigValue(flt, "-0.1").ok, false);
    assert.equal(parseConfigValue(flt, "abc").ok, false);
  });

  test("int: min/max bounds", () => {
    assert.deepEqual(parseConfigValue(intt, "8000"), { ok: true, value: 8000 });
    assert.equal(parseConfigValue(intt, "100").ok, false);     // < 500
    assert.equal(parseConfigValue(intt, "200000").ok, false);  // > 100000
  });

  test("string: reset/off/- → empty; spaces and length — error", () => {
    assert.deepEqual(parseConfigValue(str, "reset"), { ok: true, value: "" });
    assert.deepEqual(parseConfigValue(str, "сброс"), { ok: true, value: "" });
    assert.deepEqual(parseConfigValue(str, "a/b"), { ok: true, value: "a/b" });
    assert.equal(parseConfigValue(str, "a b").ok, false);          // space
    assert.equal(parseConfigValue(str, "x".repeat(200)).ok, false); // length
    assert.equal(parseConfigValue(str, "").ok, false);              // empty
  });
});


describe("setConfigParam", () => {
  test("unknown key → error message", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.match(setConfigParam(ctx, "nope", "1"), /не найден/i);
  });

  test("string reset returns a reset message", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = setConfigParam(ctx, "model", "reset");
    assert.match(out, /сброшен/i);
    assert.equal(ctx.chatData.config.model, "");
  });
});


/* ====================================================================== */
/* =====================  COMMAND PARSING  ============================= */
/* ====================================================================== */

describe("parseCommandAndArg / buildCommandRegex", () => {
  const cfg = getGlobalConfig(makeEnv());

  test("non-command → {type:'llm'}; a partial match is not treated as a command", () => {
    assert.equal(parseCommandAndArg("просто текст", cfg).type, "llm");
    assert.equal(parseCommandAndArg("/helpme", cfg).type, "llm"); // no \\s|$ boundary
    assert.equal(parseCommandAndArg("", cfg).type, "llm");
  });

  test("buildCommandRegex caches by botUsername", () => {
    const env = makeEnv();
    const a = buildCommandRegex(env, "testbot");
    const b = buildCommandRegex(env, "testbot");
    assert.equal(a, b); // same object from cache
  });
});


describe("audit: getGlobalConfig edge cases", () => {
  test("botId = null for a token without a colon and for an empty token", () => {
    assert.equal(getGlobalConfig(makeEnv({ TELEGRAM_BOT_TOKEN: "NOCOLON" })).botId, null);
    assert.equal(getGlobalConfig(makeEnv({ TELEGRAM_BOT_TOKEN: "" })).botId, null);
  });
  test("answer_prob = 0 (valid 0, not the default 0.1)", () => {
    assert.equal(getGlobalConfig(makeEnv({ ANSWER_PROB: "0" })).answer_prob, 0);
  });
  test("non-numeric MAX_HISTORY_CHARS → default 8000", () => {
    assert.equal(getGlobalConfig(makeEnv({ MAX_HISTORY_CHARS: "notanumber" })).history_chars, 8000);
  });
  test("OPENROUTER_HOST / TITLE override, botUsername → lowercase, llmLog('yes')", () => {
    const cfg = getGlobalConfig(makeEnv({ OPENROUTER_HOST: "https://h/api", OPENROUTER_TITLE: "Bot", BOT_USERNAME: "MyBot_UP", LLM_LOG: "yes" }));
    assert.equal(cfg.openrouterHost, "https://h/api");
    assert.equal(cfg.openrouterTitle, "Bot");
    assert.equal(cfg.botUsername, "mybot_up");
    assert.equal(cfg.llmLog, true);
  });
  test("buildCommandRegex yields different lists for different botUsername values", () => {
    const env = makeEnv();
    const a = buildCommandRegex(env, "bot_a");
    const b = buildCommandRegex(env, "bot_b");
    assert.notEqual(a, b);
  });
});


describe("audit: mergeConfig edge cases", () => {
  test("empty string model does NOT overwrite openrouterModel", () => {
    const g = getGlobalConfig(makeEnv()); // openrouterModel = test/model
    const m = mergeConfig(g, { model: "" });
    assert.equal(m.model, "");
    assert.equal(m.openrouterModel, "test/model");
  });
  test("empty string vision_model does NOT overwrite visionModel", () => {
    const g = getGlobalConfig(makeEnv({ OPENROUTER_VISION_MODEL: "v/env" }));
    const m = mergeConfig(g, { vision_model: "" });
    assert.equal(m.visionModel, "v/env");
  });
});


describe("audit: setConfigParam message formats", () => {
  test("float is set, the message contains meta.desc", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = setConfigParam(ctx, "answer_prob", "0.25");
    assert.equal(ctx.chatData.config.answer_prob, 0.25);
    assert.match(out, /установлен в/);
    assert.ok(out.includes("Шанс ответа"));
  });
  test("int is set", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    setConfigParam(ctx, "history_chars", "5000");
    assert.equal(ctx.chatData.config.history_chars, 5000);
  });
  test("string set: format without meta.desc", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = setConfigParam(ctx, "model", "vendor/x");
    assert.match(out, /установлен:/);
    assert.ok(out.includes("vendor/x"));
  });
  test("vision_model reset → fallback 'дефолт' (not openrouterModel)", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const out = setConfigParam(ctx, "vision_model", "reset");
    assert.ok(out.includes("дефолт"));
  });
});


describe("audit: parseConfigValue bounds and variants", () => {
  test("float/int bounds", () => {
    const flt = CONFIG_SCHEMA.answer_prob, intt = CONFIG_SCHEMA.history_chars;
    assert.deepEqual(parseConfigValue(flt, "0.0"), { ok: true, value: 0 });
    assert.deepEqual(parseConfigValue(flt, "1.0"), { ok: true, value: 1 });
    assert.deepEqual(parseConfigValue(intt, "500"), { ok: true, value: 500 });
    assert.deepEqual(parseConfigValue(intt, "100000"), { ok: true, value: 100000 });
  });
  test("bool branch does NOT trim spaces; string reset variants off/default/-", () => {
    const b = CONFIG_SCHEMA.random, s = CONFIG_SCHEMA.model;
    assert.equal(parseConfigValue(b, " on ").ok, false); // bool only does toLowerCase, no trim
    assert.equal(parseConfigValue(b, "on").ok, true);
    for (const v of ["off", "default", "-"]) assert.deepEqual(parseConfigValue(s, v), { ok: true, value: "" });
  });
});

describe("i18n: /config lang (engine UI strings)", () => {
  test("default ru — /info labels in Russian", () => {
    const ctx = makeCtxFor(makeMsg({ chatType: "private" }), makeEnv(), { ...DEFAULT_CHAT_DATA(), paused: true });
    const out = buildInfoStatus(ctx);
    assert.ok(out.includes("🎭 Роль:"));
    assert.ok(out.includes("На паузе"));
    assert.ok(out.includes("Настройки: /config"));
  });
  test("lang=en (per-chat) — engine labels in English, no Russian", () => {
    const ctx = makeCtxFor(makeMsg({ chatType: "private" }), makeEnv(), { ...DEFAULT_CHAT_DATA(), config: { lang: "en" }, paused: true });
    const out = buildInfoStatus(ctx);
    assert.ok(out.includes("🎭 Role:"));
    assert.ok(out.includes("Paused"));
    assert.ok(out.includes("Settings: /config"));
    assert.ok(!out.includes("🎭 Роль:")); // the Russian engine label does not leak through
  });
  test("BOT_LANG sets the default language", () => {
    const ctx = makeCtxFor(makeMsg({ chatType: "private" }), makeEnv({ BOT_LANG: "en" }), DEFAULT_CHAT_DATA());
    assert.ok(buildInfoStatus(ctx).includes("🎭 Role:"));
  });
});
