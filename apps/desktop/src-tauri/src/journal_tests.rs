//! Journal storage tests: in-memory SQLite, no network.
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use crate::db;
use crate::error::AppError;
use crate::journal::*;
use crate::rh::pnl::PnlTrade;

fn new(body: &str) -> NewNote {
    NewNote { body: body.into(), ..Default::default() }
}

fn tmpdir(tag: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!("rebull-journal-{}-{}-{tag}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[tokio::test]
async fn crud_round_trip() {
    let p = db::open_memory().await.unwrap();
    let n = note_add(&p, NewNote { symbol: Some(" aapl ".into()), account_masked: Some("\u{2022}\u{2022}\u{2022}\u{2022}1234".into()), trade_key: Some("t_abc".into()), body: "Sold the pop".into(), tags: vec!["Earnings".into(), "plan".into()] })
        .await
        .unwrap();
    assert!(n.id > 0);
    assert_eq!(n.symbol.as_deref(), Some("AAPL"), "symbol normalised");
    assert_eq!(n.tags, ["Earnings", "plan"]);
    assert_eq!(n.trade_key.as_deref(), Some("t_abc"));
    assert!(!n.created_at.is_empty() && n.created_at == n.updated_at);
    let got = notes_list(&p, &NoteFilter::default()).await.unwrap();
    assert_eq!(got, vec![n.clone()]);
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let u = note_update(&p, n.id, "Sold the pop, too early", &["mistake".into()]).await.unwrap();
    assert_eq!(u.body, "Sold the pop, too early");
    assert_eq!(u.tags, ["mistake"]);
    assert_eq!(u.created_at, n.created_at);
    assert!(u.updated_at > n.updated_at, "{} vs {}", u.updated_at, n.updated_at);
    assert_eq!(u.symbol, n.symbol, "update only touches body and tags");
    assert_eq!(u.trade_key, n.trade_key);
    note_delete(&p, n.id).await.unwrap();
    assert!(notes_list(&p, &NoteFilter::default()).await.unwrap().is_empty());
}

#[tokio::test]
async fn list_is_newest_first_and_edits_do_not_reorder() {
    let p = db::open_memory().await.unwrap();
    let a = note_add(&p, new("a")).await.unwrap();
    let b = note_add(&p, new("b")).await.unwrap();
    let c = note_add(&p, new("c")).await.unwrap();
    note_update(&p, a.id, "a2", &[]).await.unwrap();
    let ids: Vec<i64> = notes_list(&p, &NoteFilter::default()).await.unwrap().iter().map(|n| n.id).collect();
    assert_eq!(ids, [c.id, b.id, a.id]);
}

#[tokio::test]
async fn filters_by_symbol_trade_key_text_and_limit() {
    let p = db::open_memory().await.unwrap();
    let mk = |sym: Option<&str>, key: Option<&str>, body: &str| NewNote { symbol: sym.map(String::from), trade_key: key.map(String::from), body: body.into(), ..Default::default() };
    note_add(&p, mk(Some("AAA"), Some("t_1"), "100% win")).await.unwrap();
    note_add(&p, mk(Some("BBB"), Some("t_2"), "100x win")).await.unwrap();
    note_add(&p, mk(Some("AAA"), None, "a_b literal")).await.unwrap();
    note_add(&p, mk(None, None, "axb other")).await.unwrap();
    let f = |sym: Option<&str>, key: Option<&str>, text: Option<&str>, limit: Option<u32>| NoteFilter { symbol: sym.map(String::from), trade_key: key.map(String::from), text: text.map(String::from), limit };
    let bodies = |v: Vec<Note>| v.into_iter().map(|n| n.body).collect::<Vec<_>>();
    assert_eq!(bodies(notes_list(&p, &f(Some("aaa"), None, None, None)).await.unwrap()), ["a_b literal", "100% win"]);
    assert_eq!(bodies(notes_list(&p, &f(None, Some("t_2"), None, None)).await.unwrap()), ["100x win"]);
    assert_eq!(bodies(notes_list(&p, &f(None, None, Some("100%"), None)).await.unwrap()), ["100% win"], "% is literal");
    assert_eq!(bodies(notes_list(&p, &f(None, None, Some("a_b"), None)).await.unwrap()), ["a_b literal"], "_ is literal");
    assert_eq!(bodies(notes_list(&p, &f(None, None, Some("WIN"), None)).await.unwrap()).len(), 2, "case-insensitive");
    assert_eq!(bodies(notes_list(&p, &f(None, None, Some("\\"), None)).await.unwrap()).len(), 0, "backslash is literal");
    assert_eq!(notes_list(&p, &f(Some("AAA"), None, Some("win"), None)).await.unwrap().len(), 1, "filters combine");
    assert_eq!(notes_list(&p, &f(None, None, Some("   "), None)).await.unwrap().len(), 4, "blank text = no text filter");
    assert_eq!(notes_list(&p, &f(None, None, None, Some(2))).await.unwrap().len(), 2);
    assert_eq!(notes_list(&p, &f(None, None, None, Some(MAX_LIST_LIMIT))).await.unwrap().len(), 4);
    for bad in [0, MAX_LIST_LIMIT + 1] {
        assert!(matches!(notes_list(&p, &f(None, None, None, Some(bad))).await, Err(AppError::Invalid(_))), "limit {bad}");
    }
    assert!(matches!(notes_list(&p, &f(Some("bad sym"), None, None, None)).await, Err(AppError::Invalid(_))));
    assert!(matches!(notes_list(&p, &f(None, None, Some(&"x".repeat(201)), None)).await, Err(AppError::Invalid(_))));
}

#[tokio::test]
async fn validation_table_for_add_and_update() {
    let p = db::open_memory().await.unwrap();
    let tag33 = "t".repeat(33);
    let big = "x".repeat(MAX_BODY_CHARS + 1);
    let many: Vec<String> = (0..MAX_TAGS + 1).map(|i| format!("t{i}")).collect();
    let bad_bodies = ["", "   ", "\n\t ", big.as_str(), "a\u{0}b", "a\u{7}b", "a\u{1b}[31mred", "a\u{7f}b", "a\rb", "a\u{85}b"];
    let seed = note_add(&p, new("seed")).await.unwrap();
    for b in bad_bodies {
        assert!(matches!(note_add(&p, new(b)).await, Err(AppError::Invalid(_))), "add {:?}", b.chars().take(8).collect::<String>());
        assert!(matches!(note_update(&p, seed.id, b, &[]).await, Err(AppError::Invalid(_))), "update {:?}", b.chars().take(8).collect::<String>());
    }
    let bad_tags: Vec<Vec<String>> = vec![many.clone(), vec![tag33.clone()], vec!["".into()], vec!["  ".into()], vec!["a\nb".into()], vec!["a\u{0}".into()]];
    for t in &bad_tags {
        assert!(matches!(note_add(&p, NewNote { body: "ok".into(), tags: t.clone(), ..Default::default() }).await, Err(AppError::Invalid(_))), "add tags {t:?}");
        assert!(matches!(note_update(&p, seed.id, "ok", t).await, Err(AppError::Invalid(_))), "update tags {t:?}");
    }
    for (sym, key, acct) in [(Some("bad sym"), None, None), (Some("1ABC"), None, None), (None, Some("a b"), None), (None, Some(&*"k".repeat(65)), None), (None, None, Some(&*"m".repeat(33))), (None, None, Some("a\nb"))] {
        let n = NewNote { body: "ok".into(), symbol: sym.map(String::from), trade_key: key.map(String::from), account_masked: acct.map(String::from), ..Default::default() };
        assert!(matches!(note_add(&p, n).await, Err(AppError::Invalid(_))), "{sym:?} {key:?} {acct:?}");
    }
    // limits are inclusive, newlines and tabs in a note body are allowed
    assert!(note_add(&p, new(&"x".repeat(MAX_BODY_CHARS))).await.is_ok());
    assert!(note_add(&p, new(&"\u{e9}".repeat(MAX_BODY_CHARS))).await.is_ok(), "limit counts characters, not bytes");
    let ten: Vec<String> = (0..MAX_TAGS).map(|i| format!("t{i}")).collect();
    assert!(note_add(&p, NewNote { body: "ok".into(), tags: ten, ..Default::default() }).await.is_ok());
    assert!(note_add(&p, NewNote { body: "ok".into(), tags: vec!["t".repeat(MAX_TAG_CHARS)], ..Default::default() }).await.is_ok());
    let n = note_add(&p, new("line one\n\tline two")).await.unwrap();
    assert_eq!(n.body, "line one\n\tline two");
    // tags are trimmed and de-duplicated case-insensitively
    let t = note_add(&p, NewNote { body: "ok".into(), tags: vec![" Plan ".into(), "plan".into(), "x".into()], ..Default::default() }).await.unwrap();
    assert_eq!(t.tags, ["Plan", "x"]);
    // the table did not grow from rejected rows
    // seed + 10_000 x's + 10_000 e-acutes + ten tags + 32-char tag + multi-line + dedupe note = 7 rows; every rejected add left nothing behind
    assert_eq!(notes_all(&p).await.unwrap().0.len(), 7);
}

#[tokio::test]
async fn missing_ids_are_not_found_and_never_panic() {
    let p = db::open_memory().await.unwrap();
    for id in [1, 0, -5, i64::MAX, i64::MIN] {
        assert!(matches!(note_update(&p, id, "x", &[]).await, Err(AppError::NotFound(_))), "update {id}");
        assert!(matches!(note_delete(&p, id).await, Err(AppError::NotFound(_))), "delete {id}");
    }
    let n = note_add(&p, new("x")).await.unwrap();
    note_delete(&p, n.id).await.unwrap();
    assert!(matches!(note_delete(&p, n.id).await, Err(AppError::NotFound(_))), "double delete");
}

#[tokio::test]
async fn migration_0002_applies_on_a_database_that_already_has_the_m2_tables() {
    let opts = <sqlx::sqlite::SqliteConnectOptions as std::str::FromStr>::from_str("sqlite::memory:").unwrap();
    let p = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();
    sqlx::raw_sql(include_str!("../migrations/0001_workspace.sql")).execute(&p).await.unwrap();
    sqlx::query("INSERT INTO layouts (name, json) VALUES ('Main', '{}')").execute(&p).await.unwrap();
    sqlx::query("INSERT INTO settings (key, value) VALUES ('k', 'v')").execute(&p).await.unwrap();
    sqlx::raw_sql(include_str!("../migrations/0002_journal.sql")).execute(&p).await.unwrap();
    assert_eq!(db::layout_load(&p, "Main").await.unwrap().as_deref(), Some("{}"), "M2 data survives");
    assert_eq!(db::setting_get(&p, "k").await.unwrap().as_deref(), Some("v"));
    let n = note_add(&p, new("works")).await.unwrap();
    assert_eq!(n.tags, Vec::<String>::new());
    let idx: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='journal_notes' AND name NOT LIKE 'sqlite_%'").fetch_all(&p).await.unwrap();
    assert!(idx.iter().any(|i| i.contains("symbol")) && idx.iter().any(|i| i.contains("trade_key")), "{idx:?}");
    // and the real migrator reaches the same state from scratch
    let fresh = db::open_memory().await.unwrap();
    assert!(note_add(&fresh, new("fresh")).await.is_ok());
}

// ---- CSV ----

/// RFC 4180-ish parser used only to prove the writer round-trips.
fn parse_csv(s: &str) -> Vec<Vec<String>> {
    let (mut rows, mut row, mut cell) = (vec![], vec![], String::new());
    let (mut quoted, mut chars) = (false, s.chars().peekable());
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    cell.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                cell.push(c);
            }
        } else {
            match c {
                '"' => quoted = true,
                ',' => row.push(std::mem::take(&mut cell)),
                '\r' if chars.peek() == Some(&'\n') => {}
                '\n' => {
                    row.push(std::mem::take(&mut cell));
                    rows.push(std::mem::take(&mut row));
                }
                other => cell.push(other),
            }
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

#[test]
fn csv_cell_escaping_table() {
    let t = [
        ("plain", "plain"),
        ("", ""),
        ("a,b", "\"a,b\""),
        ("say \"hi\"", "\"say \"\"hi\"\"\""),
        ("l1\nl2", "\"l1\nl2\""),
        ("=1+1", "'=1+1"),
        ("+1", "'+1"),
        ("-1", "'-1"),
        ("@SUM(A1)", "'@SUM(A1)"),
        ("\tx", "'\tx"),
        ("\rx", "\"'\rx\""),
        ("=A,\"B\"", "\"'=A,\"\"B\"\"\""),
        ("a=b", "a=b"),
        ("it's", "it's"),
    ];
    for (i, o) in t {
        assert_eq!(csv_cell(i), o, "{i:?}");
    }
}

fn trade(sym: &str, key: &str, gain: Option<f64>, ts: &str) -> PnlTrade {
    PnlTrade { trade_key: key.into(), symbol: sym.into(), side: Some("sell".into()), quantity: Some(10.0), price: Some(101.5), realized_gain: gain, timestamp: Some(ts.into()) }
}

fn note(id: i64, key: Option<&str>, sym: Option<&str>, body: &str, tags: &[&str]) -> Note {
    Note { id, created_at: "2026-11-06T10:00:00.000Z".into(), updated_at: "2026-11-06T10:00:00.000Z".into(), symbol: sym.map(String::from), account_masked: None, trade_key: key.map(String::from), body: body.into(), tags: tags.iter().map(|t| t.to_string()).collect() }
}

#[tokio::test]
async fn export_merges_notes_by_trade_key_and_round_trips_hostile_text() {
    let hostile = "=cmd|' /C calc'!A0, \"quoted\"\nsecond line\r\nthird";
    let trades = vec![trade("AAA", "t_1", Some(15.0), "2026-11-05T15:30:00Z"), trade("=EVIL", "t_2", Some(-3.25), "2026-11-04T14:00:00Z"), trade("CCC", "t_3", None, "2026-11-03T14:00:00Z")];
    let notes = vec![
        note(1, Some("t_1"), Some("AAA"), hostile, &["plan", "@tag", "a,b"]),
        note(2, Some("t_1"), Some("AAA"), "second note on the same trade", &[]),
        note(3, None, Some("ZZZ"), "+free form", &["x"]),
        note(4, Some("t_gone"), None, "-orphan key (trade out of span)", &[]),
    ];
    let csv = export_csv(&notes, &trades);
    let rows = parse_csv(&csv);
    assert_eq!(rows[0], ["kind", "date", "symbol", "side", "quantity", "price", "realized_gain", "trade_key", "note", "tags", "note_created_at"]);
    assert!(rows.iter().all(|r| r.len() == 11), "ragged rows: {rows:?}");
    // 3 trades, one expands to 2 notes, plus 2 unmatched notes = 1 + 4 + 2 data rows
    assert_eq!(rows.len() - 1, 6);
    assert_eq!(export_row_count(&notes, &trades), 6);
    let r1 = &rows[1];
    assert_eq!((r1[0].as_str(), r1[2].as_str(), r1[6].as_str(), r1[7].as_str()), ("trade", "AAA", "15", "t_1"));
    assert_eq!(r1[8], format!("'{hostile}"), "formula-leading note is prefixed, the rest is verbatim");
    assert_eq!(r1[9], "plan; '@tag; a,b", "tags joined with '; ' and each guarded");
    assert_eq!(rows[2][8], "second note on the same trade");
    assert_eq!(rows[2][6], "15", "trade columns repeat per note");
    assert_eq!(rows[3][2], "'=EVIL", "hostile symbol cell is guarded");
    assert_eq!(rows[3][6], "-3.25", "a negative P&L stays a number");
    assert_eq!(rows[3][8], "");
    assert_eq!(rows[4][2], "CCC");
    assert_eq!(rows[4][6], "", "missing gain is an empty cell");
    assert_eq!((rows[5][0].as_str(), rows[5][2].as_str(), rows[5][8].as_str()), ("note", "ZZZ", "'+free form"));
    assert_eq!((rows[6][0].as_str(), rows[6][7].as_str(), rows[6][8].as_str()), ("note", "t_gone", "'-orphan key (trade out of span)"));
    assert!(rows.iter().skip(1).all(|r| r.iter().all(|c| !c.starts_with(['=', '+', '@', '\t', '\r']) && (!c.starts_with('-') || c.parse::<f64>().is_ok()))), "no raw formula cell: {rows:?}");
    // CRLF line endings
    assert!(csv.ends_with("\r\n") && csv.starts_with("kind,date,"));
}

#[test]
fn export_of_nothing_is_just_the_header() {
    let csv = export_csv(&[], &[]);
    assert_eq!(parse_csv(&csv).len(), 1);
    assert_eq!(export_row_count(&[], &[]), 0);
}

#[test]
fn write_export_is_0600_sanitised_and_refuses_traversal_and_overwrite() {
    let d = tmpdir("write").join("exports");
    let p = write_export(&d, "j.csv", "a,b\r\n").unwrap();
    assert_eq!(p, d.join("j.csv"));
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "a,b\r\n");
    assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
    let q = write_export(&d, "my report!.csv", "x").unwrap();
    assert_eq!(q.file_name().unwrap(), "my_report_.csv");
    let r = write_export(&d, "noext", "x").unwrap();
    assert_eq!(r.file_name().unwrap(), "noext.csv");
    for bad in ["../x", "a/b", "..", ".hidden", "", "a\\b", "x/../../y.csv", &"n".repeat(101), "a\0b"] {
        assert!(matches!(write_export(&d, bad, "x"), Err(AppError::Invalid(_))), "{bad:?}");
    }
    assert!(matches!(write_export(&d, "j.csv", "y"), Err(AppError::Io(_))), "never overwrites or follows an existing name");
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "a,b\r\n", "the first export is untouched");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/etc/passwd", d.join("link.csv")).unwrap();
        assert!(write_export(&d, "link.csv", "y").is_err(), "a symlink at the target is not followed");
    }
    let names: Vec<String> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(names.iter().all(|n| !n.starts_with('.')), "{names:?}");
    let _ = std::fs::remove_dir_all(d.parent().unwrap());
}

/// R11: two exports in the same second (or millisecond) get different file names.
#[test]
fn export_file_names_never_collide() {
    let a = export_file_name(1_762_819_200_123, "month");
    let b = export_file_name(1_762_819_200_123, "month");
    assert_ne!(a, b);
    assert!(a.starts_with("rebull-journal-2025-11-11-") && a.ends_with("-month.csv"), "{a}");
    let d = tmpdir("names");
    write_export(&d, &a, "x").unwrap();
    write_export(&d, &b, "y").unwrap();
}

/// R11: the note cap is reported (like the trade cap) instead of silently dropping notes.
#[tokio::test]
async fn notes_all_reports_truncation() {
    let p = db::open_memory().await.unwrap();
    for i in 0..5 {
        note_add(&p, new(&format!("n{i}"))).await.unwrap();
    }
    let (n, more) = notes_all_capped(&p, 3).await.unwrap();
    assert_eq!((n.len(), more), (3, true));
    let (n, more) = notes_all_capped(&p, 5).await.unwrap();
    assert_eq!((n.len(), more), (5, false));
}
