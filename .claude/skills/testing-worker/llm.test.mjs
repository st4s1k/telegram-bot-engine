import { vi } from "vitest";
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
  LLM_IDLE_TIMEOUT_MS,
  // харнесс
  makeEnv, makeMsg, makeKV, makeCtxFor, photoSizes, sse, jsonResp, streamResp,
  stubRandom, restoreRandom, CONSOLE, clearConsole, FETCH, newFetch,
} = H;


/* ====================================================================== */
/* =====================  LLM (OpenRouter)  ============================ */
/* ====================================================================== */

describe("callOpenRouter", () => {
  const msgs = () => [{ role: "system", content: "s" }, { role: "user", content: "u" }];

  test("успешный стрим → склейка дельт", async () => {
    const env = makeEnv();
    const cfg = getGlobalConfig(env);
    FETCH.set("chat", () => sse(["при", "вет"]));
    const out = await callOpenRouter(cfg, msgs());
    assert.equal(out, "привет");
  });

  test("буферизация неполной строки SSE между чанками", async () => {
    const cfg = getGlobalConfig(makeEnv());
    FETCH.set("chat", () => sse(["длинный ответ модели"], { splitAcrossChunks: true }));
    const out = await callOpenRouter(cfg, msgs());
    assert.equal(out, "длинный ответ модели");
  });

  test("usage.cost → addSpend (когда есть ctx и cost>0)", async () => {
    const env = makeEnv();
    const cfg = getGlobalConfig(env);
    const ctx = makeCtxFor(makeMsg(), env);
    FETCH.set("chat", () => sse(["ок"], { cost: 0.0025 }));
    await callOpenRouter(cfg, msgs(), { ctx });
    assert.ok(Math.abs(ctx.chatData.spend - 0.0025) < 1e-9);
    assert.equal(ctx.chatData.spendCount, 1);
  });

  test("HTTP 402 → FALLBACK_NO_CREDITS", async () => {
    const cfg = getGlobalConfig(makeEnv());
    FETCH.set("chat", () => jsonResp({ error: "no credits" }, { ok: false, status: 402 }));
    assert.equal(await callOpenRouter(cfg, msgs()), FALLBACK_NO_CREDITS);
  });

  test("прочий не-OK → FALLBACK_LLM_ERROR", async () => {
    const cfg = getGlobalConfig(makeEnv());
    FETCH.set("chat", () => jsonResp({ error: "boom" }, { ok: false, status: 500 }));
    assert.equal(await callOpenRouter(cfg, msgs()), FALLBACK_LLM_ERROR);
  });

  test("пустой стрим → FALLBACK_LLM_ERROR", async () => {
    const cfg = getGlobalConfig(makeEnv());
    FETCH.set("chat", () => sse([])); // только [DONE]
    assert.equal(await callOpenRouter(cfg, msgs()), FALLBACK_LLM_ERROR);
  });

  test("modelOverride попадает в payload", async () => {
    const env = makeEnv();
    const cfg = getGlobalConfig(env);
    await callOpenRouter(cfg, msgs(), { modelOverride: "vendor/vis" });
    assert.equal(FETCH.chatBody().model, "vendor/vis");
  });

  test("reasoning вкл → {exclude:true}, выкл → {enabled:false}", async () => {
    let cfg = getGlobalConfig(makeEnv()); // reasoning по умолчанию вкл
    await callOpenRouter(cfg, msgs());
    assert.deepEqual(FETCH.chatBody().reasoning, { exclude: true });

    newFetch();
    cfg = getGlobalConfig(makeEnv({ ENABLE_REASONING: "false" }));
    await callOpenRouter(cfg, msgs());
    assert.deepEqual(FETCH.chatBody().reasoning, { enabled: false });
  });

  test("payload: max_tokens = cfg.maxTokens (дефолт 4000)", async () => {
    await callOpenRouter(getGlobalConfig(makeEnv()), msgs());
    assert.equal(FETCH.chatBody().max_tokens, 4000);
  });

  test("payload: max_tokens берёт значение из cfg (env override)", async () => {
    await callOpenRouter(getGlobalConfig(makeEnv({ MAX_TOKENS: "1500" })), msgs());
    assert.equal(FETCH.chatBody().max_tokens, 1500);
  });

  test("payload: maxTokens 0/невалид → поле max_tokens не отправляется", async () => {
    await callOpenRouter(getGlobalConfig(makeEnv({ MAX_TOKENS: "0" })), msgs());
    assert.equal("max_tokens" in FETCH.chatBody(), false);
  });

  test("заголовки: Authorization + X-Title (ASCII-кодированный)", async () => {
    const env = makeEnv({ OPENROUTER_TITLE: "Бот" });
    const cfg = getGlobalConfig(env);
    await callOpenRouter(cfg, msgs());
    const h = FETCH.of("/chat/completions")[0].headers;
    assert.equal(h.Authorization, "Bearer sk-test");
    assert.equal(h["X-Title"], encodeURIComponent("Бот"));
  });

  test("payload: stream и usage.include всегда заданы", async () => {
    const cfg = getGlobalConfig(makeEnv());
    await callOpenRouter(cfg, msgs());
    const b = FETCH.chatBody();
    assert.equal(b.stream, true);
    assert.deepEqual(b.usage, { include: true });
  });
});


