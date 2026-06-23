/* ================= I18N ================= */
// Engine UI strings live in per-locale JSON files (ru.json, en.json) so locales are easy to add/edit.
// The active locale is `cfg.lang` (per-chat `/config lang`, default `ru`). `t(lang, key, ...args)`
// resolves a key in the active locale, falling back to `ru` for a missing locale/key, then
// interpolates positional `{0}`, `{1}`, … placeholders. Leaf module — only imports the JSON tables.
// Persona-supplied strings are localized separately by the pack.

import ru from "./ru.json";
import en from "./en.json";

export const DEFAULT_LANG = "ru";

// A locale value is a single string, or an array of lines for a multi-line prompt (joined with \n).
const MESSAGES: Record<string, Record<string, string | string[]>> = { ru, en };

// Available UI locales (for /config lang validation / help). Add a JSON file + an entry here to extend.
export const LOCALES: string[] = Object.keys(MESSAGES);

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
