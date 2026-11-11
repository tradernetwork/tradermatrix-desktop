//! M17 tasks 1 and 3: alert storage, validation, the migration over populated data, and the transactional single-fire guard
//! (cooldown, hysteresis re-arm, once alerts, two callers at once). Local SQLite only: no network, no keys.
use sqlx::SqlitePool;

use crate::alerts::{self as al, AlertPatch, FireOutcome, NewAlert};
use crate::db;
use crate::error::AppError;

const T0: i64 = 1_800_000_000_000;

fn new_alert() -> NewAlert {
    serde_json::from_str(r#"{"symbol":"aapl","kind":"price","ref_kind":"price","price":100.0,"dir":"up","mode":"cross","repeat":"once"}"#).unwrap()
}

fn rearm_alert() -> NewAlert {
    NewAlert { repeat: "rearm".into(), ..new_alert() }
}

async fn mem() -> SqlitePool {
    db::open_memory().await.unwrap()
}

async fn event_count(p: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM alert_events").fetch_one(p).await.unwrap()
}

fn fired(o: &FireOutcome) -> bool {
    matches!(o, FireOutcome::Fired { .. })
}

fn skipped_reason(o: &FireOutcome) -> String {
    match o {
        FireOutcome::Skipped { reason } => reason.clone(),
        FireOutcome::Fired { .. } => panic!("expected skipped"),
    }
}

// ---------------------------------------------------------------- task 1: CRUD + validation

#[tokio::test]
async fn insert_list_update_delete_round_trip() {
    let p = mem().await;
    let a = al::create(&p, T0, new_alert()).await.unwrap();
    assert_eq!((a.symbol.as_str(), a.kind.as_str(), a.ref_kind.as_str(), a.price, a.dir.as_str(), a.mode.as_str(), a.repeat.as_str()), ("AAPL", "price", "price", 100.0, "up", "cross", "once"));
    // defaults from the schema
    assert_eq!((a.cooldown_s, a.hysteresis_pct, a.enabled, a.extended_hours, a.armed, a.created_at), (300, 0.05, true, false, true, T0));
    assert_eq!((a.last_side, a.last_fired_at, a.snooze_until, a.expires_at, a.ref_param.as_deref(), a.tf.as_deref()), (None, None, None, None, None, None));
    let b = al::create(&p, T0 + 1, NewAlert { symbol: "MSFT".into(), price: 400.5, dir: "either".into(), ..new_alert() }).await.unwrap();
    let list = al::list(&p).await.unwrap();
    assert_eq!(list.iter().map(|x| x.id).collect::<Vec<_>>(), vec![a.id, b.id]);

    let u = al::update(&p, T0, a.id, AlertPatch { price: Some(101.5), enabled: Some(false), cooldown_s: Some(60), hysteresis_pct: Some(0.5), snooze_until: Some(T0 + 900_000), extended_hours: Some(true), ..Default::default() }).await.unwrap();
    assert_eq!((u.price, u.enabled, u.cooldown_s, u.hysteresis_pct, u.snooze_until, u.extended_hours), (101.5, false, 60, 0.5, Some(T0 + 900_000), true));
    // clearing a snooze: 0 is "not snoozed"
    let u = al::update(&p, T0, a.id, AlertPatch { snooze_until: Some(0), ..Default::default() }).await.unwrap();
    assert_eq!(u.snooze_until, Some(0));
    assert!(matches!(al::update(&p, T0, 9999, AlertPatch::default()).await, Err(AppError::NotFound(_))));

    al::delete(&p, a.id).await.unwrap();
    assert_eq!(al::list(&p).await.unwrap().len(), 1);
    assert!(matches!(al::delete(&p, a.id).await, Err(AppError::NotFound(_))));
}

#[tokio::test]
async fn bad_rows_are_rejected_and_store_nothing() {
    let p = mem().await;
    let bad: Vec<(&str, NewAlert)> = vec![
        ("empty symbol", NewAlert { symbol: "".into(), ..new_alert() }),
        ("symbol with space", NewAlert { symbol: "AA PL".into(), ..new_alert() }),
        ("symbol too long", NewAlert { symbol: "ABCDEFGHIJKLM".into(), ..new_alert() }),
        ("symbol with quote", NewAlert { symbol: "A';--".into(), ..new_alert() }),
        ("price zero", NewAlert { price: 0.0, ..new_alert() }),
        ("price negative", NewAlert { price: -1.0, ..new_alert() }),
        ("price nan", NewAlert { price: f64::NAN, ..new_alert() }),
        ("price inf", NewAlert { price: f64::INFINITY, ..new_alert() }),
        ("bad kind", NewAlert { kind: "order_now".into(), ..new_alert() }),
        ("bad ref_kind", NewAlert { ref_kind: "place".into(), ..new_alert() }),
        ("bad dir", NewAlert { dir: "sideways".into(), ..new_alert() }),
        ("bad mode", NewAlert { mode: "tickle".into(), ..new_alert() }),
        ("bad repeat", NewAlert { repeat: "forever".into(), ..new_alert() }),
        ("cooldown negative", NewAlert { cooldown_s: Some(-1), ..new_alert() }),
        ("cooldown 86401", NewAlert { cooldown_s: Some(86_401), ..new_alert() }),
        ("hysteresis negative", NewAlert { hysteresis_pct: Some(-0.01), ..new_alert() }),
        ("hysteresis 5.01", NewAlert { hysteresis_pct: Some(5.01), ..new_alert() }),
        ("hysteresis nan", NewAlert { hysteresis_pct: Some(f64::NAN), ..new_alert() }),
        ("ref_param too big", NewAlert { ref_kind: "apex".into(), ref_param: Some("x".repeat(257)), ..new_alert() }),
        ("ref_param control char", NewAlert { ref_kind: "apex".into(), ref_param: Some("45\n0".into()), ..new_alert() }),
        ("ref_param on a manual price alert", NewAlert { ref_param: Some("450".into()), ..new_alert() }),
        ("tf junk", NewAlert { tf: Some("15 m; DROP".into()), ..new_alert() }),
        ("last_side 2", NewAlert { last_side: Some(2), ..new_alert() }),
        ("expiry negative", NewAlert { expires_at: Some(-5), ..new_alert() }),
    ];
    for (why, n) in bad {
        assert!(matches!(al::create(&p, T0, n).await, Err(AppError::Invalid(_))), "{why}");
    }
    assert!(al::list(&p).await.unwrap().is_empty());
    // good edge values pass
    al::create(&p, T0, NewAlert { cooldown_s: Some(0), hysteresis_pct: Some(5.0), ..new_alert() }).await.unwrap();
    al::create(&p, T0, NewAlert { cooldown_s: Some(86_400), hysteresis_pct: Some(0.0), symbol: "BRK.B".into(), ..new_alert() }).await.unwrap();
    // updates validate too
    let a = al::list(&p).await.unwrap()[0].id;
    for patch in [
        AlertPatch { price: Some(0.0), ..Default::default() },
        AlertPatch { price: Some(f64::NAN), ..Default::default() },
        AlertPatch { dir: Some("nope".into()), ..Default::default() },
        AlertPatch { cooldown_s: Some(86_401), ..Default::default() },
        AlertPatch { hysteresis_pct: Some(6.0), ..Default::default() },
        AlertPatch { last_side: Some(3), ..Default::default() },
        AlertPatch { observe_px: Some(f64::INFINITY), ..Default::default() },
    ] {
        assert!(matches!(al::update(&p, T0, a, patch).await, Err(AppError::Invalid(_))));
    }
    // unknown JSON fields (a webview cannot smuggle an order or an account in) are refused at the boundary
    assert!(serde_json::from_str::<NewAlert>(r#"{"symbol":"AAPL","kind":"price","ref_kind":"price","price":1,"dir":"up","mode":"cross","repeat":"once","account":"123456789"}"#).is_err());
    assert!(serde_json::from_str::<AlertPatch>(r#"{"order":"buy"}"#).is_err());
}

#[tokio::test]
async fn the_alert_count_is_capped() {
    let p = mem().await;
    for _ in 0..al::MAX_ALERTS {
        al::create(&p, T0, new_alert()).await.unwrap();
    }
    assert!(matches!(al::create(&p, T0, new_alert()).await, Err(AppError::Invalid(_))));
}

#[tokio::test]
async fn rows_hold_no_account_secret_or_digest_columns() {
    let p = mem().await;
    for t in ["alerts", "alert_events"] {
        let cols: Vec<String> = sqlx::query_scalar(&format!("SELECT name FROM pragma_table_info('{t}')")).fetch_all(&p).await.unwrap();
        for c in &cols {
            for banned in ["account", "secret", "key", "token", "digest", "body", "note", "text"] {
                assert!(!c.contains(banned), "{t}.{c}");
            }
        }
    }
    let want_alerts = ["id", "symbol", "kind", "ref_kind", "ref_param", "price", "dir", "tf", "mode", "repeat", "cooldown_s", "hysteresis_pct", "expires_at", "snooze_until", "enabled", "extended_hours", "last_side", "armed", "last_fired_at", "created_at"];
    let got: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('alerts') ORDER BY cid").fetch_all(&p).await.unwrap();
    assert_eq!(got, want_alerts);
    let want_events = ["id", "alert_id", "fired_at", "symbol", "label", "trigger_px", "ref_px", "quote_age_s", "kind", "seen", "missed"];
    let got: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('alert_events') ORDER BY cid").fetch_all(&p).await.unwrap();
    assert_eq!(got, want_events);
}

#[tokio::test]
async fn migration_0005_is_purely_additive_and_existing_data_survives() {
    let sql = include_str!("../migrations/0005_alerts.sql").to_uppercase();
    for banned in ["DROP ", "ALTER ", "DELETE FROM", "UPDATE ", "INSERT "] {
        assert!(!sql.contains(banned), "0005 must be additive only: {banned}");
    }
    // an app database that already has migrations 0001-0004 applied (with data in them) gets 0005 on the next launch
    let dir = std::env::temp_dir().join(format!("rebull-mig5-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("old.db");
    let _ = std::fs::remove_file(&path);
    let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();
    let mut old = sqlx::migrate!("./migrations");
    old.migrations = std::borrow::Cow::Owned(old.migrations.iter().filter(|m| m.version <= 4).cloned().collect());
    old.run(&pool).await.unwrap();
    db::layout_save(&pool, "Main", r#"{"a":1}"#).await.unwrap();
    db::setting_set(&pool, "chat.mode", "\"trader\"").await.unwrap();
    sqlx::query("INSERT INTO candles (source, instrument, interval, ts, open, high, low, close, volume, fetched_at) VALUES ('rh','AAPL','15m',1700000000000,1,2,0.5,1.5,10,1)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO explain_threads (symbol, created_at, updated_at, title) VALUES ('AAPL', 1, 1, 'hello')").execute(&pool).await.unwrap();
    let has: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('alerts','alert_events')").fetch_one(&pool).await.unwrap();
    assert_eq!(has, 0);
    drop(pool);
    let pool = db::open(&path).await.unwrap();
    assert_eq!(db::layout_load(&pool, "Main").await.unwrap().as_deref(), Some(r#"{"a":1}"#));
    assert_eq!(db::setting_get(&pool, "chat.mode").await.unwrap().as_deref(), Some("\"trader\""));
    for (t, n) in [("candles", 1), ("explain_threads", 1), ("alerts", 0), ("alert_events", 0)] {
        let c: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {t}")).fetch_one(&pool).await.unwrap();
        assert_eq!(c, n, "{t}");
    }
    // the new tables work on the migrated file and a second open is a no-op
    al::create(&pool, T0, new_alert()).await.unwrap();
    drop(pool);
    let pool = db::open(&path).await.unwrap();
    assert_eq!(al::list(&pool).await.unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- task 3: alert_fire

#[tokio::test]
async fn fire_writes_one_event_with_the_trigger_and_the_level() {
    let p = mem().await;
    let a = al::create(&p, T0, new_alert()).await.unwrap();
    let o = al::fire(&p, T0 + 5, a.id, 1, 101.25, 1.5).await.unwrap();
    let FireOutcome::Fired { event: e } = o else { panic!("expected fired") };
    assert_eq!((e.alert_id, e.fired_at, e.symbol.as_str(), e.trigger_px, e.ref_px, e.quote_age_s, e.kind.as_str(), e.seen, e.missed), (a.id, T0 + 5, "AAPL", 101.25, 100.0, 1.5, "fire", false, false));
    assert!(e.label.contains("AAPL") && e.label.contains("100.00"), "{}", e.label);
    assert_eq!(event_count(&p).await, 1);
    let after = &al::list(&p).await.unwrap()[0];
    assert_eq!((after.last_fired_at, after.last_side), (Some(T0 + 5), Some(1)));
}

#[tokio::test]
async fn a_once_alert_disables_itself_and_cannot_fire_again() {
    let p = mem().await;
    let a = al::create(&p, T0, new_alert()).await.unwrap();
    assert!(fired(&al::fire(&p, T0, a.id, 1, 101.0, 0.0).await.unwrap()));
    let after = &al::list(&p).await.unwrap()[0];
    assert!(!after.enabled);
    let o = al::fire(&p, T0 + 10_000_000, a.id, -1, 99.0, 0.0).await.unwrap();
    assert_eq!(skipped_reason(&o), "disabled");
    assert_eq!(event_count(&p).await, 1);
}

#[tokio::test]
async fn cooldown_two_fires_200_s_apart_with_cooldown_300_make_one_event() {
    let p = mem().await;
    let a = al::create(&p, T0, NewAlert { cooldown_s: Some(300), ..rearm_alert() }).await.unwrap();
    assert!(fired(&al::fire(&p, T0, a.id, 1, 100.5, 0.0).await.unwrap()));
    // the price retreats far enough to re-arm, then crosses again 200 s after the first fire: the cooldown holds it back
    al::update(&p, T0 + 100_000, a.id, AlertPatch { observe_px: Some(99.0), ..Default::default() }).await.unwrap();
    assert!(al::list(&p).await.unwrap()[0].armed);
    let o = al::fire(&p, T0 + 200_000, a.id, 1, 100.6, 0.0).await.unwrap();
    assert_eq!(skipped_reason(&o), "cooldown");
    assert_eq!(event_count(&p).await, 1);
    // the skipped crossing still records the side, so a late fire for an old flip cannot happen
    assert_eq!(al::list(&p).await.unwrap()[0].last_side, Some(1));
    // exactly at the end of the cooldown it may fire again (last_fired_at <= now - cooldown)
    al::update(&p, T0 + 250_000, a.id, AlertPatch { observe_px: Some(99.0), ..Default::default() }).await.unwrap();
    assert_eq!(skipped_reason(&al::fire(&p, T0 + 299_999, a.id, 1, 100.7, 0.0).await.unwrap()), "cooldown");
    assert!(fired(&al::fire(&p, T0 + 300_000, a.id, 1, 100.7, 0.0).await.unwrap()));
    assert_eq!(event_count(&p).await, 2);
}

#[tokio::test]
async fn rearm_needs_a_retreat_of_hysteresis_pct_from_the_level() {
    let p = mem().await;
    // level 100, hysteresis 0.05% => the price must come back to 99.95 or lower
    let a = al::create(&p, T0, NewAlert { hysteresis_pct: Some(0.05), cooldown_s: Some(0), ..rearm_alert() }).await.unwrap();
    assert!(fired(&al::fire(&p, T0, a.id, 1, 100.2, 0.0).await.unwrap()));
    assert!(!al::list(&p).await.unwrap()[0].armed, "a rearm alert disarms when it fires");
    assert_eq!(skipped_reason(&al::fire(&p, T0 + 1, a.id, 1, 100.3, 0.0).await.unwrap()), "disarmed");
    let rearmed = |p: SqlitePool, px: f64| async move { al::update(&p, T0 + 2, a.id, AlertPatch { observe_px: Some(px), ..Default::default() }).await.unwrap().armed };
    assert!(!rearmed(p.clone(), 100.04).await, "100.04 does not re-arm");
    assert!(!rearmed(p.clone(), 100.0).await, "the level itself does not re-arm");
    assert!(!rearmed(p.clone(), 99.96).await, "99.96 is inside the band");
    assert!(rearmed(p.clone(), 99.90).await, "99.90 re-arms");
    // re-arming resets the side to the side the price is on, so the next rise through the level can fire
    assert_eq!(al::list(&p).await.unwrap()[0].last_side, Some(-1));
    assert!(fired(&al::fire(&p, T0 + 3, a.id, 1, 100.1, 0.0).await.unwrap()));
    assert_eq!(event_count(&p).await, 2);
}

#[tokio::test]
async fn a_down_alert_rearms_above_the_level() {
    let p = mem().await;
    let a = al::create(&p, T0, NewAlert { dir: "down".into(), hysteresis_pct: Some(0.05), cooldown_s: Some(0), ..rearm_alert() }).await.unwrap();
    assert!(fired(&al::fire(&p, T0, a.id, -1, 99.8, 0.0).await.unwrap()));
    let obs = |px: f64| al::update(&p, T0 + 1, a.id, AlertPatch { observe_px: Some(px), ..Default::default() });
    assert!(!obs(100.04).await.unwrap().armed);
    assert!(obs(100.06).await.unwrap().armed);
}

#[tokio::test]
async fn observing_never_rearms_a_disabled_or_once_alert() {
    let p = mem().await;
    let a = al::create(&p, T0, new_alert()).await.unwrap();
    al::fire(&p, T0, a.id, 1, 101.0, 0.0).await.unwrap();
    let u = al::update(&p, T0 + 1, a.id, AlertPatch { observe_px: Some(50.0), ..Default::default() }).await.unwrap();
    assert!(!u.enabled);
    assert!(u.armed, "a once alert never uses the armed flag");
    assert_eq!(skipped_reason(&al::fire(&p, T0 + 2, a.id, 1, 101.0, 0.0).await.unwrap()), "disabled");
}

#[tokio::test]
async fn two_callers_firing_the_same_alert_at_once_make_exactly_one_event() {
    // a real file database (4 connections) so the two calls genuinely race
    let dir = std::env::temp_dir().join(format!("rebull-fire-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("race.db");
    let _ = std::fs::remove_file(&path);
    let p = db::open(&path).await.unwrap();
    for round in 0..20 {
        let a = al::create(&p, T0, new_alert()).await.unwrap();
        let (p1, p2) = (p.clone(), p.clone());
        let id = a.id;
        let h1 = tokio::spawn(async move { al::fire(&p1, T0 + 1, id, 1, 101.0, 0.0).await });
        let h2 = tokio::spawn(async move { al::fire(&p2, T0 + 1, id, 1, 101.0, 0.0).await });
        let (r1, r2) = (h1.await.unwrap().unwrap(), h2.await.unwrap().unwrap());
        assert_eq!([&r1, &r2].iter().filter(|o| fired(o)).count(), 1, "round {round}");
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM alert_events WHERE alert_id = ?1").bind(id).fetch_one(&p).await.unwrap();
        assert_eq!(n, 1, "round {round}");
    }
    drop(p);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn fire_is_skipped_while_snoozed_expired_or_missing_and_still_records_the_side() {
    let p = mem().await;
    let a = al::create(&p, T0, NewAlert { expires_at: Some(T0 + 1_000_000), ..rearm_alert() }).await.unwrap();
    al::update(&p, T0, a.id, AlertPatch { snooze_until: Some(T0 + 900_000), ..Default::default() }).await.unwrap();
    assert_eq!(skipped_reason(&al::fire(&p, T0 + 1, a.id, 1, 101.0, 0.0).await.unwrap()), "snoozed");
    assert_eq!(al::list(&p).await.unwrap()[0].last_side, Some(1));
    // the snooze has passed: it fires
    let b = al::create(&p, T0, NewAlert { expires_at: Some(T0 + 1_000_000), ..rearm_alert() }).await.unwrap();
    al::update(&p, T0, b.id, AlertPatch { snooze_until: Some(T0 + 900_000), ..Default::default() }).await.unwrap();
    assert!(fired(&al::fire(&p, T0 + 900_000, b.id, 1, 101.0, 0.0).await.unwrap()));
    // expired
    assert_eq!(skipped_reason(&al::fire(&p, T0 + 1_000_000, a.id, 1, 101.0, 0.0).await.unwrap()), "expired");
    assert_eq!(skipped_reason(&al::fire(&p, T0, 424242, 1, 101.0, 0.0).await.unwrap()), "missing");
    // bad inputs
    assert!(matches!(al::fire(&p, T0, a.id, 2, 101.0, 0.0).await, Err(AppError::Invalid(_))));
    assert!(matches!(al::fire(&p, T0, a.id, 1, f64::NAN, 0.0).await, Err(AppError::Invalid(_))));
    assert!(matches!(al::fire(&p, T0, a.id, 1, 101.0, -1.0).await, Err(AppError::Invalid(_))));
}

#[tokio::test]
async fn a_drag_resets_the_side_so_the_next_fire_needs_a_real_crossing() {
    // Review focus 1, storage half: the webview rewrites price AND last_side in ONE update; nothing fires from it.
    let p = mem().await;
    let a = al::create(&p, T0, NewAlert { last_side: Some(-1), ..new_alert() }).await.unwrap();
    let u = al::update(&p, T0, a.id, AlertPatch { price: Some(90.0), last_side: Some(1), ..Default::default() }).await.unwrap();
    assert_eq!((u.price, u.last_side), (90.0, Some(1)));
    assert_eq!(event_count(&p).await, 0);
}

// ---------------------------------------------------------------- events

#[tokio::test]
async fn events_list_newest_first_unseen_filter_ack_and_survive_alert_deletion() {
    let p = mem().await;
    let a = al::create(&p, T0, NewAlert { cooldown_s: Some(0), ..rearm_alert() }).await.unwrap();
    for i in 0..3 {
        al::fire(&p, T0 + i * 1000, a.id, 1, 101.0 + i as f64, 0.0).await.unwrap();
        al::update(&p, T0 + i * 1000 + 1, a.id, AlertPatch { observe_px: Some(90.0), ..Default::default() }).await.unwrap();
    }
    let all = al::events(&p, None, false).await.unwrap();
    assert_eq!(all.len(), 3);
    assert!(all.windows(2).all(|w| w[0].fired_at > w[1].fired_at), "newest first");
    assert_eq!(al::events(&p, Some(2), false).await.unwrap().len(), 2);
    assert_eq!(al::events(&p, None, true).await.unwrap().len(), 3);
    // ack one id, then all
    assert_eq!(al::ack(&p, Some(vec![all[0].id])).await.unwrap(), 1);
    assert_eq!(al::events(&p, None, true).await.unwrap().len(), 2);
    assert_eq!(al::ack(&p, Some(vec![all[0].id])).await.unwrap(), 0, "already seen");
    assert_eq!(al::ack(&p, None).await.unwrap(), 2);
    assert!(al::events(&p, None, true).await.unwrap().is_empty());
    assert!(matches!(al::ack(&p, Some(vec![1; 501])).await, Err(AppError::Invalid(_))));
    // deleting the alert keeps its history
    al::delete(&p, a.id).await.unwrap();
    assert_eq!(al::events(&p, None, false).await.unwrap().len(), 3);
}

#[tokio::test]
async fn event_history_is_capped_and_the_oldest_go_first() {
    let p = mem().await;
    let a = al::create(&p, T0, NewAlert { cooldown_s: Some(0), ..rearm_alert() }).await.unwrap();
    for i in 0..(al::MAX_EVENTS + 5) {
        sqlx::query("UPDATE alerts SET armed = 1, enabled = 1").execute(&p).await.unwrap();
        al::fire(&p, T0 + i, a.id, 1, 101.0, 0.0).await.unwrap();
    }
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM alert_events").fetch_one(&p).await.unwrap();
    assert_eq!(n, al::MAX_EVENTS);
    let oldest: i64 = sqlx::query_scalar("SELECT MIN(fired_at) FROM alert_events").fetch_one(&p).await.unwrap();
    assert_eq!(oldest, T0 + 5);
}

// ---------------------------------------------------------------- M17b: event kinds, labels, missed, level gone, notice text

use crate::alert_commands::clean_notice;
use crate::alerts::FireExtra;

fn extra(kind: Option<&str>, label: Option<&str>, missed: bool) -> FireExtra {
    FireExtra { kind: kind.map(String::from), label: label.map(String::from), missed }
}

#[tokio::test]
async fn fire_ex_takes_a_caller_label_and_keeps_the_fire_guard() {
    let p = mem().await;
    let a = al::create(&p, T0, new_alert()).await.unwrap();
    let o = al::fire_ex(&p, T0, a.id, 1, 100.5, 1.0, extra(None, Some("AAPL verdict: protected to exposed"), false)).await.unwrap();
    let FireOutcome::Fired { event } = o else { panic!("fired") };
    assert_eq!((event.label.as_str(), event.kind.as_str(), event.missed), ("AAPL verdict: protected to exposed", "fire", false));
    // the once-alert is spent: same guard as plain fire
    assert_eq!(skipped_reason(&al::fire_ex(&p, T0 + 1, a.id, 1, 100.5, 1.0, extra(None, None, false)).await.unwrap()), "disabled");
}

#[tokio::test]
async fn a_missed_event_is_stored_with_missed_1_and_kind_missed() {
    let p = mem().await;
    let a = al::create(&p, T0, new_alert()).await.unwrap();
    let o = al::fire_ex(&p, T0, a.id, 1, 101.0, 0.0, extra(Some("missed"), Some("AAPL crossed above 100.00 while you were away"), true)).await.unwrap();
    let FireOutcome::Fired { event } = o else { panic!("fired") };
    assert_eq!((event.missed, event.kind.as_str()), (true, "missed"));
    assert_eq!(event_count(&p).await, 1);
}

#[tokio::test]
async fn level_gone_snoozes_the_alert_and_writes_exactly_one_event() {
    let p = mem().await;
    let a = al::create(&p, T0, NewAlert { ref_kind: "apex".into(), ref_param: Some("rank:2".into()), repeat: "rearm".into(), ..new_alert() }).await.unwrap();
    let o = al::fire_ex(&p, T0, a.id, 0, 450.0, 0.0, extra(Some("level_gone"), Some("AAPL level gone: APEX rank 2 (alert snoozed)"), false)).await.unwrap();
    let FireOutcome::Fired { event } = o else { panic!("event") };
    assert_eq!(event.kind, "level_gone");
    let after = al::list(&p).await.unwrap().remove(0);
    assert_eq!(after.snooze_until, Some(T0 + 24 * 3_600_000));
    // not a fire: the alert stays armed and enabled, last_fired_at untouched
    assert_eq!((after.armed, after.enabled, after.last_fired_at), (true, true, None));
    // a second report of the same disappearance while snoozed writes nothing
    assert_eq!(skipped_reason(&al::fire_ex(&p, T0 + 1000, a.id, 0, 450.0, 0.0, extra(Some("level_gone"), None, false)).await.unwrap()), "snoozed");
    assert_eq!(event_count(&p).await, 1);
}

#[tokio::test]
async fn two_level_gone_reports_at_once_make_one_event() {
    let p = mem().await;
    let a = al::create(&p, T0, NewAlert { ref_kind: "apex".into(), ref_param: Some("rank:2".into()), ..new_alert() }).await.unwrap();
    let (x, y) = tokio::join!(
        al::fire_ex(&p, T0, a.id, 0, 450.0, 0.0, extra(Some("level_gone"), None, false)),
        al::fire_ex(&p, T0, a.id, 0, 450.0, 0.0, extra(Some("level_gone"), None, false)),
    );
    assert_eq!([x.unwrap(), y.unwrap()].iter().filter(|o| fired(o)).count(), 1);
    assert_eq!(event_count(&p).await, 1);
}

#[tokio::test]
async fn fire_ex_rejects_a_bad_kind_or_label() {
    let p = mem().await;
    let a = al::create(&p, T0, new_alert()).await.unwrap();
    for bad in [extra(Some("order"), None, false), extra(None, Some(""), false), extra(None, Some("x\u{7}y"), false), extra(None, Some(&"z".repeat(161)), false)] {
        assert!(matches!(al::fire_ex(&p, T0, a.id, 1, 100.5, 1.0, bad).await, Err(AppError::Invalid(_))));
    }
    assert_eq!(event_count(&p).await, 0);
}

#[test]
fn notice_text_is_cleaned_and_capped() {
    let (t, b) = clean_notice("  AAPL above 190.00 ", "last 190.42\u{0}\n at 10:01").unwrap();
    assert_eq!((t.as_str(), b.as_str()), ("AAPL above 190.00", "last 190.42   at 10:01"));
    assert!(clean_notice("   ", "x").is_err());
    let (t, b) = clean_notice(&"t".repeat(300), &"b".repeat(500)).unwrap();
    assert_eq!((t.chars().count(), b.chars().count()), (80, 200));
}
