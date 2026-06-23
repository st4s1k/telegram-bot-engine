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

  test("non-admin → null", async () => {
    const ctx = makeCtxFor(makeMsg({ username: "vasya", chatType: "private" }), await adminEnv());
    assert.equal(await COMMANDS.admin(ctx, { argText: "chats" }), null);
  });
  test("admin, but not in a private chat → null", async () => {
    const ctx = makeCtxFor(makeMsg({ username: "admin", chatType: "group" }), await adminEnv());
    assert.equal(await COMMANDS.admin(ctx, { argText: "chats" }), null);
  });
  test("without a subcommand → help", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    assert.match(await COMMANDS.admin(ctx, { argText: "" }), /Админ-команды/);
  });

  // --- admin list via env ADMIN_USERNAMES ---
  test("ADMIN_USERNAMES: anyone from the CSV list (with spaces) is an admin", async () => {
    const env = makeEnv({ ADMIN_USERNAMES: "alice, admin , Bob" });
    for (const u of ["alice", "bob", "admin"]) {
      const ctx = makeCtxFor(makeMsg({ username: u, chatType: "private" }), env);
      assert.match(await COMMANDS.admin(ctx, { argText: "" }), /Админ-команды/, `${u} should be an admin`);
    }
  });
  test("ADMIN_USERNAMES: case-insensitive username comparison", async () => {
    const env = makeEnv({ ADMIN_USERNAMES: "alice" });
    const ctx = makeCtxFor(makeMsg({ username: "ALICE", chatType: "private" }), env);
    assert.match(await COMMANDS.admin(ctx, { argText: "" }), /Админ-команды/);
  });
  test("ADMIN_USERNAMES: anyone not in the list → null (default admin displaced)", async () => {
    const env = makeEnv({ ADMIN_USERNAMES: "alice,bob" });
    const ctx = makeCtxFor(makeMsg({ username: "admin", chatType: "private" }), env);
    assert.equal(await COMMANDS.admin(ctx, { argText: "" }), null);
  });
  test("ADMIN_USERNAMES empty → NO admins (engine has no hardcoded default)", async () => {
    const ctx = makeCtxFor(makeMsg({ username: "admin", chatType: "private" }), makeEnv({ ADMIN_USERNAMES: "" }));
    assert.equal(await COMMANDS.admin(ctx, { argText: "" }), null);
  });
  test("chats → list of sessions with spend", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    const out = await COMMANDS.admin(ctx, { argText: "chats" });
    assert.ok(out.includes("Сессии"));
    assert.ok(out.includes("-100"));
    assert.ok(out.includes("Суммарный расход"));
  });
  test("stats → summary", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    const out = await COMMANDS.admin(ctx, { argText: "stats" });
    assert.ok(out.includes("Сводка"));
    assert.ok(out.includes("личных"));
  });
  test("chat <id> → session details", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    const out = await COMMANDS.admin(ctx, { argText: "chat -100" });
    assert.ok(out.includes("-100"));
    assert.ok(out.includes("Группа A"));
  });
  test("chat_cmd: an allowed command runs in the target chat", async () => {
    const env = await adminEnv();
    const ctx = makeCtxFor(adminMsg(), env);
    const out = await COMMANDS.admin(ctx, { argText: "chat_cmd -100 rp ты вежливый" });
    assert.ok(out.includes("rp"));
    assert.ok(out.includes("принята"));
    assert.equal((await dbChat(env, -100)).role, "ты вежливый"); // target chat updated in D1
  });
  test("chat_cmd: info reads the target chat's status (its model, not the admin's)", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    const out = await COMMANDS.admin(ctx, { argText: "chat_cmd -100 info" });
    assert.ok(out.includes("info"));
    assert.ok(out.includes("🎭"));
    assert.ok(out.includes("m/x")); // the TARGET chat's model (config.model), not the admin's default test/model
  });
  test("chat_cmd: model requests the price of the target chat's model, not the admin's default", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    await COMMANDS.admin(ctx, { argText: "chat_cmd -100 model" });
    const urls = FETCH.of("/model/").map(c => c.url);
    assert.ok(urls.some(u => u.includes("/model/m/x")), urls.join(" | "));
    assert.ok(!urls.some(u => u.includes("test/model")), "the admin's model must not be requested");
  });
  test("chat_cmd: an LLM preview does NOT persist to the target chat (memory/history/spend)", async () => {
    const env = makeEnv();
    await seedChat(env, -100, {
      config: { rag: true }, // curation enabled on the TARGET chat
      spend: 0.01, spendCount: 2,
      history: [
        { role: "user", content: "меня зовут Иван, работаю в Кишинёве", meta: { message_id: 1 } },
        { role: "user", content: "люблю рыбалку по выходным", meta: { message_id: 2 } },
        { role: "assistant", content: "ага", meta: { message_id: 3 } },
      ],
    });
    const ctx = makeCtxFor(adminMsg(), env);
    // If curation ran (a bug), this response would be parsed into facts and sent to addMemory
    // (write-through, bypassing the skipped flush) → it would leak into the target chat's memory.
    FETCH.set("chat", () => sse(["- Ивана зовут Иван\n- Любит рыбалку"], { cost: 0.05 }));
    const out = await COMMANDS.admin(ctx, { argText: "chat_cmd -100 summary" });
    assert.ok(out.includes("summary"));                    // the preview response returned to the admin
    assert.equal((await dbMemories(env, -100)).length, 0);  // curation suppressed in preview — facts did not leak
    assert.equal((await dbHistory(env, -100)).length, 3);   // the target chat's history is untouched
    assert.equal(Number((await dbChat(env, -100)).spend), 0.01); // existing spend not overwritten/not increased
  });
  test("chat_cmd: the admin command is rejected (no recursion)", async () => {
    const ctx = makeCtxFor(adminMsg(), await adminEnv());
    const out = await COMMANDS.admin(ctx, { argText: "chat_cmd -100 admin chats" });
    assert.match(out, /недопустимая команда/i);
  });
});


