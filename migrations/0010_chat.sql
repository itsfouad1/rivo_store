CREATE TABLE chat_conversations(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES users(id),order_id TEXT REFERENCES orders(id),subject TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','assigned','waiting_customer','escalated','closed')),assignee TEXT REFERENCES users(id),revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX chat_one_active ON chat_conversations(customer_id) WHERE status<>'closed';
CREATE INDEX chat_queue ON chat_conversations(status,updated_at);
ALTER TABLE chat_conversations ADD COLUMN escalation_reason TEXT NOT NULL DEFAULT '';
CREATE TABLE chat_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),sender_id TEXT NOT NULL REFERENCES users(id),sender_kind TEXT NOT NULL CHECK(sender_kind IN ('customer','staff')),visibility TEXT NOT NULL CHECK(visibility IN ('public','internal')),body TEXT NOT NULL,client_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(conversation_id,sender_id,client_id));
CREATE INDEX chat_messages_conversation ON chat_messages(conversation_id,seq);
CREATE UNIQUE INDEX chat_message_nonce ON chat_messages(sender_id,client_id);
CREATE TABLE chat_limits(actor TEXT PRIMARY KEY,window INTEGER NOT NULL,hits INTEGER NOT NULL);
