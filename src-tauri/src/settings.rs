//! Your settings, shared by every Wallsong window.
//!
//! Stored as one JSON file in the app's config folder
//! (%APPDATA%\app.wallsong.desktop\settings.json). The pages own the defaults and
//! the meaning of most keys; the core only reads the few it acts on itself:
//! `source`, `displays`, `controlsDisplay`, `keepAwake`, `general.desktopIcons`,
//! `controls.bottom` and `card.x` / `card.y`. It also moves old settings forward
//! (`migrate`), which is the one place it edits `dock.items`.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub struct Settings {
    value: Mutex<Value>,
    path: Option<PathBuf>,
}

fn file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"))
}

/// Objects merge key by key; anything else (and `null` to delete) replaces.
pub fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(base), Value::Object(patch)) => {
            for (key, value) in patch {
                if value.is_null() {
                    base.remove(key);
                } else {
                    merge(base.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
        (base, patch) => *base = patch.clone(),
    }
}

/// Brings settings saved by older versions up to date. Returns true if anything changed.
pub fn migrate(value: &mut Value) -> bool {
    let icons = migrate_icon_switch(value);
    let controls = add_controls_tile(value);
    icons || controls
}

/// v0.5.1 adds the Controls tile to the Dock, right after Now Playing (at the end
/// if Now Playing was removed). Done once, marked by `dock.controlsTile`, so taking
/// it out in Edit Dock sticks. Without saved tiles there's nothing to add: the
/// default tiles already include it.
pub fn add_controls_tile(value: &mut Value) -> bool {
    let Some(root) = value.as_object_mut() else { return false };
    let Some(dock) = root.entry("dock").or_insert_with(|| json!({})).as_object_mut() else { return false };
    if dock.get("controlsTile").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if let Some(items) = dock.get_mut("items").and_then(Value::as_array_mut) {
        if !items.iter().any(|item| item["type"] == "controls") {
            let at = items.iter().position(|item| item["type"] == "nowPlaying").map_or(items.len(), |i| i + 1);
            items.insert(at, json!({ "type": "controls" }));
        }
    }
    dock.insert("controlsTile".into(), json!(true));
    true
}

/// v0.4 `general.hideDesktopIcons: bool` became v0.5 `general.desktopIcons: "dock" | "desktop"`.
pub fn migrate_icon_switch(value: &mut Value) -> bool {
    let Some(general) = value.get_mut("general").and_then(Value::as_object_mut) else { return false };
    let Some(hide) = general.remove("hideDesktopIcons") else { return false };
    if !general.contains_key("desktopIcons") {
        let place = if hide.as_bool() == Some(false) { "desktop" } else { "dock" };
        general.insert("desktopIcons".into(), json!(place));
    }
    true
}

impl Settings {
    pub fn load(app: &AppHandle) -> Self {
        let path = file_path(app);
        let mut value = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let migrated = migrate(&mut value);
        let settings = Settings { value: Mutex::new(value), path };
        if migrated {
            // Save straight away so every window reads the new shape.
            if let Err(e) = settings.update(&json!({})) {
                log::warn!("couldn't save migrated settings: {e}");
            }
        }
        settings
    }

    pub fn get(&self) -> Value {
        self.value.lock().map(|v| v.clone()).unwrap_or_else(|_| json!({}))
    }

    /// Applies a partial change, saves it, and returns the full settings.
    pub fn update(&self, patch: &Value) -> Result<Value, String> {
        let mut value = self.value.lock().map_err(|_| "settings are locked")?;
        merge(&mut value, patch);
        if let Some(path) = &self.path {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create the settings folder: {e}"))?;
            }
            let text = serde_json::to_string_pretty(&*value).map_err(|e| e.to_string())?;
            std::fs::write(path, text).map_err(|e| format!("couldn't save settings: {e}"))?;
        }
        Ok(value.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_nested_and_deletes() {
        let mut base = json!({"glow": {"thickness": 1, "style": "flame"}, "keepAwake": true});
        merge(&mut base, &json!({"glow": {"thickness": 2}, "keepAwake": null, "source": "auto"}));
        assert_eq!(base, json!({"glow": {"thickness": 2, "style": "flame"}, "source": "auto"}));
    }

    #[test]
    fn migrates_the_v04_icon_switch() {
        let mut off = json!({"general": {"hideDesktopIcons": false}, "keepAwake": true});
        assert!(migrate_icon_switch(&mut off));
        assert_eq!(off, json!({"general": {"desktopIcons": "desktop"}, "keepAwake": true}));

        let mut on = json!({"general": {"hideDesktopIcons": true}});
        assert!(migrate_icon_switch(&mut on));
        assert_eq!(on, json!({"general": {"desktopIcons": "dock"}}));

        // Already v0.5, or never set: nothing to do.
        let mut new = json!({"general": {"desktopIcons": "desktop"}});
        assert!(!migrate_icon_switch(&mut new));
        assert!(!migrate_icon_switch(&mut json!({})));
    }

    #[test]
    fn adds_the_controls_tile_once() {
        // v0.5 tiles: Controls goes right after Now Playing.
        let mut v05 = json!({"dock": {"items": [{"type": "clock"}, {"type": "nowPlaying"}, {"type": "weather"}]}});
        assert!(add_controls_tile(&mut v05));
        assert_eq!(
            v05,
            json!({"dock": {"items": [{"type": "clock"}, {"type": "nowPlaying"}, {"type": "controls"}, {"type": "weather"}], "controlsTile": true}})
        );

        // Removed afterwards in Edit Dock: it stays removed.
        v05["dock"]["items"] = json!([{"type": "clock"}]);
        assert!(!add_controls_tile(&mut v05));
        assert_eq!(v05["dock"]["items"], json!([{"type": "clock"}]));

        // Now Playing taken out: Controls goes at the end.
        let mut no_song = json!({"dock": {"items": [{"type": "clock"}, {"type": "pin", "path": "C:\\a", "name": "a"}]}});
        assert!(add_controls_tile(&mut no_song));
        assert_eq!(no_song["dock"]["items"][2], json!({"type": "controls"}));

        // No saved tiles (the defaults include it): only marked.
        let mut fresh = json!({});
        assert!(add_controls_tile(&mut fresh));
        assert_eq!(fresh, json!({"dock": {"controlsTile": true}}));
    }

    #[test]
    fn migrate_runs_every_step() {
        let mut old = json!({"general": {"hideDesktopIcons": false}, "dock": {"items": [{"type": "nowPlaying"}]}});
        assert!(migrate(&mut old));
        assert_eq!(old["general"], json!({"desktopIcons": "desktop"}));
        assert_eq!(old["dock"]["items"], json!([{"type": "nowPlaying"}, {"type": "controls"}]));
        // Up to date: nothing more to do.
        assert!(!migrate(&mut old));
    }
}
