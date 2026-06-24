import * as H from "./harness.mjs";
const {
  test, describe, beforeEach, assert,
  setPersona, getPersona, getPersonaTexts,
  assemblePrompt, buildHelp, buildInfoStatus, messageMentionsBot, buildCommandRegex,
  COMMANDS, getGlobalConfig, DEFAULT_CHAT_DATA, makeEnv, makeMsg, makeCtxFor,
  seedChat,
} = H;

// The persona's localized texts are baked into the engine i18n at BUILD time (the generate step), so a
// runtime setPersona() swap can't neutralize them. The text-neutrality checks below therefore apply only
// to a NEUTRAL build (no persona i18n staged) — skip them when a pack is staged (e.g. the fasol suite).
// The pack OBJECT (commands/quick-replies/hooks/wakeWords) IS runtime-swappable, so those checks run always.
const NEUTRAL_BUILD = !getPersonaTexts("en").defaultVoice;

/* ====================================================================== */
/* ===== PERSONALESS: the engine under a neutral pack (forkability) ===== */
/* ====================================================================== */
// Forkability goal (Phase 2): the engine works WITHOUT a persona. The eagerly-composed maps
// (CONFIG_SCHEMA/CONFIG_GROUPS/COMMANDS) are frozen at module load with whatever pack was active
// then (persona via the barrel), so their neutrality can't be checked here — that's the
// prod-build scenario (active.ts → default). But the PER-CALL persona readers (assemblePrompt/buildHelp/
// buildInfoStatus/messageMentionsBot/buildCommandRegex/admin label) read the active pack at call
// time — those are what we test, swapping the pack for a neutral one (like NEUTRAL in registry.ts / ./default).

// New contract: the persona's localized texts come from its i18n folder (discovered + merged). With no
// persona i18n staged, getPersonaTexts returns the engine's NEUTRAL_TEXTS defaults (empty voice/help,
// "ℹ️ **Status**" title, English fallbacks). The pack object only carries the non-localized identity.
const NEUTRAL_PACK = { wakeWords: [], usernameAliases: {} };

describe("personaless (neutral pack)", () => {
  beforeEach(() => { const saved = getPersona(); setPersona(NEUTRAL_PACK); return () => setPersona(saved); });

  test.skipIf(!NEUTRAL_BUILD)("assemblePrompt without a role: no junk 'ТВОЯ РОЛЬ: \"\"' and no 'undefined'", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv(), { ...DEFAULT_CHAT_DATA(), role: null, personaState: { arousal: 3 } });
    const p = assemblePrompt(["Ты отвечаешь на сообщение."], ctx);
    assert.ok(p.includes("Ты отвечаешь на сообщение."));
    assert.ok(!p.includes("ТВОЯ РОЛЬ"));            // empty defaultVoice → line is omitted
    assert.ok(!p.includes("undefined"));            // neutral flavor is empty → nothing leaks
    assert.ok(!p.includes("ФИЗИЧЕСКОЕ СОСТОЯНИЕ")); // neutral flavor is empty → no line
  });

  test("assemblePrompt with a chat role: the role works even without a persona", () => {
    const ctx = makeCtxFor(makeMsg(), makeEnv(), { ...DEFAULT_CHAT_DATA(), role: "вежливый секретарь", personaState: { arousal: 0 } });
    const p = assemblePrompt(["x"], ctx);
    assert.ok(p.includes('ТВОЯ РОЛЬ: "вежливый секретарь"'));
  });

  test("buildHelp: neutral text, no persona content", () => {
    const h = buildHelp();
    assert.ok(h.includes("/help"));
    assert.ok(!/анек/i.test(h));
  });

  test.skipIf(!NEUTRAL_BUILD)("buildInfoStatus: neutral title, no arousal line", () => {
    const env = makeEnv({ BOT_LANG: "en" }); // neutral texts are now localized → pin to en (the neutral base)
    const ctx = makeCtxFor(makeMsg({ chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), personaState: { arousal: 4 } });
    const out = buildInfoStatus(ctx);
    assert.ok(out.includes("Status"));        // neutral infoTitle (neutral_info_title, en)
    assert.ok(!out.includes("Возбуждение")); // neutral has no infoLines hook → no arousal line (even arousal>0)
  });

  test("messageMentionsBot: without wakeWords it reacts only to an @-mention", () => {
    const cfg = getGlobalConfig(makeEnv());
    const msg = makeMsg({ chatType: "group" });
    assert.equal(messageMentionsBot("привет всем", msg, cfg), false);     // neutral pack has no wake words
    assert.equal(messageMentionsBot("@testbot привет", msg, cfg), true); // an @-mention still wakes it
  });

  test("buildCommandRegex: without a persona — only engine commands", () => {
    const types = buildCommandRegex(makeEnv(), "neutral_probe_bot").map((e) => e.type);
    const ENGINE = ["admin", "help", "config", "memory", "model", "summary", "rp", "info", "stop", "resume", "lang", "alias", "start"];
    for (const t of ENGINE) assert.ok(types.includes(t), `engine command ${t} must be present`);
    // and NOTHING beyond the engine: with no registered persona, no extra commands appear
    assert.deepEqual(types.slice().sort(), ENGINE.slice().sort());
  });

  test("admin chat <id>: the dump does not expose the persona arousal label", async () => {
    const env = makeEnv();
    await seedChat(env, -100, { _name: "Группа", personaState: { arousal: 5 } });
    const ctx = makeCtxFor(makeMsg({ username: "admin", chatType: "private" }), env);
    const out = await COMMANDS.admin(ctx, { argText: "chat -100" });
    assert.ok(out.includes("-100"));
    assert.ok(!out.includes("Возбуждение")); // label comes from the pack (infoArousalLabel), neutral has none
  });
});
