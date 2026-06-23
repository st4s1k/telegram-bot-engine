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
