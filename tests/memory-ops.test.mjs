// Memory RECONCILIATION: curation speaks an operation protocol (ADD / UPDATE <id>) so long-term memory is
// not append-only — a fact that changed is UPDATEd in place instead of piling up next to its newer
// version. There is NO DELETE: an LLM pass never removes a fact (only a human does — /memory del/forget).
// Plain lines still mean ADD (a model that ignores the protocol degrades to the old behaviour). Manual
// facts are protected from LLM passes. There is no list-only "consolidation" pass any more (it invented
// the passage of time and glued people together) — every UPDATE is grounded in new messages.
import {
  test, describe, assert,
  makeEnv, makeCtxFor, makeMsg, seedChat, dbMemories,
  FETCH, sse, DEFAULT_CHAT_DATA,
  addMemory, updateMemory, deleteMemory,
  runMemoryCuration, parseMemoryOps, parseExtractedFacts, applyMemoryOps,
  memVectorId, COMMANDS, parseCommandAndArg,
} from "./harness.mjs";

const ragEnv = () => makeEnv({ ENABLE_RAG: "true" });
const runMemory = async (ctx, text) => COMMANDS.memory(ctx, parseCommandAndArg(text, ctx.cfg));
const K = (id, text, source = "auto") => ({ id, text, source });

/* ====================================================================== */
/* =====================  parseMemoryOps (protocol)  ==================== */
/* ====================================================================== */

