-- Multiple fixed denominations may map to the same supplier service.
-- No table references fox_products; retain every existing link and its values.
CREATE TABLE fox_products_next (
 product_id TEXT PRIMARY KEY REFERENCES products(id), remote_id TEXT NOT NULL,
 cost_units INTEGER NOT NULL, stock INTEGER NOT NULL, min_qty INTEGER NOT NULL DEFAULT 1,
 max_qty INTEGER, delivery_type TEXT NOT NULL, note_schema TEXT NOT NULL DEFAULT '{}',
 markup_bps INTEGER NOT NULL DEFAULT 1000, auto_price INTEGER NOT NULL DEFAULT 1,
 checked_at TEXT NOT NULL,
 service_type TEXT NOT NULL DEFAULT 'standard' CHECK(service_type IN ('standard','steam')),
 supplier_quantity INTEGER NOT NULL DEFAULT 1 CHECK(supplier_quantity BETWEEN 1 AND 500)
);
INSERT INTO fox_products_next(product_id,remote_id,cost_units,stock,min_qty,max_qty,delivery_type,note_schema,markup_bps,auto_price,checked_at)
 SELECT product_id,remote_id,cost_units,stock,min_qty,max_qty,delivery_type,note_schema,markup_bps,auto_price,checked_at FROM fox_products;
DROP TABLE fox_products;
ALTER TABLE fox_products_next RENAME TO fox_products;
CREATE INDEX fox_products_remote ON fox_products(remote_id);
CREATE UNIQUE INDEX fox_products_standard_unique ON fox_products(remote_id) WHERE service_type='standard';
CREATE UNIQUE INDEX fox_products_steam_unique ON fox_products(remote_id,supplier_quantity) WHERE service_type='steam';
ALTER TABLE fox_order_lines ADD COLUMN service_type TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE fox_order_lines ADD COLUMN supplier_quantity INTEGER NOT NULL DEFAULT 1;
CREATE TABLE steam_checks (
 check_key TEXT PRIMARY KEY, checked_at TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE steam_limits (
 id TEXT PRIMARY KEY, next_at INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0
);
