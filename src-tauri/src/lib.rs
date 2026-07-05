//! FS25 Mod Manager backend.
//!
//! Model: a *library* folder holds every downloaded mod/map `.zip`. "Enabling"
//! an item places a link (or copy) of it into the FS25 *mods* folder; disabling
//! removes only that link, never the library original. A small on-disk catalog
//! remembers per-item capability tags so we can flag mods that won't work on the
//! currently active map (e.g. Courseplay on a flat, field-less map).

mod moddesc;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Bump when the on-disk data formats change so future versions can migrate.
const DATA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Config {
    /// Schema version of the app's stored data (config/catalog/scenarios/…).
    #[serde(default = "one")]
    version: u32,
    /// Folder that holds all downloaded mod/map zips.
    library_dir: String,
    /// The FS25 `mods` folder that the game reads.
    mods_dir: String,
    /// "symlink" | "hardlink" | "copy".
    link_mode: String,
    /// Filename of the map the user is currently playing, if any.
    active_map: Option<String>,
    /// GitHub repo (owner/name) used for backup/sync, if configured.
    #[serde(default)]
    sync_repo: Option<String>,
    /// Developer mode: surfaces the action log, paths and extra diagnostics.
    #[serde(default)]
    dev_mode: bool,
}

fn default_mods_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        dirs::document_dir()
            .unwrap_or_default()
            .join("My Games")
            .join("FarmingSimulator2025")
            .join("mods")
    } else if cfg!(target_os = "macos") {
        dirs::home_dir()
            .unwrap_or_default()
            .join("Library/Application Support/FarmingSimulator2025/mods")
    } else {
        dirs::home_dir()
            .unwrap_or_default()
            .join(".local/share/FarmingSimulator2025/mods")
    }
}

fn default_link_mode() -> String {
    // Hardlinks everywhere: FS25's engine does NOT follow symlinks in the mods
    // folder (it fails to read the zip), and on Windows symlinks also need admin.
    // Hardlinks appear to the game as real files, cost no extra disk, and are
    // instant even for huge maps. (Same-volume only; place() falls back to copy.)
    "hardlink".into()
}

fn one() -> u32 {
    1
}

fn default_config() -> Config {
    let library = dirs::document_dir()
        .unwrap_or_default()
        .join("FS25ModLibrary");
    Config {
        version: DATA_VERSION,
        library_dir: library.to_string_lossy().into_owned(),
        mods_dir: default_mods_dir().to_string_lossy().into_owned(),
        link_mode: default_link_mode(),
        active_map: None,
        sync_repo: None,
        dev_mode: false,
    }
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    /// Milliseconds since the Unix epoch (formatted client-side).
    ts: u64,
    level: String,
    message: String,
}

/// Append a timestamped line to the rolling action log (`app.log` in the config
/// dir). Best-effort: never fails a command if logging can't write. Lines are
/// `<epoch_ms>\t<level>\t<message>`; the file is trimmed when it gets large.
fn log_line(app: &AppHandle, level: &str, message: &str) {
    use std::io::Write;
    let Ok(dir) = config_dir(app) else { return };
    let path = dir.join("app.log");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let line = format!("{ts}\t{level}\t{}\n", message.replace(['\n', '\t'], " "));
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
    // Keep the log bounded: once it passes ~512 KB, keep the last 1000 lines.
    if fs::metadata(&path)
        .map(|m| m.len() > 512 * 1024)
        .unwrap_or(false)
    {
        if let Ok(content) = fs::read_to_string(&path) {
            let lines: Vec<&str> = content.lines().collect();
            let start = lines.len().saturating_sub(1000);
            let _ = fs::write(&path, format!("{}\n", lines[start..].join("\n")));
        }
    }
}

#[tauri::command]
fn get_log(app: AppHandle) -> Result<Vec<LogEntry>, String> {
    let path = config_dir(&app)?.join("app.log");
    let Ok(content) = fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    let mut entries: Vec<LogEntry> = content
        .lines()
        .filter_map(|l| {
            let mut it = l.splitn(3, '\t');
            let ts = it.next()?.parse::<u64>().ok()?;
            let level = it.next()?.to_string();
            let message = it.next().unwrap_or("").to_string();
            Some(LogEntry { ts, level, message })
        })
        .collect();
    // Return the most recent 500, newest first.
    let start = entries.len().saturating_sub(500);
    entries.drain(..start);
    entries.reverse();
    Ok(entries)
}

#[tauri::command]
fn clear_log(app: AppHandle) -> Result<(), String> {
    let path = config_dir(&app)?.join("app.log");
    if path.exists() {
        fs::write(&path, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Key filesystem paths, for the developer-mode diagnostics panel.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPaths {
    config_dir: String,
    library_dir: String,
    mods_dir: String,
    log_file: String,
}

#[tauri::command]
fn app_paths(app: AppHandle) -> Result<AppPaths, String> {
    let dir = config_dir(&app)?;
    let cfg = load_config(&app)?;
    Ok(AppPaths {
        log_file: dir.join("app.log").to_string_lossy().into_owned(),
        config_dir: dir.to_string_lossy().into_owned(),
        library_dir: cfg.library_dir,
        mods_dir: cfg.mods_dir,
    })
}

/// Open a folder in the OS file manager (developer-mode "reveal" buttons).
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut c = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut c = std::process::Command::new("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut c = std::process::Command::new("xdg-open");
    c.arg(&path);
    c.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Live telemetry written by the FS25_ScenarioCompanion in-game mod into
/// `<savegame>/scenarioCompanion.xml` each in-game hour.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionData {
    money: Option<f64>,
    loan: Option<f64>,
    day: Option<i64>,
    days_per_period: Option<i64>,
    period: Option<i64>,
    hour: Option<i64>,
    /// File modified time (ms since epoch, wall clock) — for freshness.
    updated_ms: Option<u64>,
}

#[tauri::command]
fn read_companion(app: AppHandle, slot: String) -> Result<Option<CompanionData>, String> {
    safe_filename(&slot)?;
    let cfg = load_config(&app)?;
    let path = game_dir(&cfg).join(&slot).join("scenarioCompanion.xml");
    if !path.exists() {
        return Ok(None);
    }
    let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let doc = roxmltree::Document::parse(strip_bom(&s)).map_err(|e| e.to_string())?;
    let num = |tag: &str| xml_text(&doc, tag).and_then(|v| v.parse::<f64>().ok());
    let int = |tag: &str| xml_text(&doc, tag).and_then(|v| v.parse::<i64>().ok());
    let updated_ms = fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(Some(CompanionData {
        money: num("money"),
        loan: num("loan"),
        day: int("day"),
        days_per_period: int("daysPerPeriod"),
        period: int("period"),
        hour: int("hour"),
        updated_ms,
    }))
}

/// One point in a scenario's history — one in-game day.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Sample {
    day: i64,
    days_per_period: i64,
    cash: f64,
    debt: f64,
    equipment: f64,
}

/// Build a scenario's day-ordered history for the rule engine, merging (a) any
/// persisted history, (b) the companion mod's daily history file, and (c) the
/// current save snapshot (which alone knows equipment value). The merged result
/// is persisted per scenario so it accumulates even across sessions / sources.
#[tauri::command]
fn scenario_history(
    app: AppHandle,
    scenario_id: String,
    slot: String,
) -> Result<Vec<Sample>, String> {
    safe_filename(&slot)?;
    let key: String = scenario_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-')
        .collect();
    if key.is_empty() {
        return Err("bad scenario id".into());
    }
    let cfg = load_config(&app)?;
    let base = game_dir(&cfg).join(&slot);
    let hist_dir = config_dir(&app)?.join("history");
    fs::create_dir_all(&hist_dir).ok();
    let hist_path = hist_dir.join(format!("{key}.json"));

    // In-game calendar: current day + days-per-period.
    let (cur_day, dpp) = (|| {
        let env = fs::read_to_string(base.join("environment.xml")).ok()?;
        let doc = roxmltree::Document::parse(strip_bom(&env)).ok()?;
        let day = xml_text(&doc, "currentDay")?.parse::<i64>().ok()?;
        let dpp = xml_text(&doc, "daysPerPeriod")
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|d| *d > 0)
            .unwrap_or(1);
        Some((day, dpp))
    })()
    .unwrap_or((0, 1));

    // Start from persisted history.
    let mut byday: std::collections::BTreeMap<i64, Sample> = fs::read_to_string(&hist_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Sample>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|s| (s.day, s))
        .collect();

    // Merge the companion's daily history (authoritative cash/debt per day).
    if let Ok(s) = fs::read_to_string(base.join("scenarioCompanionHistory.xml")) {
        if let Ok(doc) = roxmltree::Document::parse(strip_bom(&s)) {
            for n in doc
                .root_element()
                .descendants()
                .filter(|n| n.has_tag_name("s"))
            {
                if let Some(day) = n.attribute("day").and_then(|v| v.parse::<i64>().ok()) {
                    let cash = n
                        .attribute("cash")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0.0);
                    let debt = n
                        .attribute("loan")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0.0);
                    let equipment = byday.get(&day).map(|x| x.equipment).unwrap_or(0.0);
                    byday.insert(
                        day,
                        Sample {
                            day,
                            days_per_period: dpp,
                            cash,
                            debt,
                            equipment,
                        },
                    );
                }
            }
        }
    }

    // Current save snapshot — the only source with equipment (vehicle) value.
    if base.join("careerSavegame.xml").exists() {
        let money = (|| {
            let s = fs::read_to_string(base.join("careerSavegame.xml")).ok()?;
            let doc = roxmltree::Document::parse(strip_bom(&s)).ok()?;
            xml_text(&doc, "money")?.parse::<f64>().ok()
        })();
        let (loan, farm_id) = match read_player_farm(&base.join("farms.xml"), money) {
            Some((l, id)) => (l.unwrap_or(0.0), Some(id)),
            None => (0.0, None),
        };
        let equipment = farm_id
            .as_ref()
            .map(|fid| sum_owned_prices(&base.join("vehicles.xml"), fid))
            .unwrap_or(0.0);
        byday.insert(
            cur_day,
            Sample {
                day: cur_day,
                days_per_period: dpp,
                cash: money.unwrap_or(0.0),
                debt: loan,
                equipment,
            },
        );
    }

    // Forward-fill equipment onto companion-only days (which lack it) so "net"
    // over history isn't jumpy.
    let mut out: Vec<Sample> = byday.into_values().collect();
    let mut last_equip = 0.0;
    for s in out.iter_mut() {
        if s.equipment > 0.0 {
            last_equip = s.equipment;
        } else if last_equip > 0.0 {
            s.equipment = last_equip;
        }
    }

    let _ = fs::write(&hist_path, serde_json::to_string(&out).unwrap_or_default());
    Ok(out)
}

