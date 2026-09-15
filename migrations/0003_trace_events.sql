-- Observability: every stage of every request as one row (see src/trace.ts). A trace = one incoming
-- Telegram update (`u<update_id>`) or one cron job per chat; its events: webhook → dedup → route → recall →
-- llm (prompt / last user message / memory block / response in `detail`) → command → send, plus errors.
-- Bounded by time only: the daily cron purges rows older than TRACE_DAYS. Read via /admin trace | event.
CREATE TABLE IF NOT EXISTS trace_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  chat_id    TEXT    NOT NULL,
  trace      TEXT    NOT NULL,   -- u<update_id> | cron-<date>-<chat> | t<random> (one-off)
  ms         INTEGER NOT NULL,   -- milliseconds since the trace started
  stage      TEXT    NOT NULL,   -- webhook | dedup | route | recall | llm | command | send | cron | error
  kind       TEXT,               -- sub-type: llm kind (reply/rewrite/…), route decision, command name, error site
  outcome    TEXT,               -- ok | skipped | silent | hit | miss | http_<status> | timeout_idle | error | …
  elapsed_ms INTEGER,            -- duration of the stage itself, when it has one (llm, recall, send, command)
  cost       REAL,               -- USD, llm events
  detail     TEXT    NOT NULL    -- JSON, capped (TRACE_DETAIL_CAP)
);
CREATE INDEX IF NOT EXISTS idx_trace_events_chat  ON trace_events(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_trace_events_trace ON trace_events(trace, id);
CREATE INDEX IF NOT EXISTS idx_trace_events_ts    ON trace_events(ts);
