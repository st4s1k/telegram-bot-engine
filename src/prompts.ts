/* ================= PROMPTS ================= */
// System-prompt assembly: instruction lines + persona voice (role) + persona extra lines (hook).
// Engine instruction strings are localized via t(cfg.lang, …); the persona supplies its own texts
// (languageLine, defaultVoice, prompt-line hook) per its own locales.

import { PHOTO_DELIM, MEM_MAX_FACTS_PER_RUN } from "./constants";
import { getPersona, getPersonaTexts } from "./persona/registry";
import { t } from "./i18n";
import type { Ctx } from "./types";

export function assemblePrompt(instructions: string[], ctx: Ctx, memories: string[] = []): string {
  const persona_pack = getPersona();
  const lang = ctx.cfg.lang;
  const tx = getPersonaTexts(lang);
  const persona = ctx.chatData.role || tx.defaultVoice;
  const lines = [...instructions];
  // Long-term memory (RAG): semantically surfaced fragments of old conversation — reference
  // context, NOT new messages. They go between the instructions and the housekeeping note about tags.
  if (memories.length) {
    lines.push(t(lang, "prompt_rag_intro"), ...memories.map(m => `— ${m}`));
  }
  lines.push(t(lang, "prompt_tag_instruction", ctx.cfg.timezone), tx.languageLine);
  // YOUR ROLE — only if there is a voice (chat role or persona.defaultVoice); without a persona (NEUTRAL,
  // defaultVoice="") the line is not needed — otherwise the prompt would get the junk `YOUR ROLE: ""`.
  if (persona) lines.push(t(lang, "prompt_role", persona));
  // Extra persona lines (flavor based on its OWN state — the engine does not know the semantics).
  if (persona_pack.buildPromptLines) lines.push(...persona_pack.buildPromptLines(ctx));
  return lines.filter(Boolean).join("\n");
}

export function buildDefaultPrompt(ctx: Ctx, memories: string[] = []): string {
  return assemblePrompt([t(ctx.cfg.lang, "prompt_default")], ctx, memories);
}
// Persona prompts live in the persona pack (src/persona/<pack>/prompts.ts).
export function buildReplyPrompt(orig: string, ctx: Ctx, memories: string[] = []): string {
  return assemblePrompt([t(ctx.cfg.lang, "prompt_reply", orig)], ctx, memories);
}
export function buildVisionPrompt(ctx: Ctx): string {
  return assemblePrompt([t(ctx.cfg.lang, "prompt_vision", PHOTO_DELIM)], ctx);
}
// Reply based on an ALREADY known image description (without re-sending the image).
export function buildPhotoFromCachePrompt(desc: string, ctx: Ctx): string {
  return assemblePrompt([t(ctx.cfg.lang, "prompt_photo_cache", desc)], ctx);
}

// Fact-extraction prompt for long-term memory. NEUTRAL (no persona) — passed to
// runLLMWithHistory as the system prompt directly (not via assemblePrompt). Language — from cfg.lang.
export function buildMemoryExtractionPrompt(lang: string, existing: string[] = []): string {
  const lines = [t(lang, "mem_extract", MEM_MAX_FACTS_PER_RUN)];
  if (existing.length) {
    // Inject only the RECENT facts as a dedup hint (bounds prompt tokens); parseExtractedFacts still
    // dedups the model's OUTPUT against the FULL existing set the caller passes.
    lines.push(t(lang, "mem_extract_known"), ...existing.slice(-40).map(f => `- ${f}`));
  }
  return lines.join("\n");
}

// Short summary of NEW chat messages (incremental). prevSummary — the previous summary,
// supplied as "already known — do not repeat" (the novelty boundary is set by messages.id above).
export function buildSummaryPrompt(ctx: Ctx, prevSummary?: string): string {
  const lang = ctx.cfg.lang;
  const lines = [t(lang, "prompt_summary")];
  if (prevSummary) {
    lines.push(t(lang, "prompt_summary_prev", prevSummary));
  }
  return assemblePrompt(lines, ctx);
}
