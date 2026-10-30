CREATE TABLE customer_favorites(user_id TEXT NOT NULL REFERENCES users(id), product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(user_id,product_id));
CREATE TABLE customer_reviews(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,order_id TEXT NOT NULL REFERENCES orders(id),stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),body TEXT NOT NULL,display_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,product_id));
CREATE INDEX reviews_product_status ON customer_reviews(product_id,status,created_at);
CREATE TABLE store_coupons(code TEXT PRIMARY KEY,percent_bps INTEGER NOT NULL CHECK(percent_bps BETWEEN 100 AND 5000),min_usd_cents INTEGER NOT NULL,min_margin_bps INTEGER NOT NULL CHECK(min_margin_bps BETWEEN 0 AND 10000),max_uses INTEGER NOT NULL,starts_at TEXT NOT NULL,expires_at TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,product_ids TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE coupon_price_floors(product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,floor_usd_cents INTEGER NOT NULL CHECK(floor_usd_cents>0),updated_at TEXT NOT NULL);
CREATE TABLE coupon_redemptions(order_id TEXT PRIMARY KEY REFERENCES orders(id),code TEXT NOT NULL REFERENCES store_coupons(code),user_id TEXT NOT NULL REFERENCES users(id),coupon_version INTEGER NOT NULL,subtotal_cents INTEGER NOT NULL,discount_cents INTEGER NOT NULL,currency TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(code,user_id));
CREATE TRIGGER reserve_coupon BEFORE INSERT ON coupon_redemptions BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM store_coupons c WHERE c.code=NEW.code AND c.enabled=1 AND c.version=NEW.coupon_version AND c.starts_at<=NEW.created_at AND c.expires_at>NEW.created_at AND (SELECT count(*) FROM coupon_redemptions r WHERE r.code=c.code)<c.max_uses) THEN RAISE(ABORT,'coupon_unavailable') END;
END;
CREATE TABLE customer_email_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id),email TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,confirmed_at TEXT,token_hash TEXT,token_expires TEXT,requested_at TEXT);
CREATE TABLE email_outbox(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),order_id TEXT REFERENCES orders(id),kind TEXT NOT NULL CHECK(kind IN ('confirmation','order')),recipient TEXT NOT NULL,subject TEXT NOT NULL,link_path TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',payload_json TEXT,attempts INTEGER NOT NULL DEFAULT 0,first_attempt_at TEXT,next_attempt_at TEXT NOT NULL,lock_until TEXT,provider_id TEXT,error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE INDEX email_pending ON email_outbox(status,next_attempt_at);
CREATE TABLE email_budget(day TEXT PRIMARY KEY,attempts INTEGER NOT NULL);
INSERT INTO settings(id,value) VALUES('commerce:email','{"enabled":false}') ON CONFLICT(id) DO NOTHING;
CREATE TRIGGER queue_order_email AFTER INSERT ON customer_notifications
WHEN EXISTS(SELECT 1 FROM settings WHERE id='commerce:email' AND json_extract(value,'$.enabled')=1)
BEGIN
 INSERT OR IGNORE INTO email_outbox(id,user_id,order_id,kind,recipient,subject,link_path,next_attempt_at,created_at)
 SELECT 'notice:'||NEW.id,NEW.user_id,NEW.order_id,'order',p.email,NEW.title,'/order.html?order='||NEW.order_id,NEW.created_at,NEW.created_at
 FROM customer_email_preferences p JOIN users u ON u.id=p.user_id JOIN orders o ON o.id=NEW.order_id
 WHERE p.user_id=NEW.user_id AND p.enabled=1 AND p.confirmed_at IS NOT NULL AND p.email=u.email AND o.payment_status NOT LIKE 'test_%' AND NOT EXISTS(SELECT 1 FROM payunit_invoices i WHERE i.order_id=o.id AND i.environment='test');
END;
