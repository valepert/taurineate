//! Small JSON files in the app config dir: tracer path overrides and presets.
//! (Delineate kept these in ./settings relative to the working directory.)

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Config {
    /// Binary path overrides, keyed by engine name ("potrace", "autotrace").
    #[serde(default)]
    pub tracer_paths: BTreeMap<String, String>,
}

/// Presets per engine: engine name -> preset name -> settings (owned by the UI).
pub type Presets = BTreeMap<String, BTreeMap<String, Value>>;

pub fn load<T: Default + for<'de> Deserialize<'de>>(path: &Path) -> T {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_round_trip_and_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/presets.json");
        assert!(load::<Presets>(&path).is_empty());

        let mut presets = Presets::new();
        presets.entry("potrace".into()).or_default().insert("logo".into(), serde_json::json!({"threshold": 40}));
        save(&path, &presets).unwrap();
        assert_eq!(load::<Presets>(&path), presets);
    }
}