describe("parseMemoryOps · protocol", () => {
  test("ADD / UPDATE are parsed; keywords are case-insensitive", () => {
    const ops = parseMemoryOps("ADD: Стас живёт в Кишинёве\nupdate 7: Вася таксует", [K(7, "Вася на складе"), K(9, "старое")]);
    assert.deepEqual(ops.adds, ["Стас живёт в Кишинёве"]);
    assert.deepEqual(ops.updates, [{ id: 7, text: "Вася таксует" }]);
  });

  test("DELETE is not an operation: the line is dropped — never applied, never an ADD", () => {
    const known = [K(7, "Вася на складе"), K(9, "старое")];
    const ops = parseMemoryOps("Delete 9\nDELETE [7] -> [9]\nDELETE 7, 9\nremove 9\nUPDATE 7: Вася таксует", known);
    assert.deepEqual(ops, { adds: [], updates: [{ id: 7, text: "Вася таксует" }] });
  });

  test("a plain line (no keyword) is an ADD — back-compat with the old append-only output", () => {
    const ops = parseMemoryOps("- живёт в Кишинёве\n2. любит вино\nпросто факт", []);
    assert.deepEqual(ops.adds, ["живёт в Кишинёве", "любит вино", "просто факт"]);
    assert.deepEqual(ops.updates, []);
  });

  test("an id the model was NOT shown is a hallucinated reference → dropped", () => {
    const ops = parseMemoryOps("UPDATE 999: whatever", [K(1, "a")]);
    assert.deepEqual(ops.updates, []);
  });

  test("manual facts are protected from UPDATE (user intent wins)", () => {
    const known = [K(3, "я вегетарианец", "manual"), K(4, "auto fact")];
    const ops = parseMemoryOps("UPDATE 3: ест мясо\nUPDATE 4: auto fact, corrected", known);
    assert.deepEqual(ops.updates, [{ id: 4, text: "auto fact, corrected" }]);
  });

  test("UPDATE whose new text already exists as another fact is a no-op (it used to be a merge = a delete)", () => {
    const known = [K(1, "Вася таксует"), K(2, "Вася водит такси")];
    const ops = parseMemoryOps("UPDATE 2: Вася таксует", known);
    assert.deepEqual(ops, { adds: [], updates: [] });
  });

  test("UPDATE to the same text (case-insensitive) is a no-op", () => {
    const ops = parseMemoryOps("UPDATE 1: ВАСЯ ТАКСУЕТ", [K(1, "Вася таксует")]);
    assert.deepEqual(ops.updates, []);
  });

  test("one op per id per pass — the first wins", () => {
    const ops = parseMemoryOps("UPDATE 1: x\nUPDATE 1: y", [K(1, "a")]);
    assert.deepEqual(ops.updates, [{ id: 1, text: "x" }]);
  });

  test("ADD dedups against known facts and within the batch; capped at maxAdds", () => {
    const ops = parseMemoryOps("ADD: a\nADD: A\nADD: known\nb\nc\nd\ne\nf\ng", [K(1, "known")]);
    assert.deepEqual(ops.adds, ["a", "b", "c", "d", "e"]); // 5 = MEM_MAX_FACTS_PER_RUN
    const zero = parseMemoryOps("ADD: a\nUPDATE 1: known, corrected", [K(1, "known")], "en", 0);
    assert.deepEqual(zero.adds, []);      // maxAdds=0 → no invented facts
    assert.deepEqual(zero.updates, [{ id: 1, text: "known, corrected" }]);
  });

  test("refusals/headings are ignored for ADD and for UPDATE text", () => {
    const ops = parseMemoryOps("Extracted facts:\nnone\nUPDATE 1: no facts", [K(1, "a")], "en");
    assert.deepEqual(ops.adds, []);
    assert.deepEqual(ops.updates, []);
  });

  test("a stray `- 12` / `-1` is a bullet, not an op", () => {
    const ops = parseMemoryOps("- 12\n-1", [K(1, "a"), K(12, "b")]);
    assert.deepEqual(ops.updates, []);
  });

  test("NONE (the explicit nothing-to-do sentinel) yields no ops and is not a fact", () => {
    const ops = parseMemoryOps("NONE", [K(1, "a")]);
    assert.deepEqual(ops, { adds: [], updates: [] });
    assert.deepEqual(parseMemoryOps("none.", []).adds, []);
  });

  test("ids written as [id] / #id are understood (deepseek echoes the [id] it was shown)", () => {
    const known = [K(1, "one"), K(2, "two"), K(3, "three")];
    const ops = parseMemoryOps("UPDATE [1]: one, corrected\nUPDATE #2: two, corrected\nUPDATE [ 3 ]: three, corrected", known, "en", 0);
    assert.deepEqual(ops.updates, [{ id: 1, text: "one, corrected" }, { id: 2, text: "two, corrected" }, { id: 3, text: "three, corrected" }]);
    assert.deepEqual(ops.adds, []);
  });

  test("a protocol line that does not parse never turns into an ADD", () => {
    const known = [K(1, "one")];
    const ops = parseMemoryOps("UPDATE 1 no colon here\nDELETE all\nDELETE [999]\nUPDATE [999]: ghost", known, "en", 5);
    assert.deepEqual(ops, { adds: [], updates: [] });
  });

  test("an UPDATE that shrinks a fact below half its length is compression, not a correction → skipped", () => {
    const long = "Стас принимает фенибут по назначению врача (500 мг утром и 500 мг в обед), плюс глицин и 3 мг мелатонина перед сном.";
    const known = [K(1, long), K(2, "Лиза любит сыр"), K(3, "Лиза обожает сыр")];
    const ops = parseMemoryOps(`UPDATE 1: Стас принимает фенибут, глицин и мелатонин.\nUPDATE 2: Лиза любит сыр (очень)\nUPDATE 3: Лиза любит сыр`, known, "en", 0);
    assert.deepEqual(ops.updates, [{ id: 2, text: "Лиза любит сыр (очень)" }]); // 1 skipped (shrunk), 3 no-op (text exists)
  });

  test("parseExtractedFacts (legacy wrapper) is unchanged in behaviour", () => {
    assert.deepEqual(parseExtractedFacts("- факт1\n2. факт2\n\nфакт3"), ["факт1", "факт2", "факт3"]);
    assert.deepEqual(parseExtractedFacts("новый", ["новый"]), []);
  });
});