fn load_config(app: &AppHandle) -> Result<Config, String> {
    let path = config_dir(app)?.join("config.json");
    if path.exists() {
        let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| e.to_string())
    } else {
        let cfg = default_config();
        write_config(app, &cfg)?;
        Ok(cfg)
    }
}

fn write_config(app: &AppHandle, cfg: &Config) -> Result<(), String> {
    let path = config_dir(app)?.join("config.json");
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, s).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Catalog: per-item capability metadata, keyed by filename.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct ItemMeta {
    /// "map" | "mod" — overrides the auto-detected kind.
    #[serde(default)]
    kind: String,
    /// Library category (e.g. "Vehicles", "Tools", "Scripts", "Map").
    #[serde(default)]
    category: String,
    /// Free-form user tags.
    #[serde(default)]
    tags: Vec<String>,
    /// Capabilities a *mod* needs from the active map (e.g. "fields").
    #[serde(default)]
    requires: Vec<String>,
    /// Capabilities a *map* provides (e.g. "fields", "selling-points").
    #[serde(default)]
    provides: Vec<String>,
    #[serde(default)]
    notes: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Catalog {
    items: HashMap<String, ItemMeta>,
}

fn load_catalog(app: &AppHandle) -> Result<Catalog, String> {
    let path = config_dir(app)?.join("catalog.json");
    if path.exists() {
        let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| e.to_string())
    } else {
        Ok(Catalog::default())
    }
}

fn write_catalog(app: &AppHandle, cat: &Catalog) -> Result<(), String> {
    let path = config_dir(app)?.join("catalog.json");
    let s = serde_json::to_string_pretty(cat).map_err(|e| e.to_string())?;
    fs::write(path, s).map_err(|e| e.to_string())
}

/// Seed sensible defaults the first time we see a mod, so compatibility works
/// out of the box for well-known mods without the user configuring anything.
fn seed_meta(filename: &str, is_map: bool) -> ItemMeta {
    let f = filename.to_lowercase();
    let (requires, provides) = if is_map {
        // Flat / empty maps deliberately provide nothing; ordinary maps provide
        // the usual capabilities. Both are user-editable afterwards.
        let provides = if f.contains("flat") || f.contains("empty") {
            vec![]
        } else {
            vec![
                "fields".to_string(),
                "roads".to_string(),
                "selling-points".to_string(),
            ]
        };
        (vec![], provides)
    } else {
        let requires = if f.contains("courseplay") {
            vec!["fields".to_string(), "roads".to_string()]
        } else if f.contains("autodrive") {
            vec!["roads".to_string()]
        } else {
            vec![]
        };
        (requires, vec![])
    };
    ItemMeta {
        kind: if is_map { "map".into() } else { "mod".into() },
        category: guess_category(&f, is_map),
        tags: vec![],
        requires,
        provides,
        notes: String::new(),
    }
}

/// Rough first-guess category from the filename; user-editable afterwards.
fn guess_category(lower_filename: &str, is_map: bool) -> String {
    if is_map {
        return "Map".into();
    }
    let f = lower_filename;
    let has = |words: &[&str]| words.iter().any(|w| f.contains(w));
    if has(&[
        "courseplay",
        "autodrive",
        "script",
        "hud",
        "helper",
        "guidance",
    ]) {
        "Scripts".into()
    } else if has(&[
        "barn",
        "shed",
        "silo",
        "workshop",
        "garage",
        "building",
        "stable",
        "greenhouse",
    ]) {
        "Buildings".into()
    } else if has(&[
        "plow",
        "seeder",
        "trailer",
        "cultivator",
        "mower",
        "baler",
        "loader",
        "header",
        "tool",
        "plough",
        "harrow",
        "spreader",
    ]) {
        "Tools".into()
    } else if has(&["pack"]) {
        "Packs".into()
    } else if has(&[
        "tractor",
        "harvester",
        "combine",
        "truck",
        "car",
        "loader",
        "excavator",
        "vario",
        "silverado",
    ]) {
        "Vehicles".into()
    } else {
        "Other".into()
    }
}

// ---------------------------------------------------------------------------
// Item listing sent to the frontend.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModItem {
    filename: String,
    title: String,
    author: String,
    version: String,
    kind: String,
    category: String,
    enabled: bool,
    is_active_map: bool,
    tags: Vec<String>,
    requires: Vec<String>,
    provides: Vec<String>,
    notes: String,
    compatible: bool,
    incompat_reasons: Vec<String>,
    size: u64,
    description: String,
    /// Mod names this depends on (from modDesc <dependencies>).
    dependencies: Vec<String>,
    /// Set if we couldn't read the archive's modDesc.xml.
    error: Option<String>,
}

fn is_zip(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
}

/// Reject anything that isn't a bare filename to avoid path traversal.
fn safe_filename(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("unsafe filename: {name}"));
    }
    Ok(())
}

fn scan(app: &AppHandle) -> Result<Vec<ModItem>, String> {
    let cfg = load_config(app)?;
    let mut catalog = load_catalog(app)?;
    let library = PathBuf::from(&cfg.library_dir);
    let mods = PathBuf::from(&cfg.mods_dir);

    // Make sure the library exists so a first run doesn't error out.
    fs::create_dir_all(&library).ok();

    let mut catalog_dirty = false;
    let mut raw: Vec<(String, moddesc::ModDesc, Option<String>, u64)> = Vec::new();

    let entries = fs::read_dir(&library).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_zip(&path) {
            continue;
        }
        let filename = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let (desc, error) = match moddesc::parse(&path) {
            Ok(d) => (d, None),
            Err(e) => (moddesc::ModDesc::default(), Some(e)),
        };

        // Seed catalog on first sight; afterwards the catalog is source of truth.
        if !catalog.items.contains_key(&filename) {
            catalog
                .items
                .insert(filename.clone(), seed_meta(&filename, desc.is_map));
            catalog_dirty = true;
        }
        raw.push((filename, desc, error, size));
    }

    if catalog_dirty {
        write_catalog(app, &catalog)?;
    }

    // Resolve the active map's provided capabilities up front.
    let active_provides: Vec<String> = cfg
        .active_map
        .as_ref()
        .and_then(|m| catalog.items.get(m))
        .map(|meta| meta.provides.clone())
        .unwrap_or_default();
    let have_active_map = cfg.active_map.is_some();

    let mut items: Vec<ModItem> = raw
        .into_iter()
        .map(|(filename, desc, error, size)| {
            let meta = catalog.items.get(&filename).cloned().unwrap_or_default();
            let kind = if meta.kind.is_empty() {
                if desc.is_map {
                    "map".into()
                } else {
                    "mod".into()
                }
            } else {
                meta.kind.clone()
            };
            let category = if meta.category.is_empty() {
                guess_category(&filename.to_lowercase(), kind == "map")
            } else {
                meta.category.clone()
            };
            let enabled = mods.join(&filename).symlink_metadata().is_ok();
            let is_active_map = cfg.active_map.as_deref() == Some(filename.as_str());

            // A mod is incompatible if it needs a capability the active map
            // doesn't provide. Maps themselves are always "compatible".
            let mut incompat_reasons = Vec::new();
            if kind == "mod" && have_active_map {
                for req in &meta.requires {
                    if !active_provides.contains(req) {
                        incompat_reasons.push(req.clone());
                    }
                }
            }
            let title = if desc.title.is_empty() {
                filename.trim_end_matches(".zip").to_string()
            } else {
                desc.title.clone()
            };

            ModItem {
                filename,
                title,
                author: desc.author,
                version: desc.version,
                kind,
                category,
                enabled,
                is_active_map,
                tags: meta.tags,
                requires: meta.requires,
                provides: meta.provides,
                notes: meta.notes,
                compatible: incompat_reasons.is_empty(),
                incompat_reasons,
                size,
                description: desc.description,
                dependencies: desc.dependencies,
                error,
            }
        })
        .collect();

    items.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });
    Ok(items)
}

// ---------------------------------------------------------------------------
// Enable / disable: place or remove the link in the mods folder.
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn make_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(windows)]
fn make_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(src, dst)
}

