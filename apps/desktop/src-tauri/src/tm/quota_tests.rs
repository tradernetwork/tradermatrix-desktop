//! M20a tasks 1 and 2: the quota gate (pure, driven by a fake clock), the day counter on disk, and migration 0006.
//! No network and no real key anywhere in here.
use super::quota::{self, Admit, Budgets, DayRow, DenyKind, Gate, Priority, Signal};
use crate::db;

const MIN: i64 = 60_000;

fn t0() -> i64 {
    quota::utc_ms(2026, 11, 11, 15, 0, 0)
}

fn gate(per_min: u32, per_day: u32) -> Gate {
    Gate::new(Budgets { per_min, per_day })
}

fn is_go(a: &Admit) -> bool {
    matches!(a, Admit::Go)
}

/// Sends per sliding 60 s window never exceed `cap`.
fn max_in_any_window(sent: &[i64]) -> usize {
    sent.iter().map(|&t| sent.iter().filter(|&&s| s > t - MIN && s <= t).count()).max().unwrap_or(0)
}

// ---------------------------------------------------------------- helpers

#[test]
fn utc_helpers_round_trip() {
    let t = quota::utc_ms(2026, 11, 11, 15, 30, 5);
    assert_eq!(quota::iso_utc(t), "2026-11-11T15:30:05Z");
    assert_eq!(quota::day_string(t), "2026-11-11");
    assert_eq!(quota::iso_utc(quota::next_midnight_ms(t)), "2026-11-12T00:00:00Z");
    // exactly at midnight the NEXT midnight is a full day later
    let m = quota::utc_ms(2026, 12, 31, 0, 0, 0);
    assert_eq!(quota::iso_utc(quota::next_midnight_ms(m)), "2027-01-01T00:00:00Z");
    assert_eq!(quota::day_string(quota::utc_ms(2028, 2, 29, 23, 59, 59)), "2028-02-29");
    assert_eq!(quota::iso_utc(0), "1970-01-01T00:00:00Z");
}

#[test]
fn budgets_validate_and_default() {
    assert_eq!(Budgets::default(), Budgets { per_min: 10, per_day: 200 });
    assert!(Budgets::validate(10, 200).is_ok());
    assert!(Budgets::validate(12, 10_000).is_ok());
    assert!(Budgets::validate(1, 1).is_ok());
    for (m, d) in [(0, 200), (13, 200), (10, 0), (10, 10_001)] {
        assert!(Budgets::validate(m, d).is_err(), "{m} {d}");
    }
}

#[test]
fn server_messages_are_recognised_exactly_and_the_limit_is_parsed() {
    use Signal::*;
    assert_eq!(quota::signal_from_text("Daily limit reached"), Some(DailyLimit(None)));
    assert_eq!(quota::signal_from_text("daily limit reached. Resets at midnight UTC."), Some(DailyLimit(None)));
    assert_eq!(quota::signal_from_text("Daily limit reached (25 calls/day on the free plan)"), Some(DailyLimit(Some(25))));
    assert_eq!(quota::signal_from_text("Daily limit reached: 200 tool calls per day"), Some(DailyLimit(Some(200))));
    assert_eq!(quota::signal_from_text("Slow down"), Some(SlowDown));
    assert_eq!(quota::signal_from_text("Slow down: 12 tool calls per minute"), Some(SlowDown));
    assert_eq!(quota::signal_from_text("TraderMatrix is busy"), Some(Busy));
    // not budget signals
    assert_eq!(quota::signal_from_text("Premium feature"), None);
    assert_eq!(quota::signal_from_text("unknown tool"), None);
    assert_eq!(quota::signal_from_text(""), None);
}

// ---------------------------------------------------------------- Review Focus 1: the per-minute wall

