ALTER TABLE chat_conversations ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','urgent'));
CREATE INDEX chat_priority_queue ON chat_conversations(priority,status,updated_at);
CREATE TABLE chat_templates(
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1,
 created_by TEXT REFERENCES users(id),
 updated_by TEXT REFERENCES users(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
INSERT INTO chat_templates(id,title,body,created_at,updated_at) VALUES
 ('14ef2b9f-2537-4854-a6c4-2b2854a7b601','ترحيب','أهلًا فيك في ريفو، كيف بنقدر نساعدك؟',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('14ef2b9f-2537-4854-a6c4-2b2854a7b602','طلب رقم الطلب','ممكن تبعت رقم الطلب أو تختاره من قائمة طلباتك حتى نراجع المشكلة؟ لا ترسل كلمة المرور أو بيانات الدفع.',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('14ef2b9f-2537-4854-a6c4-2b2854a7b603','تفاصيل مشكلة التفعيل','وضّح رسالة الخطأ ومنطقة حسابك واسم المنصة حتى نقدر نساعدك. لا ترسل كلمة مرور الحساب.',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
