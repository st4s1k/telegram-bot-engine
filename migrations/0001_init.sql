-- Initial schema. Chat state is one row in `chats`; conversation history is one row per message in
-- `messages`; curated long-term-memory facts are one row per fact in `memories`. History is written
-- per message (INSERT/DELETE, not a rewritten blob), avoiding the read-modify-write race that dropped
-- messages on concurrent updates.

CREATE TABLE IF NOT EXISTS chats (
  chat_id       TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL DEFAULT '',   -- chat name (group title or interlocutor's name, for /admin)
  role          TEXT,                          -- NULL = no role set
  paused        INTEGER NOT NULL DEFAULT 0,    -- 0/1
  config        TEXT    NOT NULL DEFAULT '{}', -- JSON: per-chat config overrides (small map)
  photo_cache   TEXT    NOT NULL DEFAULT '{}', -- JSON: file_unique_id -> description (capped)
  persona_state TEXT    NOT NULL DEFAULT '{}', -- JSON: generic persona-owned state slot (schema defined by the pack)
  spend         REAL    NOT NULL DEFAULT 0,    -- total spent, $
  spend_count   INTEGER NOT NULL DEFAULT 0,    -- number of paid requests
  summary       TEXT    NOT NULL DEFAULT '',   -- /summary digest cache (the "already known" context)
  updated_at    INTEGER NOT NULL DEFAULT 0,    -- unix-ms of the last update
  -- Incremental-summary / curation boundaries by our monotonic `messages.id` (NOT the Telegram message_id):
  daily_upto_id INTEGER NOT NULL DEFAULT 0,    -- max id in the last daily (cron) summary
  cmd_upto_id   INTEGER NOT NULL DEFAULT 0,    -- max id in the last /summary command (reset daily)
  cmd_day       TEXT    NOT NULL DEFAULT '',   -- date (configured timezone, YYYY-MM-DD) of the last command summary
  mem_upto_id   INTEGER NOT NULL DEFAULT 0     -- max id that passed through fact curation
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic, not reused — the basis for summary boundaries
  chat_id    TEXT    NOT NULL,
  role       TEXT    NOT NULL,                  -- 'user' | 'assistant'
  content    TEXT    NOT NULL,
  meta       TEXT,                              -- JSON HistoryMeta
  message_id INTEGER,                           -- Telegram message_id (dedup / edits)
  created_at INTEGER NOT NULL                   -- unix-ms
);

-- Chat-history window selection and ordering.
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, id);
-- Dedup by (chat_id, role, message_id) — INSERT OR IGNORE relies on it. Partial index: rows without a
-- message_id (rare, e.g. message_id=0) are not deduped.
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_dedup ON messages(chat_id, role, message_id) WHERE message_id IS NOT NULL;

-- Long-term memory = curated facts (not every raw message). Source of truth for facts (auto =
-- extracted before a summary, manual = /memory add). The per-fact vector lives in Vectorize
-- (namespace mem:<chatId>, id m<chatId>:<memories.id>); this table backs /memory list and re-indexing.
CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'auto',   -- 'auto' | 'manual'
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id, id);
-- DB-level fact dedup within a chat (exact text). Case-insensitive dedup is done in JS
-- (parseExtractedFacts, Unicode toLowerCase) since SQLite lower() is ASCII-only.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_uniq ON memories(chat_id, text);
