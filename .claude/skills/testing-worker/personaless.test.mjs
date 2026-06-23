import * as H from "./harness.mjs";
const {
  test, describe, beforeEach, assert,
  setPersona, getPersona,
  assemblePrompt, buildHelp, buildInfoStatus, messageMentionsBot, buildCommandRegex,
  COMMANDS, getGlobalConfig, DEFAULT_CHAT_DATA, makeEnv, makeMsg, makeCtxFor,
  seedChat,
} = H;

/* ====================================================================== */
/* ===== PERSONALESS: движок под нейтральным паком (форкабельность) ===== */
/* ====================================================================== */
// Цель форкабельности (Фаза 2): движок работает БЕЗ персоны. Эагерно-скомпозиченные карты
// (CONFIG_SCHEMA/CONFIG_GROUPS/COMMANDS) замораживаются на загрузке модуля с активным тогда
// паком (персона через барель), поэтому их нейтральность здесь не проверить — это сценарий
// прод-сборки (active.ts → default). Но ПОВЫЗОВНЫЕ читатели персоны (assemblePrompt/buildHelp/
// buildInfoStatus/messageMentionsBot/buildCommandRegex/админ-лейбл) читают активный пак в момент
// вызова — их и проверяем, подменив пак на нейтральный (как NEUTRAL в registry.ts / ./default).

const NEUTRAL_PACK = {
  texts: {
    defaultVoice: "", languageLine: "",
    fallbackError: "ошибка, попробуй позже", fallbackNoCredits: "нет кредитов",
    wakeWords: [], usernameAliases: {}, targetNameFallback: "друг",
    helpText: "Команды: /help · /config · /info · /model · /memory · /summary · /stop · /resume",
    infoTitle: "ℹ️ **Статус**", // без infoArousalLabel → строки возбуждения нет
  },
};

describe("personaless (нейтральный пак)", () => {
  beforeEach(() => { const saved = getPersona(); setPersona(NEUTRAL_PACK); return () => setPersona(saved); });

  test("assemblePrompt без роли: нет мусорной 'ТВОЯ РОЛЬ: \"\"' и нет 'undefined'", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv(), { ...DEFAULT_CHAT_DATA(), role: null, personaState: { arousal: 3 } });
    const p = assemblePrompt(["Ты отвечаешь на сообщение."], ctx);
    assert.ok(p.includes("Ты отвечаешь на сообщение."));
    assert.ok(!p.includes("ТВОЯ РОЛЬ"));            // пустой defaultVoice → строка опущена
    assert.ok(!p.includes("undefined"));            // нейтральный флейвор пуст → ничего не утекает
    assert.ok(!p.includes("ФИЗИЧЕСКОЕ СОСТОЯНИЕ")); // нейтральный флейвор пуст → строки нет
  });

  test("assemblePrompt с ролью чата: роль работает и без персоны", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv(), { ...DEFAULT_CHAT_DATA(), role: "вежливый секретарь", personaState: { arousal: 0 } });
    const p = assemblePrompt(["x"], ctx);
    assert.ok(p.includes('ТВОЯ РОЛЬ: "вежливый секретарь"'));
  });

  test("buildHelp: нейтральный текст, без персона-контента", () => {
    const h = buildHelp();
    assert.ok(h.includes("/help"));
    assert.ok(!/анек/i.test(h));
  });

  test("buildInfoStatus: нейтральный заголовок, без строки возбуждения", () => {
    const env = makeEnv();
    const ctx = makeCtxFor(makeMsg({ chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), personaState: { arousal: 4 } });
    const out = buildInfoStatus(ctx);
    assert.ok(out.includes("Статус"));       // нейтральный infoTitle
    assert.ok(!out.includes("Возбуждение")); // нет infoArousalLabel → строки нет (даже при arousal>0)
  });

  test("messageMentionsBot: без wakeWords реагирует только на @-упоминание", () => {
    const cfg = getGlobalConfig(makeEnv());
    const msg = makeMsg({ chatType: "group" });
    assert.equal(messageMentionsBot("привет всем", msg, cfg), false);     // нет wake-слов у нейтрали
    assert.equal(messageMentionsBot("@testbot привет", msg, cfg), true); // @-упоминание всё равно будит
  });

  test("buildCommandRegex: без персоны — только команды движка", () => {
    const types = buildCommandRegex(makeEnv(), "neutral_probe_bot").map((e) => e.type);
    const ENGINE = ["admin", "help", "config", "memory", "model", "summary", "rp", "info", "stop", "resume"];
    for (const t of ENGINE) assert.ok(types.includes(t), `должна быть команда движка ${t}`);
    // и НИЧЕГО сверх движка: без зарегистрированной персоны никаких доп. команд не появляется
    assert.deepEqual(types.slice().sort(), ENGINE.slice().sort());
  });

  test("admin chat <id>: дамп не светит персона-лейбл возбуждения", async () => {
    const env = makeEnv();
    await seedChat(env, -100, { _name: "Группа", personaState: { arousal: 5 } });
    const ctx = makeCtxFor(makeMsg({ username: "admin", chatType: "private" }), env);
    const out = await COMMANDS.admin(ctx, { argText: "chat -100" });
    assert.ok(out.includes("-100"));
    assert.ok(!out.includes("Возбуждение")); // лейбл из пака (infoArousalLabel), у нейтрали нет
  });
});
