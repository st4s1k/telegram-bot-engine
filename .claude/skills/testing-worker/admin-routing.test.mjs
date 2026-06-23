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
  // харнесс
  makeEnv, makeMsg, makeKV, makeCtxFor, photoSizes, sse, jsonResp, streamResp,
  stubRandom, restoreRandom, CONSOLE, clearConsole, FETCH, newFetch,
  seedChat, dbChat, dbHistory, dbMemories,
} = H;


/* ====================================================================== */
/* =====================  /admin  ===================================== */
/* ====================================================================== */

describe("COMMANDS.admin", () => {
  async function adminEnv() {
    const env = makeEnv();
    await seedChat(env, -100, {
      history: [{ role: "user", content: "a", meta: { message_id: 1 } }, { role: "assistant", content: "b", meta: { message_id: 2 } }],
      spend: 0.01, spendCount: 2, role: "x", _name: "Группа A", config: { model: "m/x" }, personaState: { arousal: 3 },
    });
    await seedChat(env, 42, { history: [], _name: "Аня" });
    return env;
  }
  const adminMsg = () => makeMsg({ username: "admin", chatType: "private" });

  test("не-админ → null", async () => {
    const ctx = makeCtxFor(makeMsg({ username: "vasya", chatType: "private" }), await adminEnv());
    assert.equal(await COMMANDS.admin(ctx, { argText: "chats" }), null);
  });
  test("админ, но не в личке → null", async () => {
    const ctx = makeCtxFor(makeMsg({ username: "admin", chatType: "group" }), await adminEnv());
    assert.equal(await COMMANDS.admin(ctx, { argText: "chats" }), null);
  });
  test("без подкоманды → справка", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    assert.match(await COMMANDS.admin(ctx, { argText: "" }), /Админ-команды/);
  });

  // --- список админов через env ADMIN_USERNAMES ---
  test("ADMIN_USERNAMES: любой из CSV-списка (с пробелами) — админ", async () => {
    const env = makeEnv({ ADMIN_USERNAMES: "alice, admin , Bob" });
    for (const u of ["alice", "bob", "admin"]) {
      const ctx = makeCtxFor(makeMsg({ username: u, chatType: "private" }), env);
      assert.match(await COMMANDS.admin(ctx, { argText: "" }), /Админ-команды/, `${u} должен быть админом`);
    }
  });
  test("ADMIN_USERNAMES: сравнение без учёта регистра username", async () => {
    const env = makeEnv({ ADMIN_USERNAMES: "alice" });
    const ctx = makeCtxFor(makeMsg({ username: "ALICE", chatType: "private" }), env);
    assert.match(await COMMANDS.admin(ctx, { argText: "" }), /Админ-команды/);
  });
  test("ADMIN_USERNAMES: кто не в списке → null (дефолтный admin вытеснен)", async () => {
    const env = makeEnv({ ADMIN_USERNAMES: "alice,bob" });
    const ctx = makeCtxFor(makeMsg({ username: "admin", chatType: "private" }), env);
    assert.equal(await COMMANDS.admin(ctx, { argText: "" }), null);
  });
  test("ADMIN_USERNAMES пустой → НЕТ админов (движок без хардкод-дефолта)", async () => {
    const ctx = makeCtxFor(makeMsg({ username: "admin", chatType: "private" }), makeEnv({ ADMIN_USERNAMES: "" }));
    assert.equal(await COMMANDS.admin(ctx, { argText: "" }), null);
  });
  test("chats → список сессий с расходом", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    const out = await COMMANDS.admin(ctx, { argText: "chats" });
    assert.ok(out.includes("Сессии"));
    assert.ok(out.includes("-100"));
    assert.ok(out.includes("Суммарный расход"));
  });
  test("stats → сводка", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    const out = await COMMANDS.admin(ctx, { argText: "stats" });
    assert.ok(out.includes("Сводка"));
    assert.ok(out.includes("личных"));
  });
  test("chat <id> → детали сессии", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    const out = await COMMANDS.admin(ctx, { argText: "chat -100" });
    assert.ok(out.includes("-100"));
    assert.ok(out.includes("Группа A"));
  });
  test("chat_cmd: разрешённая команда исполняется в целевом чате", async () => {
    const env = await adminEnv();
    const ctx = makeCtxFor(adminMsg(), env);
    const out = await COMMANDS.admin(ctx, { argText: "chat_cmd -100 rp ты вежливый" });
    assert.ok(out.includes("rp"));
    assert.ok(out.includes("принята"));
    assert.equal((await dbChat(env, -100)).role, "ты вежливый"); // целевой чат обновлён в D1
  });
  test("chat_cmd: info читает статус целевого чата (его модель, не админскую)", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    const out = await COMMANDS.admin(ctx, { argText: "chat_cmd -100 info" });
    assert.ok(out.includes("info"));
    assert.ok(out.includes("🎭"));
    assert.ok(out.includes("m/x")); // модель ЦЕЛЕВОГО чата (config.model), не админский дефолт test/model
  });
  test("chat_cmd: model запрашивает цену модели целевого чата, не админского дефолта", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    await COMMANDS.admin(ctx, { argText: "chat_cmd -100 model" });
    const urls = FETCH.of("/model/").map(c => c.url);
    assert.ok(urls.some(u => u.includes("/model/m/x")), urls.join(" | "));
    assert.ok(!urls.some(u => u.includes("test/model")), "не должна запрашиваться модель админа");
  });
  test("chat_cmd: LLM-превью НЕ персистит в целевой чат (память/история/spend)", async () => {
    const env = makeEnv();
    await seedChat(env, -100, {
      config: { rag: true }, // курация включена у ЦЕЛЕВОГО чата
      spend: 0.01, spendCount: 2,
      history: [
        { role: "user", content: "меня зовут Иван, работаю в Кишинёве", meta: { message_id: 1 } },
        { role: "user", content: "люблю рыбалку по выходным", meta: { message_id: 2 } },
        { role: "assistant", content: "ага", meta: { message_id: 3 } },
      ],
    });
    const ctx = makeCtxFor(adminMsg(), env);
    // Если бы курация выполнилась (баг), этот ответ распарсился бы в факты и ушёл бы в addMemory
    // (write-through, в обход пропущенного flush) → утёк бы в память целевого чата.
    FETCH.set("chat", () => sse(["- Ивана зовут Иван\n- Любит рыбалку"], { cost: 0.05 }));
    const out = await COMMANDS.admin(ctx, { argText: "chat_cmd -100 summary" });
    assert.ok(out.includes("summary"));                    // ответ-превью вернулся админу
    assert.equal((await dbMemories(env, -100)).length, 0);  // курация в превью подавлена — факты не утекли
    assert.equal((await dbHistory(env, -100)).length, 3);   // история целевого чата не тронута
    assert.equal(Number((await dbChat(env, -100)).spend), 0.01); // существующий spend не затёрт/не увеличен
  });
  test("chat_cmd: команда admin отклонена (без рекурсии)", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    const out = await COMMANDS.admin(ctx, { argText: "chat_cmd -100 admin chats" });
    assert.match(out, /недопустимая команда/i);
  });
});


