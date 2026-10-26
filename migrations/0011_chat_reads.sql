CREATE TABLE chat_reads (
 conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 last_seq INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(conversation_id,user_id)
);
CREATE INDEX chat_reads_user ON chat_reads(user_id,conversation_id);
