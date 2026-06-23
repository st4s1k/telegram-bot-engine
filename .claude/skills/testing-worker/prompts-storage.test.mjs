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
  DEFAULT_CHAT_DATA, getChatData, flushChatData, updatePersonaState, getPersonaStateDefaults, setRole, setPaused, saveChatConfig,
  addSpend, cachePhotoDesc, PHOTO_CACHE_CAP, messagesSince,
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
  seedChat, dbChat, dbHistory,
} = H;


/* ====================================================================== */
/* =====================  ПРОМПТЫ  ===================================== */
/* ====================================================================== */

describe("промпты", () => {
  test("buildVisionPrompt содержит разделитель PHOTO_DELIM", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    assert.ok(buildVisionPrompt(ctx).includes(PHOTO_DELIM));
  });
});


/* ====================================================================== */
/* =====================  CTX / ВИЗУАЛ  ================================= */
/* ====================================================================== */

describe("visualFromMsg / makeCtx", () => {
  test("photo → kind photo", () => {
    const v = visualFromMsg(makeMsg({ photo: photoSizes("P") }));
    assert.equal(v.kind, "photo");
    assert.equal(v.photos.length, 3);
  });

  test("статичный стикер → сам файл как картинка", () => {
    const v = visualFromMsg({ sticker: { file_id: "S1", file_unique_id: "U1", emoji: "😂" } });
    assert.equal(v.kind, "sticker");
    assert.equal(v.emoji, "😂");
    assert.equal(v.photos[0].file_id, "S1");
  });

  test("анимированный стикер → thumbnail как картинка", () => {
    const v = visualFromMsg({ sticker: { is_animated: true, emoji: "🔥", thumbnail: { file_id: "T1" }, file_unique_id: "U2" } });
    assert.equal(v.photos[0].file_id, "T1");
    assert.equal(v.emoji, "🔥");
  });

  test("анимированный стикер без thumbnail → картинки нет, эмодзи есть", () => {
    const v = visualFromMsg({ sticker: { is_video: true, emoji: "🎬", file_unique_id: "U3" } });
    assert.equal(v.photos, null);
    assert.equal(v.emoji, "🎬");
  });

  test("нет визуала → null", () => {
    assert.equal(visualFromMsg(makeMsg({ text: "привет" })), null);
    assert.equal(visualFromMsg(null), null);
  });

  test("makeCtx: свой визуал приоритетнее реплая; флаги", () => {
    const env = makeEnv();
    const m = makeMsg({ caption: "подпись", photo: photoSizes("OWN"), reply_to_message: makeMsg({ photo: photoSizes("REP") }) });
    const ctx = makeCtxFor(m, env);
    assert.equal(ctx.hasVisual, true);
    assert.equal(ctx.hasPhoto, true);
    assert.equal(ctx.visualKind, "photo");
    assert.equal(ctx.photoFromReply, false);
    assert.equal(ctx.textRaw, "подпись");
    assert.equal(photoCacheKey(ctx.photo), "OWN");
  });

  test("makeCtx: визуал из реплая, когда своего нет", () => {
    const m = makeMsg({ text: "что тут", reply_to_message: makeMsg({ photo: photoSizes("REP") }) });
    const ctx = makeCtxFor(m, makeEnv());
    assert.equal(ctx.photoFromReply, true);
    assert.equal(photoCacheKey(ctx.photo), "REP");
  });

  test("photoCacheKey берёт file_unique_id крупнейшего размера", () => {
    assert.equal(photoCacheKey(photoSizes("BIG")), "BIG");
    assert.equal(photoCacheKey([]), null);
    assert.equal(photoCacheKey(null), null);
  });

  test("visualLabel / visualNote", () => {
    const env = makeEnv();
    const ctxPhoto = makeCtxFor(makeMsg({ photo: photoSizes("X") }), env);
    assert.equal(visualLabel(ctxPhoto), "фото");
    const ctxSticker = makeCtxFor({ chat: { id: 1, type: "private" }, from: { first_name: "A" }, message_id: 1, sticker: { file_id: "s", file_unique_id: "u", emoji: "😎" } }, env);
    assert.equal(visualLabel(ctxSticker), "стикер 😎");
    assert.equal(visualNote("фото", "капшн", "описание"), "[фото: описание] капшн");
    assert.equal(visualNote("фото", "", "описание"), "[фото: описание]");
    assert.equal(visualNote("фото", "капшн", ""), "[фото] капшн");
    assert.equal(visualNote("фото", "", ""), "[фото]");
  });

  test("pickVisionDetail: hd-слово в подписи → high", () => {
    const cfg = getGlobalConfig(makeEnv());
    assert.equal(pickVisionDetail("ну-ка присмотрись", cfg), "high");
    assert.equal(pickVisionDetail("обычная подпись", cfg), "low");
    assert.equal(pickVisionDetail("", cfg), "low");
  });

  test("albumContext: позиция кадра и описания соседних из кэша", () => {
    const env = makeEnv();
    const cd = {
      ...DEFAULT_CHAT_DATA(),
      photoCache: { K2: "второй кадр" },
      history: [
        { role: "user", content: "[фото]", meta: { media_group_id: "G", photo_key: "K1" } },
        { role: "user", content: "[фото]", meta: { media_group_id: "G", photo_key: "K2" } },
      ],
    };
    const m = makeMsg({ reply_to_message: { media_group_id: "G", photo: photoSizes("K1") } });
    const ctx = makeCtxFor(m, env, cd);
    const out = albumContext(ctx, "K1");
    assert.ok(out.includes("1 из 2"));
    assert.ok(out.includes("второй кадр"));
    // одиночный кадр → пусто
    assert.equal(albumContext(makeCtxFor(makeMsg({ text: "x" }), env, DEFAULT_CHAT_DATA()), "K1"), "");
  });
});


