//! M18 R tools storage tests: in-memory SQLite, no network. INFORMATIONAL data only: nothing here can touch an order.
use crate::db;
use crate::error::AppError;
use crate::risk::*;

const RV: &str = "11111111-2222-4333-8444-555555555555";
const RV2: &str = "11111111-2222-4333-8444-666666666666";
const OID: &str = "22222222-3333-4444-8555-666666666666";
const MASK: &str = "\u{2022}\u{2022}\u{2022}\u{2022}0001";
const NOW: i64 = 1_793_800_000_000;
/// 2026-11-05T15:30:00Z, about a day after NOW.
const CLOSE_TS: &str = "2026-11-05T15:30:00Z";

fn fields() -> DraftFields {
    DraftFields {
        side: "buy".into(),
        account_masked: Some(MASK.into()),
        symbol: "AAA".into(),
        instrument: "equity".into(),
        risk_basis: "equity_stop".into(),
        planned_risk_usd: 50.0,
        qty: Some(10.0),
        entry_price: Some(100.0),
        stop_price: Some(95.0),
        multiplier: None,
    }
}
fn put_in(rv: &str) -> DraftIn {
    DraftIn { review_id: rv.into(), fields: Some(fields()), order_id: None }
}
fn attach_in(rv: &str) -> DraftIn {
    DraftIn { review_id: rv.into(), fields: None, order_id: Some(OID.into()) }
}
fn trade(key: &str, sym: &str, side: &str, qty: f64, ts: &str) -> RiskTradeIn {
    RiskTradeIn { trade_key: key.into(), symbol: sym.into(), side: Some(side.into()), quantity: Some(qty), realized_gain: Some(15.0), timestamp: Some(ts.into()) }
}
fn manual() -> ManualRisk {
    ManualRisk {
        account_masked: Some(MASK.into()),
        symbol: "BBB".into(),
        instrument: "option".into(),
        risk_basis: "spread_max_loss".into(),
        planned_risk_usd: 380.0,
        qty: Some(1.0),
        entry_price: Some(1.2),
        stop_price: None,
        multiplier: None,
        note: Some("set later".into()),
    }
}
fn promote_manual(key: &str, m: ManualRisk) -> PromoteIn {
    PromoteIn { trade_key: key.into(), review_id: None, manual: Some(m) }
}
fn invalid<T: std::fmt::Debug>(r: Result<T, AppError>) {
    assert!(matches!(r, Err(AppError::Invalid(_))), "{r:?}");
}

#[tokio::test]
async fn settings_have_defaults_and_round_trip() {
    let p = db::open_memory().await.unwrap();
    let s = settings_get(&p).await.unwrap();
    assert_eq!((s.default_risk_pct, s.default_option_stop_mult, s.r_fallback_enabled), (1.0, 2.0, false));
    let s = settings_set(&p, RiskSettingsIn { default_risk_pct: Some(0.5), default_option_stop_mult: None, r_fallback_enabled: Some(true) }).await.unwrap();
    assert_eq!((s.default_risk_pct, s.default_option_stop_mult, s.r_fallback_enabled), (0.5, 2.0, true), "a patch leaves other fields alone");
    assert_eq!(settings_get(&p).await.unwrap(), s);
    for bad in [0.0, -1.0, 100.01, f64::NAN, f64::INFINITY] {
        invalid(settings_set(&p, RiskSettingsIn { default_risk_pct: Some(bad), ..Default::default() }).await);
    }
    for bad in [1.0, 0.5, -2.0, 51.0, f64::NAN] {
        invalid(settings_set(&p, RiskSettingsIn { default_option_stop_mult: Some(bad), ..Default::default() }).await);
    }
    assert_eq!(settings_get(&p).await.unwrap(), s, "rejected patches changed nothing");
}

