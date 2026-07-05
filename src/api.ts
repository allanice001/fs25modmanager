import { invoke } from "@tauri-apps/api/core";

export type LinkMode = "symlink" | "hardlink" | "copy";

export interface Config {
  libraryDir: string;
  modsDir: string;
  linkMode: LinkMode;
  activeMap: string | null;
}

export interface ItemMeta {
  kind: string;
  category: string;
  tags: string[];
  requires: string[];
  provides: string[];
  notes: string;
}

export interface ModItem {
  filename: string;
  title: string;
  author: string;
  version: string;
  kind: "map" | "mod";
  category: string;
  enabled: boolean;
  isActiveMap: boolean;
  tags: string[];
  requires: string[];
  provides: string[];
  notes: string;
  compatible: boolean;
  incompatReasons: string[];
  size: number;
  error: string | null;
  description: string;
  /** Mod names (zip stems) this mod depends on, from modDesc.xml. */
  dependencies: string[];
}

export interface VehicleEntry {
  name: string;
  value: number;
}

export interface FarmOverview {
  money: number | null;
  vehicleCount: number;
  vehicleValue: number;
  topVehicles: VehicleEntry[];
  buildingCount: number;
  buildingValue: number;
  fieldCount: number;
}

export interface LibEntry {
  filename: string;
  title: string;
  size: number;
}

export interface DiskReport {
  totalSize: number;
  count: number;
  biggest: LibEntry[];
  /** Groups of library files sharing a title (likely duplicate versions). */
  duplicates: LibEntry[][];
  /** Files in the mods folder not present in the library. */
  orphans: string[];
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  mode: string;
  rules: string[];
  map: string | null;
  requiredMods: string[];
  startingKit: string;
  startMoney: number | null;
  goalMoney: number | null;
  deadlineYears: number | null;
  savegameSlot: string | null;
  /** Aug–Dec is a free warm-up window; the deadline counts from January. */
  warmupToJanuary?: boolean;
}

export interface SaveInfo {
  slot: string;
  name: string;
  mapTitle: string;
  money: number | null;
  loan: number | null;
  assetValue: number | null;
  /** Value of owned vehicles only (excludes a map's pre-placed buildings). */
  vehicleValue: number | null;
  playTimeHours: number | null;
  yearsElapsed: number | null;
  mods: string[];
  /** `<mapId>` e.g. "FS25_ronidaIslandCp.ronidaIslandCP_nt"; the prefix before
   *  the first '.' is the map mod's zip stem (reliable map identity). */
  mapId?: string | null;
}

export interface ModHubEntry {
  modId: string;
  title: string;
  author: string;
  image: string;
  url: string;
  category: string;
  label: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
}

export interface HealthReport {
  failedMods: string[];
  symlinks: string[];
  orphans: string[];
  healthy: number;
  logFound: boolean;
}

export interface Profile {
  id: string;
  name: string;
  mods: string[];
}

export interface BackupInfo {
  name: string;
  slot: string;
  size: number;
}

export interface SlotInfo {
  slot: string;
  occupied: boolean;
  name: string;
  mapTitle: string;
  money: number | null;
}

export interface SyncStatus {
  repo: string | null;
  cloned: boolean;
  toolsOk: boolean;
}

export interface ManifestEntry {
  filename: string;
  title: string;
  kind: string;
  modId: string;
}

export interface PullResult {
  restored: string[];
  missing: ManifestEntry[];
  savesAvailable: number;
}

export const api = {
  getConfig: () => invoke<Config>("get_config"),
  saveConfig: (config: Config) => invoke<void>("save_config", { config }),
  launchGame: () => invoke<void>("launch_game"),
  listItems: () => invoke<ModItem[]>("list_items"),
  setEnabled: (filename: string, enabled: boolean) =>
    invoke<void>("set_enabled", { filename, enabled }),
  setEnabledMany: (filenames: string[], enabled: boolean) =>
    invoke<void>("set_enabled_many", { filenames, enabled }),
  setActiveMap: (filename: string | null) =>
    invoke<void>("set_active_map", { filename }),
  updateMeta: (filename: string, meta: ItemMeta) =>
    invoke<void>("update_meta", { filename, meta }),
  importFromMods: () => invoke<ImportResult>("import_from_mods"),
  modhubAll: () => invoke<ModHubEntry[]>("modhub_all"),
  modhubUpsert: (entries: ModHubEntry[], cachedAt: number) =>
    invoke<void>("modhub_upsert", { entries, cachedAt }),
  downloadMod: (modId: string) => invoke<string>("download_mod", { modId }),
  fetchImage: (url: string) => invoke<string>("fetch_image", { url }),
  listSavegames: () => invoke<SaveInfo[]>("list_savegames"),
  listScenarios: () => invoke<Scenario[]>("list_scenarios"),
  saveScenario: (scenario: Scenario) =>
    invoke<void>("save_scenario", { scenario }),
  deleteScenario: (id: string) => invoke<void>("delete_scenario", { id }),
  applyScenario: (id: string, exclusive: boolean) =>
    invoke<void>("apply_scenario", { id, exclusive }),
  healthCheck: () => invoke<HealthReport>("health_check"),
  fixLinks: () => invoke<number>("fix_links"),
  listProfiles: () => invoke<Profile[]>("list_profiles"),
  saveProfile: (profile: Profile) => invoke<void>("save_profile", { profile }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  applyProfile: (id: string) => invoke<void>("apply_profile", { id }),
  listBackups: () => invoke<BackupInfo[]>("list_backups"),
  backupSavegame: (slot: string) =>
    invoke<string>("backup_savegame", { slot }),
  restoreSavegame: (backupName: string, slot: string) =>
    invoke<void>("restore_savegame", { backupName, slot }),
  listSlots: () => invoke<SlotInfo[]>("list_slots"),
  patchSavegame: (slot: string, name: string | null, money: number | null) =>
    invoke<void>("patch_savegame", { slot, name, money }),
  cloneSavegame: (fromSlot: string, toSlot: string) =>
    invoke<void>("clone_savegame", { fromSlot, toSlot }),
  stripEquipment: (slot: string, keepBase: boolean) =>
    invoke<number>("strip_equipment", { slot, keepBase }),
  getTemplates: () => invoke<Record<string, string>>("get_templates"),
  setTemplate: (mapKey: string, slot: string) =>
    invoke<void>("set_template", { mapKey, slot }),
  farmOverview: (slot: string) =>
    invoke<FarmOverview>("farm_overview", { slot }),
  diskReport: () => invoke<DiskReport>("disk_report"),
  syncStatus: () => invoke<SyncStatus>("sync_status"),
  syncSetup: (name: string) => invoke<string>("sync_setup", { name }),
  syncPush: () => invoke<string>("sync_push"),
  syncPull: () => invoke<PullResult>("sync_pull"),
};
