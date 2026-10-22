-- Separate IDs and roles prevent automatic linking of old unverified emails.
-- Retain old tables/data for a deliberate migration; no old sessions are accepted.
CREATE TABLE auth_roles (user_id TEXT PRIMARY KEY REFERENCES users(id), role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','admin')));
