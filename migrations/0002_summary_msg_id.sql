-- Add the "previous summary" pointer: the Telegram message_id of the last /summary (or daily-cron)
-- digest we POSTED in a chat. Each fresh digest deep-links back to it (supergroups only). 0 = none yet.
ALTER TABLE chats ADD COLUMN summary_msg_id INTEGER NOT NULL DEFAULT 0;
