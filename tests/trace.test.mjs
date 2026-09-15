// Observability (src/trace.ts): every stage of a request lands in trace_events under one trace id.
import {
  test, describe, assert,
  makeEnv, makeCtxFor, makeMsg, seedChat, FETCH, sse, DEFAULT_CHAT_DATA,
  handleTelegramMessage, runDailySummaries, addMemory, COMMANDS, WORKER,
  traceEvent, traceRaw, startTrace, purgeTraces, getTrace, listTraces,
} from "./harness.mjs";

const ragEnv = (over = {}) => makeEnv({ ENABLE_RAG: "true", ...over });
const events = async (env, chatId) => ((await env.DB.prepare("SELECT * FROM trace_events WHERE chat_id=? ORDER BY id").bind(String(chatId)).all()).results || []);
const brief = (rows) => rows.map(e => e.stage + (e.kind ? ":" + e.kind : "") + (e.outcome ? " " + e.outcome : ""));
const post = (update) => new Request("https://worker.test/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(update) });
const execCtx = { waitUntil() {}, passThroughOnException() {} };

describe("trace · a chat reply, stage by stage", () => {
  test("route → llm:rewrite → recall → llm:reply → send, one trace id, offsets monotonic, LLM detail carries prompt/question/response/memory", async () => {
    const env = ragEnv();
    await seedChat(env, 700, { config: { rag: true, rag_min_score: 0 }, history: [{ role: "user", content: "у Стаса болят зубы", meta: { message_id: 1 } }] });
    const seedCtx = makeCtxFor(makeMsg({ chatId: 700 }), env);
    await addMemory(seedCtx, "Стас проходил лечение у стоматолога: два импланта", "auto");
    let n = 0;
    FETCH.set("chat", () => (++n === 1 ? sse(["Стас зубы стоматолог"]) : sse(["ответ бота"], { cost: 0.002 })));
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 700, text: "а что у него с зубами?", message_id: 2 }), env);
    const rows = await events(env, 700);
    assert.deepEqual(brief(rows), ["route:chat:default answer", "llm:rewrite ok", "recall hit", "llm:reply ok", "send ok"]);
    assert.equal(new Set(rows.map(r => r.trace)).size, 1);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].ms >= rows[i - 1].ms);
    const recall = JSON.parse(rows[2].detail);
    assert.equal(recall.raw, "а что у него с зубами?");
    assert.equal(recall.query, "Стас зубы стоматолог");
    assert.equal(recall.facts.length, 1);
    assert.ok(Array.isArray(recall.vector) && recall.vector[0].score >= 0, JSON.stringify(recall));
    const llm = JSON.parse(rows[3].detail);
    assert.ok(llm.system.includes("два импланта"), llm.system);                 // the dated fact in the system prompt
    assert.ok(llm.user_text.includes("а что у него с зубами?"));
    assert.equal(llm.response, "ответ бота");
    assert.equal(llm.recall.query, "Стас зубы стоматолог");
    assert.equal(rows[3].cost, 0.002);
    assert.ok(rows[3].elapsed_ms >= 0 && rows[4].elapsed_ms >= 0);
    assert.equal(JSON.parse(rows[4].detail).stored, true);
  });

  test("a command: route:command → command reply → send", async () => {
    const env = makeEnv();
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 701, text: "/help" }), env);
    assert.deepEqual(brief(await events(env, 701)), ["route:command:help", "command:help reply", "send ok"]);
  });

  test("an LLM failure is an llm event with outcome http_500 and the fallback send is marked", async () => {
    const env = makeEnv();
    FETCH.set("chat", () => sse([], { ok: false, status: 500 }));
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 702, text: "привет как дела" }), env);
    const rows = await events(env, 702);
    assert.deepEqual(brief(rows), ["route:chat:default answer", "llm:reply http_500", "send ok"]);
    assert.equal(JSON.parse(rows[2].detail).fallback, true);
    assert.equal(JSON.parse(rows[2].detail).stored, false);
  });

  test("silent paths are traced too: a paused chat, a group message not addressed to the bot", async () => {
    const env = makeEnv();
    await seedChat(env, 703, { paused: true });
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 703, text: "эй" }), env);
    assert.deepEqual(brief(await events(env, 703)), ["route:paused silent"]);
    await handleTelegramMessage(makeMsg({ chatType: "group", chatId: -704, text: "просто болтаем тут" }), env);
    assert.deepEqual(brief(await events(env, -704)), ["route:chat silent"]);
  });

  test("TRACE_LOG=false → nothing is written", async () => {
    const env = makeEnv({ TRACE_LOG: "false" });
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 705, text: "/help" }), env);
    assert.equal((await events(env, 705)).length, 0);
  });
});

describe("trace · the webhook edge", () => {
  test("the update is the first event (trace id = u<update_id>); a redelivered update is a dedup event and nothing else", async () => {
    const env = makeEnv();
    const update = { update_id: 950, message: makeMsg({ chatType: "private", chatId: 710, text: "/help" }) };
    await WORKER.fetch(post(update), env, execCtx);
    await WORKER.fetch(post(update), env, execCtx);
    const rows = await events(env, 710);
    assert.deepEqual(brief(rows), ["webhook:text", "route:command:help", "command:help reply", "send ok", "webhook:text", "dedup skipped"]);
    assert.ok(rows.every(r => r.trace === "u950"));
    assert.equal(JSON.parse(rows[0].detail).update_id, 950);
  });
});