#[tokio::test]
async fn manual_attach_round_trip_and_flag() {
    let p = db::open_memory().await.unwrap();
    let r = promote(&p, NOW, promote_manual("t_abc123", manual())).await.unwrap();
    assert_eq!((r.trade_key.as_str(), r.symbol.as_str(), r.instrument.as_str(), r.risk_basis.as_str()), ("t_abc123", "BBB", "option", "spread_max_loss"));
    assert_eq!((r.planned_risk_usd, r.qty, r.entry_price, r.stop_price, r.multiplier), (380.0, Some(1.0), Some(1.2), None, 100), "option multiplier defaults to 100");
    assert_eq!(r.source, "manual");
    assert!(r.after_the_fact, "manual attach is flagged as set after the fact");
    assert_eq!(r.account_masked.as_deref(), Some(MASK));
    assert_eq!(r.note.as_deref(), Some("set later"));
    let st = get_state(&p, NOW).await.unwrap();
    assert_eq!(st.risk, vec![r.clone()]);
    // overwriting the same trade key updates in place
    let mut m = manual();
    m.planned_risk_usd = 400.0;
    let r2 = promote(&p, NOW + 5, promote_manual("t_abc123", m)).await.unwrap();
    assert_eq!(r2.planned_risk_usd, 400.0);
    assert_eq!(get_state(&p, NOW).await.unwrap().risk.len(), 1);
    // an equity manual attach defaults the multiplier to 1
    let mut e = manual();
    e.instrument = "equity".into();
    e.risk_basis = "equity_stop".into();
    assert_eq!(promote(&p, NOW, promote_manual("t_eq", e)).await.unwrap().multiplier, 1);
}

#[tokio::test]
async fn validation_rejects_bad_numbers_keys_accounts_and_basis_mixes() {
    let p = db::open_memory().await.unwrap();
    let go = |m: ManualRisk| promote_manual("t_ok", m);
    for bad in [0.0, -1.0, f64::NAN, f64::INFINITY, 1e12] {
        let mut m = manual();
        m.planned_risk_usd = bad;
        invalid(promote(&p, NOW, go(m)).await);
    }
    for bad in [0.0, -3.0, f64::NAN] {
        let mut m = manual();
        m.qty = Some(bad);
        invalid(promote(&p, NOW, go(m)).await);
        let mut m = manual();
        m.entry_price = Some(bad);
        invalid(promote(&p, NOW, go(m)).await);
        let mut m = manual();
        m.stop_price = Some(bad);
        invalid(promote(&p, NOW, go(m)).await);
    }
    for bad in [0, -1, 1001] {
        let mut m = manual();
        m.multiplier = Some(bad);
        invalid(promote(&p, NOW, go(m)).await);
    }
    // basis must fit the instrument: no silent mixing of conventions
    let mut m = manual();
    m.risk_basis = "equity_stop".into();
    invalid(promote(&p, NOW, go(m)).await);
    let mut m = manual();
    m.instrument = "equity".into();
    invalid(promote(&p, NOW, go(m)).await);
    let mut m = manual();
    m.risk_basis = "kelly".into();
    invalid(promote(&p, NOW, go(m)).await);
    let mut m = manual();
    m.instrument = "future".into();
    invalid(promote(&p, NOW, go(m)).await);
    // manual dollars fits either instrument
    for inst in ["equity", "option"] {
        let mut m = manual();
        m.instrument = inst.into();
        m.risk_basis = "manual_dollars".into();
        assert!(promote(&p, NOW, promote_manual(&format!("t_{inst}"), m)).await.is_ok());
    }
    // trade key charset is the journal's
    for bad in ["", "a b", "t_\u{e9}", "x;drop", &"k".repeat(65)] {
        invalid(promote(&p, NOW, promote_manual(bad, manual())).await);
    }
    // symbol and note
    let mut m = manual();
    m.symbol = "bad symbol!".into();
    invalid(promote(&p, NOW, go(m)).await);
    let mut m = manual();
    m.note = Some("x".repeat(501));
    invalid(promote(&p, NOW, go(m)).await);
    let mut m = manual();
    m.note = Some("a\u{0}b".into());
    invalid(promote(&p, NOW, go(m)).await);
    // exactly one of review_id / manual
    invalid(promote(&p, NOW, PromoteIn { trade_key: "t_ok".into(), review_id: None, manual: None }).await);
    invalid(promote(&p, NOW, PromoteIn { trade_key: "t_ok".into(), review_id: Some(RV.into()), manual: Some(manual()) }).await);
    assert!(get_state(&p, NOW).await.unwrap().risk.iter().all(|r| r.trade_key != "t_ok"), "nothing rejected was stored");
}