/* ====================================================================== */
/* =====================  storage: updateMemory / deleteMemory  ========= */
/* ====================================================================== */

describe("storage · updateMemory / deleteMemory", () => {
  test("updateMemory rewrites the row text in place and re-embeds under the SAME vector id", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 50 }), env, { ...DEFAULT_CHAT_DATA() });
    const id = await addMemory(ctx, "Вася на складе", "auto");
    const vid = memVectorId(50, id);
    const before = env._vec.store.get(vid);
    assert.ok(before);
    assert.equal(await updateMemory(ctx, id, "Вася таксует"), true);
    const rows = await dbMemories(env, 50);
    assert.deepEqual(rows.map(r => r.text), ["Вася таксует"]);
    const after = env._vec.store.get(vid);
    assert.equal(after.metadata.text, "Вася таксует");
    assert.notEqual(JSON.stringify(after.values), JSON.stringify(before.values)); // re-embedded
    assert.equal(env._vec.store.size, 1);            // no orphan vector
  });

  test("updateMemory keeps the source (manual stays manual)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 51 }), env, { ...DEFAULT_CHAT_DATA() });
    const id = await addMemory(ctx, "старое", "manual");
    await updateMemory(ctx, id, "новое");
    assert.equal((await dbMemories(env, 51))[0].source, "manual");
    assert.equal(env._vec.store.get(memVectorId(51, id)).metadata.source, "manual");
  });

  test("updateMemory: empty / unchanged text / foreign id → false, nothing written", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 52 }), env, { ...DEFAULT_CHAT_DATA() });
    const id = await addMemory(ctx, "a", "auto");
    const other = makeCtxFor(makeMsg({ chatId: 53 }), env, { ...DEFAULT_CHAT_DATA() });
    const foreign = await addMemory(other, "b", "auto");
    assert.equal(await updateMemory(ctx, id, ""), false);
    assert.equal(await updateMemory(ctx, id, "a"), false);
    assert.equal(await updateMemory(ctx, foreign, "hijack"), false); // chat-scoped
    assert.equal((await dbMemories(env, 53))[0].text, "b");
  });

  test("updateMemory: text collision with another fact (UNIQUE) → false", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 54 }), env, { ...DEFAULT_CHAT_DATA() });
    const a = await addMemory(ctx, "one", "auto");
    await addMemory(ctx, "two", "auto");
    assert.equal(await updateMemory(ctx, a, "two"), false);
    assert.deepEqual((await dbMemories(env, 54)).map(r => r.text), ["one", "two"]);
  });

  test("deleteMemory (the human path: /memory del) returns whether a row went; foreign id is a no-op", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 55 }), env, { ...DEFAULT_CHAT_DATA() });
    const id = await addMemory(ctx, "x", "auto");
    const other = makeCtxFor(makeMsg({ chatId: 56 }), env, { ...DEFAULT_CHAT_DATA() });
    const foreign = await addMemory(other, "y", "auto");
    assert.equal(await deleteMemory(ctx, foreign), false);
    assert.equal((await dbMemories(env, 56)).length, 1);
    assert.equal(await deleteMemory(ctx, id), true);
    assert.equal((await dbMemories(env, 55)).length, 0);
    assert.equal(env._vec.store.has(memVectorId(55, id)), false);
    assert.equal(await deleteMemory(ctx, id), false); // already gone
  });
});

/* ====================================================================== */
/* =====================  runMemoryCuration applies ops  ================ */
/* ====================================================================== */

