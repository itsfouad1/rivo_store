CREATE TABLE fox_products (
 product_id TEXT PRIMARY KEY REFERENCES products(id), remote_id TEXT NOT NULL UNIQUE,
 cost_units INTEGER NOT NULL, stock INTEGER NOT NULL, min_qty INTEGER NOT NULL DEFAULT 1,
 max_qty INTEGER, delivery_type TEXT NOT NULL, note_schema TEXT NOT NULL DEFAULT '{}',
 markup_bps INTEGER NOT NULL DEFAULT 1000, auto_price INTEGER NOT NULL DEFAULT 1,
 checked_at TEXT NOT NULL
);
CREATE TABLE fox_order_lines (
 item_id TEXT PRIMARY KEY REFERENCES order_items(id), remote_id TEXT NOT NULL,
 cost_units INTEGER NOT NULL, delivery_type TEXT NOT NULL, note_schema TEXT NOT NULL
);
CREATE TABLE fox_jobs (
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES order_items(id), is_mock INTEGER NOT NULL,
 remote_id TEXT UNIQUE, status TEXT NOT NULL, request_json TEXT NOT NULL,
 result_json TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '',
 pay_started INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(item_id,is_mock)
);
CREATE TABLE fox_events (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE INDEX fox_jobs_pending ON fox_jobs(status,updated_at);
