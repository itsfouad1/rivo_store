CREATE TABLE payunit_invoices (
  order_id TEXT PRIMARY KEY NOT NULL REFERENCES orders(id),
  invoice_id TEXT UNIQUE,
  amount_usd_cents INTEGER NOT NULL,
  rates_json TEXT NOT NULL DEFAULT '{}',
  request_json TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  checkout_url TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '',
  fee_usd_cents INTEGER,
  net_usd_cents INTEGER,
  payment_reference TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE payunit_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX payunit_invoices_status ON payunit_invoices(status,updated_at);
