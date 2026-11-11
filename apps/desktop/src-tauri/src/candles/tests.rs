//! Candle storage tests: in-memory SQLite, no network.
use super::*;
use crate::db;

const T0: i64 = 1_700_000_000_000;

fn bar(ts: i64, close: f64) -> CandleIn {
    CandleIn { ts, open: close - 1.0, high: close + 1.0, low: close - 2.0, close, volume: 1000.0 }
}

async fn all(p: &SqlitePool) -> Vec<CandleRow> {
    load_candles(p, "rh_equity", "AAPL", "1D", 0, i64::MAX, MAX_LOAD).await.unwrap()
}

#[tokio::test]
async fn upsert_is_idempotent_and_round_trips() {
    let p = db::open_memory().await.unwrap();
    let bars = vec![bar(T0, 100.0), bar(T0 + 86_400_000, 101.0)];
    assert_eq!(store_candles(&p, "rh_equity", "AAPL", "1D", &bars, 10).await.unwrap(), 2);
    assert_eq!(store_candles(&p, "rh_equity", "AAPL", "1D", &bars, 10).await.unwrap(), 2);
    let got = all(&p).await;
    assert_eq!(got.len(), 2);
    assert_eq!(got[0], CandleRow { ts: T0, open: 99.0, high: 101.0, low: 98.0, close: 100.0, volume: 1000.0 });
    assert_eq!(stats(&p).await.unwrap().candles, 2);
}

#[tokio::test]
async fn newer_fetched_at_wins_older_does_not() {
    let p = db::open_memory().await.unwrap();
    store_candles(&p, "rh_equity", "AAPL", "1D", &[bar(T0, 100.0)], 10).await.unwrap();
    store_candles(&p, "rh_equity", "AAPL", "1D", &[bar(T0, 150.0)], 20).await.unwrap();
    assert_eq!(all(&p).await[0].close, 150.0);
    store_candles(&p, "rh_equity", "AAPL", "1D", &[bar(T0, 120.0)], 15).await.unwrap();
    assert_eq!(all(&p).await[0].close, 150.0, "older fetch must not clobber a newer row");
    store_candles(&p, "rh_equity", "AAPL", "1D", &[bar(T0, 120.0)], 20).await.unwrap();
    assert_eq!(all(&p).await[0].close, 150.0, "equal fetched_at is not newer");
}

#[tokio::test]
async fn keys_are_independent() {
    let p = db::open_memory().await.unwrap();
    store_candles(&p, "rh_equity", "AAPL", "1D", &[bar(T0, 11.0)], 1).await.unwrap();
    store_candles(&p, "rh_equity", "AAPL", "5m", &[bar(T0, 12.0)], 1).await.unwrap();
    store_candles(&p, "rh_option", "AAPL", "1D", &[bar(T0, 13.0)], 1).await.unwrap();
    assert_eq!(all(&p).await.len(), 1);
    assert_eq!(stats(&p).await.unwrap().candles, 3);
}

#[tokio::test]
async fn bad_rows_reject_the_whole_batch() {
    let p = db::open_memory().await.unwrap();
    let good = bar(T0, 100.0);
    let cases: Vec<(&str, CandleIn)> = vec![
        ("nan", CandleIn { close: f64::NAN, ..good }),
        ("inf", CandleIn { high: f64::INFINITY, ..good }),
        ("high<low", CandleIn { high: 1.0, low: 2.0, ..good }),
        ("neg volume", CandleIn { volume: -1.0, ..good }),
        ("nan volume", CandleIn { volume: f64::NAN, ..good }),
        ("neg price", CandleIn { low: -1.0, ..good }),
        ("ts 1970", CandleIn { ts: 5, ..good }),
        ("ts far future", CandleIn { ts: now_ms() + 10 * 86_400_000, ..good }),
    ];
    for (name, bad) in cases {
        let r = store_candles(&p, "rh_equity", "AAPL", "1D", &[bar(T0 + 1000, 11.0), bad], 1).await;
        assert!(matches!(r, Err(AppError::Invalid(_))), "{name}: {r:?}");
        assert_eq!(stats(&p).await.unwrap().candles, 0, "{name}: nothing may be written");
    }
}

#[tokio::test]
async fn identifiers_are_checked() {
    let p = db::open_memory().await.unwrap();
    let b = [bar(T0, 11.0)];
    for (s, i, v) in [
        ("", "AAPL", "1D"),
        ("rh equity", "AAPL", "1D"),
        ("RH", "AAPL", "1D"),
        ("rh_equity", "", "1D"),
        ("rh_equity", "AA PL", "1D"),
        ("rh_equity", "A';DROP TABLE candles;--", "1D"),
        ("rh_equity", &"A".repeat(65), "1D"),
        ("rh_equity", "AAPL", ""),
        ("rh_equity", "AAPL", "1 D"),
        ("rh_equity", "AAPL", "123456789012345"),
    ] {
        assert!(matches!(store_candles(&p, s, i, v, &b, 1).await, Err(AppError::Invalid(_))), "{s:?} {i:?} {v:?}");
        assert!(matches!(load_candles(&p, s, i, v, 0, 10, 10).await, Err(AppError::Invalid(_))), "load {s:?} {i:?} {v:?}");
    }
    store_candles(&p, "rh_option", "0f3c2a1e-5b7d-4c9a-8e21-3a4b5c6d7e8f", "5minute", &b, 1).await.unwrap();
    store_candles(&p, "rh_equity", "BRK.B", "1D", &b, 1).await.unwrap();
}

