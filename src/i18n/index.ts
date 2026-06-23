/* ================= I18N ================= */
// Engine UI strings live in per-locale JSON files (ru.json, en.json) so locales are easy to add/edit.
// The active locale is `cfg.lang` (per-chat `/config lang`, default `en`). `t(lang, key, ...args)`
// resolves a key in the active locale, falling back to the DEFAULT_LANG (en) for a missing locale/key,
// then interpolates positional `{0}`, `{1}`, … placeholders. Leaf module — only imports the JSON tables.
// A persona merges its own per-locale strings in via addLocaleStrings (called from setPersona), so
// persona-supplied keys (e.g. config descriptions / group titles) resolve through t() like engine keys.

import { ENGINE_TABLES, PERSONA_TABLES } from "./_generated";

// The default/fallback UI language. English: the public engine defaults to English for any deployment
// that does not set BOT_LANG. A localized deployment (e.g. the «Фасол» bot) opts into its language via
// env BOT_LANG / per-chat `/config lang` (or `/lang`).
export const DEFAULT_LANG = "en";

// Locale tables are DISCOVERED from the i18n folders (scripts/select-persona.mjs generates the imports):
// the engine's src/i18n/*.json, with the active persona's i18n/*.json merged on top per locale. The code
// hardcodes NO language list — drop a <code>.json into a folder and that locale becomes available.
// A value is a single string, or an array of lines for a multi-line prompt (joined with \n).
const MESSAGES: Record<string, Record<string, string | string[]>> = {};
for (const [lang, table] of Object.entries(ENGINE_TABLES)) MESSAGES[lang] = { ...table };
for (const [lang, table] of Object.entries(PERSONA_TABLES)) MESSAGES[lang] = { ...(MESSAGES[lang] || {}), ...table };

// Available UI locales (for /lang validation + listing), derived from the discovered tables.
export const LOCALES: string[] = Object.keys(MESSAGES);

// Raw lookup of a single string key: the value (array values joined with \n), or undefined if the key is
// absent in this locale AND in DEFAULT_LANG. Used by getPersonaTexts to read the persona's localized
// PersonaTexts fields (persona_* keys) from the discovered tables, falling back to a neutral default.
export function tRaw(lang: string, key: string): string | undefined {
  const raw = MESSAGES[lang]?.[key] ?? MESSAGES[DEFAULT_LANG]?.[key];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw.join("\n") : raw;
}

export function t(lang: string, key: string, ...args: (string | number | boolean)[]): string {
  const table = MESSAGES[lang] || MESSAGES[DEFAULT_LANG];
  const raw = table[key] ?? MESSAGES[DEFAULT_LANG][key] ?? key;
  let s = Array.isArray(raw) ? raw.join("\n") : raw; // a multi-line prompt is an array of lines
  for (let i = 0; i < args.length; i++) s = s.split(`{${i}}`).join(String(args[i]));
  return s;
}

// Raw locale value as a list of words — for INPUT-matching vocabularies (config value aliases, command
// sub-aliases, fact-refusal markers) that must not be hardcoded in the engine. Unlike t(): no join, and
// NO fallback to DEFAULT_LANG (a missing key → [], so an unknown locale gets no aliases rather than the
// default language's). The universal/English tokens stay in code; these are the per-language extras.
export function tList(lang: string, key: string): string[] {
  const raw = MESSAGES[lang]?.[key];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw) return [raw];
  return [];
}