describe("runLLMWithHistory / toLLMMessages", () => {
  test("runLLMWithHistory: modelOverride прокидывается в запрос", async () => {
    FETCH.set("chat", () => sse(["ок"]));
    await runLLMWithHistory(getGlobalConfig(makeEnv()), "sys", [], "u", makeMsg(), { modelOverride: "google/gemini-3.5-flash" });
    assert.equal(FETCH.chatBody().model, "google/gemini-3.5-flash");
  });

  test("toLLMMessages: system + история + новый user", () => {
    const m = makeMsg({ message_id: 100, text: "вопрос" });
    const out = toLLMMessages("СИС", [{ role: "user", content: "ранее", meta: { message_id: 1 } }], "вопрос", m, { forceAppendUser: false });
    assert.equal(out.length, 3);
    assert.equal(out[0].role, "system");
    assert.equal(out[2].role, "user");
  });

  test("toLLMMessages: последний user с тем же message_id не дублируется", () => {
    const m = makeMsg({ message_id: 7 });
    const hist = [{ role: "user", content: "вопрос", meta: { message_id: 7 } }];
    const out = toLLMMessages("СИС", hist, "вопрос", m, { forceAppendUser: false });
    assert.equal(out.length, 2); // system + history, без повторного user
  });

  test("toLLMMessages: forceAppendUser добавляет user всегда", () => {
    const m = makeMsg({ message_id: 7 });
    const hist = [{ role: "user", content: "вопрос", meta: { message_id: 7 } }];
    const out = toLLMMessages("СИС", hist, "вопрос", m, { forceAppendUser: true });
    assert.equal(out.length, 3);
  });

  test("runLLMWithHistory возвращает ответ и шлёт messages", async () => {
    const env = makeEnv();
    const cfg = getGlobalConfig(env);
    FETCH.set("chat", () => sse(["готово"]));
    const out = await runLLMWithHistory(cfg, "СИС", [], "привет", makeMsg(), { forceAppendUser: true });
    assert.equal(out, "готово");
    const body = FETCH.chatBody();
    assert.equal(body.messages[0].role, "system");
    assert.ok(body.messages.length >= 2);
  });
});


