/* ================= NEUTRAL DEFAULT (personaless) ================= */
// Target for a personaless build of the engine: no pack is registered, and the registry (registry.ts) returns
// NEUTRAL — a neutral voice, with no extra commands / quick-reply / random-throw, generic /help.
// When env PERSONA_PACK is not set, scripts/select-persona.mjs generates active.ts → import "./default"
// (see there). The file intentionally does nothing (no setPersona) — its mere presence gives active.ts
// a valid target, so the engine builds and runs at all without a persona pack.
export {};