/* ====================================================================== */
/* =====================  ХРАНИЛИЩЕ (KV)  ============================== */
/* ====================================================================== */

describe("getChatData / flushChatData", () => {
  test("пустой KV → дефолтная структура", async () => {
    const env = makeEnv();
    const cd = await getChatData(1, env);
    assert.deepEqual(cd.history, []);
    assert.deepEqual(cd.personaState, getPersonaStateDefaults());
    assert.equal(cd.role, null);
    assert.equal(cd.paused, false);
    assert.equal(cd.spend, 0);
  });

  test("читает состояние + историю; дедуп по UNIQUE(role,message_id)", async () => {
    const env = makeEnv();
    await seedChat(env, 9, {
      history: [
        { role: "user", content: "a", meta: { message_id: 1 } },
        { role: "user", content: "a", meta: { message_id: 1 } }, // дубль → OR IGNORE
      ],
      personaState: { arousal: 2 }, role: "x", paused: true, spend: 0.5, spendCount: 3,
    });
    const cd = await getChatData(9, env);
    assert.equal(cd.history.length, 1); // дедуп
    assert.equal(cd.personaState.arousal, 2);
    assert.equal(cd.spend, 0.5);
    assert.equal(cd.role, "x");
    assert.equal(cd.paused, true);
  });

  test("flushChatData: UPSERT строки chats (state, без истории)", async () => {
    const env = makeEnv();
    await flushChatData(7, env, { ...DEFAULT_CHAT_DATA(), _dirty: true, _name: "new", personaState: { arousal: 4 }, role: "z", spend: 0.1 });
    const row = await dbChat(env, 7);
    assert.equal(row.name, "new");
    assert.equal(JSON.parse(row.persona_state).arousal, 4);
    assert.equal(row.role, "z");
    await flushChatData(7, env, { ...DEFAULT_CHAT_DATA(), _name: "new", personaState: { arousal: 1 } }); // UPSERT, не дубль
    assert.equal(JSON.parse((await dbChat(env, 7)).persona_state).arousal, 1);
  });

  test("границы сводок/памяти (daily/cmd/cmd_day/mem) сохраняются и читаются через round-trip", async () => {
    const env = makeEnv();
    await flushChatData(7, env, { ...DEFAULT_CHAT_DATA(), _dailyUptoId: 42, _cmdUptoId: 40, _cmdDay: "2026-06-20", _memUptoId: 41 });
    const row = await dbChat(env, 7);
    assert.equal(row.daily_upto_id, 42);
    assert.equal(row.cmd_upto_id, 40);
    assert.equal(row.cmd_day, "2026-06-20");
    assert.equal(row.mem_upto_id, 41);
    const cd = await getChatData(7, env);
    assert.equal(cd._dailyUptoId, 42);
    assert.equal(cd._cmdUptoId, 40);
    assert.equal(cd._cmdDay, "2026-06-20");
    assert.equal(cd._memUptoId, 41);
  });

  test("getChatData прокидывает время сообщения в meta.ts (created_at→ts)", async () => {
    const env = makeEnv();
    await seedChat(env, 13, { history: [{ role: "user", content: "привет", meta: { message_id: 1, name: "Аня" } }] });
    const cd = await getChatData(13, env);
    assert.equal(typeof cd.history[0].meta.ts, "number"); // время есть → formatWithMeta покажет дату/время
  });

  test("обычный flush не сбрасывает границы (нет в INSERT/SET — был бы 0)", async () => {
    const env = makeEnv();
    await flushChatData(7, env, { ...DEFAULT_CHAT_DATA(), _dailyUptoId: 99 });
    // последующий апдейт несвязанного состояния тоже несёт границу (она в chatData) — проверяем,
    // что значение переживает UPSERT, а не молча обнуляется.
    const cd = await getChatData(7, env);
    await flushChatData(7, env, { ...cd, personaState: { arousal: 5 } });
    assert.equal((await dbChat(env, 7)).daily_upto_id, 99);
  });
});