describe("fetchModelPrice / fetchOpenRouterUsage", () => {
  test("цена и зрение модели", async () => {
    const cfg = getGlobalConfig(makeEnv());
    const out = await fetchModelPrice(cfg, "vendor/model");
    assert.ok(out.includes("Видит фото: да"));
    assert.ok(out.includes("вход $1.00/млн"));
    assert.ok(out.includes("выход $2.00/млн"));
  });

  test("платная модель (как qwen3.7-plus): $/млн, не «бесплатно»", async () => {
    const cfg = getGlobalConfig(makeEnv());
    FETCH.set("model", () => jsonResp({ data: { pricing: { prompt: "0.00000032", completion: "0.00000128" }, architecture: { input_modalities: ["text", "image"] } } }));
    const out = await fetchModelPrice(cfg, "qwen/qwen3.7-plus");
    assert.ok(out.includes("вход $0.32/млн"), out);
    assert.ok(out.includes("выход $1.28/млн"), out);
    assert.ok(!out.includes("бесплатно"));
  });

  test("настоящий 0 → «бесплатно»", async () => {
    const cfg = getGlobalConfig(makeEnv());
    FETCH.set("model", () => jsonResp({ data: { pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"] } } }));
    const out = await fetchModelPrice(cfg, "free/model");
    assert.ok(out.includes("вход бесплатно"));
    assert.ok(out.includes("выход бесплатно"));
  });

  test("цена не пришла (null/пусто) → «нет данных», НЕ «бесплатно»", async () => {
    const cfg = getGlobalConfig(makeEnv());
    FETCH.set("model", () => jsonResp({ data: { pricing: { prompt: null, completion: "" }, architecture: { input_modalities: ["text"] } } }));
    const out = await fetchModelPrice(cfg, "x/y");
    assert.ok(out.includes("вход нет данных"), out);
    assert.ok(out.includes("выход нет данных"), out);
    assert.ok(!out.includes("бесплатно"));
  });

  test("тильда в id убирается, сегменты id не ломают путь", async () => {
    const cfg = getGlobalConfig(makeEnv());
    await fetchModelPrice(cfg, "~author/slug");
    assert.ok(FETCH.of("/model/")[0].url.includes("/model/author/slug"));
  });

  test("HTTP-ошибка или отсутствие pricing → пустая строка", async () => {
    const cfg = getGlobalConfig(makeEnv());
    FETCH.set("model", () => jsonResp({}, { ok: false, status: 404 }));
    assert.equal(await fetchModelPrice(cfg, "x/y"), "");
    newFetch();
    FETCH.set("model", () => jsonResp({ data: {} }));
    assert.equal(await fetchModelPrice(cfg, "x/y"), "");
  });

  test("пустой id → пустая строка без запроса", async () => {
    const cfg = getGlobalConfig(makeEnv());
    assert.equal(await fetchModelPrice(cfg, ""), "");
    assert.equal(FETCH.of("/model/").length, 0);
  });

  test("usage: provisioning-ключ → /credits (полный баланс)", async () => {
    const cfg = getGlobalConfig(makeEnv({ OPENROUTER_PROVISIONING_KEY: "prov-key" }));
    const out = await fetchOpenRouterUsage(cfg);
    assert.ok(out.includes("$5.00 из $20.00"));
    assert.ok(out.includes("осталось $15.00"));
  });

  test("usage: без provisioning → /key с лимитом", async () => {
    const cfg = getGlobalConfig(makeEnv());
    const out = await fetchOpenRouterUsage(cfg);
    assert.ok(out.includes("$1.50 из $10.00"));
    assert.ok(out.includes("осталось $8.50"));
  });

  test("usage: /key без лимита → только потрачено", async () => {
    const cfg = getGlobalConfig(makeEnv());
    FETCH.set("key", () => jsonResp({ data: { usage: 1.5, limit: null } }));
    const out = await fetchOpenRouterUsage(cfg);
    assert.ok(out.includes("Потрачено: $1.50"));
    assert.ok(out.includes("OPENROUTER_PROVISIONING_KEY"));
  });

  test("usage: нет ключа OpenRouter → заглушка", async () => {
    const cfg = getGlobalConfig(makeEnv({ OPENROUTER_API_KEY: "" }));
    const out = await fetchOpenRouterUsage(cfg);
    assert.ok(out.includes("ключ OpenRouter не задан"));
  });
});


describe("аудит: LLM краевые", () => {
  const msgs = () => [{ role: "system", content: "s" }, { role: "user", content: "u" }];

  test("AbortError / сетевая ошибка fetch → FALLBACK_LLM_ERROR", async () => {
    const cfg = getGlobalConfig(makeEnv());
    FETCH.set("chat", () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
    assert.equal(await callOpenRouter(cfg, msgs()), FALLBACK_LLM_ERROR);
    newFetch();
    FETCH.set("chat", () => { throw new Error("network down"); });
    assert.equal(await callOpenRouter(cfg, msgs()), FALLBACK_LLM_ERROR);
  });

  test("idle-таймаут: ac.abort(reason) → FALLBACK + лог 'LLM timeout', НЕ 'LLM fetch error'", async () => {
    // Реальный сценарий из прода: abort(reason) реджектит fetch строкой reason (без e.name).
    // Раньше это уходило в console.error('LLM fetch error', {msg:'hard'}) — теперь warn('LLM timeout').
    vi.useFakeTimers();
    try {
      FETCH.set("chat", () => new Promise(() => {})); // ответ не приходит никогда
      const p = callOpenRouter(getGlobalConfig(makeEnv()), msgs());
      await vi.advanceTimersByTimeAsync(LLM_IDLE_TIMEOUT_MS); // срабатывает idle-таймер → ac.abort("idle")
      assert.equal(await p, FALLBACK_LLM_ERROR);
    } finally {
      vi.useRealTimers();
    }
    assert.ok(CONSOLE.warn.some(s => s.includes("LLM timeout")), "ожидали warn 'LLM timeout'");
    assert.ok(!CONSOLE.error.some(s => s.includes("LLM fetch error")), "таймаут не должен быть error");
  });
  test("cost=0 не добавляется в spend", async () => {
    const env = makeEnv();
    const ctx = makeCtxFor(makeMsg(), env);
    FETCH.set("chat", () => sse(["ок"], { cost: 0 }));
    await callOpenRouter(getGlobalConfig(env), msgs(), { ctx });
    assert.equal(ctx.chatData.spend, 0);
    assert.equal(ctx.chatData.spendCount, 0);
  });
  test("контент только из пробелов → FALLBACK_LLM_ERROR", async () => {
    const cfg = getGlobalConfig(makeEnv());
    FETCH.set("chat", () => sse(["   \n  "]));
    assert.equal(await callOpenRouter(cfg, msgs()), FALLBACK_LLM_ERROR);
  });
  test("toLLMMessages: msg=null + forceAppendUser → бросает (зависимость от msg.from)", () => {
    assert.throws(() => toLLMMessages("s", [], "c", null, { forceAppendUser: true }));
  });
  test("toLLMMessages: последний элемент assistant → user всё равно добавляется", () => {
    const m = makeMsg({ message_id: 7 });
    const hist = [{ role: "assistant", content: "x", meta: { message_id: 7 } }];
    assert.equal(toLLMMessages("s", hist, "новое", m, { forceAppendUser: false }).length, 3);
  });
  test("fetchModelPrice: только цена картинки / input_modalities не массив", async () => {
    const cfg = getGlobalConfig(makeEnv());
    FETCH.set("model", () => jsonResp({ data: { pricing: { image: "0.002" }, architecture: { input_modalities: ["image"] } } }));
    const a = await fetchModelPrice(cfg, "x/y");
    assert.ok(a.includes("Видит фото: да"));
    assert.ok(a.includes("картинка $0.0020"));     // цена картинки показывается
    assert.ok(a.includes("вход нет данных"));        // текстовой цены нет → «нет данных», не «бесплатно»
    newFetch();
    FETCH.set("model", () => jsonResp({ data: { pricing: { prompt: "0.000001", completion: "0.000002" }, architecture: { input_modalities: null } } }));
    const b = await fetchModelPrice(cfg, "x/y");
    assert.ok(b.includes("Цена"));
    assert.ok(!b.includes("Видит фото"));
  });
  test("fetchOpenRouterUsage: /credits падает → фолбэк на /key", async () => {
    const cfg = getGlobalConfig(makeEnv({ OPENROUTER_PROVISIONING_KEY: "prov" }));
    FETCH.set("credits", () => jsonResp({ error: "no" }, { ok: false, status: 401 }));
    const out = await fetchOpenRouterUsage(cfg);
    assert.ok(out.includes("$1.50 из $10.00")); // данные из /key
  });
});
