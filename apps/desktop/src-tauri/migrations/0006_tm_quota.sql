-- M20a: the TraderMatrix daily call counter (one row per UTC day), so a restart never resets the budget. PURELY ADDITIVE (new table only).
-- Privacy: counts and flags only. No key, no header, no response body and no symbol is ever stored here.
-- (The two budgets live in the existing `settings` table under tm.quota.budgets; the skills cache table arrives with M20b.)
CREATE TABLE IF NOT EXISTS tm_quota (
    day TEXT PRIMARY KEY,
    used INTEGER NOT NULL DEFAULT 0,
    limit_seen INTEGER,
    paused INTEGER NOT NULL DEFAULT 0
);
