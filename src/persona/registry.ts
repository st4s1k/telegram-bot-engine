/* ================= PERSONA REGISTRY ================= */
// Persona pack — the bot's swappable "character" layered on top of a depersonalized engine. The engine reads it ON DEMAND
// (per-request) via getPersona(); a specific pack is registered as a side-effect in src/index.ts during
// isolate initialization (before the first fetch/scheduled). This layer is the very BOTTOM (imports types only),
// so that the engine can read the persona without a cycle, while the pack cannot (forkability: the engine is public, the pack
// can be moved into a private repo). The contract grows over the course of Phase 1 (texts → prompts → commands …).

import type { Ctx, CommandMode, ChatConfig, ConfigMeta, Env } from "../types";
import { tRaw, LOCALES } from "../i18n";

// The persona's contribution to config: its own schema keys (switches/probabilities), presets, and defaults for those keys.
// The engine merges them: CONFIG_SCHEMA/CONFIG_PRESETS/CONFIG_GROUPS = engine-base ∪ persona;
// getGlobalConfig mixes in defaults(env). Persona groups are appended after the engine ones.
export interface ConfigContribution {
  schema?: Record<string, ConfigMeta>;
  groups?: Record<string, string[]>;
  presets?: Record<string, { desc: string; config: ChatConfig }>;
  presetAliases?: Record<string, string>;
  defaults?: (env: Env) => Record<string, boolean | number>;
}

// A command the persona adds on top of the core. The engine merges it into COMMANDS/literal regexes/
// TECH/LLM sets (engine-base ∪ registry). type — the internal key, defaultCmd — the command name.
// llm → "typing" indicator + not TECH; skipHistory → TECH.
export interface RegisteredCommand {
  type: string;
  defaultCmd: string;
  handler: (ctx: Ctx, mode: CommandMode) => Promise<string | null>;
  llm?: boolean;
  skipHistory?: boolean;
  remoteAdmin?: boolean;
  /** optional slice of per-chat state owned by this command (schema: field→type/default/bounds).
   *  The engine merges the slices of all commands into persona-state and applies defaults — so a "command with its own
   *  state" plugs in trivially (see getPersonaStateDefaults). */
  state?: Record<string, PersonaStateField>;
}

// A quick reply without the LLM (persona content). The engine (tryQuickReply) iterates over them in order:
// gating on cfg[cfgFlag]; either test mode (substring/regex + optional probKey + responses→pickOne) OR
// tokenTable (by the message's last token). Order in the array = order of checking.
export interface QuickReplyRule {
  cfgFlag: string;
  probKey?: string;
  test?: (textLower: string) => boolean;
  responses?: string[];
  tokenTable?: Record<string, string[]>;
}

// A random persona "throw" (a content reply instead of the usual one). The engine weights
// cfgFlag×probKey (pickRandomRandomKind) and calls handler. Order in the array = order of buckets.
export interface RandomThrowKind {
  name: string;
  cfgFlag: string;
  probKey: string;
  handler: (ctx: Ctx, memories?: string[]) => Promise<string>;
}

export interface PersonaTexts {
  /** default voice if the chat has no role of its own (assemblePrompt) */
  defaultVoice: string;
  /** instruction line for the reply language (empty → skipped) */
  languageLine: string;
  /** fallback reply on LLM error/timeout (filtered out of history by isFallbackMessage) */
  fallbackError: string;
  /** fallback reply on HTTP 402 (no credits on OpenRouter) */
  fallbackNoCredits: string;
  /** words addressing the bot (substring, any case) — wake the bot in groups */
  wakeWords: string[];
  /** username (lowercase, without @) → display name (takes priority over Telegram first_name) */
  usernameAliases: Record<string, string>;
  /** placeholder name for the addressee, if neither the reply nor the author provided a name */
  targetNameFallback: string;
  /** full text of the /help reply (the persona curates its own command list) */
  helpText: string;
  /** /info title (with emoji/markup), e.g. "ℹ️ **Status**" */
  infoTitle: string;
}

// Description of a single persona-state field: type + default (+ bounds for numeric ones). The pack defines the schema
// of its own JSON state — the engine applies defaults on load without knowing the semantics of the fields.
export interface PersonaStateField {
  type: "int" | "float" | "bool" | "string";
  default?: unknown;
  min?: number;
  max?: number;
}