/* ====================================================================== */
/* =====================  handleTelegramMessage (routing)  ============= */
/* ====================================================================== */

describe("handleTelegramMessage", () => {
  test("plain text in a private chat → replies, history in D1 (input + reply)", async () => {
    const env = makeEnv();
    FETCH.set("chat", () => sse(["привет-привет"]));
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, text: "хай" }), env);
    assert.equal(FETCH.sends()[0].body.text.includes("привет"), true);
    const hist = await dbHistory(env, 555);
    assert.ok(hist.some(h => h.role === "user" && h.content === "хай"));
    assert.ok(hist.some(h => h.role === "assistant" && h.content.includes("привет")));
  });

  test("edit → updates history, does NOT reply", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: [{ role: "user", content: "старое", meta: { message_id: 10 } }] });
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, message_id: 10, text: "новое" }), env, true);
    assert.equal(FETCH.sends().length, 0);
    assert.equal((await dbHistory(env, 555))[0].content, "новое");
  });

  test("photo without vision and without a command → photo branch (note), no reply", async () => {
    const env = makeEnv();
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, photo: photoSizes("K"), caption: "гляди" }), env);
    assert.equal(FETCH.sends().length, 0);
    assert.ok((await dbHistory(env, 555)).at(-1).content.includes("[фото"));
  });

  test("paused and not a command → logs, but stays silent", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { paused: true });
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, text: "эй" }), env);
    assert.equal(FETCH.sends().length, 0);
    assert.equal((await dbHistory(env, 555)).at(-1).content, "эй"); // incoming message logged
  });

  test("while paused, the /resume command is processed", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { paused: true });
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, text: "/resume" }), env);
    assert.equal(FETCH.sends().length, 1);
    assert.ok(!(await dbChat(env, 555)).paused);
  });

  test("a TECH command (/help) is NOT written to history (neither the call nor the reply)", async () => {
    const env = makeEnv();
    await seedChat(env, 555, { history: [{ role: "user", content: "раньше", meta: { message_id: 1 } }] });
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 555, message_id: 50, text: "/help" }), env);
    assert.equal(FETCH.sends().length, 1); // the /help reply is still sent to the chat
    const hist = await dbHistory(env, 555);
    assert.ok(!hist.some(h => h.content === "/help")); // the command call is not logged
    assert.ok(!hist.some(h => h.role === "assistant")); // and the reply isn't either (skipHistory)
    assert.equal(hist.length, 1); // only the previous message
  });

  test("updates the chat name (_name) from the incoming message", async () => {
    const env = makeEnv();
    FETCH.set("chat", () => sse(["ок"]));
    await handleTelegramMessage(makeMsg({ chatType: "group", chatId: -100, chatTitle: "Беседа", text: "@testbot привет" }), env);
    assert.equal((await dbChat(env, -100)).name, "Беседа");
  });
});


/* ====================================================================== */
/* =====================  fetch ENTRY POINT  ========================== */
/* ====================================================================== */

