CREATE TABLE staff_access(user_id TEXT PRIMARY KEY REFERENCES users(id),role TEXT NOT NULL CHECK(role IN ('owner','admin','support','customer')),active INTEGER NOT NULL DEFAULT 1,permissions TEXT NOT NULL DEFAULT '[]');
CREATE TABLE support_notes(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),actor TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created_at TEXT NOT NULL);
INSERT INTO staff_access(user_id,role) SELECT id,'owner' FROM users WHERE id='supabase:9fe15a87-5c6a-4575-839d-5bf4905aef6e';