/* ====================================================================== */
/* =====================  handleTelegramMessage (роутинг)  ============= */
/* ====================================================================== */

describe("handleTelegramMessage", () => {
  test("обычный текст в личке → отвечает, история в D1 (вход + ответ)", async () => {
    const env = makeEnv();
    FETCH.set("chat", () => sse(["привет-привет"]));
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, text: "хай" }), env);
    assert.equal(FETCH.sends()[0].body.text.includes("привет"), true);
    const hist = await dbHistory(env, 555);
    assert.ok(hist.some(h => h.role === "user" && h.content === "хай"));
    assert.ok(hist.some(h => h.role === "assistant" && h.content.includes("привет")));
  });

  test("редактирование → обновляет историю, НЕ отвечает", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: [{ role: "user", content: "старое", meta: { message_id: 10 } }] });
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, message_id: 10, text: "новое" }), env, true);
    assert.equal(FETCH.sends().length, 0);
    assert.equal((await dbHistory(env, 555))[0].content, "новое");
  });

  test("фото без зрения и без команды → ветка фото (пометка), без ответа", async () => {
    const env = makeEnv();
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, photo: photoSizes("K"), caption: "гляди" }), env);
    assert.equal(FETCH.sends().length, 0);
    assert.ok((await dbHistory(env, 555)).at(-1).content.includes("[фото"));
  });

  test("на паузе и не команда → логирует, но молчит", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { paused: true });
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, text: "эй" }), env);
    assert.equal(FETCH.sends().length, 0);
    assert.equal((await dbHistory(env, 555)).at(-1).content, "эй"); // входящее залогировано
  });

  test("на паузе команда /resume — обрабатывается", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { paused: true });
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, text: "/resume" }), env);
    assert.equal(FETCH.sends().length, 1);
    assert.ok(!(await dbChat(env, 555)).paused);
  });

  test("TECH-команда (/help) НЕ пишется в историю (ни вызов, ни ответ)", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: [{ role: "user", content: "раньше", meta: { message_id: 1 } }] });
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, message_id: 50, text: "/help" }), env);
    assert.equal(FETCH.sends().length, 1); // ответ /help всё равно отправлен в чат
    const hist = await dbHistory(env, 555);
    assert.ok(!hist.some(h => h.content === "/help")); // вызов команды не залогирован
    assert.ok(!hist.some(h => h.role === "assistant")); // и ответ тоже (skipHistory)
    assert.equal(hist.length, 1); // только прежнее сообщение
  });

  test("обновляет имя чата (_name) из входящего сообщения", async () => {
    const env = makeEnv();
    FETCH.set("chat", () => sse(["ок"]));
    await handleTelegramMessage(makeMsg({ chatType: "group", chatId: -100, chatTitle: "Беседа", text: "@testbot привет" }), env);
    assert.equal((await dbChat(env, -100)).name, "Беседа");
  });
});