describe("trace · cron and retention", () => {
  test("the daily cron traces curation/summary per chat under cron-<day>-<chat> and purges rows older than TRACE_DAYS", async () => {
    const env = ragEnv();
    await seedChat(env, 720, { config: { rag: true }, history: [{ role: "user", content: "я живу в Кишинёве" }, { role: "user", content: "люблю вино" }] });
    // an old event (30 days) that must be purged
    await traceRaw(env, 720, startTrace("old"), "route", { kind: "chat" });
    await env.DB.prepare("UPDATE trace_events SET ts=? WHERE trace='old'").bind(Date.now() - 30 * 86400_000).run();
    FETCH.set("chat", () => sse(["NONE"]));
    await runDailySummaries(env, Date.UTC(2026, 8, 16, 8, 0, 0)); // 08:00 UTC = the gate (default TZ)
    const rows = await events(env, 720);
    assert.ok(!rows.some(r => r.trace === "old"), "old event purged");
    assert.ok(rows.some(r => r.stage === "cron" && r.kind === "curation" && r.outcome === "ran"), brief(rows).join(","));
    assert.ok(rows.some(r => r.stage === "llm" && r.kind === "curation"), brief(rows).join(","));
    assert.ok(rows.every(r => r.trace.startsWith("cron-2026-09-16-720")), rows.map(r => r.trace).join(","));
  });

  test("purgeTraces returns the number of rows dropped", async () => {
    const env = makeEnv();
    await traceRaw(env, 730, startTrace(), "route", {});
    await env.DB.prepare("UPDATE trace_events SET ts=1").run();
    assert.equal(await purgeTraces(env, 1000), 1);
    assert.equal(await purgeTraces(env, 1000), 0);
  });
});

describe("trace · /admin trace | event", () => {
  const adminMsg = () => makeMsg({ username: "admin", chatType: "private", chatId: 555 });

  test("`/admin trace <chat>` lists traces stage by stage; `/admin trace <traceId>` and `/admin event <id>` drill down; `/admin trace` gives 24 h metrics", async () => {
    const env = ragEnv();
    await seedChat(env, 740, { config: { rag: true, rag_min_score: 0 } });
    await addMemory(makeCtxFor(makeMsg({ chatId: 740 }), env), "Лена планирует поставить зубной имплант", "auto");
    FETCH.set("chat", () => sse(["превью"], { cost: 0.001 }));
    await handleTelegramMessage(makeMsg({ chatType: "private", chatId: 740, text: "что у Лены с имплантом" }), env);
    const ctx = makeCtxFor(adminMsg(), env);

    const list = await COMMANDS.admin(ctx, { argText: "trace 740" });
    assert.match(list, /Трассы `740`/);
    assert.ok(list.includes("route:chat:default answer → recall hit"), list);
    assert.ok(list.includes("llm:reply ok") && list.includes("send ok"), list);
    const traceId = (await events(env, 740))[0].trace;

    const full = await COMMANDS.admin(ctx, { argText: "trace " + traceId });
    assert.match(full, /Трасса `t/);
    assert.ok(full.includes("+") && full.includes("llm:reply ok"), full);
    const llmRow = (await events(env, 740)).find(r => r.stage === "llm");

    const ev = await COMMANDS.admin(ctx, { argText: "event " + llmRow.id });
    assert.ok(ev.includes("Системный промпт") && ev.includes("зубной имплант"), ev);
    assert.ok(ev.includes("Ответ:\nпревью"), ev);
    assert.ok(ev.includes("Память — запрос: что у Лены с имплантом · фактов: 1"), ev);

    const stats = await COMMANDS.admin(ctx, { argText: "trace" });
    assert.match(stats, /За 24 часа/);
    assert.ok(stats.includes("LLM reply: 1 вызовов, ошибок 0"), stats);
    assert.ok(stats.includes("send: 1") && stats.includes("route:chat:default: 1"), stats);

    assert.match(await COMMANDS.admin(ctx, { argText: "trace nope" }), /не найдена/);
    assert.match(await COMMANDS.admin(ctx, { argText: "event 999999" }), /не найдено/);
    assert.match(await COMMANDS.admin(ctx, { argText: "trace 999" }), /Трасс для `999` нет/);
  });

  test("an admin preview in another chat is filed under the admin's trace, with the target chat id", async () => {
    const env = ragEnv();
    await seedChat(env, 750, { config: { rag: true } });
    const ctx = makeCtxFor(adminMsg(), env);
    ctx._trace = startTrace("adm1");
    FETCH.set("chat", () => sse(["ответ"]));
    await COMMANDS.admin(ctx, { argText: "chat 750 привет как дела" });
    const rows = await events(env, 750);
    assert.ok(rows.some(r => r.stage === "llm" && r.kind === "preview" && r.trace === "adm1"), brief(rows).join(","));
  });

  test("traceEvent is available to persona packs: a custom stage lands in the same trace", async () => {
    const env = makeEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 760 }), env);
    ctx._trace = startTrace("pack1");
    await traceEvent(ctx, "persona", { kind: "haiku", outcome: "ok", detail: { topic: "коты" } });
    const rows = await getTrace(env, "pack1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stage, "persona");
    assert.equal(JSON.parse(rows[0].detail).topic, "коты");
    assert.equal((await listTraces(env, 760, 5)).length, 1);
  });
});