describe("messagesSince (дельта для инкрементальной сводки)", () => {
  test("id > afterId хронологически + maxId", async () => {
    const env = makeEnv();
    await seedChat(env, 3, { history: [
      { role: "user", content: "m1" }, { role: "assistant", content: "m2" }, { role: "user", content: "m3" },
    ] }); // id 1,2,3
    const all = await messagesSince(env, 3, 0);
    assert.equal(all.items.length, 3);
    assert.equal(all.maxId, 3);
    assert.equal(all.items[0].content, "m1");
    const tail = await messagesSince(env, 3, 2);
    assert.equal(tail.items.length, 1);
    assert.equal(tail.items[0].content, "m3");
    assert.equal(tail.maxId, 3);
  });

  test("нет новых → пустой срез, maxId 0", async () => {
    const env = makeEnv();
    await seedChat(env, 3, { history: [{ role: "user", content: "m1" }] }); // id 1
    const r = await messagesSince(env, 3, 1);
    assert.equal(r.items.length, 0);
    assert.equal(r.maxId, 0);
  });

  test("daily_summary on: незасводканные строки (id>daily_upto_id) НЕ обрезаются char-budget'ом", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { daily_summary: true, history_chars: 500 } };
    const ctx = makeCtxFor(makeMsg({ chatId: 700 }), env, cd); // _dailyUptoId=0 → защищены все
    for (let i = 1; i <= 10; i++) {
      await appendHistory(ctx, [{ role: "user", content: `msg${i} ` + "x".repeat(200), meta: { message_id: i } }]);
    }
    assert.equal((await dbHistory(env, 700)).length, 10); // сохранены для будущего дайджеста
  });

  test("без daily_summary: история обрезается по char-budget как раньше", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), config: { history_chars: 500 } };
    const ctx = makeCtxFor(makeMsg({ chatId: 701 }), env, cd);
    for (let i = 1; i <= 10; i++) {
      await appendHistory(ctx, [{ role: "user", content: `msg${i} ` + "x".repeat(200), meta: { message_id: i } }]);
    }
    assert.ok((await dbHistory(env, 701)).length < 10); // обрезано до ~бюджета
  });
});