/* ====================================================================== */
/* =====================  ТОЧКА ВХОДА fetch  ========================== */
/* ====================================================================== */

describe("default.fetch (вебхук)", () => {
  const ctxObj = { waitUntil() {} };
  const post = (update) => ({ method: "POST", json: async () => update });

  test("GET → строка о работе воркера", async () => {
    const res = await WORKER.fetch({ method: "GET" }, makeEnv(), ctxObj);
    assert.ok((await res.text()).includes("running"));
  });

  test("сообщение без text/photo/sticker → ok, без обработки", async () => {
    const env = makeEnv();
    const upd = { update_id: 1, message: { chat: { id: 1, type: "private" }, from: {}, message_id: 1 } };
    const res = await WORKER.fetch(post(upd), env, ctxObj);
    assert.equal(await res.text(), "ok");
    assert.equal(FETCH.sends().length, 0);
  });

  test("валидное сообщение → обрабатывается", async () => {
    const env = makeEnv();
    FETCH.set("chat", () => sse(["здарова"]));
    const upd = { update_id: 2, message: makeMsg({ chatType: "private", chatId: 555, text: "привет" }) };
    const res = await WORKER.fetch(post(upd), env, ctxObj);
    assert.equal(await res.text(), "ok");
    assert.equal(FETCH.sends().length, 1);
  });

  test("дедуп по update_id: повторный апдейт игнорируется", async () => {
    const env = makeEnv();
    FETCH.set("chat", () => sse(["раз"]));
    const upd = { update_id: 77, message: makeMsg({ chatType: "private", chatId: 555, text: "привет" }) };
    await WORKER.fetch(post(upd), env, ctxObj);
    assert.equal(FETCH.sends().length, 1);
    await WORKER.fetch(post(upd), env, ctxObj); // тот же update_id
    assert.equal(FETCH.sends().length, 1); // второй раз не обработан
  });

  test("ошибка в обработчике проглатывается → всегда ok", async () => {
    const env = makeEnv();
    delete env.DB; // appendHistory кинет (нет DB) → WORKER.fetch поймает
    FETCH.set("chat", () => sse(["ок"]));
    const upd = { update_id: 3, message: makeMsg({ chatType: "private", text: "привет" }) };
    const res = await WORKER.fetch(post(upd), env, ctxObj);
    assert.equal(await res.text(), "ok");
  });

  test("битый JSON в теле → ok, без падения", async () => {
    const badReq = { method: "POST", json: async () => { throw new SyntaxError("bad json"); } };
    const res = await WORKER.fetch(badReq, makeEnv(), ctxObj);
    assert.equal(await res.text(), "ok");
  });

  test("сообщение только со стикером → обрабатывается (ветка фото)", async () => {
    const env = makeEnv();
    const upd = { update_id: 10, message: { chat: { id: 555, type: "private" }, from: { first_name: "A" }, message_id: 1, sticker: { file_id: "s", file_unique_id: "u", emoji: "😂" } } };
    const res = await WORKER.fetch(post(upd), env, ctxObj);
    assert.equal(await res.text(), "ok");
    assert.equal(FETCH.sends().length, 0); // зрение выкл → только пометка
    assert.ok((await dbHistory(env, 555)).at(-1).content.includes("[стикер"));
  });
});


