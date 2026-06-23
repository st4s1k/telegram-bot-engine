// Daily summary on cron: DST gate "08:00 Chisinau" (from two UTC crons), per-chat opt-in,
// send-without-writing-to-history, advancing the _dailyUptoId boundary, skipping when nothing new,
// per-chat error isolation, and the thin WORKER.scheduled wrapper.
import {
  test, describe, assert,
  makeEnv, makeMsg, seedChat, dbChat, dbHistory, dbMemories,
  FETCH, sse, CONSOLE,
  runDailySummaries, WORKER, DEFAULT_CHAT_DATA,
} from "./harness.mjs";

// Time moments (UTC) that yield 08:00 in Chisinau in both DST phases, plus a control "not 8".
// These tests set BOT_TZ=Europe/Chisinau (which also exercises the configurable TZ + DST gate).
const SUMMER_8 = Date.UTC(2026, 6, 15, 5, 0); // Jul 15 05:00 UTC = 08:00 EEST (UTC+3)
const WINTER_8 = Date.UTC(2026, 0, 15, 6, 0); // Jan 15 06:00 UTC = 08:00 EET  (UTC+2)
const SUMMER_9 = Date.UTC(2026, 6, 15, 6, 0); // Jul 15 06:00 UTC = 09:00 EEST → gate blocks it
const UTC_8 = Date.UTC(2026, 6, 15, 8, 0);    // 08:00 UTC — for the gate with the default TZ (BOT_TZ unset)

const hist3 = () => [
  { role: "user", content: "обсудили релиз" },
  { role: "assistant", content: "ну норм" },
  { role: "user", content: "и планы на завтра" },
];

describe("CRON · daily summary", () => {
  test("sends only to subscribers; does NOT write to history; advances the _dailyUptoId boundary", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 100, { config: { daily_summary: true }, history: hist3() }); // subscribed
    await seedChat(env, 200, { history: hist3() });                                  // NOT subscribed
    FETCH.set("chat", () => sse(["дайджест за сутки"]));

    await runDailySummaries(env, SUMMER_8);

    const sends = FETCH.sends();
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body.chat_id, 100);          // only the subscribed chat
    assert.equal((await dbChat(env, 100)).daily_upto_id, 3); // boundary advanced to max id
    assert.equal((await dbHistory(env, 100)).length, 3);     // summary NOT appended to history
    assert.equal((await dbChat(env, 200)).daily_upto_id, 0); // non-subscriber untouched
  });

  test("DST: the winter cron (06:00 UTC) also gives 08:00 Chisinau → sends", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 100, { config: { daily_summary: true }, history: hist3() });
    FETCH.set("chat", () => sse(["зимний дайджест"]));
    await runDailySummaries(env, WINTER_8);
    assert.equal(FETCH.sends().length, 1);
  });

  test("DST gate: not 08:00 in Chisinau (09:00) → do nothing", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 100, { config: { daily_summary: true }, history: hist3() });
    FETCH.set("chat", () => sse(["не должно уйти"]));
    await runDailySummaries(env, SUMMER_9);
    assert.equal(FETCH.sends().length, 0);
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });

  test("no new messages since the last daily → don't send, boundary unchanged", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    // boundary already at the last message (id 3) → delta is empty
    await seedChat(env, 100, { config: { daily_summary: true }, history: hist3(), _summary: "вчерашнее", _dailyUptoId: 3 });
    await runDailySummaries(env, SUMMER_8);
    assert.equal(FETCH.sends().length, 0);
    assert.equal(FETCH.of("/chat/completions").length, 0);
    assert.equal((await dbChat(env, 100)).daily_upto_id, 3);
  });

  test("a generation failure in one chat doesn't disrupt the next", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 100, { config: { daily_summary: true }, history: hist3() });
    await seedChat(env, 200, { config: { daily_summary: true }, history: hist3() });
    let n = 0; // the first chat in line fails (500), the second responds — order is not pinned
    FETCH.set("chat", () => (++n === 1 ? sse([], { ok: false, status: 500 }) : sse(["дайджест"])));

    await runDailySummaries(env, SUMMER_8);

    const sends = FETCH.sends();
    assert.equal(sends.length, 1); // exactly one chat got the summary, the other's failure didn't interfere
    const okChat = sends[0].body.chat_id;
    const failChat = okChat === 100 ? 200 : 100;
    assert.ok((await dbChat(env, okChat)).daily_upto_id > 0);    // the successful one's boundary advanced
    assert.equal((await dbChat(env, failChat)).daily_upto_id, 0); // the failed one's did not
  });

  test("WORKER.scheduled delegates to runDailySummaries", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 100, { config: { daily_summary: true }, history: hist3() });
    FETCH.set("chat", () => sse(["через scheduled"]));
    await WORKER.scheduled({ scheduledTime: SUMMER_8, cron: "0 5 * * *" }, env, { waitUntil() {} });
    assert.equal(FETCH.sends().length, 1);
  });

  test("WORKER.scheduled swallows the error (the cron doesn't crash)", async () => {
    // env without DB → runDailySummaries throws on SELECT, scheduled should absorb it.
    // Default TZ (UTC, BOT_TZ unset) → use 08:00 UTC so the gate lets it through to the SELECT.
    await WORKER.scheduled({ scheduledTime: UTC_8, cron: "0 8 * * *" }, {}, { waitUntil() {} });
    assert.ok(CONSOLE.error.some(s => s.includes("runDailySummaries failed")));
  });
});

