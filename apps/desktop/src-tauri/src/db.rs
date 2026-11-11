use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};

use crate::error::AppError;

pub const MAX_LAYOUT_JSON: usize = 1024 * 1024;
const MAX_SETTING_VALUE: usize = 64 * 1024;

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct LayoutMeta {
    pub name: String,
    pub updated_at: String,
}

async fn migrate(pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

/// Opens (creating if needed) the on-disk database in WAL mode and runs migrations.
pub async fn open(path: &Path) -> Result<SqlitePool, AppError> {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await?;
    migrate(&pool).await?;
    Ok(pool)
}

/// In-memory database for tests. One connection only: every `:memory:` connection is its own DB.
pub async fn open_memory() -> Result<SqlitePool, AppError> {
    let opts = SqliteConnectOptions::from_str("sqlite::memory:")?;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await?;
    migrate(&pool).await?;
    Ok(pool)
}

pub fn validate_layout_name(name: &str) -> Result<(), AppError> {
    let n = name.chars().count();
    if n == 0 || n > 64 {
        return Err(AppError::Invalid("layout name must be 1 to 64 characters".into()));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(AppError::Invalid("layout name contains control characters".into()));
    }
    if name.trim() != name {
        return Err(AppError::Invalid("layout name has leading or trailing space".into()));
    }
    Ok(())
}

pub async fn layout_save(p: &SqlitePool, name: &str, json: &str) -> Result<LayoutMeta, AppError> {
    validate_layout_name(name)?;
    if json.len() > MAX_LAYOUT_JSON {
        return Err(AppError::Invalid("layout json exceeds 1 MiB".into()));
    }
    serde_json::from_str::<serde_json::Value>(json)
        .map_err(|e| AppError::Invalid(format!("layout json does not parse: {e}")))?;
    let row = sqlx::query(
        "INSERT INTO layouts (name, json) VALUES (?1, ?2) \
         ON CONFLICT(name) DO UPDATE SET name = excluded.name, json = excluded.json, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         RETURNING name, updated_at",
    )
    .bind(name)
    .bind(json)
    .fetch_one(p)
    .await?;
    Ok(LayoutMeta {
        name: row.get("name"),
        updated_at: row.get("updated_at"),
    })
}

pub async fn layout_list(p: &SqlitePool) -> Result<Vec<LayoutMeta>, AppError> {
    let rows = sqlx::query("SELECT name, updated_at FROM layouts ORDER BY updated_at DESC, rowid DESC")
        .fetch_all(p)
        .await?;
    Ok(rows
        .iter()
        .map(|r| LayoutMeta {
            name: r.get("name"),
            updated_at: r.get("updated_at"),
        })
        .collect())
}

pub async fn layout_load(p: &SqlitePool, name: &str) -> Result<Option<String>, AppError> {
    validate_layout_name(name)?;
    let row = sqlx::query("SELECT json FROM layouts WHERE name = ?1")
        .bind(name)
        .fetch_optional(p)
        .await?;
    Ok(row.map(|r| r.get("json")))
}

pub async fn layout_delete(p: &SqlitePool, name: &str) -> Result<(), AppError> {
    validate_layout_name(name)?;
    sqlx::query("DELETE FROM layouts WHERE name = ?1")
        .bind(name)
        .execute(p)
        .await?;
    Ok(())
}

fn validate_setting_key(key: &str) -> Result<(), AppError> {
    let n = key.chars().count();
    if n == 0 || n > 128 || key.chars().any(|c| c.is_control()) {
        return Err(AppError::Invalid("setting key must be 1 to 128 printable characters".into()));
    }
    Ok(())
}

pub async fn setting_get(p: &SqlitePool, key: &str) -> Result<Option<String>, AppError> {
    validate_setting_key(key)?;
    let row = sqlx::query("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(p)
        .await?;
    Ok(row.map(|r| r.get("value")))
}

pub async fn setting_set(p: &SqlitePool, key: &str, value: &str) -> Result<(), AppError> {
    validate_setting_key(key)?;
    if value.len() > MAX_SETTING_VALUE {
        return Err(AppError::Invalid("setting value exceeds 64 KiB".into()));
    }
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(p)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const J: &str = r#"{"a":1}"#;

    #[tokio::test]
    async fn save_list_load_round_trip() {
        let p = open_memory().await.unwrap();
        let meta = layout_save(&p, "Main", J).await.unwrap();
        assert_eq!(meta.name, "Main");
        let list = layout_list(&p).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Main");
        assert_eq!(layout_load(&p, "Main").await.unwrap().as_deref(), Some(J));
        assert_eq!(layout_load(&p, "nope").await.unwrap(), None);
    }

    #[tokio::test]
    async fn same_name_different_case_overwrites() {
        let p = open_memory().await.unwrap();
        layout_save(&p, "Main", r#"{"v":1}"#).await.unwrap();
        layout_save(&p, "MAIN", r#"{"v":2}"#).await.unwrap();
        assert_eq!(layout_list(&p).await.unwrap().len(), 1);
        assert_eq!(layout_load(&p, "main").await.unwrap().as_deref(), Some(r#"{"v":2}"#));
    }

    #[tokio::test]
    async fn list_is_newest_first() {
        let p = open_memory().await.unwrap();
        layout_save(&p, "first", J).await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        layout_save(&p, "second", J).await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        layout_save(&p, "third", J).await.unwrap();
        let names: Vec<_> = layout_list(&p).await.unwrap().into_iter().map(|m| m.name).collect();
        assert_eq!(names, ["third", "second", "first"]);
        tokio::time::sleep(Duration::from_millis(5)).await;
        layout_save(&p, "first", J).await.unwrap();
        let names: Vec<_> = layout_list(&p).await.unwrap().into_iter().map(|m| m.name).collect();
        assert_eq!(names[0], "first");
    }

    #[tokio::test]
    async fn delete_removes_and_missing_is_ok() {
        let p = open_memory().await.unwrap();
        layout_save(&p, "x", J).await.unwrap();
        layout_delete(&p, "x").await.unwrap();
        assert!(layout_list(&p).await.unwrap().is_empty());
        layout_delete(&p, "x").await.unwrap();
    }

    #[tokio::test]
    async fn bad_names_rejected() {
        let p = open_memory().await.unwrap();
        let long = "a".repeat(65);
        for bad in ["", long.as_str(), "a\nb", " lead", "trail ", "tab\there"] {
            assert!(matches!(layout_save(&p, bad, J).await, Err(AppError::Invalid(_))), "{bad:?}");
        }
        assert!(layout_save(&p, &"a".repeat(64), J).await.is_ok());
        assert!(layout_list(&p).await.unwrap().len() == 1);
    }

    #[tokio::test]
    async fn bad_json_rejected() {
        let p = open_memory().await.unwrap();
        assert!(matches!(layout_save(&p, "n", "{not json").await, Err(AppError::Invalid(_))));
        // exactly 1 MiB of valid JSON is accepted, 1 MiB + 1 is not
        let ok = format!("\"{}\"", "a".repeat(MAX_LAYOUT_JSON - 2));
        assert_eq!(ok.len(), MAX_LAYOUT_JSON);
        let big = format!("\"{}\"", "a".repeat(MAX_LAYOUT_JSON - 1));
        assert_eq!(big.len(), MAX_LAYOUT_JSON + 1);
        assert!(matches!(layout_save(&p, "n", &big).await, Err(AppError::Invalid(_))));
        assert!(layout_save(&p, "n", &ok).await.is_ok());
    }

    #[tokio::test]
    async fn settings_round_trip_and_overwrite() {
        let p = open_memory().await.unwrap();
        assert_eq!(setting_get(&p, "k").await.unwrap(), None);
        setting_set(&p, "k", "v1").await.unwrap();
        setting_set(&p, "k", "v2").await.unwrap();
        assert_eq!(setting_get(&p, "k").await.unwrap().as_deref(), Some("v2"));
        assert!(matches!(setting_set(&p, "", "v").await, Err(AppError::Invalid(_))));
    }

    #[tokio::test]
    async fn open_on_disk_twice_is_fine() {
        let dir = std::env::temp_dir().join(format!("rebull-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let a = open(&path).await.unwrap();
        layout_save(&a, "x", J).await.unwrap();
        let b = open(&path).await.unwrap();
        assert_eq!(layout_list(&b).await.unwrap().len(), 1);
        drop((a, b));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