export interface PersonaPack {
  /** Non-localized persona identity. The LOCALIZED texts — defaultVoice/languageLine/help/fallbacks/info
   *  title (the PersonaTexts fields) AND the /config descriptions/group titles/preset descriptions — live
   *  in the pack's i18n/<lang>.json: PersonaTexts fields under `persona_*` keys, config strings under their
   *  own keys. The generate step (scripts/select-persona.mjs) discovers + merges them into the engine i18n;
   *  getPersonaTexts reads the persona_* keys per cfg.lang, and t() resolves the config keys. */
  wakeWords?: string[];
  usernameAliases?: Record<string, string>;
  commands?: RegisteredCommand[];
  quickReplies?: QuickReplyRule[];
  randomThrows?: RandomThrowKind[];
  config?: ConfigContribution;
  /** extra lines added to EVERY system prompt (assemblePrompt) — flavor based on its own state */
  buildPromptLines?: (ctx: Ctx) => string[];
  /** extra persona lines for /info (under the title, before the role) */
  infoLines?: (ctx: Ctx) => string[];
  /** compact flag for /admin from the parsed persona-state of the row (empty → don't show) */
  adminFlags?: (state: Record<string, unknown>) => string;
}

// Neutral text defaults — used when no pack supplies a localized value (no persona, or a missing key).
// The localized PersonaTexts fields live in each pack's i18n/<lang>.json under `persona_<field>` keys.
const NEUTRAL_TEXTS = {
  defaultVoice: "", languageLine: "",
  fallbackError: "error, try again later", fallbackNoCredits: "out of credits",
  targetNameFallback: "friend", helpText: "", infoTitle: "ℹ️ **Status**",
} as const;

// A neutral default pack — so the engine builds/runs WITHOUT a persona (personaless).
const NEUTRAL: PersonaPack = {};

let active: PersonaPack = NEUTRAL;

export function setPersona(pack: PersonaPack): void { active = pack; }
export function getPersona(): PersonaPack { return active; }

// Persona texts for a locale. The localized fields come from the discovered i18n tables (`persona_<field>`
// keys, with tRaw's lang→DEFAULT_LANG fallback), falling back to the neutral defaults; the non-localized
// identity (wakeWords/usernameAliases) comes from the active pack object.
export function getPersonaTexts(lang: string): PersonaTexts {
  const g = (f: keyof typeof NEUTRAL_TEXTS): string => tRaw(lang, "persona_" + f) ?? NEUTRAL_TEXTS[f];
  return {
    defaultVoice: g("defaultVoice"),
    languageLine: g("languageLine"),
    fallbackError: g("fallbackError"),
    fallbackNoCredits: g("fallbackNoCredits"),
    targetNameFallback: g("targetNameFallback"),
    helpText: g("helpText"),
    infoTitle: g("infoTitle"),
    wakeWords: active.wakeWords ?? [],
    usernameAliases: active.usernameAliases ?? {},
  };
}

// All fallback strings across all discovered locales — so isFallbackMessage keeps them out of history
// regardless of the reply language.
export function getAllFallbackTexts(): string[] {
  const out: string[] = [NEUTRAL_TEXTS.fallbackError, NEUTRAL_TEXTS.fallbackNoCredits];
  for (const lang of LOCALES) {
    const e = tRaw(lang, "persona_fallbackError"); if (e) out.push(e);
    const n = tRaw(lang, "persona_fallbackNoCredits"); if (n) out.push(n);
  }
  return out;
}
export function getPersonaCommands(): RegisteredCommand[] { return active.commands || []; }

// The engine's core commands are registered by the SAME RegisteredCommand contract as the persona
// (commands.ts calls setEngineCommands on load). This way both the engine and the pack form a single list of plugins:
// COMMANDS/TECH/LLM/regex are derived from it, and adding a command = one self-describing object.
let engineCommands: RegisteredCommand[] = [];
export function setEngineCommands(cmds: RegisteredCommand[]): void { engineCommands = cmds; }
export function getEngineCommands(): RegisteredCommand[] { return engineCommands; }
// All commands (core + persona) in order: the engine first, then the pack.
export function getAllCommands(): RegisteredCommand[] { return [...engineCommands, ...(active.commands || [])]; }
export function getPersonaQuickReplies(): QuickReplyRule[] { return active.quickReplies || []; }
export function getPersonaThrows(): RandomThrowKind[] { return active.randomThrows || []; }
export function getPersonaConfig(): ConfigContribution { return active.config || {}; }

// persona-state defaults = the union of the state slices of ALL commands of the active pack (each command
// declares its own state via RegisteredCommand.state). Applied on chat load/reset.
// Without commands that have state — an empty object (the neutral engine carries no persona state).
export function getPersonaStateDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const cmd of active.commands || []) {
    if (!cmd.state) continue;
    for (const [key, field] of Object.entries(cmd.state)) {
      if (field.default !== undefined) out[key] = field.default;
    }
  }
  return out;
}
