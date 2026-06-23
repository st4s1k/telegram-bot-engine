// Ежедневная сводка по крону: DST-гейт «08:00 Кишинёв» (из двух UTC-кронов), opt-in по чату,
// отправка-без-записи-в-историю, продвижение границы _dailyUptoId, пропуск при отсутствии нового,
// изоляция ошибок по чату и тонкая обёртка WORKER.scheduled.
import {
  test, describe, assert,
  makeEnv, makeMsg, seedChat, dbChat, dbHistory, dbMemories,
  FETCH, sse, CONSOLE,
  runDailySummaries, WORKER, DEFAULT_CHAT_DATA,
} from "./harness.mjs";

// Моменты времени (UTC), дающие 08:00 по Кишинёву в обе фазы DST, и контрольный «не 8».
// Эти тесты задают BOT_TZ=Europe/Chisinau (заодно проверяют настраиваемый TZ + DST-гейт).
const SUMMER_8 = Date.UTC(2026, 6, 15, 5, 0); // 15 июл 05:00 UTC = 08:00 EEST (UTC+3)
const WINTER_8 = Date.UTC(2026, 0, 15, 6, 0); // 15 янв 06:00 UTC = 08:00 EET  (UTC+2)
const SUMMER_9 = Date.UTC(2026, 6, 15, 6, 0); // 15 июл 06:00 UTC = 09:00 EEST → гейт не пускает
const UTC_8 = Date.UTC(2026, 6, 15, 8, 0);    // 08:00 UTC — для гейта при дефолтном TZ (BOT_TZ не задан)

const hist3 = () => [
  { role: "user", content: "обсудили релиз" },
  { role: "assistant", content: "ну норм" },
  { role: "user", content: "и планы на завтра" },
];

describe("CRON · ежедневная сводка", () => {
  test("шлёт только подписавшимся; НЕ пишет в историю; двигает границу _dailyUptoId", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 100, { config: { daily_summary: true }, history: hist3() }); // подписан
    await seedChat(env, 200, { history: hist3() });                                  // НЕ подписан
    FETCH.set("chat", () => sse(["дайджест за сутки"]));

    await runDailySummaries(env, SUMMER_8);

    const sends = FETCH.sends();
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body.chat_id, 100);          // только подписанный чат
    assert.equal((await dbChat(env, 100)).daily_upto_id, 3); // граница продвинулась к max id
    assert.equal((await dbHistory(env, 100)).length, 3);     // сводка НЕ дописана в историю
    assert.equal((await dbChat(env, 200)).daily_upto_id, 0); // неподписанный не тронут
  });

  test("DST: зимний крон (06:00 UTC) тоже даёт 08:00 Кишинёв → шлёт", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 100, { config: { daily_summary: true }, history: hist3() });
    FETCH.set("chat", () => sse(["зимний дайджест"]));
    await runDailySummaries(env, WINTER_8);
    assert.equal(FETCH.sends().length, 1);
  });

  test("DST-гейт: не 08:00 по Кишинёву (09:00) → ничего не делаем", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 100, { config: { daily_summary: true }, history: hist3() });
    FETCH.set("chat", () => sse(["не должно уйти"]));
    await runDailySummaries(env, SUMMER_9);
    assert.equal(FETCH.sends().length, 0);
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });

  test("нет новых сообщений с прошлой ежедневной → не шлём, граница не меняется", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    // граница уже на последнем сообщении (id 3) → дельта пуста
    await seedChat(env, 100, { config: { daily_summary: true }, history: hist3(), _summary: "вчерашнее", _dailyUptoId: 3 });
    await runDailySummaries(env, SUMMER_8);
    assert.equal(FETCH.sends().length, 0);
    assert.equal(FETCH.of("/chat/completions").length, 0);
    assert.equal((await dbChat(env, 100)).daily_upto_id, 3);
  });

  test("сбой генерации в одном чате не мешает следующему", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 100, { config: { daily_summary: true }, history: hist3() });
    await seedChat(env, 200, { config: { daily_summary: true }, history: hist3() });
    let n = 0; // первый по очереди чат падает (500), второй отвечает — порядок не фиксируем
    FETCH.set("chat", () => (++n === 1 ? sse([], { ok: false, status: 500 }) : sse(["дайджест"])));

    await runDailySummaries(env, SUMMER_8);

    const sends = FETCH.sends();
    assert.equal(sends.length, 1); // ровно один чат получил сводку, второй сбой не помешал
    const okChat = sends[0].body.chat_id;
    const failChat = okChat === 100 ? 200 : 100;
    assert.ok((await dbChat(env, okChat)).daily_upto_id > 0);    // у успешного граница двинулась
    assert.equal((await dbChat(env, failChat)).daily_upto_id, 0); // у сбойного — нет
  });

  test("WORKER.scheduled делегирует в runDailySummaries", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 100, { config: { daily_summary: true }, history: hist3() });
    FETCH.set("chat", () => sse(["через scheduled"]));
    await WORKER.scheduled({ scheduledTime: SUMMER_8, cron: "0 5 * * *" }, env, { waitUntil() {} });
    assert.equal(FETCH.sends().length, 1);
  });

  test("WORKER.scheduled глушит ошибку (крон не падает)", async () => {
    // env без DB → runDailySummaries бросит на SELECT, scheduled должен поглотить.
    // Дефолтный TZ (UTC, BOT_TZ не задан) → берём 08:00 UTC, чтобы гейт пропустил до SELECT.
    await WORKER.scheduled({ scheduledTime: UTC_8, cron: "0 8 * * *" }, {}, { waitUntil() {} });
    assert.ok(CONSOLE.error.some(s => s.includes("runDailySummaries failed")));
  });
});

