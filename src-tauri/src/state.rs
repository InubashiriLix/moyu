use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub background_opacity: f64,
    pub text_opacity: f64,
    pub contrast: f64,
    pub font_size: f64,
    pub line_height: f64,
    pub theme: String,
    pub always_on_top: bool,
    pub shortcut: String,
    pub hide_toolbar: bool,
    pub font_family: String,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            background_opacity: 0.86,
            text_opacity: 1.0,
            contrast: 0.72,
            font_size: 16.0,
            line_height: 1.9,
            theme: "light".into(),
            always_on_top: true,
            shortcut: "Ctrl+Alt+M".into(),
            hide_toolbar: true,
            font_family: "jetbrains".into(),
        }
    }
}

impl Preferences {
    pub fn normalize(&mut self) {
        let defaults = Self::default();
        fn range(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
            if value.is_finite() {
                value.clamp(min, max)
            } else {
                fallback
            }
        }
        self.background_opacity = range(
            self.background_opacity,
            0.0,
            1.0,
            defaults.background_opacity,
        );
        self.text_opacity = range(self.text_opacity, 0.05, 1.0, defaults.text_opacity);
        self.contrast = range(self.contrast, 0.05, 1.0, defaults.contrast);
        self.font_size = range(self.font_size, 10.0, 32.0, defaults.font_size);
        self.line_height = range(self.line_height, 1.2, 2.6, defaults.line_height);
        if !["light", "dark"].contains(&self.theme.as_str()) {
            self.theme = defaults.theme;
        }
        if !["jetbrains", "systemMono", "serif"].contains(&self.font_family.as_str()) {
            self.font_family = defaults.font_family;
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Position {
    pub chapter: usize,
    pub offset: usize,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub id: String,
    pub path: String,
    pub title: String,
    pub encoding: String,
    pub opened_at: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Geometry {
    pub width: f64,
    pub height: f64,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            width: 360.0,
            height: 480.0,
            x: None,
            y: None,
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedState {
    pub preferences: Preferences,
    pub recents: Vec<Recent>,
    pub progress: HashMap<String, Position>,
    pub last_book: Option<String>,
    pub geometry: Geometry,
}

pub struct Store {
    pub saved: Mutex<SavedState>,
    path: PathBuf,
    pub warning: Option<String>,
}

impl Store {
    pub fn load(directory: PathBuf) -> Self {
        let path = directory.join("state.json");
        let (mut saved, warning) = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<SavedState>(&bytes) {
                Ok(state) => (state, None),
                Err(_) => {
                    let backup = directory.join(format!("state.invalid-{}.json", now()));
                    let _ = fs::copy(&path, backup);
                    (
                        SavedState::default(),
                        Some("保存的设置损坏，已备份并恢复默认设置。".into()),
                    )
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (SavedState::default(), None),
            Err(e) => (SavedState::default(), Some(format!("读取设置失败：{e}"))),
        };
        saved.preferences.normalize();
        saved.recents.truncate(20);
        saved.geometry.width = saved.geometry.width.clamp(180.0, 4000.0);
        saved.geometry.height = saved.geometry.height.clamp(120.0, 4000.0);
        Self {
            saved: Mutex::new(saved),
            path,
            warning,
        }
    }

    pub fn persist(&self, saved: &SavedState) -> Result<(), String> {
        let directory = self.path.parent().ok_or("无法保存设置。")?;
        fs::create_dir_all(directory).map_err(|e| format!("创建设置目录失败：{e}"))?;
        let temp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(saved).map_err(|e| e.to_string())?;
        let mut file = fs::File::create(&temp).map_err(|e| format!("保存设置失败：{e}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("保存设置失败：{e}"))?;
        fs::rename(temp, &self.path).map_err(|e| format!("保存设置失败：{e}"))
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trips_and_recovers_corruption() {
        let dir = std::env::temp_dir().join(format!("moyu-state-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = Store::load(dir.clone());
        let mut saved = SavedState::default();
        saved.preferences.font_size = 22.0;
        saved.progress.insert(
            "book".into(),
            Position {
                chapter: 3,
                offset: 104,
            },
        );
        store.persist(&saved).unwrap();
        let recovered = Store::load(dir.clone());
        let state = recovered.saved.lock().unwrap();
        assert_eq!(state.preferences.font_size, 22.0);
        assert_eq!(state.progress["book"].offset, 104);
        drop(state);
        fs::write(dir.join("state.json"), b"broken").unwrap();
        assert!(Store::load(dir.clone()).warning.is_some());
        assert!(fs::read_dir(&dir).unwrap().any(|f| f
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("state.invalid")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preferences_are_bounded() {
        let mut p = Preferences {
            font_size: f64::NAN,
            background_opacity: 4.0,
            text_opacity: -1.0,
            ..Default::default()
        };
        p.normalize();
        assert_eq!(p.font_size, 16.0);
        assert_eq!(p.background_opacity, 1.0);
        assert_eq!(p.text_opacity, 0.05);
    }
}
