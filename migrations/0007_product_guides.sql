ALTER TABLE products ADD COLUMN activation_instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN delivery_estimate TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN purchase_notice TEXT NOT NULL DEFAULT '';

-- Preserve what was shown when a new order was placed.
-- Older orders intentionally stay blank rather than showing today's instructions.
ALTER TABLE order_items ADD COLUMN activation_instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN delivery_estimate TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN purchase_notice TEXT NOT NULL DEFAULT '';
