#!/usr/bin/env node
// Read the observability journal (trace_events) of a LIVE deployment from the terminal — the same views as
// /admin trace | event, without Telegram. Uses `wrangler d1 execute --remote` with the deployment's
// wrangler.jsonc (real database id), so a logged-in wrangler session (or CLOUDFLARE_API_TOKEN) is enough.
//
//   node scripts/trace.mjs --config <path/to/deployment/wrangler.jsonc> stats [hours=24]
//   node scripts/trace.mjs --config … list <chatId> [n=10]        newest traces of a chat, one line each
//   node scripts/trace.mjs --config … trace <traceId>              one trace, every event
//   node scripts/trace.mjs --config … event <id>                   one event in full (LLM: prompt / question / memory / response)
//   node scripts/trace.mjs --config … errors [hours=24]            error events across chats
//   node scripts/trace.mjs --config … find <chatId> <substring>    LLM events whose question/response contains the text
//
// --db <name> overrides the D1 database name (default: the first `database_name` in the config).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); if (i < 0) return def; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const config = opt("--config", "wrangler.jsonc");
const dbOverride = opt("--db", "");
const [cmd, ...rest] = argv;

const dbName = dbOverride || (readFileSync(config, "utf8").match(/"database_name"\s*:\s*"([^"]+)"/) || [])[1];
if (!dbName) { console.error("no database_name in " + config + " (use --db)"); process.exit(1); }

// Windows: .cmd shims need a shell, and a shell needs the arguments quoted (the SQL has spaces and quotes).
const win = process.platform === "win32";
const shq = (a) => (win && /[\s"]/.test(a) ? "\"" + a.replace(/"/g, "\\\"") + "\"" : a);
function sql(query) {
  const args = ["wrangler", "d1", "execute", dbName, "--remote", "--config", config, "--json", "--command", query].map(shq);
  const r = spawnSync(win ? "npx.cmd" : "npx", args, { encoding: "utf8", shell: win });
  const out = String(r.stdout || "");
  const i = out.indexOf("[");
  if (r.status !== 0 || i < 0) { console.error((r.stderr || out).slice(0, 2000)); process.exit(1); }
  return JSON.parse(out.slice(i))[0].results;
}
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const when = (ts) => new Date(Number(ts)).toISOString().replace("T", " ").slice(0, 19);
const brief = (e) => e.stage + (e.kind ? ":" + e.kind : "") + (e.outcome ? " " + e.outcome : "") + (e.elapsed_ms != null ? " " + (e.elapsed_ms / 1000).toFixed(1) + "s" : "") + (e.cost != null ? " $" + Number(e.cost).toFixed(4) : "");
const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };

if (cmd === "stats") {
  const since = Date.now() - Number(rest[0] || 24) * 3600_000;
  const llm = sql(`SELECT kind, COUNT(*) n, SUM(CASE WHEN outcome='ok' THEN 1 ELSE 0 END) ok, ROUND(AVG(elapsed_ms)) avg_ms, MAX(elapsed_ms) max_ms, ROUND(COALESCE(SUM(cost),0),4) cost FROM trace_events WHERE stage='llm' AND ts>=${since} GROUP BY kind ORDER BY n DESC`);
  console.log("LLM (last " + (rest[0] || 24) + " h):");
  for (const r of llm) console.log(`  ${r.kind.padEnd(14)} calls ${String(r.n).padStart(4)}  failed ${String(r.n - r.ok).padStart(3)}  avg ${r.avg_ms} ms  max ${r.max_ms} ms  $${r.cost}`);
  const st = sql(`SELECT stage, COALESCE(kind,'') kind, COUNT(*) n FROM trace_events WHERE stage<>'llm' AND ts>=${since} GROUP BY stage, kind ORDER BY stage, n DESC`);
  console.log("stages:");
  for (const r of st) console.log(`  ${(r.stage + (r.kind ? ":" + r.kind : "")).padEnd(32)} ${r.n}`);
} else if (cmd === "list") {
  const [chat, n = "10"] = rest;
  if (!chat) { console.error("list <chatId> [n]"); process.exit(1); }
  const rows = sql(`SELECT * FROM trace_events WHERE chat_id=${q(chat)} ORDER BY id DESC LIMIT ${Number(n) * 24}`).reverse();
  const by = new Map();
  for (const e of rows) { (by.get(e.trace) || by.set(e.trace, []).get(e.trace)).push(e); }
  for (const [trace, events] of [...by.entries()].reverse().slice(0, Number(n))) {
    console.log(`${trace}  ${when(events[0].ts)}`);
    console.log("   " + events.map(brief).join(" → "));
  }
} else if (cmd === "trace") {
  const rows = sql(`SELECT * FROM trace_events WHERE trace=${q(rest[0] || "")} ORDER BY id`);
  if (!rows.length) { console.log("not found"); process.exit(0); }
  console.log(`trace ${rest[0]}  chat ${rows[0].chat_id}  ${when(rows[0].ts)}`);
  for (const e of rows) console.log(`#${e.id} +${String(e.ms).padStart(6)}ms  ${brief(e)}  ${e.detail && e.detail !== "{}" ? e.detail.slice(0, 200) : ""}`);
} else if (cmd === "event") {
  const [e] = sql(`SELECT * FROM trace_events WHERE id=${Number(rest[0] || 0)}`);
  if (!e) { console.log("not found"); process.exit(0); }
  const d = parse(e.detail);
  console.log(`#${e.id}  trace ${e.trace}  chat ${e.chat_id}  ${when(e.ts)}  +${e.ms}ms  ${brief(e)}`);
  if (e.stage === "llm") {
    console.log(`model ${d.model}  finish ${d.finish}  messages ${d.msg_count}  prompt chars ${d.prompt_chars}`);
    if (d.recall) { console.log(`\n== recall: ${d.recall.raw}${d.recall.raw !== d.recall.query ? " ⟶ " + d.recall.query : ""}`); for (const f of d.recall.facts || []) console.log("  — " + f); }
    console.log("\n== user:\n" + d.user_text + "\n\n== response:\n" + d.response + "\n\n== system:\n" + d.system);
  } else {
    console.log(JSON.stringify(d, null, 2));
  }
} else if (cmd === "errors") {
  const since = Date.now() - Number(rest[0] || 24) * 3600_000;
  const rows = sql(`SELECT * FROM trace_events WHERE (stage='error' OR (stage='llm' AND outcome<>'ok') OR (stage='send' AND outcome<>'ok')) AND ts>=${since} ORDER BY id DESC LIMIT 100`);
  for (const e of rows) console.log(`#${e.id} ${when(e.ts)} chat ${e.chat_id} ${e.trace}  ${brief(e)}  ${e.detail.slice(0, 160)}`);
  if (!rows.length) console.log("none");
} else if (cmd === "find") {
  const [chat, ...words] = rest;
  const needle = words.join(" ");
  const rows = sql(`SELECT id, ts, trace, kind, outcome, detail FROM trace_events WHERE chat_id=${q(chat)} AND stage='llm' AND instr(detail, ${q(needle)}) > 0 ORDER BY id DESC LIMIT 20`);
  for (const e of rows) { const d = parse(e.detail); console.log(`#${e.id} ${when(e.ts)} ${e.trace} llm:${e.kind} ${e.outcome}\n   Q: ${(d.user_text || "").slice(0, 120)}\n   A: ${(d.response || "").slice(0, 120)}`); }
  if (!rows.length) console.log("none");
} else {
  console.log("usage: trace.mjs --config <wrangler.jsonc> stats [h] | list <chatId> [n] | trace <traceId> | event <id> | errors [h] | find <chatId> <text>");
}
