CREATE TABLE exchange_rates (
  currency TEXT PRIMARY KEY NOT NULL,
  rate_units INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO exchange_rates (currency, rate_units, updated_at)
VALUES ('USD', 1000000, '1970-01-01T00:00:00.000Z');

-- USD selling-price snapshot used to protect FoxReload live fulfilment even
-- when the customer checked out in another currency.
ALTER TABLE fox_order_lines ADD COLUMN sale_usd_cents INTEGER NOT NULL DEFAULT 0;