describe("runMemoryCuration · reconciles instead of appending", () => {
  const seedTwo = async (env, chatId) => {
    await seedChat(env, chatId, { history: [
      { role: "user", content: "я ушёл со склада, теперь таксую" },
      { role: "user", content: "и в отпуск больше не еду" },
    ] });
    const ctx = makeCtxFor(makeMsg({ chatId }), env, { ...DEFAULT_CHAT_DATA() });
    const job = await addMemory(ctx, "Вася работает на складе", "auto");
    const trip = await addMemory(ctx, "Вася едет в отпуск в мае", "auto");
    return { ctx, job, trip };
  };

  test("UPDATE replaces the stale fact, ADD adds, a DELETE line is ignored; boundary advances", async () => {
    const env = ragEnv();
    const { ctx, job, trip } = await seedTwo(env, 60);
    FETCH.set("chat", () => sse([`UPDATE ${job}: Вася таксует\nDELETE ${trip}\nADD: Вася не любит отпуска`]));
    await runMemoryCuration(ctx);
    const rows = await dbMemories(env, 60);
    assert.deepEqual(rows.map(r => r.text).sort(), ["Вася едет в отпуск в мае", "Вася не любит отпуска", "Вася таксует"].sort());
    assert.equal(env._vec.store.size, 3);
    assert.equal(env._vec.store.get(memVectorId(60, job)).metadata.text, "Вася таксует");
    assert.equal(env._vec.store.has(memVectorId(60, trip)), true); // an LLM pass never deletes
    assert.equal(ctx.chatData._memUptoId, 2);
  });

  test("the extractor is shown known facts WITH their ids (so it can reference them); the prompt offers no DELETE", async () => {
    const env = ragEnv();
    const { ctx, job } = await seedTwo(env, 61);
    FETCH.set("chat", () => sse(["NONE"]));
    await runMemoryCuration(ctx);
    const sys = FETCH.chatBody().messages[0].content;
    assert.ok(sys.includes(`[${job}] Вася работает на складе`), sys);
    assert.ok(/UPDATE <id>/.test(sys));
    assert.ok(!/DELETE <id>/.test(sys), sys);
  });

  test("a model that ignores the protocol (plain lines) still just adds — never silent", async () => {
    const env = ragEnv();
    const { ctx } = await seedTwo(env, 62);
    FETCH.set("chat", () => sse(["Вася таксует\nВася не едет в отпуск"]));
    await runMemoryCuration(ctx);
    assert.equal((await dbMemories(env, 62)).length, 4); // 2 old + 2 new (append-only fallback)
  });

  test("manual facts survive an LLM pass that tries to delete/rewrite them", async () => {
    const env = ragEnv();
    await seedChat(env, 63, { history: [{ role: "user", content: "a" }, { role: "user", content: "b" }] });
    const ctx = makeCtxFor(makeMsg({ chatId: 63 }), env, { ...DEFAULT_CHAT_DATA() });
    const m = await addMemory(ctx, "я вегетарианец", "manual");
    FETCH.set("chat", () => sse([`DELETE ${m}\nUPDATE ${m}: ест мясо`]));
    await runMemoryCuration(ctx);
    assert.deepEqual((await dbMemories(env, 63)).map(r => r.text), ["я вегетарианец"]);
  });

  test("ADD is deduped against ALL known facts, not just the shown slice", async () => {
    const env = ragEnv();
    await seedChat(env, 64, { history: [{ role: "user", content: "a" }, { role: "user", content: "b" }] });
    const ctx = makeCtxFor(makeMsg({ chatId: 64 }), env, { ...DEFAULT_CHAT_DATA() });
    // 45 facts: the first 5 fall outside the MEM_KNOWN_SHOWN=40 window the model sees
    for (let i = 0; i < 45; i++) await addMemory(ctx, "fact " + i, "auto");
    FETCH.set("chat", () => sse(["ADD: fact 0\nADD: fact 44\nADD: brand new"]));
    await runMemoryCuration(ctx);
    assert.equal((await dbMemories(env, 64)).length, 46); // only "brand new" got in
  });

  test("LLM fallback → nothing applied, boundary NOT advanced", async () => {
    const env = ragEnv();
    const { ctx, job } = await seedTwo(env, 65);
    FETCH.set("chat", () => sse([], { ok: false, status: 500 }));
    await runMemoryCuration(ctx);
    assert.equal((await dbMemories(env, 65)).length, 2);
    assert.equal((await dbMemories(env, 65)).find(r => r.id === job).text, "Вася работает на складе");
    assert.equal(ctx.chatData._memUptoId, 0);
  });

  // The live failure modes of the removed list-only consolidation (2026-09-15): DELETE with a pair, a bare DELETE,
  // a merge-UPDATE onto an unrelated fact. None of that can touch the store through the extraction pass either.
  test("DELETE lines and a merge-UPDATE onto an unrelated fact leave every fact intact", async () => {
    const env = ragEnv();
    await seedChat(env, 66, { history: [{ role: "user", content: "a" }, { role: "user", content: "b" }] });
    const ctx = makeCtxFor(makeMsg({ chatId: 66 }), env, { ...DEFAULT_CHAT_DATA() });
    const texts = ["Глеб проектирует интерфейсы", "Глеб хокаге, графический дизайнер", "Стас избегает незнакомых девушек на улице", "Стас водомут"];
    const ids = [];
    for (const tx of texts) ids.push(await addMemory(ctx, tx, "auto"));
    FETCH.set("chat", () => sse([[`DELETE ${ids[0]} -> ${ids[1]}`, `UPDATE ${ids[2]}: Стас водомут`, `DELETE ${ids[3]}`].join("\n")]));
    await runMemoryCuration(ctx);
    assert.deepEqual((await dbMemories(env, 66)).map(r => r.text), texts);
    assert.equal(env._vec.store.size, 4);
  });
});

