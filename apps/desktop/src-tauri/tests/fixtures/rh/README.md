# SYNTHETIC fixtures (not real captures)

Every file here was hand-written from the `outputSchema` entries in
the Robinhood MCP tool schemas. None came from a live Robinhood response; account numbers,
symbols, ids and prices are invented. They exist to exercise the parsers in `src/rh/types.rs` and
`src/rh/reads.rs`, and they deliberately include the awkward shapes the API is known to produce:

- numbers as strings, as bare numbers, as `null`, and absent
- unknown extra fields that must be ignored
- `null` where a list is expected
- nested objects where a scalar might be assumed (`dollar_based_amount`, `buying_power`)

Real shapes may differ. Replace these with sanitized real captures after the first live run (M3 live test).

## M6 order fixtures (also SYNTHETIC)

`review_equity.json`, `review_option.json`, `place_order.json`, `place_approval.json`, `cancel_ok.json`,
`approvals.json`, `approval_setting.json` were hand-written on 2026-11-10 from the `outputSchema` entries in
the Robinhood MCP tool schemas. No real review, place or cancel was ever sent to produce them
(nothing here touches robinhood.com). Real shapes may differ; replace with sanitized captures after the
user's own live test. `review_option.json` carries a non-empty `order_checks` on purpose.

## M7 fixtures (also SYNTHETIC)

`watchlist_write_ok.json` (one object keyed by tool: create, update, add, remove, option_add, option_remove),
`pnl_trades.json` and `pnl_trades_page2.json` were hand-written on 2026-11-10 from the `outputSchema` entries in
the Robinhood MCP tool schemas. No real watchlist was written and no real P&L was read. The existing
`realized_pnl.json` is reused for `get_realized_pnl`. Real shapes may differ; replace with sanitized captures after the
user's own live check.