#[tokio::test]
async fn account_numbers_are_never_stored_only_masked_ones() {
    let p = db::open_memory().await.unwrap();
    for bad in ["900000001", "SYN00000001", "1234", "\u{2022}\u{2022}\u{2022}1234", "\u{2022}\u{2022}\u{2022}\u{2022}12345", "****1234x"] {
        let mut m = manual();
        m.account_masked = Some(bad.into());
        invalid(promote(&p, NOW, promote_manual("t_ok", m)).await);
        let mut f = fields();
        f.account_masked = Some(bad.into());
        invalid(draft_put(&p, NOW, DraftIn { review_id: RV.into(), fields: Some(f), order_id: None }).await);
    }
    let mut m = manual();
    m.account_masked = None;
    assert!(promote(&p, NOW, promote_manual("t_none", m)).await.is_ok(), "an account is optional");
}

#[tokio::test]
async fn database_checks_reject_bad_rows_even_without_the_validation_layer() {
    let p = db::open_memory().await.unwrap();
    let ins = |risk: &str, mult: &str, inst: &str, basis: &str| {
        format!(
            "INSERT INTO trade_risk (trade_key, created_at, updated_at, symbol, instrument, risk_basis, planned_risk_usd, multiplier) \
             VALUES ('t_x', 'a', 'a', 'AAA', '{inst}', '{basis}', {risk}, {mult})"
        )
    };
    assert!(sqlx::query(&ins("100", "1", "equity", "equity_stop")).execute(&p).await.is_ok());
    sqlx::query("DELETE FROM trade_risk").execute(&p).await.unwrap();
    for (risk, mult, inst, basis) in [("0", "1", "equity", "equity_stop"), ("-5", "1", "equity", "equity_stop"), ("100", "0", "equity", "equity_stop"), ("100", "-1", "equity", "equity_stop"), ("100", "1", "future", "equity_stop"), ("100", "1", "equity", "kelly")] {
        assert!(sqlx::query(&ins(risk, mult, inst, basis)).execute(&p).await.is_err(), "{risk} {mult} {inst} {basis}");
    }
    let draft = |risk: &str| {
        format!(
            "INSERT INTO review_risk_draft (review_id, created_at, symbol, side, instrument, risk_basis, planned_risk_usd, multiplier, expires_at) \
             VALUES ('r', 1, 'AAA', 'buy', 'equity', 'equity_stop', {risk}, 1, 2)"
        )
    };
    assert!(sqlx::query(&draft("0")).execute(&p).await.is_err());
    assert!(sqlx::query(&draft("10")).execute(&p).await.is_ok());
    for bad in ["(1, 0, 2, 0)", "(1, 101, 2, 0)", "(1, 1, 1, 0)", "(1, 1, 2, 2)", "(2, 1, 2, 0)"] {
        let q = format!("INSERT INTO risk_settings (id, default_risk_pct, default_option_stop_mult, r_fallback_enabled) VALUES {bad}");
        assert!(sqlx::query(&q).execute(&p).await.is_err(), "{bad}");
    }
}

