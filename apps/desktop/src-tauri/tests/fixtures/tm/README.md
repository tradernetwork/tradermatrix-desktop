# TraderMatrix fixtures

REAL responses (not synthetic) captured 2026-11-11 through the TraderMatrix MCP for AAPL: get_apex_levels, get_expected_move,
get_ticker_snapshot, get_iv_rank. Public market analytics, no credentials. Shapes are the contract for the Rust mappers.
Notes: ivRank is on a 0-100 scale (never multiply by 100); expectedMovePct is a DECIMAL fraction (0.036 = 3.6%); atmIv/fromIv/toIv are decimals.

Watchlist fixtures (2026-11-11): list_watchlists.json is a SANITIZED sample of the real response shape (real field names; fake tickers/notes so no personal data is committed). watchlist_add_* / watchlist_create_* are shapes from the tool descriptions ({ok, added, ticker, list} / {ok:false, error, availableLists}), not captures.