/* ====================================================================== */
/* ========  ДОП. ПОКРЫТИЕ ПО АУДИТУ (краевые ветки/error-пути)  ======== */
/* ====================================================================== */

describe("аудит: точка входа и роутинг", () => {
  test("ошибка записи в D1 в finally проглатывается (не пробрасывается)", async () => {
    const env = makeEnv();
    const realDB = env.DB;
    // Ломаем только UPSERT состояния (flushChatData); история (messages) пишется нормально.
    env.DB = {
      prepare(sql) {
        if (sql.includes("INSERT INTO chats")) return { bind: () => ({ run: async () => { throw new Error("d1 down"); } }) };
        return realDB.prepare(sql);
      },
      batch: (s) => realDB.batch(s),
    };
    FETCH.set("chat", () => sse(["ок"]));
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, text: "привет" }), env);
    assert.equal(FETCH.sends().length, 1);
    assert.ok(CONSOLE.error.some(l => l.includes("flushChatData")));
  });

  test("сбой ЧТЕНИЯ chats в getChatData не затирает реальную строку дефолтами", async () => {
    const env = makeEnv();
    await seedChat(env, 556, { role: "маньяк", spend: 1.23, spendCount: 5, config: { rag: true }, _dailyUptoId: 42 });
    const realDB = env.DB;
    // Ломаем ТОЛЬКО чтение состояния (SELECT * FROM chats); messages и все записи работают.
    env.DB = {
      prepare(sql) {
        if (sql.includes("SELECT * FROM chats")) return { bind: () => ({ first: async () => { throw new Error("d1 read down"); } }) };
        return realDB.prepare(sql);
      },
      batch: (s) => realDB.batch(s),
    };
    FETCH.set("chat", () => sse(["ок"]));
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 556, text: "привет" }), env);
    env.DB = realDB; // вернуть рабочую БД для ассертов

    const row = await dbChat(env, 556);
    assert.equal(row.role, "маньяк");             // роль НЕ затёрта дефолтом (null)
    assert.equal(Number(row.spend), 1.23);        // расход НЕ обнулён
    assert.equal(Number(row.daily_upto_id), 42);  // граница сводки цела
    const hist = await dbHistory(env, 556);
    assert.ok(hist.some(h => h.content === "привет")); // входящее сообщение всё же сохранено (write-through)
  });
});


describe("аудит: admin вспомогательные", () => {
  test("admin chat без id → подсказка", async () => {
    const ctx = makeCtxFor(makeMsg({ username: "admin", chatType: "private" }), makeEnv());
    assert.match(await COMMANDS.admin(ctx, { argText: "chat" }), /Укажи id/);
  });
  test("admin chat_cmd с нечисловым id → ошибка", async () => {
    const ctx = makeCtxFor(makeMsg({ username: "admin", chatType: "private" }), makeEnv());
    assert.match(await COMMANDS.admin(ctx, { argText: "chat_cmd rp ты" }), /числовой chatId/);
  });
});
