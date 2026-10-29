CREATE TABLE order_observations (
 order_id TEXT PRIMARY KEY REFERENCES orders(id), signature TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 0, checked_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE customer_notifications (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), order_id TEXT NOT NULL REFERENCES orders(id),
 title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX customer_notifications_owner ON customer_notifications(user_id,created_at);
CREATE TABLE order_followups (
 order_id TEXT PRIMARY KEY REFERENCES orders(id), state TEXT NOT NULL DEFAULT 'open',
 assigned_to TEXT REFERENCES users(id), priority TEXT NOT NULL DEFAULT 'normal',
 due_at TEXT, internal_note TEXT NOT NULL DEFAULT '', updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE order_followup_history (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), actor TEXT NOT NULL,
 action TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX followup_history_order ON order_followup_history(order_id,created_at);
CREATE TABLE supplier_receipts (
 job_id TEXT PRIMARY KEY REFERENCES fox_jobs(id), cost_units INTEGER NOT NULL,
 raw_amount TEXT NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE TABLE ops_order_money (
 order_id TEXT PRIMARY KEY REFERENCES orders(id), revenue_usd_cents INTEGER,
 manual_cost_units INTEGER, manual_fee_cents INTEGER, note TEXT NOT NULL DEFAULT '',
 recorded_by TEXT, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE supplier_balance_snapshots (
 supplier_id TEXT PRIMARY KEY, balance_units INTEGER NOT NULL, checked_at TEXT NOT NULL
);
CREATE TABLE ops_money_history (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), actor TEXT NOT NULL,
 previous_json TEXT NOT NULL, next_json TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX ops_money_history_order ON ops_money_history(order_id,created_at);
CREATE TABLE supplier_product_events (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 old_cost_units INTEGER NOT NULL, new_cost_units INTEGER NOT NULL, created_at TEXT NOT NULL, acknowledged_at TEXT
);
CREATE INDEX supplier_product_events_product ON supplier_product_events(product_id,created_at);
CREATE TABLE ops_config (id INTEGER PRIMARY KEY CHECK(id=1), delay_minutes INTEGER NOT NULL DEFAULT 30, low_balance_cents INTEGER NOT NULL DEFAULT 2000);
INSERT INTO ops_config(id) VALUES (1);
CREATE INDEX orders_owner_updated ON orders(user_id,updated_at);
-- Existing orders establish a baseline; do not invent historical notification events.
INSERT INTO order_observations(order_id,signature,checked_at)
 SELECT id,json_array(status,payment_status,customer_update),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM orders;