describe("default.fetch (webhook)", () => {
  const ctxObj = { waitUntil() {} };
  const post = (update) => ({ method: "POST", json: async () => update });

  test("GET → string about the worker running", async () => {
    const res = await WORKER.fetch({ method: "GET" }, makeEnv(), ctxObj);
    assert.ok((await res.text()).includes("running"));
  });

  test("message without text/photo/sticker → ok, no processing", async () => {
    const env = makeEnv();
    const upd = { update_id: 1, message: { chat: { id: 1, type: "private" }, from: {}, message_id: 1 } };
    const res = await WORKER.fetch(post(upd), env, ctxObj);
    assert.equal(await res.text(), "ok");
    assert.equal(FETCH.sends().length, 0);
  });

  test("valid message → processed", async () => {
    const env = makeEnv();
    FETCH.set("chat", () => sse(["здарова"]));
    const upd = { update_id: 2, message: makeMsg({ chatType: "private", chatId: 555, text: "привет" }) };
    const res = await WORKER.fetch(post(upd), env, ctxObj);
    assert.equal(await res.text(), "ok");
    assert.equal(FETCH.sends().length, 1);
  });

  test("dedup by update_id: a repeated update is ignored", async () => {
    const env = makeEnv();
    FETCH.set("chat", () => sse(["раз"]));
    const upd = { update_id: 77, message: makeMsg({ chatType: "private", chatId: 555, text: "привет" }) };
    await WORKER.fetch(post(upd), env, ctxObj);
    assert.equal(FETCH.sends().length, 1);
    await WORKER.fetch(post(upd), env, ctxObj); // the same update_id
    assert.equal(FETCH.sends().length, 1); // not processed the second time
  });

  test("an error in the handler is swallowed → always ok", async () => {
    const env = makeEnv();
    delete env.DB; // appendHistory throws (no DB) → WORKER.fetch catches it
    FETCH.set("chat", () => sse(["ок"]));
    const upd = { update_id: 3, message: makeMsg({ chatType: "private", text: "привет" }) };
    const res = await WORKER.fetch(post(upd), env, ctxObj);
    assert.equal(await res.text(), "ok");
  });

  test("broken JSON in the body → ok, no crash", async () => {
    const badReq = { method: "POST", json: async () => { throw new SyntaxError("bad json"); } };
    const res = await WORKER.fetch(badReq, makeEnv(), ctxObj);
    assert.equal(await res.text(), "ok");
  });

  test("message with only a sticker → processed (photo branch)", async () => {
    const env = makeEnv();
    const upd = { update_id: 10, message: { chat: { id: 555, type: "private" }, from: { first_name: "A" }, message_id: 1, sticker: { file_id: "s", file_unique_id: "u", emoji: "😂" } } };
    const res = await WORKER.fetch(post(upd), env, ctxObj);
    assert.equal(await res.text(), "ok");
    assert.equal(FETCH.sends().length, 0); // vision off → note only
    assert.ok((await dbHistory(env, 555)).at(-1).content.includes("[стикер"));
  });
});


/* ====================================================================== */
/* ========  EXTRA AUDIT COVERAGE (edge branches/error paths)  ======== */
/* ====================================================================== */

describe("audit: entry point and routing", () => {
  test("a D1 write error in finally is swallowed (not rethrown)", async () => {
    const env = makeEnv();
    const realDB = env.DB;
    // Break only the state UPSERT (flushChatData); history (messages) writes normally.
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

  test("a chats READ failure in getChatData does not overwrite the real row with defaults", async () => {
    const env = makeEnv();
    await seedChat(env, 556, { role: "маньяк", spend: 1.23, spendCount: 5, config: { rag: true }, _dailyUptoId: 42 });
    const realDB = env.DB;
    // Break ONLY the state read (SELECT * FROM chats); messages and all writes work.
    env.DB = {
      prepare(sql) {
        if (sql.includes("SELECT * FROM chats")) return { bind: () => ({ first: async () => { throw new Error("d1 read down"); } }) };
        return realDB.prepare(sql);
      },
      batch: (s) => realDB.batch(s),
    };
    FETCH.set("chat", () => sse(["ок"]));
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 556, text: "привет" }), env);
    env.DB = realDB; // restore the working DB for the assertions

    const row = await dbChat(env, 556);
    assert.equal(row.role, "маньяк");             // role NOT overwritten with the default (null)
    assert.equal(Number(row.spend), 1.23);        // spend NOT zeroed
    assert.equal(Number(row.daily_upto_id), 42);  // summary boundary intact
    const hist = await dbHistory(env, 556);
    assert.ok(hist.some(h => h.content === "привет")); // the incoming message is still saved (write-through)
  });
});


describe("audit: admin helpers", () => {
  test("admin chat without an id → hint", async () => {
    const ctx = makeCtxFor(makeMsg({ username: "admin", chatType: "private" }), makeEnv());
    assert.match(await COMMANDS.admin(ctx, { argText: "chat" }), /Укажи id/);
  });
  test("admin chat_cmd with a non-numeric id → error", async () => {
    const ctx = makeCtxFor(makeMsg({ username: "admin", chatType: "private" }), makeEnv());
    assert.match(await COMMANDS.admin(ctx, { argText: "chat_cmd rp ты" }), /числовой chatId/);
  });
});
