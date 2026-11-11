-- M7: local trading journal. Notes never leave this database.
CREATE TABLE journal_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    symbol TEXT,
    account_masked TEXT,
    trade_key TEXT,
    body TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_journal_notes_symbol ON journal_notes(symbol);
CREATE INDEX idx_journal_notes_trade_key ON journal_notes(trade_key);
