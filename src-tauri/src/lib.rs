mod discover;
mod raster;
mod store;
mod trace;
mod tracers;

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tracers::{Descriptor, Engine};

#[derive(Default)]
struct AppState {
    runner: trace::Runner,
    cache: Mutex<raster::Cache>,
    /// Resolved tracers, so `--version` doesn't run on every trace.
    tracers: Mutex<HashMap<Engine, discover::TracerInfo>>,
}

type Shared<'a> = State<'a, Arc<AppState>>;

fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join(name))
}

fn tracer_override(app: &AppHandle, engine: Engine) -> Option<PathBuf> {
    let config: store::Config = store::load(&config_file(app, "config.json").ok()?);
    config.tracer_paths.get(engine.binary()).map(PathBuf::from)
}

fn resolve_tracer(app: &AppHandle, state: &AppState, engine: Engine) -> discover::TracerInfo {
    let info = discover::resolve(engine, tracer_override(app, engine).as_deref());
    state.tracers.lock().unwrap().insert(engine, info.clone());
    info
}

fn tracer_binary(app: &AppHandle, state: &AppState, engine: Engine) -> Result<PathBuf, String> {
    let cached = state.tracers.lock().unwrap().get(&engine).cloned();
    let info = cached.unwrap_or_else(|| resolve_tracer(app, state, engine));
    info.path
        .map(PathBuf::from)
        .ok_or_else(|| format!("{} not found: install it or choose the program in the {} tab", engine.binary(), engine.binary()))
}

#[tauri::command]
fn get_descriptors() -> Vec<Descriptor> {
    tracers::descriptors()
}

#[tauri::command]
async fn detect_tracers(app: AppHandle, state: Shared<'_>) -> Result<Vec<discover::TracerInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        [Engine::Autotrace, Engine::Potrace].into_iter().map(|e| resolve_tracer(&app, &state, e)).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Like Delineate's first-run prompt: remember where a tracer lives, after checking it
/// really is that program. `None` goes back to automatic search.
#[tauri::command]
async fn set_tracer_path(app: AppHandle, state: Shared<'_>, engine: Engine, path: Option<String>) -> Result<discover::TracerInfo, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(p) = &path {
            discover::check(engine, Path::new(p))?;
        }
        let file = config_file(&app, "config.json")?;
        let mut config: store::Config = store::load(&file);
        match &path {
            Some(p) => config.tracer_paths.insert(engine.binary().into(), p.clone()),
            None => config.tracer_paths.remove(engine.binary()),
        };
        store::save(&file, &config)?;
        Ok(resolve_tracer(&app, &state, engine))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedImage {
    data_url: String,
    width: u32,
    height: u32,
    bytes: u64,
    /// Brightness histogram (256 bins) for the threshold control.
    histogram: Vec<u32>,
}

#[tauri::command]
async fn load_image(state: Shared<'_>, path: PathBuf) -> Result<LoadedImage, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let img = state.cache.lock().unwrap().load(&path)?;
        Ok(LoadedImage {
            data_url: raster::png_data_url(&img)?,
            width: img.width(),
            height: img.height(),
            bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            histogram: raster::luma_histogram(&img),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Traces in memory (live preview). With `output`, also writes the SVG there (Run).
#[tauri::command]
async fn trace(app: AppHandle, state: Shared<'_>, request: trace::TraceRequest, output: Option<PathBuf>) -> Result<trace::TraceResult, String> {
    let state = state.inner().clone();
    let binary = tracer_binary(&app, &state, request.engine)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = trace::trace(&state.runner, &state.cache, &binary, &request)?;
        if let Some(out) = output {
            std::fs::write(&out, &result.svg).map_err(|e| format!("cannot write {}: {e}", out.display()))?;
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

#[tauri::command]
fn list_presets(app: AppHandle, engine: Engine) -> Result<serde_json::Value, String> {
    let presets: store::Presets = store::load(&config_file(&app, "presets.json")?);
    Ok(serde_json::to_value(presets.get(engine.binary()).cloned().unwrap_or_default()).unwrap())
}

#[tauri::command]
fn save_preset(app: AppHandle, engine: Engine, name: String, settings: serde_json::Value) -> Result<serde_json::Value, String> {
    let file = config_file(&app, "presets.json")?;
    let mut presets: store::Presets = store::load(&file);
    presets.entry(engine.binary().into()).or_default().insert(name, settings);
    store::save(&file, &presets)?;
    list_presets(app, engine)
}

#[tauri::command]
fn delete_preset(app: AppHandle, engine: Engine, name: String) -> Result<serde_json::Value, String> {
    let file = config_file(&app, "presets.json")?;
    let mut presets: store::Presets = store::load(&file);
    if let Some(p) = presets.get_mut(engine.binary()) {
        p.remove(&name);
    }
    store::save(&file, &presets)?;
    list_presets(app, engine)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AppState::default()))
        .invoke_handler(tauri::generate_handler![
            get_descriptors,
            detect_tracers,
            set_tracer_path,
            load_image,
            trace,
            file_size,
            list_presets,
            save_preset,
            delete_preset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