#[tokio::test]
async fn migration_0007_is_purely_additive_and_existing_data_survives() {
    let sql = include_str!("../migrations/0007_trade_risk.sql").to_uppercase();
    for banned in ["DROP ", "ALTER ", "DELETE FROM", "UPDATE ", "INSERT "] {
        assert!(!sql.contains(banned), "0007 must be additive only: {banned}");
    }
    let dir = std::env::temp_dir().join(format!("rebull-mig7-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("old.db");
    let _ = std::fs::remove_file(&path);
    let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();
    let mut old = sqlx::migrate!("./migrations");
    old.migrations = std::borrow::Cow::Owned(old.migrations.iter().filter(|m| m.version <= 6).cloned().collect());
    old.run(&pool).await.unwrap();
    db::layout_save(&pool, "Main", r#"{"a":1}"#).await.unwrap();
    db::setting_set(&pool, "k", "v").await.unwrap();
    sqlx::query("INSERT INTO journal_notes (created_at, updated_at, symbol, trade_key, body) VALUES ('a','a','AAA','t_old','kept note')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO candles (source, instrument, interval, ts, open, high, low, close, volume, fetched_at) VALUES ('rh','AAPL','15m',1700000000000,1,2,0.5,1.5,10,1)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO tm_quota (day, used) VALUES ('2026-11-11', 7)").execute(&pool).await.unwrap();
    let had: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('trade_risk','risk_settings','review_risk_draft')").fetch_one(&pool).await.unwrap();
    assert_eq!(had, 0);
    drop(pool);
    let pool = db::open(&path).await.unwrap();
    assert_eq!(db::layout_load(&pool, "Main").await.unwrap().as_deref(), Some(r#"{"a":1}"#));
    assert_eq!(db::setting_get(&pool, "k").await.unwrap().as_deref(), Some("v"));
    for (t, n) in [("journal_notes", 1), ("candles", 1), ("tm_quota", 1), ("trade_risk", 0), ("review_risk_draft", 0)] {
        let c: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {t}")).fetch_one(&pool).await.unwrap();
        assert_eq!(c, n, "{t}");
    }
    assert_eq!(settings_get(&pool).await.unwrap().default_risk_pct, 1.0);
    // the old journal note still links by its key and the new table joins to it
    promote(&pool, NOW, promote_manual("t_old", manual())).await.unwrap();
    let j: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM journal_notes n JOIN trade_risk r ON r.trade_key = n.trade_key").fetch_one(&pool).await.unwrap();
    assert_eq!(j, 1);
    let want_risk = ["trade_key", "created_at", "updated_at", "account_masked", "symbol", "instrument", "risk_basis", "planned_risk_usd", "qty", "entry_price", "stop_price", "multiplier", "source", "note"];
    let got: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('trade_risk') ORDER BY cid").fetch_all(&pool).await.unwrap();
    assert_eq!(got, want_risk);
    drop(pool);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- Task 4: the review-to-trade link ----

#[tokio::test]
async fn draft_then_placed_then_matching_close_is_suggested_and_promoted_with_the_right_key() {
    let p = db::open_memory().await.unwrap();
    let d = draft_put(&p, NOW, put_in(RV)).await.unwrap();
    assert_eq!((d.review_id.as_str(), d.symbol.as_str(), d.side.as_str(), d.order_id.clone()), (RV, "AAA", "buy", None));
    assert_eq!(d.expires_at, NOW + DRAFT_OPEN_TTL_MS, "an unplaced draft lives one hour");
    let d = draft_put(&p, NOW + 1000, attach_in(RV)).await.unwrap();
    assert_eq!(d.order_id.as_deref(), Some(OID));
    assert_eq!(d.placed_at, Some(NOW + 1000));
    assert_eq!(d.expires_at, NOW + 1000 + DRAFT_PLACED_TTL_MS, "a placed draft lives 90 days");
    let t = [trade("t_match0123456789012345", "AAA", "sell", 10.0, CLOSE_TS), trade("t_other", "ZZZ", "sell", 10.0, CLOSE_TS)];
    let s = stats(&p, NOW + 2000, Some(MASK), &t).await.unwrap();
    assert_eq!(s.suggestions, vec![Suggestion { review_id: RV.into(), trade_key: "t_match0123456789012345".into() }]);
    assert!(s.rows.is_empty(), "a suggestion is NOT a link: nothing is promoted by itself");
    assert!(get_state(&p, NOW + 2000).await.unwrap().risk.is_empty());
    // the user confirms: promote by review id with the chosen trade key
    let r = promote(&p, NOW + 3000, PromoteIn { trade_key: "t_match0123456789012345".into(), review_id: Some(RV.into()), manual: None }).await.unwrap();
    assert_eq!((r.trade_key.as_str(), r.source.as_str(), r.planned_risk_usd, r.qty, r.entry_price, r.stop_price), ("t_match0123456789012345", "draft", 50.0, Some(10.0), Some(100.0), Some(95.0)));
    assert!(!r.after_the_fact, "recorded before the trade: not flagged");
    let st = get_state(&p, NOW + 3000).await.unwrap();
    assert!(st.drafts.is_empty(), "the draft is consumed");
    // and now the stats join sees it and stops suggesting
    let s = stats(&p, NOW + 3000, Some(MASK), &t).await.unwrap();
    assert_eq!((s.trades_total, s.with_risk), (2, 1));
    assert_eq!(s.rows.len(), 1);
    assert_eq!((s.rows[0].trade_key.as_str(), s.rows[0].planned_risk_usd, s.rows[0].realized_gain), ("t_match0123456789012345", 50.0, Some(15.0)));
    assert!(s.suggestions.is_empty());
}

#[tokio::test]
async fn a_fill_outside_the_window_is_not_suggested() {
    let p = db::open_memory().await.unwrap();
    draft_put(&p, NOW, put_in(RV)).await.unwrap();
    draft_put(&p, NOW, attach_in(RV)).await.unwrap();
    for ts in ["2026-11-03T00:00:00Z", "2027-03-01T00:00:00Z", "not a time", "2026-11-05 15:30:00", "2026-13-40T00:00:00Z"] {
        let s = stats(&p, NOW, Some(MASK), &[trade("t_x", "AAA", "sell", 10.0, ts)]).await.unwrap();
        assert!(s.suggestions.is_empty(), "{ts}");
    }
    let mut t = trade("t_x", "AAA", "sell", 10.0, CLOSE_TS);
    t.timestamp = None;
    assert!(stats(&p, NOW, Some(MASK), &[t]).await.unwrap().suggestions.is_empty(), "no timestamp, no guess");
    // timestamp parsing (the window logic relies on it)
    assert_eq!(parse_iso_ms("2026-11-05T15:30:00Z"), Some(1_793_892_600_000));
    assert_eq!(parse_iso_ms("2026-11-05T15:30:00.250Z"), Some(1_793_892_600_250));
    assert_eq!(parse_iso_ms("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
    assert_eq!(parse_iso_ms("2026-11-05T15:30:00+00:00"), Some(1_793_892_600_000));
    assert_eq!(parse_iso_ms("2026-11-05T15:30:00-05:00"), Some(1_793_892_600_000 + 5 * 3_600_000));
    assert_eq!(parse_iso_ms("2026-02-30T00:00:00Z"), None);
    assert_eq!(parse_iso_ms(""), None);
}

#[tokio::test]
async fn window_edges_are_inclusive_at_placed_at_and_at_90_days() {
    let p = db::open_memory().await.unwrap();
    let placed = 1_793_892_600_000; // 2026-11-05T15:30:00Z
    draft_put(&p, placed, put_in(RV)).await.unwrap();
    draft_put(&p, placed, attach_in(RV)).await.unwrap();
    let sug = |ts: &'static str| {
        let p = p.clone();
        async move { stats(&p, placed + 1, Some(MASK), &[trade("t_e", "AAA", "sell", 10.0, ts)]).await.unwrap().suggestions.len() }
    };
    assert_eq!(sug("2026-11-05T15:30:00Z").await, 1, "same instant as placed");
    assert_eq!(sug("2026-11-05T15:29:59Z").await, 0, "before it was placed");
    assert_eq!(sug("2027-02-03T15:30:00Z").await, 1, "exactly 90 days later");
    assert_eq!(sug("2027-02-03T15:30:01Z").await, 0, "past the window");
}

#[tokio::test]
async fn an_expired_or_missing_draft_means_no_r_and_nothing_is_guessed() {
    let p = db::open_memory().await.unwrap();
    // never created: attaching an order id and promoting both fail, nothing appears
    assert!(matches!(draft_put(&p, NOW, attach_in(RV)).await, Err(AppError::NotFound(_))));
    assert!(matches!(promote(&p, NOW, PromoteIn { trade_key: "t_x".into(), review_id: Some(RV.into()), manual: None }).await, Err(AppError::NotFound(_))));
    // unplaced draft expires after one hour; its late "placed" attach is refused and it is not resurrected
    draft_put(&p, NOW, put_in(RV)).await.unwrap();
    assert!(matches!(draft_put(&p, NOW + DRAFT_OPEN_TTL_MS + 1, attach_in(RV)).await, Err(AppError::NotFound(_))));
    assert!(get_state(&p, NOW + DRAFT_OPEN_TTL_MS + 1).await.unwrap().drafts.is_empty());
    // a placed draft expires after 90 days: no suggestion, promote refused
    draft_put(&p, NOW, put_in(RV2)).await.unwrap();
    draft_put(&p, NOW, attach_in(RV2)).await.unwrap();
    let later = NOW + DRAFT_PLACED_TTL_MS + 1;
    let s = stats(&p, later, Some(MASK), &[trade("t_x", "AAA", "sell", 10.0, "2027-02-03T15:30:00Z")]).await.unwrap();
    assert!(s.suggestions.is_empty() && s.rows.is_empty());
    assert!(matches!(promote(&p, later, PromoteIn { trade_key: "t_x".into(), review_id: Some(RV2.into()), manual: None }).await, Err(AppError::NotFound(_))));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM review_risk_draft").fetch_one(&p).await.unwrap();
    assert_eq!(n, 0, "TTL cleanup removed the dead rows");
    assert!(get_state(&p, later).await.unwrap().risk.is_empty());
}

#[tokio::test]
async fn an_unplaced_draft_cannot_be_promoted_or_suggested() {
    let p = db::open_memory().await.unwrap();
    draft_put(&p, NOW, put_in(RV)).await.unwrap();
    invalid(promote(&p, NOW, PromoteIn { trade_key: "t_x".into(), review_id: Some(RV.into()), manual: None }).await);
    assert!(stats(&p, NOW, Some(MASK), &[trade("t_x", "AAA", "sell", 10.0, CLOSE_TS)]).await.unwrap().suggestions.is_empty());
    // and a placed draft cannot be silently overwritten by another put
    draft_put(&p, NOW, attach_in(RV)).await.unwrap();
    invalid(draft_put(&p, NOW, put_in(RV)).await);
}

#[tokio::test]
async fn near_misses_are_never_suggested() {
    let p = db::open_memory().await.unwrap();
    draft_put(&p, NOW, put_in(RV)).await.unwrap();
    draft_put(&p, NOW, attach_in(RV)).await.unwrap();
    let cases = [
        trade("t_a", "AAA", "buy", 10.0, CLOSE_TS),  // same side as the entry: not a close
        trade("t_b", "AAA", "sell", 9.0, CLOSE_TS),  // partial close
        trade("t_c", "AAA", "sell", 11.0, CLOSE_TS), // bigger than the entry
        trade("t_d", "AAB", "sell", 10.0, CLOSE_TS), // other symbol
        trade("t_e", "AAA", "", 10.0, CLOSE_TS),     // unknown side
    ];
    for c in cases {
        let k = c.trade_key.clone();
        assert!(stats(&p, NOW, Some(MASK), &[c]).await.unwrap().suggestions.is_empty(), "{k}");
    }
    let mut nq = trade("t_f", "AAA", "sell", 10.0, CLOSE_TS);
    nq.quantity = None;
    assert!(stats(&p, NOW, Some(MASK), &[nq]).await.unwrap().suggestions.is_empty());
    // another account's list, or no account given: no match (the draft's account must equal the selected one)
    let t = [trade("t_g", "AAA", "sell", 10.0, CLOSE_TS)];
    assert!(stats(&p, NOW, Some("\u{2022}\u{2022}\u{2022}\u{2022}9999"), &t).await.unwrap().suggestions.is_empty());
    assert!(stats(&p, NOW, None, &t).await.unwrap().suggestions.is_empty());
    assert_eq!(stats(&p, NOW, Some(MASK), &t).await.unwrap().suggestions.len(), 1, "control: the same call with the right account matches");
}

#[tokio::test]
async fn ambiguity_either_way_means_no_suggestion() {
    let p = db::open_memory().await.unwrap();
    // two equal drafts, one matching close: it could belong to either, so neither is suggested
    for rv in [RV, RV2] {
        draft_put(&p, NOW, put_in(rv)).await.unwrap();
        draft_put(&p, NOW, attach_in(rv)).await.unwrap();
    }
    assert!(stats(&p, NOW, Some(MASK), &[trade("t_x", "AAA", "sell", 10.0, CLOSE_TS)]).await.unwrap().suggestions.is_empty());
    // one draft, two equal closes: also ambiguous
    let q = db::open_memory().await.unwrap();
    draft_put(&q, NOW, put_in(RV)).await.unwrap();
    draft_put(&q, NOW, attach_in(RV)).await.unwrap();
    let two = [trade("t_x", "AAA", "sell", 10.0, CLOSE_TS), trade("t_y", "AAA", "sell", 10.0, "2026-11-06T15:30:00Z")];
    assert!(stats(&q, NOW, Some(MASK), &two).await.unwrap().suggestions.is_empty());
}

#[tokio::test]
async fn draft_put_validates_ids_and_exclusive_modes() {
    let p = db::open_memory().await.unwrap();
    for bad in ["", "not-a-uuid", "11111111222243338444555555555555", &format!("{RV}x")] {
        invalid(draft_put(&p, NOW, put_in(bad)).await);
    }
    invalid(draft_put(&p, NOW, DraftIn { review_id: RV.into(), fields: None, order_id: None }).await);
    invalid(draft_put(&p, NOW, DraftIn { review_id: RV.into(), fields: Some(fields()), order_id: Some(OID.into()) }).await);
    draft_put(&p, NOW, put_in(RV)).await.unwrap();
    for bad in ["", "a b", "x;y", &"o".repeat(65)] {
        invalid(draft_put(&p, NOW, DraftIn { review_id: RV.into(), fields: None, order_id: Some(bad.into()) }).await);
    }
    let mut f = fields();
    f.side = "hold".into();
    invalid(draft_put(&p, NOW, DraftIn { review_id: RV2.into(), fields: Some(f), order_id: None }).await);
    let mut f = fields();
    f.planned_risk_usd = 0.0;
    invalid(draft_put(&p, NOW, DraftIn { review_id: RV2.into(), fields: Some(f), order_id: None }).await);
    // re-putting an unplaced draft refreshes it and its expiry
    let mut f = fields();
    f.planned_risk_usd = 75.0;
    let d = draft_put(&p, NOW + 1000, DraftIn { review_id: RV.into(), fields: Some(f), order_id: None }).await.unwrap();
    assert_eq!((d.planned_risk_usd, d.expires_at), (75.0, NOW + 1000 + DRAFT_OPEN_TTL_MS));
}

#[tokio::test]
async fn stats_rejects_bad_input_and_only_joins_known_keys() {
    let p = db::open_memory().await.unwrap();
    promote(&p, NOW, promote_manual("t_has", manual())).await.unwrap();
    let t = vec![
        RiskTradeIn { trade_key: "t_has".into(), symbol: "BBB".into(), side: None, quantity: None, realized_gain: Some(-380.0), timestamp: Some("2026-11-05T15:30:00Z".into()) },
        RiskTradeIn { trade_key: "t_none".into(), symbol: "CCC".into(), side: None, quantity: None, realized_gain: Some(5.0), timestamp: None },
    ];
    let s = stats(&p, NOW, None, &t).await.unwrap();
    assert_eq!((s.trades_total, s.with_risk), (2, 1));
    assert_eq!(s.rows[0].realized_gain, Some(-380.0));
    assert_eq!(s.rows[0].closed_at.as_deref(), Some("2026-11-05T15:30:00Z"));
    assert_eq!(s.rows[0].risk_basis, "spread_max_loss");
    invalid(stats(&p, NOW, None, &[trade("bad key!", "A", "sell", 1.0, CLOSE_TS)]).await);
    invalid(stats(&p, NOW, Some("900000001"), &t).await);
    let many: Vec<RiskTradeIn> = (0..=MAX_STATS_TRADES).map(|i| trade(&format!("t_{i}"), "A", "sell", 1.0, CLOSE_TS)).collect();
    invalid(stats(&p, NOW, None, &many).await);
    assert_eq!(stats(&p, NOW, None, &[]).await.unwrap().trades_total, 0);
}

/// INFORMATIONAL ONLY: the R modules never reach the Robinhood client, the review store, an HTTP client or any tool call.
#[test]
fn the_r_modules_have_no_path_to_orders_or_the_network() {
    for (name, src) in [("risk.rs", include_str!("risk.rs")), ("risk_commands.rs", include_str!("risk_commands.rs"))] {
        for bad in ["RhState", "McpClient", "call_tool", "ReviewStore", "ReviewRecord", "reqwest", "PlaceOutcome", "rh_commands", "rh::writes", "rh::reviews", "rh::mcp", "rh::reads", "tm::"] {
            assert!(!src.contains(bad), "{name} must not reference {bad}");
        }
    }
}
