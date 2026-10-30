# RIVO — Cloudflare + Supabase Auth + Google

هذه النسخة تستبدل اشتقاق كلمات المرور محليًا بخدمة Supabase Auth، مع بقاء المتجر والمنتجات والطلبات في Cloudflare D1 والصور في R2. لا تحتاج Workers Paid بسبب اشتقاق كلمات المرور في هذه النسخة؛ تبقى حدود خطط الخدمات الأخرى سارية ولم نختبر حمل إنتاج فعليًا.

## المنجز فعليًا

- إنشاء مشروع Supabase باسم RIVO داخل `itsfouad1's Org`، والمؤسسة على خطة Free.
- المشروع: `atgxzobzrnjazrgimqqy`، المنطقة Frankfurt / eu-central-1.
- التحقق من وصول قاعدة المشروع ومن إعدادات Auth العامة: Email مفعّل، تأكيد الإيميل مطلوب، وGoogle مفعّل حسب آخر فحص بعد إعدادك له.
- إدراج رابط المشروع ومفتاحه **القابل للنشر** في wrangler.json. لا يوجد service_role أو Google Client Secret في الملفات.
- إضافة صفحات التسجيل والدخول وتأكيد الإيميل واسترداد كلمة المرور عبر رمز بالبريد.
- إضافة زر «متابعة باستخدام Google» ومسار العودة والتحقق بـPKCE وstate مرتبط بالمتصفح.
- الجلسات في Cookies من نوع HttpOnly/Secure/SameSite، وتجديدها عبر Supabase.
- الصلاحيات يحددها جدول auth_roles في D1؛ لا تعتمد على بيانات المستخدم القابلة للتعديل أو على الإيميل.
- حذف كود PBKDF2 من التشغيل. لا تُخزّن كلمات المرور أو بصماتها الجديدة في Cloudflare.
- الحفاظ على الثيم ووظائف المنتجات والطلبات والموردين وواتساب.

## ما لم يُفعّل بعد

- الموقع لم يُنشر على حساب Cloudflare؛ رابط Sites السابق لم يتغير.
- تم تفعيل Google في Supabase بعد إعدادك Client ID وClient Secret. بقي رفع ملفات التحديث وضبط روابط الرجوع واختبار الدخول الكامل.
- تأكيد الإيميل والاسترداد للزبائن يحتاجان Custom SMTP. البريد الافتراضي في Supabase مخصص للتجربة ومقيّد؛ لا تعتبر إرسال الإيميلات جاهزًا قبل اختباره.
- يجب لصق قالبي البريد المرفقين في Supabase حتى يستلم المستخدم رمزًا يكتبه داخل ريفو.
- بوابة الدفع والمزامنة التلقائية للموردين ما زالتا تحتاجان الربط الخاص بكل خدمة.

## 1. نشر Cloudflare

من PowerShell داخل مجلد `rivo-cloudflare`:

```powershell
npm install
npx wrangler login
npx wrangler whoami
npx wrangler d1 create rivo-store-db
```

ضع database_id الناتج بدل `REPLACE_WITH_YOUR_D1_DATABASE_ID` في wrangler.json. لا تنشئ أو تستخدم قاعدة لمشروع آخر.

لتخزين الصور، بعد تفعيل R2 في حسابك:

```powershell
npx wrangler r2 bucket create rivo-store-media
```

يمكنك حذف r2_buckets من wrangler.json والبدء بروابط صور HTTPS؛ رفع الملفات لن يعمل بدون R2.

```powershell
npm test
npm run db:remote
npm run deploy
```

سيطبع رابط المتجر الحقيقي على workers.dev. لا تحتاج شراء دومين. إذا `rivo-store` اسم Worker لمشروع آخر عندك، غيّر name أولًا كي لا تستبدله.

## 2. إعداد Supabase

افتح:
https://supabase.com/dashboard/project/atgxzobzrnjazrgimqqy

في Authentication > URL Configuration:

- Site URL: رابط المتجر الحقيقي الذي طبعه Wrangler.
- Redirect URLs: أضف `https://YOUR_WORKER_HOST/api/auth/callback**` بعد استبدال YOUR_WORKER_HOST باسم المضيف الحقيقي. اللاحقة ** لهذه الصفحة فقط حتى تقبل معامل state العشوائي؛ لا تضف wildcard على كل النطاقات.

في إعدادات Email:

- اترك Confirm email مفعّلًا. الكود يرفض منح جلسة لحساب غير مؤكد.
- اضبط الحد الأدنى لكلمة المرور على 12 حرفًا، موافقًا للواجهة.
- اربط Custom SMTP لإرسال رسائل التأكيد والاسترداد إلى الزبائن.
- في Email Templates > Confirm signup: الصق `email-templates/confirm-signup.html`.
- في Email Templates > Reset password: الصق `email-templates/reset-password.html`.

القوالب تستخدم `{{ .Token }}`. المستخدم يدخل رمز الرسالة في الموقع، ولا يحتاج حفظ رمز استرداد دائم. نُفّذ دعم الرموز بطول 6–10 أرقام.

## 3. تفعيل الدخول باستخدام Google / Gmail

هذه ميزة مستقلة عن إدخال عنوان Gmail وكلمة مرور خاصة بريفو. عند الضغط على الزر، المستخدم يختار حساب Google ويتحقق Google منه؛ ريفو لا يستلم كلمة مرور Gmail.