describe("CRON · курация фактов раз в сутки", () => {
  test("курирует чат с rag (даже без daily_summary), факты auto", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 300, { config: { rag: true }, history: [
      { role: "user", content: "меня зовут Иван" },
      { role: "assistant", content: "ок" },
      { role: "user", content: "я работаю инженером" },
    ] }); // rag вкл, daily_summary НЕТ
    FETCH.set("chat", () => sse(["Иван работает инженером"])); // извлечение фактов
    await runDailySummaries(env, SUMMER_8);
    const rows = await dbMemories(env, 300);
    assert.ok(rows.length >= 1);
    assert.ok(rows.every(r => r.source === "auto"));
    assert.equal(FETCH.sends().length, 0); // сводку не шлём — daily_summary выключен
  });

  test("DST-гейт распространяется и на курацию (не 08:00 → ничего)", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 301, { config: { rag: true }, history: hist3() });
    FETCH.set("chat", () => sse(["факт"]));
    await runDailySummaries(env, SUMMER_9); // 09:00 по Кишинёву — не наш фаер
    assert.equal((await dbMemories(env, 301)).length, 0);
    assert.equal(FETCH.of("/chat/completions").length, 0);
  });

  test("чат с daily_summary, но rag выкл → сводка есть, курации нет", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 302, { config: { daily_summary: true }, history: hist3() }); // rag выкл
    FETCH.set("chat", () => sse(["дайджест"]));
    await runDailySummaries(env, SUMMER_8);
    assert.equal((await dbMemories(env, 302)).length, 0); // курации нет (rag off)
    assert.equal(FETCH.sends().length, 1);                // сводка ушла
  });

  test("граница курации сохраняется, даже если шаг сводки падает", async () => {
    const env = makeEnv({ BOT_TZ: "Europe/Chisinau" });
    await seedChat(env, 303, { config: { rag: true, daily_summary: true }, history: [
      { role: "user", content: "меня зовут Иван" },
      { role: "assistant", content: "ок" },
      { role: "user", content: "я работаю инженером" },
    ] });
    FETCH.set("chat", () => sse(["Иван работает инженером"])); // извлечение фактов в курации
    const realDB = env.DB;
    let sinceCalls = 0; // 1-й messagesSince — курация (успех), 2-й — сводка (роняем)
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
    assert.ok(Number(row.mem_upto_id) > 0); // курация уже сохранена ДО падения сводки
    assert.ok(CONSOLE.error.some(s => s.includes("runDailySummaries[chat]")));
  });
});
