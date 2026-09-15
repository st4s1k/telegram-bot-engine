// Memory RECONCILIATION: curation speaks an operation protocol (ADD / UPDATE <id>) so long-term memory is
// not append-only — a fact that changed is UPDATEd in place instead of piling up next to its newer
// version. There is NO DELETE: an LLM pass never removes a fact (only a human does — /memory del/forget).
// Plain lines still mean ADD (a model that ignores the protocol degrades to the old behaviour). Manual
// facts are protected from LLM passes. /memory consolidate = full contradiction-repair pass.
import {
  test, describe, assert,
  makeEnv, makeCtxFor, makeMsg, seedChat, dbMemories,
  FETCH, sse, DEFAULT_CHAT_DATA,
  addMemory, listMemories, updateMemory, deleteMemory,
  runMemoryCuration, consolidateMemories, parseMemoryOps, parseExtractedFacts, applyMemoryOps,
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
    assert.deepEqual(zero.adds, []);      // maxAdds=0 → a consolidation pass never invents facts
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
});

/* ====================================================================== */
/* =====================  /memory consolidate  ========================== */
/* ====================================================================== */

describe("/memory consolidate · full contradiction-repair pass", () => {
  test("a changed fact is UPDATEd to its current state; nothing is deleted; counts reported", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 70, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    const a = await addMemory(ctx, "Vasya plans laser eye surgery, 4000 euro", "auto");
    const b = await addMemory(ctx, "Vasya had laser eye surgery", "auto");
    const c = await addMemory(ctx, "Vasya is a taxi driver", "auto");
    FETCH.set("chat", () => sse([`UPDATE ${a}: Vasya had laser eye surgery, it cost 4000 euro\nDELETE ${b} -> ${a}\nDELETE ${c}`]));
    const out = await runMemory(ctx, "/memory consolidate");
    assert.match(out, /consolidated: updated 1 \(of 3 facts\)/);
    assert.deepEqual((await dbMemories(env, 70)).map(r => r.text), ["Vasya had laser eye surgery, it cost 4000 euro", "Vasya had laser eye surgery", "Vasya is a taxi driver"]);
    assert.equal(env._vec.store.size, 3);
  });

  test("a consolidation pass never invents facts (ADD lines are ignored)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 71 }), env, { ...DEFAULT_CHAT_DATA() });
    await addMemory(ctx, "a", "auto"); await addMemory(ctx, "b", "auto");
    FETCH.set("chat", () => sse(["ADD: invented\nADD: also invented"]));
    await runMemory(ctx, "/memory consolidate");
    assert.equal((await dbMemories(env, 71)).length, 2);
  });

  test("works with rag OFF (explicit user action, like /memory add)", async () => {
    const env = makeEnv(); // no ENABLE_RAG
    const ctx = makeCtxFor(makeMsg({ chatId: 72, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    const a = await addMemory(ctx, "Vasya likes cheese", "auto");
    FETCH.set("chat", () => sse([`UPDATE ${a}: Vasya likes cheese a lot`]));
    await addMemory(ctx, "Vasya has a cat", "auto");
    const out = await runMemory(ctx, "/memory consolidate");
    assert.match(out, /updated 1/);
    assert.equal((await dbMemories(env, 72)).find(r => r.id === a).text, "Vasya likes cheese a lot");
  });

  test("already tidy (no ops) / too few facts / LLM failure → distinct messages, nothing changed", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 73, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    assert.match(await runMemory(ctx, "/memory consolidate"), /Too few facts/);
    await addMemory(ctx, "a", "auto"); await addMemory(ctx, "b", "auto");
    FETCH.set("chat", () => sse(["NONE"]));
    assert.match(await runMemory(ctx, "/memory consolidate"), /already tidy/);
    FETCH.set("chat", () => sse([], { ok: false, status: 500 }));
    assert.match(await runMemory(ctx, "/memory consolidate"), /Couldn't consolidate/);
    assert.equal((await dbMemories(env, 73)).length, 2);
  });

  test("manual facts are untouched by consolidation", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 74 }), env, { ...DEFAULT_CHAT_DATA() });
    const m = await addMemory(ctx, "keep me", "manual");
    await addMemory(ctx, "auto", "auto");
    FETCH.set("chat", () => sse([`UPDATE ${m}: keep me not`]));
    await runMemory(ctx, "/memory consolidate");
    assert.deepEqual((await dbMemories(env, 74)).map(r => r.text), ["keep me", "auto"]);
  });

  test("RU alias `/memory свести` routes to consolidate", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 75, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "ru" } });
    await addMemory(ctx, "a", "auto"); await addMemory(ctx, "b", "auto");
    FETCH.set("chat", () => sse(["NONE"]));
    assert.match(await runMemory(ctx, "/memory свести"), /в порядке/);
  });

  test("admin preview (_preview) → no writes, no LLM", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 76 }), env, { ...DEFAULT_CHAT_DATA() });
    await addMemory(ctx, "a", "auto"); await addMemory(ctx, "b", "auto");
    ctx._preview = true;
    FETCH.set("chat", () => sse(["UPDATE 1: x\nUPDATE 2: y"]));
    assert.equal(await consolidateMemories(ctx), null);
    assert.equal(FETCH.of("/chat/completions").length, 0);
    assert.equal((await dbMemories(env, 76)).length, 2);
  });

  test("applyMemoryOps: updates then adds; counts what actually went through", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 77 }), env, { ...DEFAULT_CHAT_DATA() });
    const a = await addMemory(ctx, "a", "auto");
    const r = await applyMemoryOps(ctx, { updates: [{ id: a, text: "a, corrected" }, { id: 999, text: "ghost" }], adds: ["new"] });
    assert.deepEqual(r, { added: 1, updated: 1 });
    assert.deepEqual((await dbMemories(env, 77)).map(x => x.text), ["a, corrected", "new"]);
  });
});


