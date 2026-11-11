pub mod candles;
pub mod commands;
pub mod db;
pub mod error;
pub mod explain_run;
pub mod explain_threads;
pub mod explain_usage;
pub mod journal;
pub mod llm;
pub mod llm_commands;
pub mod redact;
pub mod rh;
pub mod rh_commands;
pub mod secrets;
pub mod startup;
pub mod tm;
pub mod tm_commands;
pub mod vault;

use std::sync::Arc;

use tauri::Manager;

use crate::error::AppError;
use crate::secrets::{select_store, SecretStore};
use crate::vault::Vault;

/// Startup failures exit non-zero with a plain message (no dialog dependency).
fn fail_start(e: &AppError) -> ! {
    eprintln!("TraderMatrix Desktop failed to start: {e}");
    std::process::exit(1);
}

pub fn run() {
    let built = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().map_err(|e| AppError::Io(e.to_string()))?;
            std::fs::create_dir_all(&dir).map_err(AppError::from)?;
            // One instance per data dir, decided before the vault or the DB is touched.
            let lock = startup::acquire_instance_lock(&dir).unwrap_or_else(|e| fail_start(&e));
            app.manage(startup::InstanceLock(lock));
            let db_path = dir.join("rebull.db");
            let pool = startup::precreate_private(&db_path)
                .and_then(|_| tauri::async_runtime::block_on(db::open(&db_path)))
                .unwrap_or_else(|e| fail_start(&e));
            startup::harden_data_dir(&dir).unwrap_or_else(|e| fail_start(&e));
            app.manage(pool);
            let vault = Arc::new(Vault::new(dir.join("vault.rbv")));
            let store: Arc<dyn SecretStore> = select_store(vault.clone());
            app.manage(Arc::new(rh_commands::RhState::new(store.clone(), rh::OAuthConfig::robinhood())));
            app.manage(Arc::new(tm::TmState::new(store.clone())));
            app.manage(Arc::new(llm::LlmState::new(store.clone())));
            app.manage(vault);
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::layout_list,
            commands::layout_save,
            commands::layout_load,
            commands::layout_delete,
            commands::setting_get,
            commands::setting_set,
            commands::secret_set,
            commands::secret_exists,
            commands::secret_delete,
            commands::secret_backend_status,
            commands::vault_status,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            rh_commands::rh_connect,
            rh_commands::rh_disconnect,
            rh_commands::rh_status,
            rh_commands::rh_accounts,
            rh_commands::rh_portfolio,
            rh_commands::rh_positions,
            rh_commands::rh_option_positions,
            rh_commands::rh_orders,
            rh_commands::rh_quotes,
            rh_commands::rh_historicals,
            rh_commands::rh_option_chain,
            rh_commands::rh_earnings,
            rh_commands::rh_option_historicals,
            rh_commands::rh_watchlists,
            rh_commands::rh_watchlist_items,
            rh_commands::rh_option_watchlist,
            rh_commands::rh_review_equity_order,
            rh_commands::rh_review_option_order,
            rh_commands::rh_place_order,
            rh_commands::rh_cancel_equity_order,
            rh_commands::rh_cancel_option_order,
            rh_commands::rh_trade_approval_setting,
            rh_commands::rh_trade_approvals,
            rh_commands::rh_decline_trade_approval,
            rh_commands::rh_capture_tools,
            rh_commands::rh_pending_login_url,
            rh_commands::rh_watchlist_create,
            rh_commands::rh_watchlist_update,
            rh_commands::rh_watchlist_add,
            rh_commands::rh_watchlist_remove,
            rh_commands::rh_option_watchlist_add,
            rh_commands::rh_option_watchlist_remove,
            rh_commands::rh_realized_pnl,
            rh_commands::rh_pnl_trades,
            commands::journal_list,
            commands::journal_add,
            commands::journal_update,
            commands::journal_delete,
            commands::journal_export_csv,
            commands::candles_store,
            commands::candles_load,
            commands::snapshot_store,
            commands::candles_stats,
            tm_commands::tm_status,
            tm_commands::tm_apex_levels,
            tm_commands::tm_expected_move,
            tm_commands::tm_iv_rank,
            tm_commands::tm_snapshot,
            tm_commands::tm_watchlists,
            tm_commands::tm_watchlist_add,
            tm_commands::tm_watchlist_create,
            llm_commands::explain_ask,
            llm_commands::explain_stop,
            llm_commands::explain_usage_summary,
            llm_commands::explain_thread_list,
            llm_commands::explain_thread_load,
            llm_commands::explain_thread_append,
            llm_commands::explain_thread_delete,
            llm_commands::explain_thread_delete_all,
            llm_commands::explain_thread_export,
            llm_commands::llm_config_set,
            llm_commands::llm_config_status,
            llm_commands::llm_config_clear,
            llm_commands::llm_test,
            llm_commands::llm_detect,
        ])
        .run(tauri::generate_context!());
    if let Err(e) = built {
        eprintln!("TraderMatrix Desktop failed to start: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod explain_tests;
#[cfg(test)]
mod journal_tests;

#[cfg(test)]
mod tests {
    /// The webview-callable surface is an allowlist. Any new command (especially a write, a raw call or
    /// `secret_get`) must be added here deliberately, which makes it show up in review.
    #[test]
    fn registered_commands_are_exactly_the_intended_set() {
        let src = include_str!("lib.rs");
        let start = src.find("generate_handler![").expect("handler list") + "generate_handler![".len();
        let end = start + src[start..].find("])").expect("handler list end");
        let mut got: Vec<String> = src[start..end]
            .split(',')
            .map(|s| s.trim().rsplit("::").next().unwrap_or("").to_string())
            .filter(|s| !s.is_empty())
            .collect();
        got.sort();
        let mut want: Vec<String> = [
            "layout_list", "layout_save", "layout_load", "layout_delete", "setting_get", "setting_set",
            "secret_set", "secret_exists", "secret_delete", "secret_backend_status",
            "vault_status", "vault_create", "vault_unlock", "vault_lock",
            "rh_connect", "rh_disconnect", "rh_status", "rh_accounts", "rh_portfolio", "rh_positions",
            "rh_orders", "rh_quotes", "rh_historicals", "rh_option_chain", "rh_watchlists",
            "rh_watchlist_items", "rh_option_watchlist", "rh_capture_tools", "rh_pending_login_url",
            // M6 (2026-11-10): exactly these eight order commands, nothing else.
            "rh_review_equity_order", "rh_review_option_order", "rh_place_order",
            "rh_cancel_equity_order", "rh_cancel_option_order",
            "rh_trade_approval_setting", "rh_trade_approvals", "rh_decline_trade_approval",
            // M7 (2026-11-10): exactly these 13: six watchlist writes (never order tools), two P&L reads, five journal commands.
            "rh_watchlist_create", "rh_watchlist_update", "rh_watchlist_add", "rh_watchlist_remove",
            "rh_option_watchlist_add", "rh_option_watchlist_remove",
            "rh_realized_pnl", "rh_pnl_trades",
            "journal_list", "journal_add", "journal_update", "journal_delete", "journal_export_csv",
            // M5 (2026-11-11): exactly these five TraderMatrix commands: key-presence status and four read-only reads.
            "tm_status", "tm_apex_levels", "tm_expected_move", "tm_iv_rank", "tm_snapshot",
            // M8 (2026-11-11): exactly these three watchlist commands (list, add one symbol, create an empty list); no removal.
            "tm_watchlists", "tm_watchlist_add", "tm_watchlist_create",
            // M10 (2026-11-11): exactly one new command, a read (open option positions joined with contract and quote).
            "rh_option_positions",
            // M11 (2026-11-11): five new commands: four local-SQLite candle/snapshot commands (no network, no tool names, no raw SQL) and one read (option bar history).
            "candles_store", "candles_load", "snapshot_store", "candles_stats", "rh_option_historicals",
            // M13 (2026-11-11): exactly one new command, a read (get_earnings_results for one symbol).
            "rh_earnings",
            // M14 (2026-11-11): exactly one new command, the explain-only chat (model id, digest text, question, earlier turns; no tool names, no key).
            "explain_ask",
            // M14b (2026-11-11): provider setup. Provider, endpoint and key are saved by ONE command (config_set); no command returns the key.
            "llm_config_set", "llm_config_status", "llm_config_clear", "llm_test", "llm_detect",
            // M16 B1-B3 (2026-11-12): streaming stop (`explain_stop`; named without the order verb "cancel" so the order-verb test stays untouched), the usage
            // meter, and six chat-thread commands (list, load, append, delete, delete_all, export). Local SQLite and files only; no network, no tool names.
            "explain_stop", "explain_usage_summary",
            "explain_thread_list", "explain_thread_load", "explain_thread_append", "explain_thread_delete", "explain_thread_delete_all", "explain_thread_export",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        want.sort();
        assert_eq!(got, want);
        // Only these names may contain an order-verb fragment; anything else with one is a new write path.
        let order_verbs = ["rh_review_equity_order", "rh_review_option_order", "rh_place_order", "rh_cancel_equity_order", "rh_cancel_option_order", "rh_decline_trade_approval"];
        for n in &got {
            if ["place", "cancel", "decline", "review"].iter().any(|f| n.contains(f)) {
                assert!(order_verbs.contains(&n.as_str()), "unexpected order-verb command {n}");
            }
        }
        for v in order_verbs {
            assert!(got.iter().any(|n| n == v), "{v} missing");
        }
        // M7 additions must not look like order commands and must not delete watchlists (there is no such tool).
        for n in ["rh_watchlist_create", "rh_watchlist_update", "rh_watchlist_add", "rh_watchlist_remove", "rh_option_watchlist_add", "rh_option_watchlist_remove"] {
            assert!(!["place", "cancel", "decline", "review", "delete"].iter().any(|f| n.contains(f)), "{n}");
        }
        for bad in ["exercise", "raw", "call", "advanced", "crypto", "secret_get", "replace", "modify", "generic", "invoke"] {
            assert!(!got.iter().any(|n| n.contains(bad)), "forbidden command name fragment {bad}: {got:?}");
        }
    }

    /// R8: commands that touch the keyring, the vault file or fsync must not run on the UI thread.
    #[test]
    fn commands_that_can_block_are_async() {
        let srcs = [include_str!("commands.rs"), include_str!("rh_commands.rs"), include_str!("tm_commands.rs"), include_str!("llm_commands.rs")];
        for name in ["rh_status", "tm_status", "vault_status", "vault_lock", "secret_set", "secret_exists", "secret_delete", "secret_backend_status", "rh_pending_login_url", "explain_ask", "llm_config_set", "llm_config_status", "llm_config_clear", "llm_test", "llm_detect", "explain_stop", "explain_usage_summary", "explain_thread_list", "explain_thread_load", "explain_thread_append", "explain_thread_delete", "explain_thread_delete_all", "explain_thread_export"] {
            let decl = srcs.iter().find_map(|s| {
                let i = s.find(&format!("fn {name}("))?;
                let line_start = s[..i].rfind('\n').map(|p| p + 1).unwrap_or(0);
                Some(s[line_start..i].to_string())
            });
            let decl = decl.unwrap_or_else(|| panic!("{name} not found"));
            assert!(decl.contains("async"), "{name} must be an async command: {decl:?}");
        }
    }

    /// No command may take a raw tool name, a `ref_id`, or free-form tool arguments from the webview.
    #[test]
    fn no_command_signature_accepts_ref_id_or_raw_tool_calls() {
        let mut checked = 0;
        let mut tm_checked = 0;
        let mut llm_checked = 0;
        for (file, src) in [("rh_commands.rs", include_str!("rh_commands.rs")), ("tm_commands.rs", include_str!("tm_commands.rs")), ("llm_commands.rs", include_str!("llm_commands.rs"))] {
            for (i, _) in src.match_indices("#[tauri::command]") {
                let rest = &src[i..];
                let open = rest.find("fn ").expect("fn after attribute");
                let end = rest[open..].find('{').expect("body") + open;
                let sig = &rest[open..end];
                let name: String = sig[3..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                // Only the parameter list is checked: return types may carry JSON values and names contain verbs.
                let params = &sig[sig.find('(').expect("params")..sig.find("->").unwrap_or(sig.len())];
                for bad in ["ref_id", "refid", "tool", "serde_json::Value", "Value>", "method", "raw", "arguments"] {
                    assert!(!params.contains(bad), "command {name} in {file} takes `{bad}` from the webview: {params}");
                }
                if name == "rh_place_order" {
                    assert!(params.contains("review_id: String") && !params.contains("args"), "place takes only a review id: {params}");
                }
                if file == "tm_commands.rs" {
                    // TM commands take only symbols, list names/ids, list names to create (and, for apex levels, an expiration date).
                    assert!(!params.contains("key") && !params.contains("secret"), "{name}: {params}");
                    tm_checked += 1;
                } else if file == "llm_commands.rs" {
                    // Chat commands never take a tool name, an order or a ticket. Only `llm_config_set` may take a key (`api_key`), and it
                    // seals it together with the endpoint; no other chat command mentions a key or secret.
                    assert!(!params.contains("secret") && !params.contains("order") && !params.contains("ticket"), "{name}: {params}");
                    if name == "llm_config_set" {
                        assert!(params.contains("api_key: Option<String>") && params.contains("base_url: Option<String>"), "{params}");
                    } else {
                        assert!(!params.contains("key"), "{name}: {params}");
                    }
                    llm_checked += 1;
                } else {
                    checked += 1;
                }
            }
        }
        assert!(checked >= 20, "scanned {checked} commands");
        assert_eq!(tm_checked, 8, "scanned {tm_checked} TM commands");
        assert_eq!(llm_checked, 14, "scanned {llm_checked} chat commands");
    }
}
