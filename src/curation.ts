/* ================= MEMORY CURATION ================= */
// Curation of long-term memory facts: extract durable facts from NEW interlocutor messages
// (id > boundary) and store them in RAG. Under cfg.rag, best-effort (an error does not break the reply/summary).
// Called once a day (cron) and before the /summary command — NOT on every bot reply.

import { MEM_CURATION_MIN_NEW, MEM_MAX_FACTS_PER_RUN, MEM_MAX_FACT_CHARS } from "./constants";
import { messagesSince, addMemory, listMemories } from "./storage";
import { runLLMWithHistory } from "./llm";
import { buildMemoryExtractionPrompt } from "./prompts";
import { isFallbackMessage } from "./utils";
import { t, tList, DEFAULT_LANG } from "./i18n";
import type { Ctx } from "./types";

// Parse the fact extractor's output: line by line, strip markers/numbering, drop empty lines/preamble,
// truncate length, dedup against already-known facts (normalized) and within the batch, cap the count.
export function parseExtractedFacts(out: string, existing: string[] = [], lang: string = DEFAULT_LANG): string[] {
  const seen = new Set(existing.map(f => f.trim().toLowerCase()));
  const facts: string[] = [];
  // Locale-specific "no facts" refusal markers (kept out of the engine code): short words matched at the
  // START (a fact may legitimately CONTAIN such a word mid-sentence) + whole phrases matched anywhere.
  const refusalStarts = tList(lang, "mem_refusal_starts");
  const refusalContains = tList(lang, "mem_refusal_contains");
  for (const rawLine of String(out ?? "").split("\n")) {
    // Strip ONLY a real list marker: a bullet or a short ordinal with a delimiter.
    // `1990` is NOT a marker (no delimiter after the digits) → do not mangle a fact starting with a number.
    let line = rawLine.replace(/^\s*(?:[-*•·]+|\d{1,3}[.)\]])\s*/, "").trim();
    if (!line) continue;
    if (line.endsWith(":")) continue; // heading line (e.g. "Here are facts:", "Extracted facts:" …)
    const norm = line.toLowerCase().replace(/[.!?]+$/, "").trim();
    // Refusals: locale markers (start-anchored words + whole phrases) + universal English/abbrev forms.
    if (refusalStarts.some(w => norm === w || norm.startsWith(w + " "))
        || refusalContains.some(w => norm.includes(w))
        || norm.includes("no facts") || ["none", "empty", "n/a"].includes(norm)) continue;
    line = line.slice(0, MEM_MAX_FACT_CHARS);
    const key = line.toLowerCase();
    if (seen.has(key)) continue; // dedup against known facts and within the batch
    seen.add(key);
    facts.push(line);
    if (facts.length >= MEM_MAX_FACTS_PER_RUN) break;
  }
  return facts;
}

// Extract durable facts from NEW messages (id > boundary) and store them in long-term memory.
// Under cfg.rag, best-effort. Advance the _memUptoId boundary on LLM success (even with 0 facts).
export async function runMemoryCuration(ctx: Ctx): Promise<void> {
  if (ctx._preview) return; // /admin chat_cmd preview: addMemory is write-through (bypasses flush), don't touch someone else's chat
  if (!ctx.cfg.rag) return;
  try {
    const since = ctx.chatData._memUptoId || 0;
    const { items, maxId } = await messagesSince(ctx.env, ctx.chatId, since);
    if (items.length < MEM_CURATION_MIN_NEW) return; // too little new content — don't invoke the LLM
    // Extract facts ONLY from interlocutor messages, not from the bot's own replies (its
    // vulgar remark is not a source of facts). Advance the boundary across the whole slice anyway.
    const userItems = items.filter(it => it.role === "user");
    if (!userItems.length) { ctx.chatData._memUptoId = maxId; ctx.chatData._dirty = true; return; }
    const existing = (await listMemories(ctx.env, ctx.chatId)).map(m => m.text);
    const out = await runLLMWithHistory(
      ctx.cfg,
      buildMemoryExtractionPrompt(ctx.cfg.lang, existing), // NEUTRAL prompt, no persona
      userItems,                             // only new interlocutor messages
      t(ctx.cfg.lang, "mem_extract_user_turn"),
      ctx.msg,
      { forceAppendUser: true, ctx, modelOverride: ctx.cfg.summaryModel }
    );
    if (isFallbackMessage(out)) return; // LLM error/timeout → don't advance the boundary (retried on the next reply)
    // Dedup is best-effort in-process (against existing + within the batch). A rare race-condition duplicate on
    // parallel webhooks is possible but harmless (cleared by /memory forget, filtered out at recall).
    for (const fact of parseExtractedFacts(out, existing, ctx.cfg.lang)) {
      await addMemory(ctx, fact, "auto");
    }
    ctx.chatData._memUptoId = maxId; // success (even 0 facts) → don't reprocess this slice
    ctx.chatData._dirty = true;
  } catch (e: any) {
    console.warn("memory curation failed", { chatId: ctx.chatId, err: e?.message || e });
  }
}