#[test]
fn a_burst_of_30_interactive_calls_never_sends_more_than_10_in_any_60s_window() {
    let mut g = gate(10, 10_000);
    let mut sent: Vec<i64> = vec![];
    let mut denied = 0;
    let mut now = t0();
    // three bursts of 30, a minute apart
    for _burst in 0..3 {
        for _ in 0..30 {
            match g.try_acquire(now, Priority::Interactive) {
                Admit::Go => sent.push(now),
                Admit::Wait { until_ms } => {
                    assert!(until_ms > now && until_ms - now <= 20_000, "interactive waits are capped at 20 s");
                    now = until_ms;
                    // re-check after the wait; it must be admitted now
                    assert!(is_go(&g.try_acquire(now, Priority::Interactive)));
                    sent.push(now);
                }
                Admit::Deny { kind, .. } => {
                    assert_eq!(kind, DenyKind::Throttled);
                    denied += 1;
                }
            }
        }
        now += MIN + 1;
    }
    assert_eq!(sent.len(), 30, "10 per burst");
    assert_eq!(denied, 60);
    assert!(max_in_any_window(&sent) <= 10, "window max {}", max_in_any_window(&sent));
}

#[test]
fn background_calls_wait_their_turn_and_leave_two_slots_per_minute_for_the_symbol_on_screen() {
    let mut g = gate(10, 10_000);
    let mut sent: Vec<i64> = vec![];
    let mut now = t0();
    for _ in 0..30 {
        loop {
            match g.try_acquire(now, Priority::Background) {
                Admit::Go => {
                    sent.push(now);
                    break;
                }
                Admit::Wait { until_ms } => now = until_ms,
                Admit::Deny { kind, .. } => panic!("background should wait, not be denied: {kind:?}"),
            }
        }
    }
    assert_eq!(sent.len(), 30);
    assert!(max_in_any_window(&sent) <= 8, "background stays 2 under the cap: {}", max_in_any_window(&sent));
    // the 2 reserved slots are still there for an interactive call at the very moment a background burst has filled its share
    let mut g = gate(10, 10_000);
    for _ in 0..8 {
        assert!(is_go(&g.try_acquire(t0(), Priority::Background)));
    }
    assert!(matches!(g.try_acquire(t0(), Priority::Background), Admit::Wait { .. }));
    assert!(is_go(&g.try_acquire(t0(), Priority::Interactive)));
    assert!(is_go(&g.try_acquire(t0(), Priority::Interactive)));
    assert!(matches!(g.try_acquire(t0(), Priority::Interactive), Admit::Deny { kind: DenyKind::Throttled, .. }));
}

#[test]
fn the_eleventh_call_inside_a_minute_waits_only_when_the_wait_is_short() {
    let mut g = gate(10, 10_000);
    assert!(is_go(&g.try_acquire(t0(), Priority::Interactive)));
    for _ in 0..9 {
        assert!(is_go(&g.try_acquire(t0() + 45_000, Priority::Interactive)));
    }
    // at +50 s the oldest send leaves the window at +60 s: a 10 s wait
    assert_eq!(g.try_acquire(t0() + 50_000, Priority::Interactive), Admit::Wait { until_ms: t0() + MIN });
    // at +30 s it would be a 30 s wait: denied
    let mut g2 = gate(10, 10_000);
    for _ in 0..10 {
        assert!(is_go(&g2.try_acquire(t0(), Priority::Interactive)));
    }
    match g2.try_acquire(t0() + 30_000, Priority::Interactive) {
        Admit::Deny { kind: DenyKind::Throttled, until_ms, message } => {
            assert_eq!(until_ms, t0() + MIN);
            assert!(message.starts_with("TM throttled until 2026-11-11T15:01:00Z"), "{message}");
        }
        other => panic!("{other:?}"),
    }
    // exactly at +60 s the slot is free again
    assert!(is_go(&g2.try_acquire(t0() + MIN, Priority::Interactive)));
}

#[test]
fn opportunistic_calls_are_dropped_instead_of_waiting() {
    let mut g = gate(10, 10_000);
    for _ in 0..8 {
        assert!(is_go(&g.try_acquire(t0(), Priority::Opportunistic)));
    }
    assert!(matches!(g.try_acquire(t0(), Priority::Opportunistic), Admit::Deny { kind: DenyKind::Throttled, .. }));
}

// ---------------------------------------------------------------- daily budget