/* ====================================================================== */
/* =====================  /memory consolidate · loop + cursor  ========== */
/* ====================================================================== */

// One invocation loops over the facts in windows of MEM_CONSOLIDATE_MAX (40) while under the time budget;
// progress survives between invocations via the KV cursor `consolidate:<chatId>`, so a clean oldest window
// (NONE) no longer traps every later run on the same 40 facts.
describe("/memory consolidate · loops over windows, resumes from the KV cursor", () => {
  const CURSOR = (chatId) => "consolidate:" + chatId;
  async function seed45(ctx) {
    const ids = [];
    for (let i = 0; i < 45; i++) ids.push(await addMemory(ctx, "fact " + i, "auto"));
    return ids;
  }
  const prompts = () => FETCH.of("/chat/completions").map(c => c.body.messages[0].content);
  const textOf = async (env, chatId, id) => (await dbMemories(env, chatId)).find(r => r.id === id).text;

  test("a clean first window (NONE) does not stop the run: the second window is processed in the same call", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 75, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    const ids = await seed45(ctx);
    let n = 0;
    FETCH.set("chat", () => sse([++n === 1 ? "NONE" : `UPDATE ${ids[40]}: fact 40, corrected`]));
    const out = await runMemory(ctx, "/memory consolidate");
    assert.equal(n, 2);                                    // two windows → two passes
    assert.match(out, /updated 1 \(of 45 facts\) — checked 45, passes: 2/);
    assert.ok(!/Ran out of time/.test(out));               // complete → no partial suffix
    assert.equal(await textOf(env, 75, ids[40]), "fact 40, corrected");
    assert.ok(!env._kv.store.has(CURSOR(75)));             // finished → cursor cleared
    // each window saw only its own ids
    const [p1, p2] = prompts();
    assert.ok(p1.includes(`[${ids[0]}]`) && !p1.includes(`[${ids[40]}]`));
    assert.ok(p2.includes(`[${ids[40]}]`) && !p2.includes(`[${ids[0]}]`));
  });

  test("an LLM failure after the first pass keeps the progress, stores the cursor; the next run resumes after it", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 76, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    const ids = await seed45(ctx);
    let n = 0;
    FETCH.set("chat", () => (++n === 1 ? sse([`UPDATE ${ids[3]}: fact 3, corrected`]) : sse([], { ok: false, status: 500 })));
    const out = await runMemory(ctx, "/memory consolidate");
    assert.match(out, /updated 1 \(of 45 facts\) — checked 40, passes: 1/); // progress of pass 1 kept
    assert.match(out, /Ran out of time/);                                     // reported as partial
    assert.equal(env._kv.store.get(CURSOR(76)), String(ids[39]));            // cursor = last id of window 1

    // next invocation: continues AFTER the cursor — only the 5 remaining facts are shown
    FETCH.set("chat", () => sse(["NONE"]));
    const out2 = await runMemory(ctx, "/memory consolidate");
    const last = prompts().at(-1);
    assert.ok(last.includes(`[${ids[40]}]`) && !last.includes(`[${ids[0]}]`) && !last.includes(`[${ids[39]}]`));
    assert.match(out2, /already tidy/);                    // the remaining window was clean → tidy, not partial
    assert.ok(!env._kv.store.has(CURSOR(76)));             // reached the end → cursor cleared
  });

  test("a failure on the very FIRST pass of a run → failure message, nothing changed, cursor untouched", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 77, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    await seed45(ctx);
    FETCH.set("chat", () => sse([], { ok: false, status: 500 }));
    assert.match(await runMemory(ctx, "/memory consolidate"), /Couldn't consolidate/);
    assert.equal((await dbMemories(env, 77)).length, 45);
    assert.ok(!env._kv.store.has(CURSOR(77)));
  });

  test("time budget: with budgetMs=0 and parallel=1 exactly one round of one pass runs; the rest is left for the next run", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 78, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    const ids = await seed45(ctx);
    FETCH.set("chat", () => sse(["NONE"]));
    const r = await consolidateMemories(ctx, { budgetMs: 0, parallel: 1 });
    assert.equal(r.passes, 1);
    assert.equal(r.checked, 40);
    assert.equal(r.partial, true);
    assert.equal(env._kv.store.get(CURSOR(78)), String(ids[39]));
  });

  test("windows of one round run CONCURRENTLY: both windows are in flight before either answers", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 80, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    await seed45(ctx);
    let inFlight = 0, maxInFlight = 0;
    FETCH.set("chat", async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 20)); // both passes overlap here
      inFlight--;
      return sse(["NONE"]);
    });
    const r = await consolidateMemories(ctx, { budgetMs: 0 }); // budget 0 still runs the FIRST round in full
    assert.equal(maxInFlight, 2);                                // 45 facts = 2 windows, run together
    assert.equal(r.passes, 2);
    assert.equal(r.checked, 45);
    assert.equal(r.partial, false);
  });

  test("a failed window does not block the later windows of its round; the cursor stays contiguous", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 81, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    const ids = await seed45(ctx);
    let n = 0;
    FETCH.set("chat", () => (++n === 1 ? sse([], { ok: false, status: 500 }) : sse([`UPDATE ${ids[44]}: fact 44, corrected`])));
    const r = await consolidateMemories(ctx);
    assert.equal(r.passes, 1);                                  // window 2 succeeded and was applied…
    assert.equal(await textOf(env, 81, ids[44]), "fact 44, corrected");
    assert.equal(r.checked, 0);                                 // …but window 1 failed → cursor stays at the start
    assert.equal(r.partial, true);
    assert.ok(!env._kv.store.has(CURSOR(81)));                  // cursor 0 → no key (start over next time)
  });

  test("a stale cursor past the newest fact → the run starts over from the oldest", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 79, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    const ids = [await addMemory(ctx, "a", "auto"), await addMemory(ctx, "b", "auto")];
    await env.KV.put(CURSOR(79), String(ids[1] + 1000));
    FETCH.set("chat", () => sse(["NONE"]));
    await runMemory(ctx, "/memory consolidate");
    assert.ok(prompts().at(-1).includes(`[${ids[0]}]`));
    assert.ok(!env._kv.store.has(CURSOR(79)));
  });
});