#[tokio::test]
async fn batch_cap_is_5000() {
    let p = db::open_memory().await.unwrap();
    let many: Vec<CandleIn> = (0..5001).map(|i| bar(T0 + i * 60_000, 10.0)).collect();
    assert!(matches!(store_candles(&p, "rh_equity", "AAPL", "1m", &many, 1).await, Err(AppError::Invalid(_))));
    assert_eq!(stats(&p).await.unwrap().candles, 0);
    assert_eq!(store_candles(&p, "rh_equity", "AAPL", "1m", &many[..5000], 1).await.unwrap(), 5000);
    assert_eq!(stats(&p).await.unwrap().candles, 5000);
    assert_eq!(store_candles(&p, "rh_equity", "AAPL", "1m", &[], 1).await.unwrap(), 0);
}

#[tokio::test]
async fn duplicate_ts_inside_one_batch_is_fine() {
    let p = db::open_memory().await.unwrap();
    store_candles(&p, "rh_equity", "AAPL", "1D", &[bar(T0, 11.0), bar(T0, 12.0)], 1).await.unwrap();
    let got = all(&p).await;
    assert_eq!(got.len(), 1);
}

#[tokio::test]
async fn range_and_limit_reads() {
    let p = db::open_memory().await.unwrap();
    let bars: Vec<CandleIn> = (0..10).map(|i| bar(T0 + i * 60_000, 10.0 + i as f64)).collect();
    store_candles(&p, "rh_equity", "AAPL", "1m", &bars, 1).await.unwrap();
    let r = load_candles(&p, "rh_equity", "AAPL", "1m", T0 + 2 * 60_000, T0 + 5 * 60_000, 100).await.unwrap();
    assert_eq!(r.iter().map(|c| c.ts).collect::<Vec<_>>(), [2, 3, 4, 5].map(|i| T0 + i * 60_000), "inclusive range, ascending");
    // limit keeps the NEWEST rows of the range, still ascending
    let r = load_candles(&p, "rh_equity", "AAPL", "1m", 0, i64::MAX, 3).await.unwrap();
    assert_eq!(r.iter().map(|c| c.ts).collect::<Vec<_>>(), [7, 8, 9].map(|i| T0 + i * 60_000));
    assert!(load_candles(&p, "rh_equity", "AAPL", "1m", 0, 10, MAX_LOAD + 1).await.is_err());
    assert!(load_candles(&p, "rh_equity", "AAPL", "1m", 0, 10, 0).await.is_err());
    assert!(load_candles(&p, "rh_equity", "AAPL", "1m", 10, 5, 10).await.is_err(), "from > to");
    assert!(load_candles(&p, "rh_equity", "MSFT", "1m", 0, i64::MAX, 10).await.unwrap().is_empty());
}

#[tokio::test]
async fn snapshots_store_and_cap_size() {
    let p = db::open_memory().await.unwrap();
    store_snapshot(&p, "quote", "AAPL", r#"{"last":1.5}"#, 100).await.unwrap();
    store_snapshot(&p, "quote", "AAPL", r#"{"last":1.6}"#, 100).await.unwrap(); // same key+ts replaces
    store_snapshot(&p, "tm_levels", "AAPL", r#"{"levels":[1,2]}"#, 101).await.unwrap();
    assert_eq!(stats(&p).await.unwrap().snapshots, 2);
    let pad = "x".repeat(MAX_SNAPSHOT_JSON);
    let big = format!("{{\"a\":\"{pad}\"}}");
    assert!(big.len() > MAX_SNAPSHOT_JSON);
    assert!(matches!(store_snapshot(&p, "quote", "AAPL", &big, 102).await, Err(AppError::Invalid(_))));
    let edge = format!("{{\"a\":\"{}\"}}", "x".repeat(MAX_SNAPSHOT_JSON - 8));
    assert_eq!(edge.len(), MAX_SNAPSHOT_JSON);
    store_snapshot(&p, "quote", "AAPL", &edge, 103).await.unwrap();
    assert!(matches!(store_snapshot(&p, "quote", "AAPL", "not json", 104).await, Err(AppError::Invalid(_))));
    assert!(matches!(store_snapshot(&p, "Quote!", "AAPL", "{}", 104).await, Err(AppError::Invalid(_))));
    assert!(matches!(store_snapshot(&p, "quote", "A A", "{}", 104).await, Err(AppError::Invalid(_))));
    assert!(matches!(store_snapshot(&p, "quote", "AAPL", "{}", -1).await, Err(AppError::Invalid(_))));
    assert_eq!(stats(&p).await.unwrap().snapshots, 3);
}

#[tokio::test]
async fn stats_reports_counts_and_size() {
    let p = db::open_memory().await.unwrap();
    let s = stats(&p).await.unwrap();
    assert_eq!((s.candles, s.snapshots), (0, 0));
    assert!(s.db_bytes > 0, "page_count x page_size");
    store_candles(&p, "rh_equity", "AAPL", "1D", &[bar(T0, 11.0)], 1).await.unwrap();
    assert_eq!(stats(&p).await.unwrap().candles, 1);
}

#[test]
fn now_is_sane() {
    assert!(now_ms() > 1_700_000_000_000);
}
