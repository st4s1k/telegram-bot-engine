// Memory RECONCILIATION: curation speaks an operation protocol (ADD / UPDATE <id> / DELETE <id>) so
// long-term memory is not append-only — a stale fact is replaced or removed instead of piling up next
// to its newer version. Plain lines still mean ADD (a model that ignores the protocol degrades to the
// old behaviour). Manual facts are protected from LLM passes. /memory consolidate = full pass.
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
  test("ADD / UPDATE / DELETE are parsed; keywords are case-insensitive", () => {
    const ops = parseMemoryOps("ADD: Стас живёт в Кишинёве\nupdate 7: Вася таксует\nDelete 9", [K(7, "Вася на складе"), K(9, "старое")]);
    assert.deepEqual(ops.adds, ["Стас живёт в Кишинёве"]);
    assert.deepEqual(ops.updates, [{ id: 7, text: "Вася таксует" }]);
    assert.deepEqual(ops.deletes, [9]);
  });

  test("a plain line (no keyword) is an ADD — back-compat with the old append-only output", () => {
    const ops = parseMemoryOps("- живёт в Кишинёве\n2. любит вино\nпросто факт", []);
    assert.deepEqual(ops.adds, ["живёт в Кишинёве", "любит вино", "просто факт"]);
    assert.deepEqual(ops.updates, []);
    assert.deepEqual(ops.deletes, []);
  });

  test("an id the model was NOT shown is a hallucinated reference → dropped", () => {
    const ops = parseMemoryOps("UPDATE 999: whatever\nDELETE 42", [K(1, "a")]);
    assert.deepEqual(ops.updates, []);
    assert.deepEqual(ops.deletes, []);
  });

  test("manual facts are protected from UPDATE/DELETE (user intent wins)", () => {
    const known = [K(3, "я вегетарианец", "manual"), K(4, "auto fact")];
    const ops = parseMemoryOps("DELETE 3\nUPDATE 3: ест мясо\nDELETE 4", known);
    assert.deepEqual(ops.deletes, [4]);
    assert.deepEqual(ops.updates, []);
  });

  test("UPDATE whose new text already exists as another fact is a MERGE → DELETE of the updated id", () => {
    const known = [K(1, "Вася таксует"), K(2, "Вася водит такси")];
    const ops = parseMemoryOps("UPDATE 2: Вася таксует", known);
    assert.deepEqual(ops.updates, []);
    assert.deepEqual(ops.deletes, [2]);
  });

  test("UPDATE to the same text (case-insensitive) is a no-op", () => {
    const ops = parseMemoryOps("UPDATE 1: ВАСЯ ТАКСУЕТ", [K(1, "Вася таксует")]);
    assert.deepEqual(ops.updates, []);
    assert.deepEqual(ops.deletes, []);
  });

  test("one op per id per pass — the first wins", () => {
    const ops = parseMemoryOps("DELETE 1\nUPDATE 1: x", [K(1, "a")]);
    assert.deepEqual(ops.deletes, [1]);
    assert.deepEqual(ops.updates, []);
  });

  test("ADD dedups against known facts and within the batch; capped at maxAdds", () => {
    const ops = parseMemoryOps("ADD: a\nADD: A\nADD: known\nb\nc\nd\ne\nf\ng", [K(1, "known")]);
    assert.deepEqual(ops.adds, ["a", "b", "c", "d", "e"]); // 5 = MEM_MAX_FACTS_PER_RUN
    const zero = parseMemoryOps("ADD: a\nDELETE 1", [K(1, "known")], "en", 0);
    assert.deepEqual(zero.adds, []);      // maxAdds=0 → a consolidation pass never invents facts
    assert.deepEqual(zero.deletes, [1]);
  });

  test("refusals/headings are ignored for ADD and for UPDATE text", () => {
    const ops = parseMemoryOps("Extracted facts:\nnone\nUPDATE 1: no facts", [K(1, "a")], "en");
    assert.deepEqual(ops.adds, []);
    assert.deepEqual(ops.updates, []);
  });

  test("a stray `- 12` / `-1` is a bullet, not a DELETE (only the DELETE keyword deletes)", () => {
    const ops = parseMemoryOps("- 12\n-1", [K(1, "a"), K(12, "b")]);
    assert.deepEqual(ops.deletes, []);
    assert.deepEqual(ops.updates, []);
  });

  test("NONE (the explicit nothing-to-do sentinel) yields no ops and is not a fact", () => {
    const ops = parseMemoryOps("NONE", [K(1, "a")]);
    assert.deepEqual(ops, { adds: [], updates: [], deletes: [] });
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

  test("updateMemory: text collision with another fact (UNIQUE) → false (caller merges)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 54 }), env, { ...DEFAULT_CHAT_DATA() });
    const a = await addMemory(ctx, "one", "auto");
    await addMemory(ctx, "two", "auto");
    assert.equal(await updateMemory(ctx, a, "two"), false);
    assert.deepEqual((await dbMemories(env, 54)).map(r => r.text), ["one", "two"]);
  });

  test("deleteMemory returns whether a row went; foreign id is a no-op", async () => {
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

  test("UPDATE replaces the stale fact, DELETE removes the obsolete one, ADD adds; boundary advances", async () => {
    const env = ragEnv();
    const { ctx, job, trip } = await seedTwo(env, 60);
    FETCH.set("chat", () => sse([`UPDATE ${job}: Вася таксует\nDELETE ${trip}\nADD: Вася не любит отпуска`]));
    await runMemoryCuration(ctx);
    const rows = await dbMemories(env, 60);
    assert.deepEqual(rows.map(r => r.text).sort(), ["Вася не любит отпуска", "Вася таксует"].sort());
    assert.equal(env._vec.store.size, 2);
    assert.equal(env._vec.store.get(memVectorId(60, job)).metadata.text, "Вася таксует");
    assert.equal(env._vec.store.has(memVectorId(60, trip)), false);
    assert.equal(ctx.chatData._memUptoId, 2);
  });

  test("the extractor is shown known facts WITH their ids (so it can reference them)", async () => {
    const env = ragEnv();
    const { ctx, job } = await seedTwo(env, 61);
    FETCH.set("chat", () => sse(["NONE"]));
    await runMemoryCuration(ctx);
    const sys = FETCH.chatBody().messages[0].content;
    assert.ok(sys.includes(`[${job}] Вася работает на складе`), sys);
    assert.ok(/UPDATE <id>/.test(sys));
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

describe("/memory consolidate · full reconciliation pass", () => {
  test("merges duplicates and resolves contradictions across the whole list; reports counts", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 70, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    const a = await addMemory(ctx, "Vasya works at a warehouse", "auto");
    const b = await addMemory(ctx, "Vasya drives a taxi", "auto");
    const c = await addMemory(ctx, "Vasya is a taxi driver", "auto");
    FETCH.set("chat", () => sse([`DELETE ${a}\nUPDATE ${b}: Vasya drives a taxi (since March)\nDELETE ${c}`]));
    const out = await runMemory(ctx, "/memory consolidate");
    assert.match(out, /consolidated: updated 1, deleted 2 \(of 3 facts\)/);
    assert.deepEqual((await dbMemories(env, 70)).map(r => r.text), ["Vasya drives a taxi (since March)"]);
    assert.equal(env._vec.store.size, 1);
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
    const a = await addMemory(ctx, "dup", "auto");
    const b = await addMemory(ctx, "dup twin", "auto");
    FETCH.set("chat", () => sse([`DELETE ${b}`]));
    const out = await runMemory(ctx, "/memory consolidate");
    assert.match(out, /deleted 1/);
    assert.deepEqual((await dbMemories(env, 72)).map(r => r.id), [a]);
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
    const a = await addMemory(ctx, "auto", "auto");
    FETCH.set("chat", () => sse([`DELETE ${m}\nDELETE ${a}`]));
    await runMemory(ctx, "/memory consolidate");
    assert.deepEqual((await dbMemories(env, 74)).map(r => r.id), [m]);
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
    FETCH.set("chat", () => sse(["DELETE 1\nDELETE 2"]));
    assert.equal(await consolidateMemories(ctx), null);
    assert.equal(FETCH.of("/chat/completions").length, 0);
    assert.equal((await dbMemories(env, 76)).length, 2);
  });

  test("applyMemoryOps order: deletes → updates → adds (a merge never races its own update)", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 77 }), env, { ...DEFAULT_CHAT_DATA() });
    const a = await addMemory(ctx, "a", "auto");
    const r = await applyMemoryOps(ctx, { deletes: [a], updates: [{ id: a, text: "ghost" }], adds: ["new"] });
    assert.deepEqual(r, { added: 1, updated: 0, deleted: 1 });
    assert.deepEqual((await dbMemories(env, 77)).map(x => x.text), ["new"]);
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

  test("a clean first window (NONE) does not stop the run: the second window is processed in the same call", async () => {
    const env = ragEnv();
    const ctx = makeCtxFor(makeMsg({ chatId: 75, chatType: "private" }), env, { ...DEFAULT_CHAT_DATA(), config: { lang: "en" } });
    const ids = await seed45(ctx);
    let n = 0;
    FETCH.set("chat", () => sse([++n === 1 ? "NONE" : `DELETE ${ids[40]}`]));
    const out = await runMemory(ctx, "/memory consolidate");
    assert.equal(n, 2);                                    // two windows → two passes
    assert.match(out, /deleted 1 \(of 45 facts\) — checked 45, passes: 2/);
    assert.ok(!/Ran out of time/.test(out));               // complete → no partial suffix
    assert.equal((await dbMemories(env, 75)).length, 44);
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
    FETCH.set("chat", () => (++n === 1 ? sse([`DELETE ${ids[3]}`]) : sse([], { ok: false, status: 500 })));
    const out = await runMemory(ctx, "/memory consolidate");
    assert.match(out, /deleted 1 \(of 45 facts\) — checked 40, passes: 1/); // progress of pass 1 kept
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
    FETCH.set("chat", () => (++n === 1 ? sse([], { ok: false, status: 500 }) : sse([`DELETE ${ids[44]}`])));
    const r = await consolidateMemories(ctx);
    assert.equal(r.passes, 1);                                  // window 2 succeeded and was applied…
    assert.equal((await dbMemories(env, 81)).length, 44);
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