describe("/memory consolidate · round deadline", () => {
  test("a stuck window does not hold the round: the settled windows are applied and the reply is on time", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 82, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    const ids = [];
    for (let i = 0; i < 45; i++) ids.push(await addMemory(ctx, "fact " + i, "auto"));
    let n = 0;
    FETCH.set("chat", async () => {
      if (++n === 1) return sse([`UPDATE ${ids[3]}: fact 3, corrected`]);  // window 1: fast
      await new Promise(r => setTimeout(r, 400)); return sse(["NONE"]);   // window 2: stuck past the deadline
    });
    const t0 = Date.now();
    const r = await consolidateMemories(ctx, { budgetMs: 0, roundMs: 100 });
    assert.ok(Date.now() - t0 < 350, "the round ended at the deadline, not when the stuck window finished");
    assert.equal(r.passes, 1);                                   // window 1 applied…
    assert.equal((await dbMemories(env, 82)).find(x => x.id === ids[3]).text, "fact 3, corrected");
    assert.equal(r.checked, 40);                                 // …window 2 is left for the next run
    assert.equal(r.partial, true);
    assert.equal(env._kv.store.get("consolidate:82"), String(ids[39]));
  });
});

describe("parseMemoryOps · id spelling tolerance", () => {
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
});

describe("/memory consolidate · finish_reason=length", () => {
  test("a pass cut by max_tokens: its LAST line is dropped, the complete lines before it are applied", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 91, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    await addMemory(ctx, "one", "auto");
    const b = await addMemory(ctx, "two", "auto");
    const c = await addMemory(ctx, "three", "auto");
    // SSE with finish_reason=length: the reply ends mid-UPDATE
    const body = `UPDATE ${b}: two, fully stated\nUPDATE ${c}: three became something lon`;
    FETCH.set("chat", () => sse([], { raw: "data: " + JSON.stringify({ choices: [{ delta: { content: body }, finish_reason: "length" }] }) + "\ndata: [DONE]" }));
    const out = await runMemory(ctx, "/memory consolidate");
    assert.match(out, /updated 1/);
    assert.deepEqual((await dbMemories(env, 91)).map(r => r.text), ["one", "two, fully stated", "three"]); // UPDATE c NOT applied
  });
  test("finish_reason=stop: the last line is a normal op", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 92, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    await addMemory(ctx, "one", "auto");
    const c = await addMemory(ctx, "three", "auto");
    FETCH.set("chat", () => sse([], { raw: "data: " + JSON.stringify({ choices: [{ delta: { content: `UPDATE ${c}: three, fully stated` }, finish_reason: "stop" }] }) + "\ndata: [DONE]" }));
    await runMemory(ctx, "/memory consolidate");
    assert.deepEqual((await dbMemories(env, 92)).map(r => r.text), ["one", "three, fully stated"]);
  });
});
describe("applyMemoryOps · concurrency", () => {
  test("updates of one pass are applied concurrently (several re-embeds/upserts in flight at once)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 90 }), env, { ...DEFAULT_CHAT_DATA() });
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await addMemory(ctx, "f" + i, "auto"));
    // instrument the vector upsert (called once per updated fact) to observe overlap
    let inFlight = 0, maxInFlight = 0;
    const orig = env.VECTORIZE.upsert.bind(env.VECTORIZE);
    env.VECTORIZE.upsert = async (v) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(r => setTimeout(r, 15)); inFlight--; return orig(v); };
    const res = await applyMemoryOps(ctx, { adds: [], updates: ids.map((id, i) => ({ id, text: "f" + i + " corrected" })) });
    assert.equal(res.updated, 6);
    assert.ok(maxInFlight > 1, "expected overlapping updates, got " + maxInFlight);
    assert.deepEqual((await dbMemories(env, 90)).map(r => r.text), ids.map((_, i) => "f" + i + " corrected"));
  });
});

