/* ================= CONSTANTS ================= */
// Cross-module constants for the worker: limits, timeouts, fallbacks, special characters.
// Domain-specific literals (persona flavor, token tables, etc.)
// live next to their own modules (persona content — in the persona pack).

export const TELEGRAM_MSG_LIMIT = 4096;
export const REQ_ID_LEN = 8;
export const ROOTS_LIMIT = 8;
// LLM fallback strings (FALLBACK_LLM_ERROR/FALLBACK_NO_CREDITS) — persona content, they live in
// the persona pack (src/persona/fasol/texts.ts); the engine reads them per call via getPersona().
// Safety ceiling on the number of messages in history (so the array doesn't grow without bound
// when replies are very short). The primary limit is by characters (history_chars).
export const HISTORY_HARD_CAP_ITEMS = 500;
// For chats with a daily summary (daily_summary): do NOT trim rows not yet summarized
// (id > daily_upto_id), so the summary doesn't lose them. But if the cron is stuck the backlog must not
// grow without bound — this is the absolute ceiling on messages rows for such a chat.
export const SUMMARY_BACKLOG_CAP = 5000;
// How many image descriptions to keep cached per chat (to avoid describing them again).
export const PHOTO_CACHE_CAP = 50;
// Network request timeouts.
export const LLM_TIMEOUT_MS = 50_000;       // overall request ceiling (safeguard against hanging forever)
export const LLM_IDLE_TIMEOUT_MS = 25_000;  // max pause WITHOUT new chunks in the stream → abort
export const GETFILE_TIMEOUT_MS = 10_000;   // Telegram getFile
// Delimiter between the image description and the bot's reply in a vision response.
export const PHOTO_DELIM = "|||";

// --- RAG (long-term memory via Vectorize) ---
// Workers AI embeddings model: bge-m3 — multilingual (incl. Russian), 1024-dimensional vectors.
// NOT configurable via /config: changing the model changes the dimensionality → requires recreating the index.
export const RAG_EMBED_MODEL = "@cf/baai/bge-m3"; // 1024-dimensional vectors (= dimensionality of the memory Vectorize index)
export const RAG_MAX_EMBED_CHARS = 2000;   // truncate the embedding input (~< 512 bge-m3 tokens)
export const RAG_META_TEXT_CAP = 1500;     // how much text we carry in the vector's metadata (10 KiB limit)
export const RAG_TIMEOUT_MS = 8_000;       // ceiling on waiting for embed/query on the hot reply path
// Curating facts on the bot's reply:
export const MEM_CURATION_MIN_NEW = 2;     // don't run extraction while there are fewer new messages
export const MEM_MAX_FACTS_PER_RUN = 5;    // maximum facts per single extraction pass
export const MEM_MAX_FACT_CHARS = 300;     // truncate the length of a single fact
// NOTE on the auxiliary caps below: on "thinking" endpoints that refuse reasoning:{enabled:false} (z-ai/glm-*),
// callOpenRouter retries with reasoning kept, and most providers count the reasoning tokens AGAINST max_tokens.
// A cap sized for "a handful of short ops" then starves the visible output (finish:length with little or no
// content → treated as an empty reply → fallback). The caps are ceilings, not targets — a non-thinking model
// stops when it is done — so they are sized to leave room for reasoning.
export const MEM_MAX_TOKENS = 1500;        // response cap for fact extraction (auxiliary call; was 500 — starved on thinking models)
export const MEM_KNOWN_SHOWN = 40;         // how many recent known facts the extractor is shown (and may UPDATE/DELETE)
export const MEM_CONSOLIDATE_MAX = 40;     // facts covered by ONE /memory consolidate pass (oldest first; more → partial). 40, not 120: a
                                            // thinking model over 120 facts ran past the 50 s webhook ceiling (LLM_TIMEOUT_MS) — passes repeat anyway
export const MEM_CONSOLIDATE_PARALLEL = 4;    // windows whose LLM passes run CONCURRENTLY in one round (independent: ops reference only their own window's ids).
                                              // 4, not 10: measured on z-ai/glm-5.3-flash, 9 concurrent passes slowed each from ~20 s to 18–50 s (per-key throughput is shared) and 6/9 failed
export const MEM_CONSOLIDATE_TIME_BUDGET_MS = 35_000;
export const MEM_CONSOLIDATE_ROUND_FLOOR_MS = 1_000;
export const MEM_APPLY_PARALLEL = 8;              // memory ops applied concurrently per phase (D1 + Vectorize + embed each) // a round always gets at least this long to settle, even when the budget is already spent (tests pass budgetMs=0) // /memory consolidate loops passes while under this — the command runs inside the ~60 s Telegram webhook
export const MEM_CONSOLIDATE_MAX_TOKENS = 3000; // response cap for the consolidation pass (≤ ~800 tokens of ops for 40 facts + room for reasoning)
export const MEM_CONSOLIDATE_DIFF_MAX = 40;       // how many deleted/updated facts the /memory consolidate reply lists (the rest is summarised)
export const MEM_UPDATE_MIN_RATIO = 0.5;          // an UPDATE may not shrink a fact below this share of its length (compression ≠ correction)
export const SUMMARY_MAX_TOKENS = 2000;    // response cap for the /summary digest (auxiliary call; was 1000 — see the NOTE above)