fn place(src: &Path, dst: &Path, mode: &str) -> Result<(), String> {
    let result = match mode {
        "copy" => fs::copy(src, dst).map(|_| ()),
        "hardlink" => fs::hard_link(src, dst),
        _ => make_symlink(src, dst),
    };
    // Hardlinks fail across volumes; symlinks can fail without privilege on
    // Windows. Fall back to a plain copy so enabling never silently no-ops.
    result
        .or_else(|_| fs::copy(src, dst).map(|_| ()))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_config(app: AppHandle) -> Result<Config, String> {
    load_config(&app)
}

/// Launch Farming Simulator 25 via Steam (appid 2300320). Uses the OS URL
/// handler directly — the opener plugin blocks non-web schemes like steam://.
#[tauri::command]
fn launch_game() -> Result<(), String> {
    let url = "steam://run/2300320";
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", url]);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_config(app: AppHandle, config: Config) -> Result<(), String> {
    write_config(&app, &config)
}

#[tauri::command]
fn list_items(app: AppHandle) -> Result<Vec<ModItem>, String> {
    scan(&app)
}

/// Enable/disable a single item against an already-loaded config.
fn apply_enabled(cfg: &Config, filename: &str, enabled: bool) -> Result<(), String> {
    let src = PathBuf::from(&cfg.library_dir).join(filename);
    let dst = PathBuf::from(&cfg.mods_dir).join(filename);

    if enabled {
        if !src.exists() {
            return Err(format!("{filename} is not in the library folder"));
        }
        fs::create_dir_all(&cfg.mods_dir).map_err(|e| e.to_string())?;
        if dst.symlink_metadata().is_ok() {
            return Ok(()); // already present
        }
        place(&src, &dst, &cfg.link_mode)?;
    } else if dst.symlink_metadata().is_ok() {
        // Removes the link/copy in the mods folder only; the library keeps its
        // own copy (true for symlink, hardlink and copy modes alike).
        fs::remove_file(&dst).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_enabled(app: AppHandle, filename: String, enabled: bool) -> Result<(), String> {
    safe_filename(&filename)?;
    let cfg = load_config(&app)?;
    apply_enabled(&cfg, &filename, enabled)?;
    log_line(
        &app,
        "info",
        &format!(
            "{} {filename}",
            if enabled { "enabled" } else { "disabled" }
        ),
    );
    Ok(())
}

#[tauri::command]
fn set_enabled_many(app: AppHandle, filenames: Vec<String>, enabled: bool) -> Result<(), String> {
    for f in &filenames {
        safe_filename(f)?;
    }
    let cfg = load_config(&app)?;
    for f in &filenames {
        apply_enabled(&cfg, f, enabled)?;
    }
    log_line(
        &app,
        "info",
        &format!(
            "{} {} mod(s)",
            if enabled { "enabled" } else { "disabled" },
            filenames.len()
        ),
    );
    Ok(())
}

#[tauri::command]
fn set_active_map(app: AppHandle, filename: Option<String>) -> Result<(), String> {
    if let Some(ref f) = filename {
        safe_filename(f)?;
    }
    let mut cfg = load_config(&app)?;
    cfg.active_map = filename;
    write_config(&app, &cfg)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    imported: usize,
    skipped: usize,
}

/// Adopt mods the user dropped straight into the game's mods folder: move each
/// real (non-symlink) zip into the library, then re-link it back so it stays
/// active in-game. Zips already present in the library are left alone.
#[tauri::command]
fn import_from_mods(app: AppHandle) -> Result<ImportResult, String> {
    let cfg = load_config(&app)?;
    let mods = PathBuf::from(&cfg.mods_dir);
    let library = PathBuf::from(&cfg.library_dir);
    fs::create_dir_all(&library).map_err(|e| e.to_string())?;

    let mut imported = 0;
    let mut skipped = 0;
    let entries = match fs::read_dir(&mods) {
        Ok(e) => e,
        Err(_) => return Ok(ImportResult { imported, skipped }),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // DirEntry::metadata does not follow symlinks, so this skips links we
        // already manage and only adopts real files.
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() || !meta.is_file() || !is_zip(&path) {
            continue;
        }
        let filename = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let dest = library.join(&filename);
        if dest.exists() {
            skipped += 1;
            continue;
        }
        // Move into the library; fall back to copy+delete across volumes.
        if fs::rename(&path, &dest).is_err() {
            fs::copy(&path, &dest).map_err(|e| e.to_string())?;
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        // Re-link so the mod stays enabled in-game.
        apply_enabled(&cfg, &filename, true)?;
        imported += 1;
    }
    Ok(ImportResult { imported, skipped })
}

// ---------------------------------------------------------------------------
// ModHub: a SQLite catalog of scraped entries + a direct downloader.
// ---------------------------------------------------------------------------

const MODHUB_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModHubEntry {
    mod_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    image: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    label: String,
}

fn modhub_db(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    let path = config_dir(app)?.join("modhub.db");
    let conn = rusqlite::Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS mods (
            mod_id TEXT PRIMARY KEY,
            title TEXT, author TEXT, image TEXT, url TEXT,
            category TEXT, label TEXT, cached_at INTEGER
         )",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
fn modhub_upsert(app: AppHandle, entries: Vec<ModHubEntry>, cached_at: i64) -> Result<(), String> {
    let conn = modhub_db(&app)?;
    for e in &entries {
        conn.execute(
            "INSERT INTO mods (mod_id,title,author,image,url,category,label,cached_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(mod_id) DO UPDATE SET
                title=?2, author=?3, image=?4, url=?5,
                category=CASE WHEN ?6<>'' THEN ?6 ELSE category END,
                label=?7, cached_at=?8",
            rusqlite::params![
                e.mod_id, e.title, e.author, e.image, e.url, e.category, e.label, cached_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn modhub_all(app: AppHandle) -> Result<Vec<ModHubEntry>, String> {
    let conn = modhub_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT mod_id,title,author,image,url,category,label FROM mods ORDER BY title")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ModHubEntry {
                mod_id: r.get(0)?,
                title: r.get(1)?,
                author: r.get(2)?,
                image: r.get(3)?,
                url: r.get(4)?,
                category: r.get(5)?,
                label: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Fetch a ModHub CDN image (which blocks hot-linking without a Referer that the
/// webview's <img> can't send) and return it as a data URI, cached on disk.
#[tauri::command]
async fn fetch_image(app: AppHandle, url: String) -> Result<String, String> {
    if !url.starts_with("https://") || !url.contains("giants-software.com") {
        return Err("unsupported image host".into());
    }
    let key: String = url
        .rsplit('/')
        .take(2)
        .collect::<Vec<_>>()
        .join("_")
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '_')
        .collect();
    let cache = config_dir(&app)?.join("imgcache");
    fs::create_dir_all(&cache).ok();
    let cachefile = cache.join(format!("{key}.datauri"));
    if let Ok(s) = fs::read_to_string(&cachefile) {
        return Ok(s);
    }

    let client = reqwest::Client::builder()
        .user_agent(MODHUB_UA)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("Referer", "https://www.farming-simulator.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    use base64::Engine;
    let data_uri = format!(
        "data:{ctype};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );
    let _ = fs::write(&cachefile, &data_uri);
    Ok(data_uri)
}

/// Download a mod straight from ModHub into the library: fetch its page, find
/// the CDN zip link, and download it with the page as Referer (the CDN blocks
/// hot-linking without it). Returns the saved filename.
#[tauri::command]
async fn download_mod(app: AppHandle, mod_id: String) -> Result<String, String> {
    if !mod_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("invalid mod id".into());
    }
    let cfg = load_config(&app)?;
    let detail_url =
        format!("https://www.farming-simulator.com/mod.php?mod_id={mod_id}&title=fs2025");

    let client = reqwest::Client::builder()
        .user_agent(MODHUB_UA)
        .build()
        .map_err(|e| e.to_string())?;

    let html = client
        .get(&detail_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let re = regex::Regex::new(
        r#"https://cdn\d+\.giants-software\.com/modHub/storage/\d+/[^"'\s]+\.zip"#,
    )
    .map_err(|e| e.to_string())?;
    let zip_url = re
        .find(&html)
        .ok_or("no download link found on the mod page")?
        .as_str()
        .to_string();

    let filename = zip_url.rsplit('/').next().unwrap_or("mod.zip").to_string();
    safe_filename(&filename)?;

    let library = PathBuf::from(&cfg.library_dir);
    fs::create_dir_all(&library).map_err(|e| e.to_string())?;
    // Download to a temp file first so a partial/failed download never leaves a
    // corrupt zip in the library.
    let dest = library.join(&filename);
    let tmp = library.join(format!("{filename}.part"));

    let resp = client
        .get(&zip_url)
        .header("Referer", &detail_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    // Stream the response straight to disk instead of buffering it all in RAM,
    // so a 700 MB map won't blow up memory.
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    log_line(
        &app,
        "info",
        &format!("downloaded {filename} (mod {mod_id})"),
    );
    Ok(filename)
}

#[tauri::command]
fn update_meta(app: AppHandle, filename: String, meta: ItemMeta) -> Result<(), String> {
    safe_filename(&filename)?;
    let mut catalog = load_catalog(&app)?;
    catalog.items.insert(filename, meta);
    write_catalog(&app, &catalog)
}

// ---------------------------------------------------------------------------
// Scenarios: a named challenge = a map + a starting kit of mods + a money goal,
// optionally tracked against a real savegame.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    /// Preset this scenario came from (e.g. "realistic"), informational.
    #[serde(default)]
    mode: String,
    /// Rule ids evaluated live against the linked savegame.
    #[serde(default)]
    rules: Vec<String>,
    /// Library filename of the map this scenario is played on.
    #[serde(default)]
    map: Option<String>,
    /// Library filenames of mods the scenario starts with.
    #[serde(default)]
    required_mods: Vec<String>,
    /// Free-text starting equipment/setup notes.
    #[serde(default)]
    starting_kit: String,
    #[serde(default)]
    start_money: Option<f64>,
    #[serde(default)]
    goal_money: Option<f64>,
    /// Deadline to reach the goal, in in-game years.
    #[serde(default)]
    deadline_years: Option<f64>,
    /// Savegame folder name (e.g. "savegame1") to track progress against.
    #[serde(default)]
    savegame_slot: Option<String>,
    /// If set, the Aug–Dec warm-up window is free capital-building time and the
    /// deadline only starts counting from the following January.
    #[serde(default)]
    warmup_to_january: bool,
    /// Rule-engine conditions (evaluated client-side against the history). Stored
    /// as pass-through objects; the frontend owns their semantics.
    #[serde(default)]
    engine_rules: Vec<EngineRule>,
}

/// A rule-engine condition, persisted on a scenario. The backend only stores and
/// returns these; the frontend (rules.ts) defines and evaluates them.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EngineRule {
    id: String,
    metric: String,
    op: String,
    value: f64,
    when: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    months: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    consecutive: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

fn load_scenarios(app: &AppHandle) -> Result<Vec<Scenario>, String> {
    let path = config_dir(app)?.join("scenarios.json");
    if path.exists() {
        let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| e.to_string())
    } else {
        Ok(Vec::new())
    }
}

fn write_scenarios(app: &AppHandle, list: &[Scenario]) -> Result<(), String> {
    let path = config_dir(app)?.join("scenarios.json");
    let s = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(path, s).map_err(|e| e.to_string())
}

/// FS25 keeps savegames next to the mods folder, so the game user dir is the
/// mods folder's parent.
fn game_dir(cfg: &Config) -> PathBuf {
    PathBuf::from(&cfg.mods_dir)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(&cfg.mods_dir))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveInfo {
    slot: String,
    name: String,
    map_title: String,
    money: Option<f64>,
    /// Outstanding loan / line-of-credit debt from farms.xml.
    loan: Option<f64>,
    /// Purchase-price value of owned vehicles + placeables (approximate; the
    /// game's own figure uses depreciated sell values and includes land).
    asset_value: Option<f64>,
    /// Purchase-price value of owned vehicles only — excludes a map's pre-placed
    /// farmstead buildings, so it reflects equipment the player actually bought.
    vehicle_value: Option<f64>,
    play_time_hours: Option<f64>,
    /// Approximate in-game years elapsed (12 periods = 1 year).
    years_elapsed: Option<f64>,
    /// modName of every mod this save depends on (from careerSavegame.xml).
    mods: Vec<String>,
    /// The map's `<mapId>`, e.g. "FS25_ronidaIslandCp.ronidaIslandCP_nt". The
    /// part before the first '.' is the map mod's zip stem — a reliable map
    /// identity even when a mod bundles several map variants under one title.
    map_id: Option<String>,
}

/// roxmltree errors on a leading UTF-8 BOM, which FS25's save XML files carry.
fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

/// Pull the first `<tag>` descendant's trimmed text from an XML document.
fn xml_text(doc: &roxmltree::Document, tag: &str) -> Option<String> {
    doc.root_element()
        .descendants()
        .find(|n| n.has_tag_name(tag))
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
}

/// Find the player's farm in farms.xml — the farm whose money matches the
/// career money, falling back to the first farm. Returns (loan, farmId).
fn read_player_farm(path: &Path, career_money: Option<f64>) -> Option<(Option<f64>, String)> {
    let s = fs::read_to_string(path).ok()?;
    let doc = roxmltree::Document::parse(strip_bom(&s)).ok()?;
    let farms: Vec<_> = doc
        .root_element()
        .descendants()
        .filter(|n| n.has_tag_name("farm") && n.attribute("farmId").is_some())
        .collect();
    let farm = career_money
        .and_then(|m| {
            farms
                .iter()
                .find(|f| {
                    f.attribute("money")
                        .and_then(|v| v.parse::<f64>().ok())
                        .map(|fm| (fm - m).abs() < 1.0)
                        .unwrap_or(false)
                })
                .copied()
        })
        .or_else(|| farms.first().copied())?;
    let loan = farm.attribute("loan").and_then(|v| v.parse::<f64>().ok());
    Some((loan, farm.attribute("farmId")?.to_string()))
}

/// Sum the `price` of every OWNED vehicle/placeable belonging to `farm_id`.
fn sum_owned_prices(path: &Path, farm_id: &str) -> f64 {
    (|| -> Option<f64> {
        let s = fs::read_to_string(path).ok()?;
        let doc = roxmltree::Document::parse(strip_bom(&s)).ok()?;
        let mut total = 0.0;
        for n in doc.root_element().descendants() {
            // Only value top-level assets, never nested child nodes.
            if !(n.has_tag_name("vehicle") || n.has_tag_name("placeable")) {
                continue;
            }
            if n.attribute("farmId") != Some(farm_id) {
                continue;
            }
            // Leased vehicles aren't owned assets.
            if matches!(n.attribute("propertyState"), Some(s) if s != "OWNED") {
                continue;
            }
            if let Some(price) = n.attribute("price").and_then(|v| v.parse::<f64>().ok()) {
                total += price;
            }
        }
        Some(total)
    })()
    .unwrap_or(0.0)
}

/// FS25 new games begin in period 6 (August), so a brand-new save already sits
/// at `currentDay = 6` (with 1 day/period). Anchor elapsed time to that start so
/// loading a fresh game reads as 0 years, not half a year.
const START_PERIOD: f64 = 6.0;

/// Approximate in-game years elapsed since the game began: 12 periods (months)
/// make a year, measured from the August start (never negative).
fn years_elapsed(current_day: f64, days_per_period: f64) -> f64 {
    let dpp = if days_per_period > 0.0 {
        days_per_period
    } else {
        1.0
    };
    // Continuous count of periods since day 1, minus the 5 periods the calendar
    // is already into the year at the August start.
    let periods_elapsed = (current_day - 1.0) / dpp;
    ((periods_elapsed - (START_PERIOD - 1.0)) / 12.0).max(0.0)
}

fn read_save(dir: &Path, slot: &str) -> Option<SaveInfo> {
    let base = dir.join(slot);
    let raw = fs::read_to_string(base.join("careerSavegame.xml")).ok()?;
    let doc = roxmltree::Document::parse(strip_bom(&raw)).ok()?;
    let text = |tag: &str| xml_text(&doc, tag);

    let money = text("money").and_then(|s| s.parse::<f64>().ok());
    let play_time_hours = text("playTime")
        .and_then(|s| s.parse::<f64>().ok())
        .map(|min| min / 60.0);

    // The mods this save depends on, e.g. <mod modName="FS25_Courseplay" .../>.
    let mods: Vec<String> = doc
        .root_element()
        .descendants()
        .filter(|n| n.has_tag_name("mod"))
        .filter_map(|n| n.attribute("modName").map(str::to_string))
        .collect();

    // In-game calendar lives in environment.xml: currentDay counts elapsed
    // in-game days, daysPerPeriod is how many days a period (month) lasts, and
    // 12 periods make a year. The parsed Document borrows the file string, so
    // keep both alive together inside this closure and return an owned number.
    let years_elapsed = (|| {
        let env = fs::read_to_string(base.join("environment.xml")).ok()?;
        let env_doc = roxmltree::Document::parse(strip_bom(&env)).ok()?;
        let current_day = xml_text(&env_doc, "currentDay")?.parse::<f64>().ok()?;
        let days_per_period = xml_text(&env_doc, "daysPerPeriod")
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|d| *d > 0.0)
            .unwrap_or(1.0);
        Some(years_elapsed(current_day, days_per_period))
    })();

    // Identify the player's farm to read its debt, then value its owned assets.
    let (loan, farm_id) = match read_player_farm(&base.join("farms.xml"), money) {
        Some((l, id)) => (l, Some(id)),
        None => (None, None),
    };
    // Value owned vehicles separately from buildings: a map's pre-placed
    // farmstead placeables (barns, etc.) are assigned to the player's farm even
    // on a "Start From Scratch" game, so total assets overstate what the player
    // actually accumulated. Vehicle value is the honest "have you built up a
    // fleet" signal used by the zero-start seed check.
    let (vehicle_value, asset_value) = match farm_id.as_ref() {
        Some(fid) => {
            let v = sum_owned_prices(&base.join("vehicles.xml"), fid);
            let p = sum_owned_prices(&base.join("placeables.xml"), fid);
            (Some(v), Some(v + p))
        }
        None => (None, None),
    };

    Some(SaveInfo {
        slot: slot.to_string(),
        name: text("savegameName").unwrap_or_else(|| slot.to_string()),
        map_title: text("mapTitle").unwrap_or_default(),
        money,
        loan,
        asset_value,
        vehicle_value,
        play_time_hours,
        years_elapsed,
        mods,
        map_id: text("mapId"),
    })
}

#[tauri::command]
fn list_savegames(app: AppHandle) -> Result<Vec<SaveInfo>, String> {
    let cfg = load_config(&app)?;
    let dir = game_dir(&cfg);
    let mut saves: Vec<SaveInfo> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // savegameN folders only, and only those with a career file.
            if name.starts_with("savegame") && entry.path().is_dir() {
                if let Some(info) = read_save(&dir, &name) {
                    saves.push(info);
                }
            }
        }
    }
    // Natural-ish ordering by trailing number.
    saves.sort_by_key(|s| {
        s.slot
            .trim_start_matches("savegame")
            .parse::<u32>()
            .unwrap_or(u32::MAX)
    });
    Ok(saves)
}

#[tauri::command]
fn list_scenarios(app: AppHandle) -> Result<Vec<Scenario>, String> {
    load_scenarios(&app)
}

#[tauri::command]
fn save_scenario(app: AppHandle, scenario: Scenario) -> Result<(), String> {
    let mut list = load_scenarios(&app)?;
    match list.iter_mut().find(|s| s.id == scenario.id) {
        Some(existing) => *existing = scenario,
        None => list.push(scenario),
    }
    write_scenarios(&app, &list)
}

#[tauri::command]
fn delete_scenario(app: AppHandle, id: String) -> Result<(), String> {
    let mut list = load_scenarios(&app)?;
    list.retain(|s| s.id != id);
    write_scenarios(&app, &list)
}

/// For a clean-slate apply: remove a mods-folder entry, first adopting any
/// unmanaged real file (e.g. an auto-downloaded dependency) into the library so
/// it isn't lost — managed links and already-backed-up files are just removed.
fn clean_from_mods(cfg: &Config, name: &str) -> Result<(), String> {
    let mods_path = PathBuf::from(&cfg.mods_dir).join(name);
    let lib_path = PathBuf::from(&cfg.library_dir).join(name);
    let meta = match mods_path.symlink_metadata() {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    if meta.file_type().is_symlink() || lib_path.exists() {
        fs::remove_file(&mods_path).map_err(|e| e.to_string())?;
    } else {
        fs::create_dir_all(&cfg.library_dir).ok();
        if fs::rename(&mods_path, &lib_path).is_err() {
            fs::copy(&mods_path, &lib_path).map_err(|e| e.to_string())?;
            fs::remove_file(&mods_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The bundled companion mod, kept active during every scenario so the in-game
/// telemetry mod is always present.
const COMPANION_MOD: &str = "FS25_ScenarioCompanion.zip";

/// The companion mod zip, embedded into the binary at compile time so it's
/// available identically in `tauri dev` and production (no resource-dir lookup).
const COMPANION_ZIP: &[u8] = include_bytes!("../resources/FS25_ScenarioCompanion.zip");

/// Write the embedded companion mod into the game's mods folder (overwriting, so
/// updates propagate).
fn place_companion(cfg: &Config) -> Result<(), String> {
    fs::create_dir_all(&cfg.mods_dir).map_err(|e| e.to_string())?;
    let dst = PathBuf::from(&cfg.mods_dir).join(COMPANION_MOD);
    fs::write(&dst, COMPANION_ZIP).map_err(|e| e.to_string())?;
    Ok(())
}

/// Configure the game to match a scenario: enable its map + required mods, set
/// the active map, and (if `exclusive`) disable everything else in the mods
/// folder for a clean slate. The telemetry companion mod is always kept active.
#[tauri::command]
fn apply_scenario(app: AppHandle, id: String, exclusive: bool) -> Result<(), String> {
    let list = load_scenarios(&app)?;
    let scenario = list
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("scenario not found")?;

    let mut cfg = load_config(&app)?;

    // Everything the scenario wants active.
    let mut keep: Vec<String> = scenario.required_mods.clone();
    if let Some(m) = &scenario.map {
        keep.push(m.clone());
    }
    for f in &keep {
        safe_filename(f)?;
    }

    if exclusive {
        // Force-clean: remove every mods-folder entry not in the scenario,
        // including mods another game auto-downloaded. Unmanaged real files are
        // adopted into the library first so nothing is lost.
        if let Ok(entries) = fs::read_dir(&cfg.mods_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if is_zip(&entry.path()) && !keep.contains(&name) && name != COMPANION_MOD {
                    clean_from_mods(&cfg, &name)?;
                }
            }
        }
    }

    for f in &keep {
        apply_enabled(&cfg, f, true)?;
    }
    // The telemetry companion is always active during a scenario.
    place_companion(&cfg)?;

    cfg.active_map = scenario.map.clone();
    write_config(&app, &cfg)?;
    log_line(
        &app,
        "info",
        &format!(
            "applied scenario \"{}\" ({} mod(s){})",
            scenario.name,
            keep.len(),
            if exclusive { ", clean slate" } else { "" }
        ),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Health check: surface mods that failed to load and stray symlinks.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthReport {
    /// Mods the game failed to load last run (from log.txt).
    failed_mods: Vec<String>,
    /// Symlinks in the mods folder — FS25 can't read these.
    symlinks: Vec<String>,
    /// Files in the mods folder that aren't in the library (unmanaged).
    orphans: Vec<String>,
    /// Count of healthy entries (real files / hardlinks).
    healthy: usize,
    log_found: bool,
}

#[tauri::command]
fn health_check(app: AppHandle) -> Result<HealthReport, String> {
    let cfg = load_config(&app)?;
    let mods = PathBuf::from(&cfg.mods_dir);
    let library = PathBuf::from(&cfg.library_dir);

    // Mods that failed to load, from the game log.
    let log_path = game_dir(&cfg).join("log.txt");
    let log_found = log_path.exists();
    let mut failed_mods = Vec::new();
    if let Ok(log) = fs::read_to_string(&log_path) {
        if let Ok(re) =
            regex::Regex::new(r"Failed to open xml file '.*/mods/([^/']+)/modDesc\.xml'")
        {
            for cap in re.captures_iter(&log) {
                let name = cap[1].to_string();
                if !failed_mods.contains(&name) {
                    failed_mods.push(name);
                }
            }
        }
    }

    let lib_files: std::collections::HashSet<String> = fs::read_dir(&library)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().to_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let mut symlinks = Vec::new();
    let mut orphans = Vec::new();
    let mut healthy = 0;
    if let Ok(rd) = fs::read_dir(&mods) {
        for entry in rd.flatten() {
            if !is_zip(&entry.path()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            match entry.metadata() {
                Ok(m) if m.file_type().is_symlink() => symlinks.push(name.clone()),
                Ok(_) => healthy += 1,
                Err(_) => continue,
            }
            if !lib_files.contains(&name) {
                orphans.push(name);
            }
        }
    }
    Ok(HealthReport {
        failed_mods,
        symlinks,
        orphans,
        healthy,
        log_found,
    })
}

/// Convert any stray symlinks in the mods folder into hardlinks (copy fallback).
#[tauri::command]
fn fix_links(app: AppHandle) -> Result<usize, String> {
    let cfg = load_config(&app)?;
    let mods = PathBuf::from(&cfg.mods_dir);
    let mut fixed = 0;
    let rd = fs::read_dir(&mods).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let path = entry.path();
        let is_symlink = entry
            .metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        if !is_symlink || !is_zip(&path) {
            continue;
        }
        let target = fs::read_link(&path).map_err(|e| e.to_string())?;
        let target = if target.is_absolute() {
            target
        } else {
            mods.join(&target)
        };
        if !target.exists() {
            continue;
        }
        fs::remove_file(&path).map_err(|e| e.to_string())?;
        if fs::hard_link(&target, &path).is_err() {
            fs::copy(&target, &path).map_err(|e| e.to_string())?;
        }
        fixed += 1;
    }
    if fixed > 0 {
        log_line(
            &app,
            "info",
            &format!("fixed {fixed} symlink(s) → hardlinks"),
        );
    }
    Ok(fixed)
}

// ---------------------------------------------------------------------------
// Mod profiles: named snapshots of the enabled set.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    name: String,
    #[serde(default)]
    mods: Vec<String>,
}

fn load_profiles(app: &AppHandle) -> Result<Vec<Profile>, String> {
    let path = config_dir(app)?.join("profiles.json");
    if path.exists() {
        let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| e.to_string())
    } else {
        Ok(Vec::new())
    }
}

fn write_profiles(app: &AppHandle, list: &[Profile]) -> Result<(), String> {
    let path = config_dir(app)?.join("profiles.json");
    let s = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(path, s).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_profiles(app: AppHandle) -> Result<Vec<Profile>, String> {
    load_profiles(&app)
}

#[tauri::command]
fn save_profile(app: AppHandle, profile: Profile) -> Result<(), String> {
    let mut list = load_profiles(&app)?;
    match list.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile,
        None => list.push(profile),
    }
    write_profiles(&app, &list)
}

#[tauri::command]
fn delete_profile(app: AppHandle, id: String) -> Result<(), String> {
    let mut list = load_profiles(&app)?;
    list.retain(|p| p.id != id);
    write_profiles(&app, &list)
}

/// Enable exactly the profile's items, disabling everything else in the mods
/// folder — a one-click swap between mod loadouts.
#[tauri::command]
fn apply_profile(app: AppHandle, id: String) -> Result<(), String> {
    let profile = load_profiles(&app)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or("profile not found")?;
    for f in &profile.mods {
        safe_filename(f)?;
    }
    let cfg = load_config(&app)?;
    let keep: std::collections::HashSet<&String> = profile.mods.iter().collect();
    if let Ok(rd) = fs::read_dir(&cfg.mods_dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_zip(&entry.path()) && !keep.contains(&name) {
                apply_enabled(&cfg, &name, false)?;
            }
        }
    }
    for f in &profile.mods {
        apply_enabled(&cfg, f, true)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Savegame backup / restore (zip a savegame folder).
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    name: String,
    slot: String,
    size: u64,
}

fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = config_dir(app)?.join("backups");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let dir = backups_dir(&app)?;
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".zip") {
                continue;
            }
            let slot = name.split('_').next().unwrap_or("").to_string();
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(BackupInfo { name, slot, size });
        }
    }
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

/// Zip a directory's contents into `dest`.
fn zip_dir(src: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::FileOptions<()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for entry in walkdir::WalkDir::new(src).into_iter().flatten() {
        let path = entry.path();
        let rel = match path.strip_prefix(src) {
            Ok(r) if !r.as_os_str().is_empty() => r,
            _ => continue,
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            zip.add_directory(format!("{rel_str}/"), opts)
                .map_err(|e| e.to_string())?;
        } else {
            zip.start_file(rel_str, opts).map_err(|e| e.to_string())?;
            use std::io::Write;
            zip.write_all(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn backup_savegame(app: AppHandle, slot: String) -> Result<String, String> {
    safe_filename(&slot)?;
    let cfg = load_config(&app)?;
    let src = game_dir(&cfg).join(&slot);
    if !src.is_dir() {
        return Err("savegame folder not found".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup_name = format!("{slot}_{stamp}.zip");
    let dest = backups_dir(&app)?.join(&backup_name);
    zip_dir(&src, &dest)?;
    Ok(backup_name)
}

#[tauri::command]
fn restore_savegame(app: AppHandle, backup_name: String, slot: String) -> Result<(), String> {
    safe_filename(&backup_name)?;
    safe_filename(&slot)?;
    let cfg = load_config(&app)?;
    let backup = backups_dir(&app)?.join(&backup_name);
    let file = std::fs::File::open(&backup).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let dest = game_dir(&cfg).join(&slot);
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let out = match entry.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut outfile = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// External storage: back up manifest + saves + scenarios to a GitHub repo.
// ---------------------------------------------------------------------------

fn sync_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("sync"))
}

/// PATH to use for CLI subprocesses. A macOS/Linux GUI app launched from Finder
/// gets a minimal PATH without Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`),
/// so `gh` isn't found even though it works in `tauri dev` (launched from a
/// shell). Prepend the common install dirs. Windows GUI apps already inherit the
/// system PATH, so this is unix-only.
#[cfg(not(target_os = "windows"))]
fn cli_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    let extra = "/opt/homebrew/bin:/usr/local/bin";
    if existing.is_empty() {
        format!("{extra}:/usr/bin:/bin:/usr/sbin:/sbin")
    } else {
        format!("{extra}:{existing}")
    }
}

/// Apply the augmented PATH so bundled apps can locate `git`/`gh`.
fn apply_cli_env(cmd: &mut std::process::Command) {
    #[cfg(not(target_os = "windows"))]
    cmd.env("PATH", cli_path());
    #[cfg(target_os = "windows")]
    let _ = cmd;
}

fn run_cmd(program: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    apply_cli_env(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("{program} not runnable: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut full = vec!["-C", dir.to_str().unwrap_or(".")];
    full.extend_from_slice(args);
    run_cmd("git", &full)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncStatus {
    repo: Option<String>,
    cloned: bool,
    /// Whether `git` and `gh` are installed — sync needs both.
    tools_ok: bool,
}

fn cmd_exists(prog: &str) -> bool {
    let mut cmd = std::process::Command::new(prog);
    cmd.arg("--version");
    apply_cli_env(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

#[tauri::command]
fn sync_status(app: AppHandle) -> Result<SyncStatus, String> {
    let cfg = load_config(&app)?;
    let cloned = sync_dir(&app)?.join(".git").exists();
    Ok(SyncStatus {
        repo: cfg.sync_repo,
        cloned,
        tools_ok: cmd_exists("git") && cmd_exists("gh"),
    })
}

/// Create (if needed) and clone a private GitHub repo for backups, via `gh`.
#[tauri::command]
fn sync_setup(app: AppHandle, name: String) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains(' ') {
        return Err("enter a simple repo name, e.g. fs25-backup".into());
    }
    let owner = run_cmd("gh", &["api", "user", "--jq", ".login"])
        .map_err(|e| format!("gh not authenticated? {e}"))?
        .trim()
        .to_string();
    let slug = format!("{owner}/{name}");
    // Create the repo (ignore error if it already exists).
    let _ = run_cmd("gh", &["repo", "create", &slug, "--private"]);

    let sync = sync_dir(&app)?;
    if sync.join(".git").exists() {
        git(
            &sync,
            &[
                "remote",
                "set-url",
                "origin",
                &format!("https://github.com/{slug}.git"),
            ],
        )?;
    } else {
        if sync.exists() {
            fs::remove_dir_all(&sync).ok();
        }
        run_cmd(
            "git",
            &[
                "clone",
                &format!("https://github.com/{slug}.git"),
                sync.to_str().unwrap(),
            ],
        )?;
    }

    let mut cfg = load_config(&app)?;
    cfg.sync_repo = Some(slug.clone());
    write_config(&app, &cfg)?;
    Ok(slug)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    filename: String,
    title: String,
    kind: String,
    mod_id: String,
}

/// Push a snapshot: scenarios/profiles/catalog + a mod manifest + zipped saves.
#[tauri::command]
fn sync_push(app: AppHandle) -> Result<String, String> {
    let sync = sync_dir(&app)?;
    if !sync.join(".git").exists() {
        return Err("sync isn't set up yet".into());
    }
    let cfgdir = config_dir(&app)?;
    let _ = git(&sync, &["pull", "--no-edit"]);

    // Small config files (never sync config.json — its paths are machine-specific).
    for f in ["scenarios.json", "profiles.json", "catalog.json"] {
        let src = cfgdir.join(f);
        if src.exists() {
            fs::copy(&src, sync.join(f)).map_err(|e| e.to_string())?;
        }
    }

    // Mod manifest: library items + their ModHub id (so they can be re-fetched).
    let items = scan(&app)?;
    let conn = modhub_db(&app)?;
    let mut title_to_id: HashMap<String, String> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT title, mod_id FROM mods") {
        if let Ok(rows) =
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        {
            for row in rows.flatten() {
                let key = row
                    .0
                    .to_lowercase()
                    .replace(|c: char| !c.is_alphanumeric(), "");
                title_to_id.insert(key, row.1);
            }
        }
    }
    let manifest: Vec<ManifestEntry> = items
        .iter()
        .map(|i| {
            let key = i
                .title
                .to_lowercase()
                .replace(|c: char| !c.is_alphanumeric(), "");
            ManifestEntry {
                filename: i.filename.clone(),
                title: i.title.clone(),
                kind: i.kind.clone(),
                mod_id: title_to_id.get(&key).cloned().unwrap_or_default(),
            }
        })
        .collect();
    fs::write(
        sync.join("mod-manifest.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    // Zip each savegame into saves/.
    let saves_dir = sync.join("saves");
    fs::create_dir_all(&saves_dir).map_err(|e| e.to_string())?;
    let gdir = game_dir(&load_config(&app)?);
    let mut save_count = 0;
    if let Ok(rd) = fs::read_dir(&gdir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("savegame") && entry.path().join("careerSavegame.xml").exists() {
                zip_dir(&entry.path(), &saves_dir.join(format!("{name}.zip")))?;
                save_count += 1;
            }
        }
    }

    git(&sync, &["add", "-A"])?;
    // Commit may report "nothing to commit" — that's fine.
    let _ = git(&sync, &["commit", "-m", "fs25 manager backup"]);
    git(&sync, &["push"])?;

    Ok(format!(
        "Pushed {} mods, {} saves to backup.",
        manifest.len(),
        save_count
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PullResult {
    restored: Vec<String>,
    /// Manifest mods not present locally (with a ModHub id to re-download).
    missing: Vec<ManifestEntry>,
    saves_available: usize,
}

/// Pull a snapshot: restore scenarios/profiles/catalog, copy saves into the
/// local backups folder, and report mods to re-download from ModHub.
#[tauri::command]
fn sync_pull(app: AppHandle) -> Result<PullResult, String> {
    let sync = sync_dir(&app)?;
    if !sync.join(".git").exists() {
        return Err("sync isn't set up yet".into());
    }
    git(&sync, &["pull", "--no-edit"])?;
    let cfgdir = config_dir(&app)?;

    let mut restored = Vec::new();
    for f in ["scenarios.json", "profiles.json", "catalog.json"] {
        let src = sync.join(f);
        if src.exists() {
            fs::copy(&src, cfgdir.join(f)).map_err(|e| e.to_string())?;
            restored.push(f.to_string());
        }
    }

    // Copy synced saves into the local backups folder for restore via the UI.
    let mut saves_available = 0;
    let saves_src = sync.join("saves");
    if saves_src.is_dir() {
        let backups = backups_dir(&app)?;
        if let Ok(rd) = fs::read_dir(&saves_src) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".zip") {
                    // saved as "savegameN.zip" -> keep a distinct backup name
                    let dest =
                        backups.join(format!("{}_synced.zip", name.trim_end_matches(".zip")));
                    fs::copy(entry.path(), dest).map_err(|e| e.to_string())?;
                    saves_available += 1;
                }
            }
        }
    }

    // Which manifest mods are missing locally?
    let cfg = load_config(&app)?;
    let lib_files: std::collections::HashSet<String> = fs::read_dir(&cfg.library_dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().to_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let mut missing = Vec::new();
    if let Ok(s) = fs::read_to_string(sync.join("mod-manifest.json")) {
        if let Ok(entries) = serde_json::from_str::<Vec<ManifestEntry>>(&s) {
            for e in entries {
                if !lib_files.contains(&e.filename) && !e.mod_id.is_empty() {
                    missing.push(e);
                }
            }
        }
    }

    Ok(PullResult {
        restored,
        missing,
        saves_available,
    })
}

// ---------------------------------------------------------------------------
// Savegame slots: browse all 20, edit start money/name, clone into a slot.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SlotInfo {
    slot: String,
    occupied: bool,
    name: String,
    map_title: String,
    money: Option<f64>,
}

#[tauri::command]
fn list_slots(app: AppHandle) -> Result<Vec<SlotInfo>, String> {
    let cfg = load_config(&app)?;
    let dir = game_dir(&cfg);
    let mut out = Vec::new();
    for n in 1..=20 {
        let slot = format!("savegame{n}");
        match read_save(&dir, &slot) {
            Some(info) => out.push(SlotInfo {
                slot,
                occupied: true,
                name: info.name,
                map_title: info.map_title,
                money: info.money,
            }),
            None => out.push(SlotInfo {
                slot,
                occupied: false,
                name: String::new(),
                map_title: String::new(),
                money: None,
            }),
        }
    }
    Ok(out)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Edit a savegame's starting money and/or name in place (backs it up first).
#[tauri::command]
fn patch_savegame(
    app: AppHandle,
    slot: String,
    name: Option<String>,
    money: Option<f64>,
) -> Result<(), String> {
    safe_filename(&slot)?;
    let cfg = load_config(&app)?;
    let dir = game_dir(&cfg).join(&slot);
    let career_path = dir.join("careerSavegame.xml");
    if !career_path.exists() {
        return Err("no savegame in that slot".into());
    }
    // Always snapshot before editing so a bad edit is recoverable.
    backup_savegame(app.clone(), slot.clone())?;

    let mut career = fs::read_to_string(&career_path).map_err(|e| e.to_string())?;
    if let Some(m) = money {
        career = career_set_money(&career, m);
    }
    if let Some(n) = &name {
        career = career_set_name(&career, n);
    }
    fs::write(&career_path, career).map_err(|e| e.to_string())?;

    // The farm's balance in farms.xml is authoritative — patch it too.
    if let Some(m) = money {
        let farms_path = dir.join("farms.xml");
        if let Ok(farms) = fs::read_to_string(&farms_path) {
            fs::write(&farms_path, farms_set_money(&farms, m)).map_err(|e| e.to_string())?;
        }
    }
    log_line(
        &app,
        "info",
        &format!(
            "patched {slot}{}{}",
            money.map(|m| format!(" money={m}")).unwrap_or_default(),
            name.map(|n| format!(" name={n}")).unwrap_or_default()
        ),
    );
    Ok(())
}

/// Replace every `<money>…</money>` in a careerSavegame.xml with a whole number.
fn career_set_money(career: &str, money: f64) -> String {
    let mi = money.round() as i64;
    let re = regex::Regex::new(r"<money>[^<]*</money>").expect("valid regex");
    re.replace_all(career, format!("<money>{mi}</money>").as_str())
        .into_owned()
}

/// Replace `<savegameName>…</savegameName>` (XML-escaping the new name).
fn career_set_name(career: &str, name: &str) -> String {
    let re = regex::Regex::new(r"<savegameName>[^<]*</savegameName>").expect("valid regex");
    re.replace(
        career,
        format!("<savegameName>{}</savegameName>", xml_escape(name)).as_str(),
    )
    .into_owned()
}

/// Set the money attribute on the first (player) `<farm …>` in farms.xml.
fn farms_set_money(farms: &str, money: f64) -> String {
    let re = regex::Regex::new(r#"(<farm\b[^>]*?\bmoney=")[^"]*""#).expect("valid regex");
    re.replace(farms, format!("${{1}}{money:.6}\"").as_str())
        .into_owned()
}

/// A vehicle filename that reads like a road-going pickup/truck — the sensible
/// thing to keep as a "base" vehicle (a leveler or plough is not).
fn is_base_vehicle(filename: &str) -> bool {
    let f = filename.to_lowercase();
    [
        "pickup",
        "pickuptruck",
        "truck",
        "transporter",
        "van",
        "lizard",
    ]
    .iter()
    .any(|k| f.contains(k))
}

/// Remove every top-level `<vehicle>` owned by `farm_id` from a vehicles.xml
/// string, returning `(new_xml, removed_count)`. If `keep_base`, one starter
/// vehicle is retained — preferring a pickup/truck (cheapest such), else the
/// cheapest vehicle overall. Removal is by each element's exact byte range, so
/// the rest of the file is untouched; a leading UTF-8 BOM is preserved.
fn strip_farm_vehicles(xml: &str, farm_id: &str, keep_base: bool) -> (String, usize) {
    let had_bom = xml.starts_with('\u{feff}');
    let src = strip_bom(xml);
    let doc = match roxmltree::Document::parse(src) {
        Ok(d) => d,
        Err(_) => return (xml.to_string(), 0),
    };
    // (byte range, price, is-truck) for each vehicle on the player's farm.
    let mut owned: Vec<(std::ops::Range<usize>, f64, bool)> = doc
        .root_element()
        .children()
        .filter(|n| n.has_tag_name("vehicle") && n.attribute("farmId") == Some(farm_id))
        .map(|n| {
            let price = n
                .attribute("price")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.0);
            let truck = n
                .attribute("filename")
                .map(is_base_vehicle)
                .unwrap_or(false);
            (n.range(), price, truck)
        })
        .collect();
    if owned.is_empty() {
        return (xml.to_string(), 0);
    }
    // Keep a base vehicle: cheapest pickup/truck if any, else cheapest overall.
    let keep_idx = if keep_base {
        let has_truck = owned.iter().any(|(_, _, t)| *t);
        owned
            .iter()
            .enumerate()
            .filter(|(_, (_, _, t))| !has_truck || *t)
            .min_by(|a, b| a.1 .1.total_cmp(&b.1 .1))
            .map(|(i, _)| i)
    } else {
        None
    };
    let mut ranges: Vec<std::ops::Range<usize>> = owned
        .drain(..)
        .enumerate()
        .filter(|(i, _)| Some(*i) != keep_idx)
        .map(|(_, (r, _, _))| r)
        .collect();
    ranges.sort_by_key(|r| r.start);

    let mut out = String::with_capacity(src.len());
    let mut pos = 0;
    for r in &ranges {
        out.push_str(&src[pos..r.start]);
        pos = r.end;
    }
    out.push_str(&src[pos..]);
    let result = if had_bom {
        format!("\u{feff}{out}")
    } else {
        out
    };
    (result, ranges.len())
}

/// Remove the player's owned vehicles from a seeded/existing save (backing it up
/// first). `keep_base` retains the single cheapest vehicle. Returns how many
/// were removed.
#[tauri::command]
fn strip_equipment(app: AppHandle, slot: String, keep_base: bool) -> Result<usize, String> {
    safe_filename(&slot)?;
    let cfg = load_config(&app)?;
    let dir = game_dir(&cfg).join(&slot);
    if !dir.join("careerSavegame.xml").exists() {
        return Err("no savegame in that slot".into());
    }
    let vpath = dir.join("vehicles.xml");
    if !vpath.exists() {
        return Ok(0);
    }
    // Snapshot before editing so a bad strip is one click to restore.
    backup_savegame(app.clone(), slot.clone())?;

    let money = (|| {
        let s = fs::read_to_string(dir.join("careerSavegame.xml")).ok()?;
        let doc = roxmltree::Document::parse(strip_bom(&s)).ok()?;
        xml_text(&doc, "money")?.parse::<f64>().ok()
    })();
    let farm_id = read_player_farm(&dir.join("farms.xml"), money)
        .map(|(_, id)| id)
        .unwrap_or_else(|| "1".into());

    let xml = fs::read_to_string(&vpath).map_err(|e| e.to_string())?;
    let (new_xml, removed) = strip_farm_vehicles(&xml, &farm_id, keep_base);
    fs::write(&vpath, new_xml).map_err(|e| e.to_string())?;
    log_line(
        &app,
        "info",
        &format!(
            "stripped {removed} vehicle(s) from {slot}{}",
            if keep_base { " (kept base)" } else { "" }
        ),
    );
    Ok(removed)
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    for entry in walkdir::WalkDir::new(src).into_iter().flatten() {
        let path = entry.path();
        let rel = match path.strip_prefix(src) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let target = dst.join(rel);
        if path.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = target.parent() {
                fs::create_dir_all(p).ok();
            }
            fs::copy(path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Per-map "template" saves: which savegame slot to clone from when seeding a
/// scenario on a given map. Keyed by map identity (the map mod's zip stem, so a
/// bundle's variants all share one template), set by the frontend.
#[tauri::command]
fn get_templates(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let path = config_dir(&app)?.join("templates.json");
    if path.exists() {
        let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| e.to_string())
    } else {
        Ok(HashMap::new())
    }
}

#[tauri::command]
fn set_template(app: AppHandle, map_key: String, slot: String) -> Result<(), String> {
    let mut t = get_templates(app.clone())?;
    if slot.is_empty() {
        t.remove(&map_key);
    } else {
        t.insert(map_key, slot);
    }
    let path = config_dir(&app)?.join("templates.json");
    let s = serde_json::to_string_pretty(&t).map_err(|e| e.to_string())?;
    fs::write(path, s).map_err(|e| e.to_string())
}

/// Copy one savegame slot's folder into another (overwriting the target).
#[tauri::command]
fn clone_savegame(app: AppHandle, from_slot: String, to_slot: String) -> Result<(), String> {
    safe_filename(&from_slot)?;
    safe_filename(&to_slot)?;
    if from_slot == to_slot {
        return Err("source and target slots are the same".into());
    }
    let cfg = load_config(&app)?;
    let dir = game_dir(&cfg);
    let src = dir.join(&from_slot);
    let dst = dir.join(&to_slot);
    if !src.join("careerSavegame.xml").exists() {
        return Err("source save not found".into());
    }
    if dst.exists() {
        fs::remove_dir_all(&dst).map_err(|e| e.to_string())?;
    }
    copy_dir(&src, &dst)?;
    log_line(&app, "info", &format!("cloned {from_slot} → {to_slot}"));
    Ok(())
}

// ---------------------------------------------------------------------------
// Farm overview: richer per-savegame stats (vehicles, buildings, fields).
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VehicleEntry {
    name: String,
    value: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FarmOverview {
    money: Option<f64>,
    vehicle_count: usize,
    vehicle_value: f64,
    top_vehicles: Vec<VehicleEntry>,
    building_count: usize,
    building_value: f64,
    field_count: usize,
}

#[tauri::command]
fn farm_overview(app: AppHandle, slot: String) -> Result<FarmOverview, String> {
    safe_filename(&slot)?;
    let cfg = load_config(&app)?;
    let base = game_dir(&cfg).join(&slot);
    if !base.join("careerSavegame.xml").exists() {
        return Err("no save in that slot".into());
    }

    let money = (|| {
        let s = fs::read_to_string(base.join("careerSavegame.xml")).ok()?;
        let doc = roxmltree::Document::parse(strip_bom(&s)).ok()?;
        xml_text(&doc, "money")?.parse::<f64>().ok()
    })();
    let farm_id = read_player_farm(&base.join("farms.xml"), money)
        .map(|(_, id)| id)
        .unwrap_or_else(|| "1".into());

    // Owned vehicles + their value.
    let mut vehicles: Vec<VehicleEntry> = Vec::new();
    if let Ok(s) = fs::read_to_string(base.join("vehicles.xml")) {
        if let Ok(doc) = roxmltree::Document::parse(strip_bom(&s)) {
            for n in doc.root_element().descendants() {
                if !n.has_tag_name("vehicle") || n.attribute("farmId") != Some(farm_id.as_str()) {
                    continue;
                }
                if matches!(n.attribute("propertyState"), Some(x) if x != "OWNED") {
                    continue;
                }
                let value = n
                    .attribute("price")
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0);
                let name = n
                    .attribute("filename")
                    .map(|f| {
                        f.trim_end_matches(".xml")
                            .rsplit(['/', '\\'])
                            .next()
                            .unwrap_or(f)
                            .to_string()
                    })
                    .unwrap_or_default();
                vehicles.push(VehicleEntry { name, value });
            }
        }
    }
    let vehicle_value: f64 = vehicles.iter().map(|v| v.value).sum();
    let vehicle_count = vehicles.len();
    vehicles.sort_by(|a, b| b.value.total_cmp(&a.value));
    vehicles.truncate(8);

    // Owned buildings.
    let mut building_count = 0;
    let mut building_value = 0.0;
    if let Ok(s) = fs::read_to_string(base.join("placeables.xml")) {
        if let Ok(doc) = roxmltree::Document::parse(strip_bom(&s)) {
            for n in doc.root_element().descendants() {
                if n.has_tag_name("placeable") && n.attribute("farmId") == Some(farm_id.as_str()) {
                    building_count += 1;
                    building_value += n
                        .attribute("price")
                        .and_then(|v| v.parse::<f64>().ok())
                        .unwrap_or(0.0);
                }
            }
        }
    }

    // Owned farmland parcels.
    let mut field_count = 0;
    if let Ok(s) = fs::read_to_string(base.join("farmland.xml")) {
        if let Ok(doc) = roxmltree::Document::parse(strip_bom(&s)) {
            field_count = doc
                .root_element()
                .descendants()
                .filter(|n| {
                    n.has_tag_name("farmland") && n.attribute("farmId") == Some(farm_id.as_str())
                })
                .count();
        }
    }

    Ok(FarmOverview {
        money,
        vehicle_count,
        vehicle_value,
        top_vehicles: vehicles,
        building_count,
        building_value,
        field_count,
    })
}

// ---------------------------------------------------------------------------
// Disk manager: library size, biggest mods, duplicate versions, orphans.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibEntry {
    filename: String,
    title: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskReport {
    total_size: u64,
    count: usize,
    biggest: Vec<LibEntry>,
    /// Groups of library files that share a title (likely duplicate versions).
    duplicates: Vec<Vec<LibEntry>>,
    /// Files in the mods folder that aren't in the library.
    orphans: Vec<String>,
}

#[tauri::command]
fn disk_report(app: AppHandle) -> Result<DiskReport, String> {
    let items = scan(&app)?;
    let total_size: u64 = items.iter().map(|i| i.size).sum();
    let count = items.len();

    let mut biggest: Vec<LibEntry> = items
        .iter()
        .map(|i| LibEntry {
            filename: i.filename.clone(),
            title: i.title.clone(),
            size: i.size,
        })
        .collect();
    biggest.sort_by_key(|b| std::cmp::Reverse(b.size));
    biggest.truncate(10);

    // Group by normalized title; any group with >1 member is a duplicate set.
    let mut by_title: HashMap<String, Vec<LibEntry>> = HashMap::new();
    for i in &items {
        let key = i
            .title
            .to_lowercase()
            .replace(|c: char| !c.is_alphanumeric(), "");
        if key.is_empty() {
            continue;
        }
        by_title.entry(key).or_default().push(LibEntry {
            filename: i.filename.clone(),
            title: i.title.clone(),
            size: i.size,
        });
    }
    let mut duplicates: Vec<Vec<LibEntry>> =
        by_title.into_values().filter(|g| g.len() > 1).collect();
    duplicates.sort_by(|a, b| a[0].title.to_lowercase().cmp(&b[0].title.to_lowercase()));

    // Orphans: mods-folder zips not present in the library.
    let cfg = load_config(&app)?;
    let lib: std::collections::HashSet<String> = items.iter().map(|i| i.filename.clone()).collect();
    let mut orphans = Vec::new();
    if let Ok(rd) = fs::read_dir(&cfg.mods_dir) {
        for entry in rd.flatten() {
            if is_zip(&entry.path()) {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !lib.contains(&name) {
                    orphans.push(name);
                }
            }
        }
    }

    Ok(DiskReport {
        total_size,
        count,
        biggest,
        duplicates,
        orphans,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_money_in_career_and_farms() {
        let career = "<statistics><money>100000</money></statistics><x><money>100000</money></x>";
        // both <money> occurrences updated, whole number
        assert_eq!(
            career_set_money(career, 5000.0),
            "<statistics><money>5000</money></statistics><x><money>5000</money></x>"
        );
        // below the $100k base-game floor works fine
        assert!(career_set_money(career, 250.0).contains("<money>250</money>"));

        let farms = r#"<farms><farm farmId="1" name="My farm" loan="0.0" money="100000.000000"><players/></farm></farms>"#;
        let out = farms_set_money(farms, 5000.0);
        assert!(out.contains(r#"money="5000.000000""#));
        // farm attributes preserved
        assert!(out.contains(r#"farmId="1""#) && out.contains(r#"name="My farm""#));
    }

    #[test]
    fn renames_savegame_and_escapes() {
        let career = "<savegameName>Old</savegameName>";
        assert_eq!(
            career_set_name(career, "New & <Fancy>"),
            "<savegameName>New &amp; &lt;Fancy&gt;</savegameName>"
        );
    }

    #[test]
    fn strips_owned_vehicles_both_modes() {
        let xml = "\u{feff}<vehicles>\n\
            <vehicle farmId=\"1\" price=\"26000\" filename=\"a\"/>\n\
            <vehicle farmId=\"1\" price=\"100000\" filename=\"b\"/>\n\
            <vehicle farmId=\"0\" price=\"5\" filename=\"npc\"/>\n\
            </vehicles>";
        // keep cheapest: drops the $100k, keeps the $26k and the NPC vehicle
        let (kept, n) = strip_farm_vehicles(xml, "1", true);
        assert_eq!(n, 1);
        assert!(kept.contains("price=\"26000\""));
        assert!(!kept.contains("price=\"100000\""));
        assert!(kept.contains("npc"));
        assert!(kept.starts_with('\u{feff}')); // BOM preserved
                                               // remove all: no farm-1 vehicles remain, NPC untouched
        let (none, n2) = strip_farm_vehicles(xml, "1", false);
        assert_eq!(n2, 2);
        assert!(!none.contains("farmId=\"1\""));
        assert!(none.contains("npc"));
    }

    #[test]
    fn keep_base_prefers_a_truck_over_cheaper_tools() {
        // A cheap leveler and a pricier pickup: keep the pickup, not the leveler.
        let xml = "<vehicles>\n\
            <vehicle farmId=\"1\" price=\"5000\" filename=\"data/leveler.xml\"/>\n\
            <vehicle farmId=\"1\" price=\"26000\" filename=\"data/lizardPickup.xml\"/>\n\
            </vehicles>";
        let (out, n) = strip_farm_vehicles(xml, "1", true);
        assert_eq!(n, 1);
        assert!(out.contains("lizardPickup")); // truck kept
        assert!(!out.contains("leveler")); // leveler removed despite being cheaper
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn cli_path_includes_homebrew_dirs() {
        let p = cli_path();
        assert!(p.contains("/opt/homebrew/bin"));
        assert!(p.contains("/usr/local/bin"));
    }

    #[test]
    fn years_from_calendar() {
        // A brand-new FS25 game sits at day 6 (August start) = 0 years elapsed.
        assert!((years_elapsed(6.0, 1.0) - 0.0).abs() < 1e-9);
        // A full year later (12 more periods) at 1 day/period = day 18 = 1.0.
        assert!((years_elapsed(18.0, 1.0) - 1.0).abs() < 1e-9);
        // Same anchor holds at 2 days/period: start is day 11, +12 periods = day 35.
        assert!((years_elapsed(11.0, 2.0) - 0.0).abs() < 1e-9);
        assert!((years_elapsed(35.0, 2.0) - 1.0).abs() < 1e-9);
        // Before/at the start never goes negative.
        assert!((years_elapsed(1.0, 1.0) - 0.0).abs() < 1e-9);
        // Divide-by-zero guard: treats 0 days/period as 1.
        assert!(years_elapsed(30.0, 0.0) >= 0.0);
    }

    #[test]
    fn seed_meta_classifies_known_mods() {
        assert_eq!(
            seed_meta("FS25_Courseplay.zip", false).requires,
            vec!["fields", "roads"]
        );
        assert_eq!(
            seed_meta("FS25_AutoDrive.zip", false).requires,
            vec!["roads"]
        );
        // flat/empty maps provide nothing; ordinary maps provide the usual caps
        assert!(seed_meta("FS25_Flat_Map.zip", true).provides.is_empty());
        assert!(seed_meta("FS25_Farmlands.zip", true)
            .provides
            .contains(&"selling-points".to_string()));
    }

    #[test]
    fn safe_filename_blocks_traversal() {
        assert!(safe_filename("FS25_Mod.zip").is_ok());
        assert!(safe_filename("../evil.zip").is_err());
        assert!(safe_filename("a/b.zip").is_err());
        assert!(safe_filename("").is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            launch_game,
            list_items,
            set_enabled,
            set_enabled_many,
            set_active_map,
            update_meta,
            import_from_mods,
            modhub_upsert,
            modhub_all,
            download_mod,
            fetch_image,
            list_savegames,
            list_scenarios,
            save_scenario,
            delete_scenario,
            apply_scenario,
            health_check,
            fix_links,
            list_profiles,
            save_profile,
            delete_profile,
            apply_profile,
            list_backups,
            backup_savegame,
            restore_savegame,
            sync_status,
            sync_setup,
            sync_push,
            sync_pull,
            list_slots,
            patch_savegame,
            clone_savegame,
            strip_equipment,
            get_log,
            clear_log,
            app_paths,
            open_folder,
            read_companion,
            scenario_history,
            get_templates,
            set_template,
            farm_overview,
            disk_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
