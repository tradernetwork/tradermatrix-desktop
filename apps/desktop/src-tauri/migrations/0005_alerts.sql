-- M17: chart alerts (INFORM ONLY: an alert never places, reviews, cancels or fills anything). PURELY ADDITIVE (new tables only).
-- Privacy: no account number, no secret and no digest body is ever stored here. All times are UTC epoch milliseconds (the UI shows ET).
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref_kind TEXT NOT NULL,
    ref_param TEXT,
    price REAL NOT NULL,
    dir TEXT NOT NULL,
    tf TEXT,
    mode TEXT NOT NULL,
    "repeat" TEXT NOT NULL,
    cooldown_s INTEGER NOT NULL DEFAULT 300,
    hysteresis_pct REAL NOT NULL DEFAULT 0.05,
    expires_at INTEGER,
    snooze_until INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    extended_hours INTEGER NOT NULL DEFAULT 0,
    last_side INTEGER,
    armed INTEGER NOT NULL DEFAULT 1,
    last_fired_at INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_symbol ON alerts (symbol);

-- History. alert_id is a plain integer (no foreign key): deleting an alert keeps what it already told the user.
CREATE TABLE IF NOT EXISTS alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id INTEGER NOT NULL,
    fired_at INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    label TEXT NOT NULL,
    trigger_px REAL NOT NULL,
    ref_px REAL NOT NULL,
    quote_age_s REAL NOT NULL,
    kind TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    missed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alert_events_time ON alert_events (fired_at);
