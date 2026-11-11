-- M18: R tools. PURELY ADDITIVE (three new tables, nothing existing is touched; the settings row is created lazily by the app, not here).
-- Local only. Account numbers are never stored, only the masked form ("....1234"); notes stay on this machine.
-- INFORMATIONAL: nothing in these tables is read by Review or Place.

-- Planned risk (1R in dollars) recorded for one journal trade, keyed by the same trade_key the journal uses.
-- source 'draft' = recorded at review time and promoted by the user; 'manual' = typed in later ("set after the fact").
CREATE TABLE IF NOT EXISTS trade_risk (
    trade_key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    account_masked TEXT,
    symbol TEXT NOT NULL,
    instrument TEXT NOT NULL CHECK (instrument IN ('equity', 'option')),
    risk_basis TEXT NOT NULL CHECK (risk_basis IN ('equity_stop', 'spread_max_loss', 'stop_mult', 'manual_dollars')),
    planned_risk_usd REAL NOT NULL CHECK (planned_risk_usd > 0),
    qty REAL CHECK (qty IS NULL OR qty > 0),
    entry_price REAL,
    stop_price REAL,
    multiplier INTEGER NOT NULL DEFAULT 1 CHECK (multiplier >= 1),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('draft', 'manual')),
    note TEXT
);

-- One row (id = 1): the helper defaults. Created lazily by the app.
CREATE TABLE IF NOT EXISTS risk_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    default_risk_pct REAL NOT NULL DEFAULT 1.0 CHECK (default_risk_pct > 0 AND default_risk_pct <= 100),
    default_option_stop_mult REAL NOT NULL DEFAULT 2.0 CHECK (default_option_stop_mult > 1),
    r_fallback_enabled INTEGER NOT NULL DEFAULT 0 CHECK (r_fallback_enabled IN (0, 1))
);

-- Planned risk stored under a review id until the user promotes it to a trade (TTL: 1 h unplaced, 90 days after the order is placed).
-- Times are epoch milliseconds. order_id / placed_at are filled when the place outcome is `placed`.
CREATE TABLE IF NOT EXISTS review_risk_draft (
    review_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    account_masked TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    instrument TEXT NOT NULL CHECK (instrument IN ('equity', 'option')),
    risk_basis TEXT NOT NULL CHECK (risk_basis IN ('equity_stop', 'spread_max_loss', 'stop_mult', 'manual_dollars')),
    planned_risk_usd REAL NOT NULL CHECK (planned_risk_usd > 0),
    qty REAL CHECK (qty IS NULL OR qty > 0),
    entry_price REAL,
    stop_price REAL,
    multiplier INTEGER NOT NULL DEFAULT 1 CHECK (multiplier >= 1),
    order_id TEXT,
    placed_at INTEGER,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_risk_draft_expires ON review_risk_draft(expires_at);
