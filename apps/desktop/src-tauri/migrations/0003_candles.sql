-- M11: every candle the chart sees, plus sampled snapshots. Local only; no account numbers, tokens or keys go in here.
CREATE TABLE candles (
    source TEXT NOT NULL,
    instrument TEXT NOT NULL,
    interval TEXT NOT NULL,
    ts INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (source, instrument, interval, ts)
) WITHOUT ROWID;

CREATE TABLE snapshots (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    ts INTEGER NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (kind, key, ts)
) WITHOUT ROWID;
