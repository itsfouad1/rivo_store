CREATE INDEX IF NOT EXISTS orders_created_id ON orders(created_at,id);
CREATE INDEX IF NOT EXISTS orders_payment_status_created ON orders(payment_status,status,created_at);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS users_email ON users(email);