describe("CRON · once-a-day fact curation", () => {
  test("curates a chat with rag (even without daily_summary), facts are auto", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 300, { config: { rag: true }, history: [
      { role: "user", content: "меня зовут Иван" },
      { role: "assistant", content: "ок" },
      { role: "user", content: "я работаю инженером" },
    ] }); // rag on, daily_summary OFF
    FETCH.set("chat", () => sse(["Иван работает инженером"])); // fact extraction
    await runDailySummaries(env, SUMMER_8);
    const rows = await dbMemories(env, 300);
    assert.ok(rows.length >= 1);
    assert.ok(rows.every(r => r.source === "auto"));
    assert.equal(FETCH.sends().length, 0); // no summary sent — daily_summary is off
  });

  test("the DST gate applies to curation too (not 08:00 → nothing)", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 301, { config: { rag: true }, history: hist3() });
    FETCH.set("chat", () => sse(["факт"]));
    await runDailySummaries(env, SUMMER_9); // 09:00 in Chisinau — not our firing window
    assert.equal((await dbMemories(env, 301)).length, 0);
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });

  test("chat with daily_summary but rag off → summary present, no curation", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 302, { config: { daily_summary: true }, history: hist3() }); // rag off
    FETCH.set("chat", () => sse(["дайджест"]));
    await runDailySummaries(env, SUMMER_8);
    assert.equal((await dbMemories(env, 302)).length, 0); // no curation (rag off)
    assert.equal(FETCH.sends().length, 1);                // summary went out
  });

  test("the curation boundary persists even if the summary step fails", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 303, { config: { rag: true, daily_summary: true }, history: [
      { role: "user", content: "меня зовут Иван" },
      { role: "assistant", content: "ок" },
      { role: "user", content: "я работаю инженером" },
    ] });
    FETCH.set("chat", () => sse(["Иван работает инженером"])); // fact extraction during curation
    const realDB = env.DB;
    let sinceCalls = 0; // 1st messagesSince — curation (success), 2nd — summary (we make it fail)
    env.DB = {
      prepare(sql) {
        if (sql.includes("id>? ORDER BY id ASC") && ++sinceCalls >= 2) {
          return { bind: () => ({ all: async () => { throw new Error("d1 blip"); } }) };
        }
        return realDB.prepare(sql);
      },
      batch: (s) => realDB.batch(s),
    };
    await runDailySummaries(env, SUMMER_8);
    env.DB = realDB;
    const row = await dbChat(env, 303);
    assert.ok(Number(row.mem_upto_id) > 0); // curation was already saved BEFORE the summary failed
    assert.ok(CONSOLE.error.some(s => s.includes("runDailySummaries[chat]")));
  });
});
