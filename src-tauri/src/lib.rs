pub mod api;
pub mod atomic;
pub mod backup;
pub mod claude_config;
pub mod codex_auth;
pub mod codex_config;
pub mod commands;
pub mod detect;
pub mod error;
pub mod gateway;
pub mod paths;
pub mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(gateway::SessionState::new())
        .invoke_handler(tauri::generate_handler![
            commands::scan_environment,
            commands::load_app_state,
            commands::gateway_login,
            commands::gateway_logout,
            commands::gateway_current_user,
            commands::gateway_list_tokens,
            commands::gateway_adopt_token,
            commands::gateway_import_tokens,
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::get_remote_config,
            commands::test_connection,
            commands::test_profile_connection,
            commands::list_backups,
            commands::restore_backup,
            commands::apply_config,
            commands::revert_to_official,
            commands::rebuild_minimal_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