describe("/memory consolidate · dry run · preview + diff in the reply", () => {
  test("dry: reply lists what WOULD be updated (was ⟶ now), nothing is written, no cursor", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 93, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    const a = await addMemory(ctx, "Vasya drives a taxi", "auto");
    await addMemory(ctx, "Vasya is a taxi driver", "auto");
    FETCH.set("chat", () => sse([`UPDATE ${a}: Vasya drives a taxi (since March)`]));
    const out = await runMemory(ctx, "/memory consolidate dry");
    assert.match(out, /Dry run/);
    assert.match(out, /updated 1 \(of 2 facts\)/);
    assert.ok(out.includes("Vasya drives a taxi ⟶ Vasya drives a taxi (since March)")); // was ⟶ now
    assert.deepEqual((await dbMemories(env, 93)).map(r => r.text), ["Vasya drives a taxi", "Vasya is a taxi driver"]); // untouched
    assert.ok(!env._kv.store.has("consolidate:93"));
  });
  test("real run: the reply carries the same diff and the change is applied", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 94, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    const a = await addMemory(ctx, "keep", "auto");
    await addMemory(ctx, "other", "auto");
    FETCH.set("chat", () => sse([`UPDATE ${a}: keep, corrected`]));
    const out = await runMemory(ctx, "/memory consolidate");
    assert.match(out, /Memory consolidated: updated 1/);
    assert.ok(out.includes("Updated (was ⟶ now):") && out.includes("keep ⟶ keep, corrected"));
    assert.deepEqual((await dbMemories(env, 94)).map(r => r.text), ["keep, corrected", "other"]);
  });
});