/* ====================================================================== */
/* =====================  applyMemoryOps  =============================== */
/* ====================================================================== */

describe("applyMemoryOps", () => {
  test("updates then adds; counts what actually went through", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 77 }), env, { ...DEFAULT_CHAT_DATA() });
    const a = await addMemory(ctx, "a", "auto");
    const r = await applyMemoryOps(ctx, { updates: [{ id: a, text: "a, corrected" }, { id: 999, text: "ghost" }], adds: ["new"] });
    assert.deepEqual(r, { added: 1, updated: 1 });
    assert.deepEqual((await dbMemories(env, 77)).map(x => x.text), ["a, corrected", "new"]);
  });

  test("updates of one pass are applied concurrently (several re-embeds/upserts in flight at once)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 90 }), env, { ...DEFAULT_CHAT_DATA() });
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await addMemory(ctx, "f" + i, "auto"));
    let inFlight = 0, maxInFlight = 0;
    const orig = env.VECTORIZE.upsert.bind(env.VECTORIZE);
    env.VECTORIZE.upsert = async (v) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(r => setTimeout(r, 15)); inFlight--; return orig(v); };
    const res = await applyMemoryOps(ctx, { adds: [], updates: ids.map((id, i) => ({ id, text: "f" + i + " corrected" })) });
    assert.equal(res.updated, 6);
    assert.ok(maxInFlight > 1, "expected overlapping updates, got " + maxInFlight);
    assert.deepEqual((await dbMemories(env, 90)).map(r => r.text), ids.map((_, i) => "f" + i + " corrected"));
  });
});

/* ====================================================================== */
/* =====================  /memory consolidate is gone  ================== */
/* ====================================================================== */

describe("/memory consolidate no longer exists", () => {
  test("`/memory consolidate` and the old RU alias fall through to the unknown-subcommand path; no LLM call", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 99, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    await addMemory(ctx, "a", "auto"); await addMemory(ctx, "b", "auto");
    FETCH.set("chat", () => sse(["UPDATE 1: hijack"]));
    const out = await runMemory(ctx, "/memory consolidate");
    assert.ok(!/consolidated|Dry run|tidy/i.test(out), out);
    await runMemory(ctx, "/memory свести");
    assert.equal(FETCH.of("/chat/completions").length, 0);
    assert.deepEqual((await dbMemories(env, 99)).map(r => r.text), ["a", "b"]);
  });
});
