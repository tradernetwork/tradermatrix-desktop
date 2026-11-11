-- M16 B2 + B3: Explain chat usage counters and per-symbol threads. PURELY ADDITIVE (new tables only; nothing existing is touched).
-- Privacy: no API key, no digest body, no account number and no journal note is ever stored here. A message row keeps the chat text the
-- user typed and the model's answer, plus the SHA-256 of the digest that was sent (never the digest itself).

-- One row per (UTC day, model): token counters and an estimated dollar figure. est_usd is only meaningful when priced = 1
-- (the model had a known price); est_tokens counts tokens that were estimated (chars / 4) because the provider reported no usage.
CREATE TABLE IF NOT EXISTS explain_usage (
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt INTEGER NOT NULL DEFAULT 0,
    completion INTEGER NOT NULL DEFAULT 0,
    est_usd REAL NOT NULL DEFAULT 0,
    est_tokens INTEGER NOT NULL DEFAULT 0,
    priced INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, model)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS explain_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    title TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS explain_threads_symbol ON explain_threads (symbol, updated_at);

CREATE TABLE IF NOT EXISTS explain_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES explain_threads (id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL,
    prompt_tok INTEGER,
    completion_tok INTEGER,
    model TEXT,
    digest_hash TEXT,
    had_positions INTEGER NOT NULL DEFAULT 0,
    prompt_version TEXT,
    flagged_json TEXT
);
CREATE INDEX IF NOT EXISTS explain_messages_thread ON explain_messages (thread_id, id);
