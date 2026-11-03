-- Insiders (Alan, 2026-11-02: "how do we tell if its real users"). Additive: one column with a default.
-- 1 = us (our domains, INTERNAL_EMAILS, or an E2E reserved test domain); the rule is src/hosted/internal.js.
-- Signup sets it and each signed-in request re-checks it. This backfill covers the domain parts only;
-- INTERNAL_EMAILS is runtime config, so those accounts are tagged the next time they're used.
ALTER TABLE hosted_accounts ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;
UPDATE hosted_accounts SET internal=1 WHERE
 lower(substr(email,instr(email,'@')+1)) IN ('example.com','example.net','example.org')
 OR lower(email) LIKE '%.test' OR lower(email) LIKE '%.invalid' OR lower(email) LIKE '%.example' OR lower(email) LIKE '%.localhost';
-- The lifetime signup counter (stop guard) counted insiders other than example.invalid/example.com. Take out the
-- insiders still present; already-deleted insider signups can't be told apart and stay counted.
UPDATE analytics_population SET signups=MAX(0,signups-(SELECT COUNT(*) FROM hosted_accounts WHERE internal=1 AND email NOT LIKE '%@example.invalid' AND email NOT LIKE '%@example.com')) WHERE id=1;