#[test]
fn the_daily_budget_is_a_hard_stop_until_the_utc_day_rolls_over() {
    let mut g = gate(12, 5);
    let mut now = t0();
    for _ in 0..5 {
        assert!(is_go(&g.try_acquire(now, Priority::Interactive)));
        now += MIN; // never a per-minute problem
    }
    match g.try_acquire(now, Priority::Interactive) {
        Admit::Deny { kind: DenyKind::DailyExhausted, until_ms, message } => {
            assert_eq!(until_ms, quota::utc_ms(2026, 11, 12, 0, 0, 0));
            assert!(message.starts_with("TM paused until 2026-11-12T00:00:00Z"), "{message}");
        }
        other => panic!("{other:?}"),
    }
    let s = g.status(now);
    assert!(s.paused && s.used == 5 && s.limit == 5 && s.remaining == 0);
    assert_eq!(s.paused_until_ms, Some(quota::utc_ms(2026, 11, 12, 0, 0, 0)));
    // all priorities stay stopped
    for p in [Priority::Background, Priority::Opportunistic] {
        assert!(matches!(g.try_acquire(now, p), Admit::Deny { .. }));
    }
    // 1 ms before midnight: still stopped. At midnight: counter resets and the call goes.
    assert!(matches!(g.try_acquire(quota::utc_ms(2026, 11, 12, 0, 0, 0) - 1, Priority::Interactive), Admit::Deny { .. }));
    assert!(is_go(&g.try_acquire(quota::utc_ms(2026, 11, 12, 0, 0, 0), Priority::Interactive)));
    let s = g.status(quota::utc_ms(2026, 11, 12, 0, 0, 0));
    assert_eq!((s.used, s.paused, s.day.as_str()), (1, false, "2026-11-12"));
}