describe("мутаторы chatData", () => {
  test("updatePersonaState/setRole/setPaused/saveChatConfig помечают _dirty", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    updatePersonaState(ctx, { arousal: 4 }); assert.equal(ctx.chatData.personaState.arousal, 4); assert.equal(ctx.chatData._dirty, true);
    ctx.chatData._dirty = false;
    setRole(ctx, "зек"); assert.equal(ctx.chatData.role, "зек"); assert.equal(ctx.chatData._dirty, true);
    ctx.chatData._dirty = false;
    setPaused(ctx, true); assert.equal(ctx.chatData.paused, true); assert.equal(ctx.chatData._dirty, true);
    ctx.chatData._dirty = false;
    saveChatConfig(ctx, { bye: false }); assert.deepEqual(ctx.chatData.config, { bye: false }); assert.equal(ctx.chatData._dirty, true);
  });

  test("addSpend накапливает стоимость и счётчик", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    addSpend(ctx, 0.001);
    addSpend(ctx, 0.002);
    assert.ok(Math.abs(ctx.chatData.spend - 0.003) < 1e-9);
    assert.equal(ctx.chatData.spendCount, 2);
    assert.equal(ctx.chatData._dirty, true);
  });

  test("cachePhotoDesc: LRU-кэш с потолком PHOTO_CACHE_CAP", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    for (let i = 0; i < PHOTO_CACHE_CAP + 5; i++) cachePhotoDesc(ctx, "k" + i, "d" + i);
    const keys = Object.keys(ctx.chatData.photoCache);
    assert.equal(keys.length, PHOTO_CACHE_CAP);
    assert.ok(!keys.includes("k0")); // самые старые вытеснены
    assert.ok(keys.includes("k" + (PHOTO_CACHE_CAP + 4)));
  });

  test("cachePhotoDesc: повторная запись переставляет ключ в конец (свежий)", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    cachePhotoDesc(ctx, "a", "1");
    cachePhotoDesc(ctx, "b", "2");
    cachePhotoDesc(ctx, "a", "1updated");
    const keys = Object.keys(ctx.chatData.photoCache);
    assert.deepEqual(keys, ["b", "a"]);
    assert.equal(ctx.chatData.photoCache.a, "1updated");
  });

  test("appendHistory дедуплицирует, схлопывает, помечает _dirty", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    appendHistory(ctx, [{ role: "user", content: "раз", meta: { message_id: 1 } }]);
    appendHistory(ctx, [{ role: "user", content: "раз", meta: { message_id: 1 } }]); // дубль по id
    assert.equal(ctx.chatData.history.length, 1);
    assert.equal(ctx.chatData._dirty, true);
  });

  test("updateHistoryMessage обновляет content по message_id; не найдено — no-op", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    ctx.chatData.history = [{ role: "user", content: "старое", meta: { message_id: 5 } }];
    updateHistoryMessage(ctx, makeMsg({ message_id: 5, text: "новое" }));
    assert.equal(ctx.chatData.history[0].content, "новое");
    // несуществующий id — ничего не меняет
    const before = JSON.stringify(ctx.chatData.history);
    updateHistoryMessage(ctx, makeMsg({ message_id: 999, text: "x" }));
    assert.equal(JSON.stringify(ctx.chatData.history), before);
  });
});


describe("аудит: промпты — уровни возбуждения и фолбэки", () => {
  test("assemblePrompt: пустые инструкции / пустые строки отфильтрованы", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    const p = assemblePrompt(["", "ВАЖНО", ""], ctx);
    assert.ok(p.includes("ВАЖНО"));
    assert.ok(!p.includes("\n\n")); // пустые строки отфильтрованы — нет двойных переносов
  });
});


describe("аудит: storage коэрсии и границы", () => {
  test("getChatData: парсит photo_cache JSON и числовые колонки; нет строки → дефолт", async () => {
    const env = makeEnv();
    await seedChat(env, 1, { photoCache: { K: "кот" }, personaState: { arousal: 3 } });
    const cd = await getChatData(1, env);
    assert.deepEqual(cd.photoCache, { K: "кот" });
    assert.equal(cd.personaState.arousal, 3);
    const def = await getChatData(404, env); // нет строки → дефолт
    assert.equal(def._name, "");
    assert.deepEqual(def.photoCache, {});
  });
  test("collapseConsecutiveDuplicates: пустой content не схлопывается", () => {
    const out = collapseConsecutiveDuplicates([{ content: "" }, { content: "" }, { content: "x" }]);
    assert.equal(out.length, 3);
  });
  test("trimHistoryByChars: одно сообщение ровно на лимит / пустой массив", () => {
    assert.equal(trimHistoryByChars([{ content: "x".repeat(100) }], 100).length, 1);
    assert.deepEqual(trimHistoryByChars([], 8000), []);
  });
  test("updateHistoryMessage: визуал с подписью и описанием из кэша", async () => {
    const env = makeEnv();
    const cd = { ...DEFAULT_CHAT_DATA(), photoCache: { K: "кот" }, history: [{ role: "user", content: "старое", meta: { message_id: 5 } }] };
    const editMsg = makeMsg({ message_id: 5, photo: photoSizes("K"), caption: "кэп" });
    const ctx = makeCtxFor(editMsg, env, cd);
    await updateHistoryMessage(ctx, editMsg);
    assert.equal(ctx.chatData.history[0].content, "[фото: кот] кэп");
  });
  test("cachePhotoDesc: null-ключ или пустое описание → ранний выход, не dirty", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv());
    cachePhotoDesc(ctx, null, "d");
    cachePhotoDesc(ctx, "k", "");
    assert.ok(!ctx.chatData._dirty);
  });
  test("updateHistoryMessage: нет строки в D1 → no-op (не падает)", async () => {
    const env = makeEnv();
    const ctx = makeCtxFor(makeMsg({ message_id: 77 }), env);
    await updateHistoryMessage(ctx, makeMsg({ message_id: 77, text: "ред" })); // истории нет → тихо выходит
    assert.ok(true);
  });
});