describe("parseMemoryOps · an UPDATE that shrinks a fact is compression, not a correction", () => {
  test("shrinking below half the length is skipped; a same-size rewording works; a text equal to another fact is a no-op", () => {
    const long = "Стас принимает фенибут по назначению врача (500 мг утром и 500 мг в обед), плюс глицин и 3 мг мелатонина перед сном.";
    const known = [K(1, long), K(2, "Лиза любит сыр"), K(3, "Лиза обожает сыр")];
    const ops = parseMemoryOps(`UPDATE 1: Стас принимает фенибут, глицин и мелатонин.\nUPDATE 2: Лиза любит сыр (очень)\nUPDATE 3: Лиза любит сыр`, known, "en", 0);
    assert.deepEqual(ops.updates, [{ id: 2, text: "Лиза любит сыр (очень)" }]); // 1 skipped (shrunk), 3 no-op
  });
});

describe("/memory consolidate · today's date is in the consolidation prompt", () => {
  test("the system prompt carries YYYY-MM-DD so passed vs future plans can be told apart; no DELETE is offered", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 95, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    await addMemory(ctx, "a", "auto"); await addMemory(ctx, "b", "auto");
    FETCH.set("chat", () => sse(["NONE"]));
    await runMemory(ctx, "/memory consolidate");
    const sys = FETCH.chatBody().messages[0].content;
    assert.match(sys, /Today is \d{4}-\d{2}-\d{2}\./);
    assert.ok(!/DELETE <id>/.test(sys), sys);
  });
});

// The reason there is no DELETE — the pairs a live dry run produced (2026-09-15): the model called any two
// facts about the same PERSON "duplicates" and asked to drop the informative one. None of that can happen now.
describe("an LLM pass never deletes · the live failure modes are inert", () => {
  test("DELETE with a pair, a bare DELETE and a merge-UPDATE onto an unrelated fact all leave the facts intact", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 98, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "ru" } });
    const texts = [
      "Глеб проектирует интерфейсы",
      "Глеб хокаге, графический дизайнер, пережил лимфому, геймер",
      "Стас избегает незнакомых девушек на улице из-за социальной тревожности.",
      "Стас водомут",
      "Глеб работает удалённо.",
      "Стас работает разработчиком промышленных программ.",
    ];
    const ids = [];
    for (const tx of texts) ids.push(await addMemory(ctx, tx, "auto"));
    FETCH.set("chat", () => sse([[
      `DELETE ${ids[0]} -> ${ids[1]}`,
      `UPDATE ${ids[2]}: Стас водомут`,
      `DELETE ${ids[4]}`,
      `DELETE ${ids[5]}, ${ids[3]} -> ${ids[0]}`,
    ].join("\n")]));
    const out = await runMemory(ctx, "/memory consolidate");
    assert.match(out, /в порядке/); // nothing to apply → "already tidy"
    assert.deepEqual((await dbMemories(env, 98)).map(r => r.text), texts);
    assert.equal(env._vec.store.size, 6);
  });
});