#[test]
fn background_and_opportunistic_calls_are_dropped_under_20_percent_remaining() {
    let mut g = gate(12, 100);
    g.restore(t0(), DayRow { day: quota::day_string(t0()), used: 80, limit_seen: None, paused: false });
    // 20 left = exactly 20%: still allowed
    assert!(is_go(&g.try_acquire(t0(), Priority::Background)));
    // 19 left: below 20%, dropped (not queued) with the reason
    match g.try_acquire(t0() + MIN, Priority::Background) {
        Admit::Deny { kind: DenyKind::LowBudget, message, .. } => assert!(message.contains("19") && message.starts_with("TM paused"), "{message}"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(g.try_acquire(t0() + MIN, Priority::Opportunistic), Admit::Deny { kind: DenyKind::LowBudget, .. }));
    // the symbol on screen still gets the rest
    for i in 0..19 {
        assert!(is_go(&g.try_acquire(t0() + (i + 2) * MIN, Priority::Interactive)), "{i}");
    }
    assert!(matches!(g.try_acquire(t0() + 30 * MIN, Priority::Interactive), Admit::Deny { kind: DenyKind::DailyExhausted, .. }));
}

// ---------------------------------------------------------------- learning

#[test]
fn daily_limit_reached_jumps_the_counter_to_the_limit_and_pauses_until_rollover() {
    let mut g = gate(10, 200);
    for _ in 0..3 {
        assert!(is_go(&g.try_acquire(t0(), Priority::Interactive)));
    }
    g.learn(t0() + 5, Signal::DailyLimit(None));
    let s = g.status(t0() + 5);
    assert_eq!((s.used, s.limit, s.paused), (200, 200, true));
    assert!(matches!(g.try_acquire(t0() + 10, Priority::Interactive), Admit::Deny { kind: DenyKind::DailyExhausted, .. }));
    // tomorrow it is clean again
    assert!(is_go(&g.try_acquire(quota::utc_ms(2026, 11, 12, 0, 0, 1), Priority::Interactive)));
    let s = g.status(quota::utc_ms(2026, 11, 12, 0, 0, 1));
    assert_eq!((s.used, s.paused, s.limit_seen), (1, false, None));
}

#[test]
fn a_smaller_server_limit_is_learned_and_a_larger_one_never_beats_the_users_setting() {
    let mut g = gate(10, 200);
    g.learn(t0(), Signal::DailyLimit(Some(25)));
    let s = g.status(t0());
    assert_eq!((s.limit_seen, s.limit, s.used, s.paused), (Some(25), 25, 25, true));
    let mut g = gate(10, 200);
    g.learn(t0(), Signal::DailyLimit(Some(500)));
    let s = g.status(t0());
    assert_eq!((s.limit, s.used), (200, 200), "never guessed higher than the user's setting");
    // a learned 25 also caps later calls the same day, before the server says no again
    let mut g = gate(10, 200);
    g.restore(t0(), DayRow { day: quota::day_string(t0()), used: 24, limit_seen: Some(25), paused: false });
    assert!(is_go(&g.try_acquire(t0(), Priority::Interactive)));
    assert!(matches!(g.try_acquire(t0() + MIN, Priority::Interactive), Admit::Deny { kind: DenyKind::DailyExhausted, .. }));
}

#[test]
fn slow_down_backs_off_60_seconds_and_busy_30() {
    let mut g = gate(10, 200);
    g.learn(t0(), Signal::SlowDown);
    // interactive: a 60 s wait is over the 20 s cap, so it is denied with the time
    match g.try_acquire(t0() + 1_000, Priority::Interactive) {
        Admit::Deny { kind: DenyKind::Throttled, until_ms, .. } => assert_eq!(until_ms, t0() + MIN),
        other => panic!("{other:?}"),
    }
    // background waits it out
    assert_eq!(g.try_acquire(t0() + 1_000, Priority::Background), Admit::Wait { until_ms: t0() + MIN });
    assert!(is_go(&g.try_acquire(t0() + MIN, Priority::Interactive)));
    let mut g = gate(10, 200);
    g.learn(t0(), Signal::Busy);
    assert_eq!(g.try_acquire(t0() + 15_000, Priority::Interactive), Admit::Wait { until_ms: t0() + 30_000 });
    assert!(is_go(&g.try_acquire(t0() + 30_000, Priority::Interactive)));
    // the backoff shows in the status
    let mut g = gate(10, 200);
    g.learn(t0(), Signal::SlowDown);
    assert_eq!(g.status(t0() + 1).throttled_until_ms, Some(t0() + MIN));
    assert_eq!(g.status(t0() + MIN + 1).throttled_until_ms, None);
}

#[test]
fn changing_the_budgets_takes_effect_at_once() {
    let mut g = gate(10, 200);
    g.set_budgets(Budgets { per_min: 2, per_day: 200 });
    assert!(is_go(&g.try_acquire(t0(), Priority::Interactive)));
    assert!(is_go(&g.try_acquire(t0(), Priority::Interactive)));
    assert!(matches!(g.try_acquire(t0(), Priority::Interactive), Admit::Deny { .. }));
    g.set_budgets(Budgets { per_min: 10, per_day: 2 });
    assert!(matches!(g.try_acquire(t0() + MIN, Priority::Interactive), Admit::Deny { kind: DenyKind::DailyExhausted, .. }));
}

#[test]
fn restore_ignores_a_row_from_another_day() {
    let mut g = gate(10, 200);
    g.restore(t0(), DayRow { day: "2026-11-10".into(), used: 150, limit_seen: Some(25), paused: true });
    let s = g.status(t0());
    assert_eq!((s.used, s.paused, s.limit_seen), (0, false, None));
    g.restore(t0(), DayRow { day: "2026-11-11".into(), used: 37, limit_seen: None, paused: false });
    assert_eq!(g.status(t0()).used, 37);
    assert_eq!(g.day_row(t0()), DayRow { day: "2026-11-11".into(), used: 37, limit_seen: None, paused: false });
}

#[test]
fn status_numbers_for_the_header_chip() {
    let mut g = gate(10, 200);
    g.restore(t0(), DayRow { day: "2026-11-11".into(), used: 37, limit_seen: None, paused: false });
    for _ in 0..3 {
        g.try_acquire(t0(), Priority::Interactive);
    }
    let s = g.status(t0());
    assert_eq!((s.used, s.limit, s.remaining, s.per_min, s.per_day, s.window_used), (40, 200, 160, 10, 200, 3));
    assert!(!s.paused && !s.preview && s.throttled_until_ms.is_none() && s.now_ms == t0());
    g.note_preview();
    assert!(g.status(t0()).preview);
    // preview is a today-fact too
    assert!(!g.status(quota::utc_ms(2026, 11, 12, 0, 0, 0)).preview);
    // the sliding window empties after a minute
    assert_eq!(g.status(t0() + MIN + 1).window_used, 0);
}

// ---------------------------------------------------------------- persistence + migration

#[tokio::test]
async fn the_day_row_and_budgets_round_trip_and_garbage_falls_back_to_defaults() {
    let p = db::open_memory().await.unwrap();
    assert_eq!(quota::load_budgets(&p).await, Budgets::default());
    assert_eq!(quota::load_day(&p, "2026-11-11").await.unwrap(), None);
    quota::save_budgets(&p, &Budgets { per_min: 6, per_day: 80 }).await.unwrap();
    assert_eq!(quota::load_budgets(&p).await, Budgets { per_min: 6, per_day: 80 });
    let row = DayRow { day: "2026-11-11".into(), used: 37, limit_seen: Some(25), paused: true };
    quota::save_day(&p, &row).await.unwrap();
    assert_eq!(quota::load_day(&p, "2026-11-11").await.unwrap(), Some(row.clone()));
    let upd = DayRow { used: 38, paused: false, limit_seen: None, ..row };
    quota::save_day(&p, &upd).await.unwrap();
    assert_eq!(quota::load_day(&p, "2026-11-11").await.unwrap(), Some(upd));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tm_quota").fetch_one(&p).await.unwrap();
    assert_eq!(n, 1);
    for bad in ["not json", "{\"per_min\":99,\"per_day\":0}", "[]", "{\"per_min\":\"x\"}"] {
        db::setting_set(&p, quota::BUDGETS_SETTING, bad).await.unwrap();
        assert_eq!(quota::load_budgets(&p).await, Budgets::default(), "{bad}");
    }
}

#[tokio::test]
async fn migration_0006_is_purely_additive_and_existing_data_survives() {
    let sql = include_str!("../../migrations/0006_tm_quota.sql").to_uppercase();
    for banned in ["DROP ", "ALTER ", "DELETE FROM", "UPDATE ", "INSERT "] {
        assert!(!sql.contains(banned), "0006 must be additive only: {banned}");
    }
    // an app database that already has migrations 0001-0005 applied (with data in them) gets 0006 on the next launch
    let dir = std::env::temp_dir().join(format!("rebull-mig6-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("old.db");
    let _ = std::fs::remove_file(&path);
    let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();
    let mut old = sqlx::migrate!("./migrations");
    old.migrations = std::borrow::Cow::Owned(old.migrations.iter().filter(|m| m.version <= 5).cloned().collect());
    old.run(&pool).await.unwrap();
    db::layout_save(&pool, "Main", r#"{"a":1}"#).await.unwrap();
    db::setting_set(&pool, "chat.mode", "\"trader\"").await.unwrap();
    sqlx::query("INSERT INTO candles (source, instrument, interval, ts, open, high, low, close, volume, fetched_at) VALUES ('rh','AAPL','15m',1700000000000,1,2,0.5,1.5,10,1)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO alerts (symbol, kind, ref_kind, price, dir, mode, \"repeat\", created_at) VALUES ('AAPL','price','fixed',100,'above','close','once',1)").execute(&pool).await.unwrap();
    let has: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'tm_quota'").fetch_one(&pool).await.unwrap();
    assert_eq!(has, 0);
    drop(pool);
    let pool = db::open(&path).await.unwrap();
    assert_eq!(db::layout_load(&pool, "Main").await.unwrap().as_deref(), Some(r#"{"a":1}"#));
    assert_eq!(db::setting_get(&pool, "chat.mode").await.unwrap().as_deref(), Some("\"trader\""));
    for (t, n) in [("candles", 1), ("alerts", 1), ("tm_quota", 0)] {
        let c: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {t}")).fetch_one(&pool).await.unwrap();
        assert_eq!(c, n, "{t}");
    }
    let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('tm_quota') ORDER BY cid").fetch_all(&pool).await.unwrap();
    assert_eq!(cols, ["day", "used", "limit_seen", "paused"]);
    // the table works on the migrated file and a second open is a no-op
    quota::save_day(&pool, &DayRow { day: "2026-11-11".into(), used: 3, limit_seen: None, paused: false }).await.unwrap();
    drop(pool);
    let pool = db::open(&path).await.unwrap();
    assert_eq!(quota::load_day(&pool, "2026-11-11").await.unwrap().map(|r| r.used), Some(3));
    let _ = std::fs::remove_dir_all(&dir);
}