1. افتح https://console.cloud.google.com/auth/overview وأنشئ/اختر مشروع RIVO.
2. جهّز اسم التطبيق وبريد الدعم والجمهور في Google Auth Platform. أثناء Testing أضف حسابات الاختبار؛ قبل الإطلاق تأكد من إعداد الجمهور والنشر المناسبين. لا نغيّر هذه الإعدادات نيابة عنك بدون الوصول لحسابك.
3. أضف صلاحيات `openid` و`email` و`profile` فقط. لا نحتاج قراءة بريد Gmail أو رسائله.
4. من Clients أنشئ OAuth Client من نوع Web application.
5. Authorized JavaScript origins: رابط المتجر الحقيقي بدون مسار.
6. Authorized redirect URIs: انسخ هذا الرابط بالضبط:

```text
https://atgxzobzrnjazrgimqqy.supabase.co/auth/v1/callback
```

7. في Supabase > Authentication > Sign In / Providers > Google، ضع Client ID وClient Secret وفعّل Google. احفظ السر داخل Supabase فقط؛ لا ترسله في المحادثة ولا تضفه للكود.
8. جرّب الزر من صفحة /login. بعد النجاح ينتقل الزبون إلى /account، والأدمن إلى /admin.

رابط العودة داخل Google يشير إلى Supabase، أما رابط العودة داخل Supabase فيشير إلى متجر Cloudflare. لا تبدلهما.

دخول Google لا يحتاج رسالة تأكيد من SMTP للحساب الذي يتحقق منه Google. أما التسجيل بكلمة مرور واستعادة كلمة المرور عبر البريد فيحتاجان إعداد SMTP.

## 4. حساب الإدارة

- سجّل حسابك بنفسك بالإيميل مع تأكيده، أو باستخدام Google بعد تفعيله.
- وأنت داخل حسابك، افتح `/api/session` على موقع ريفو وانسخ user.id كاملًا. يبدأ بـ`supabase:`.
- استبدل YOUR_USER_ID في الأمر التالي بمعرّف حسابك أنت:

```powershell
npx wrangler d1 execute DB --remote --command "UPDATE auth_roles SET role='admin' WHERE user_id='YOUR_USER_ID';"
```

ثم افتح /admin. لا تمنح الصلاحية بناءً على إيميل يدّعيه شخص آخر. يتم إنشاء صف auth_roles عند أول دخول مؤكد.

## 5. إذا استخدمت النسخة السابقة

- ملفات migrations القديمة محفوظة كما هي؛ أضفنا `0003_supabase_roles.sql` فقط. طبّق الترحيلات الجديدة ولا تمسح قاعدة البيانات.
- جداول كلمات المرور القديمة لا تُقرأ للدخول الجديد، وجلساتها ورموز الاسترداد القديمة لا تعمل في هذه النسخة.
- حسابات Supabase تستخدم معرّفًا مستقلًا. لا نربط حسابًا قديمًا أو طلباته تلقائيًا اعتمادًا على تطابق الإيميل، لأن الإيميلات القديمة لم تكن موثقة.
- إذا هناك زبائن وطلبات فعلية، يجب تنفيذ ترحيل يثبت ملكية كل حساب قبل التحويل. الموقع القديم لم يتغير وهذه الحزمة لا تتضمن بيانات الإنتاج.

## الاختبارات وحدودها

24 اختبارًا آليًا نجحت: التسجيل والتأكيد، رفض حساب غير مؤكد، الصلاحيات، Cookies وتجديد الجلسة، الاسترداد، CSRF، Google PKCE/state، وأسعار وملكية الطلبات. طلبات Auth في هذه الاختبارات محاكاة وليست إرسال بريد أو تسجيل دخول Google فعليًا.

تم التحقق من مشروع Supabase الحقيقي بقراءة إعداداته واستعلام SELECT 1؛ لم نرسل رسائل اختبار أو ننشئ حسابات زبائن. تجميع Wrangler dry-run نجح. لم تكتمل تجربة تسجيل الدخول والبريد على رابط إنتاج، ولم تُنفذ مراجعة مرئية بالمتصفح لهذه النسخة.

## اختبار القبول بعد الإعداد

1. زبون جديد بالإيميل: تصله الرسالة، يؤكد الرمز، يدخل حسابه.
2. كلمة مرور خاطئة لا تمنح جلسة.
3. استرداد الحساب: يصل الرمز، تتغير الكلمة، ثم ينجح الدخول بالكلمة الجديدة.
4. زر Google: اختيار الحساب، العودة للمتجر، صفحة الزبون.
5. حساب زبون لا يدخل /api/admin/overview؛ حساب الأدمن يرى الإدارة.
6. الخروج يمسح Cookies ويُلغي refresh session لدى Supabase. توكن الوصول الصادر سابقًا قد يبقى صالحًا حتى انتهاء عمره وفق سياسة Supabase؛ لا تدّعي إبطالًا فوريًا لكل نسخة مسروقة منه.

## مراجع

https://supabase.com/docs/guides/auth/social-login/auth-google
https://supabase.com/docs/guides/auth/auth-smtp
https://supabase.com/docs/guides/auth/auth-email-templates
https://supabase.com/docs/guides/auth/sessions
