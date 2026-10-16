use crate::models::{
    schema::{CatalogEntry, DownloadStatus},
    ModelManager,
};
use tauri::Manager;

#[tauri::command]
pub fn model_catalog(manager: tauri::State<ModelManager>) -> Vec<CatalogEntry> {
    manager.catalog()
}
#[tauri::command]
pub fn model_status(manager: tauri::State<ModelManager>) -> Vec<DownloadStatus> {
    manager.statuses()
}
#[tauri::command]
pub async fn model_download(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<ModelManager>().download(&id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn model_control(
    app: tauri::AppHandle,
    id: String,
    action: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<ModelManager>().control(&id, &action))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn model_import(
    app: tauri::AppHandle,
    id: String,
    directory: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<ModelManager>()
            .import(&id, std::path::Path::new(&directory))
    })
    .await
    .map_err(|e| e.to_string())?
}
