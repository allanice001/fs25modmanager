import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import {
  api,
  Config,
  HealthReport,
  ManifestEntry,
  ModItem,
  Profile,
  SyncStatus,
} from "./api";
import { checkUpdates, UpdateInfo } from "./updates";
import { checkForUpdate } from "./updater";
import Scenarios from "./Scenarios";
import ModHub from "./ModHub";
import Saves from "./Saves";
import Disk from "./Disk";
import "./App.css";

type Tab =
  | "mods"
  | "maps"
  | "scenarios"
  | "discover"
  | "saves"
  | "disk"
  | "settings";

/** Dependency status for one mod against the current library. */
export interface DepStatus {
  owned: ModItem[];
  missing: string[];
}

function fmtSize(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

/** comma-separated <-> string[] helpers for the inline tag editors */
const toList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const fromList = (l: string[]) => l.join(", ");

/** Group items by category, alphabetically, with "Other" last. */
function groupByCategory(items: ModItem[]): [string, ModItem[]][] {
  const map = new Map<string, ModItem[]>();
  for (const it of items) {
    const c = it.category || "Other";
    (map.get(c) ?? map.set(c, []).get(c)!).push(it);
  }
  return [...map.entries()].sort((a, b) =>
    a[0] === "Other" ? 1 : b[0] === "Other" ? -1 : a[0].localeCompare(b[0]),
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("mods");
  const [config, setConfig] = useState<Config | null>(null);
  const [items, setItems] = useState<ModItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<ModItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [hideIncompat, setHideIncompat] = useState(false);
  const [modSearch, setModSearch] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [updates, setUpdates] = useState<UpdateInfo[]>([]);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);

  async function refresh() {
    try {
      const [cfg, list, profs] = await Promise.all([
        api.getConfig(),
        api.listItems(),
        api.listProfiles(),
      ]);
      setConfig(cfg);
      setItems(list);
      setProfiles(profs);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
    checkForUpdate(); // prompt if a newer signed release exists
  }, []);

  const activeMap = useMemo(
    () => items.find((i) => i.isActiveMap) ?? null,
    [items],
  );

  // Map every library item by its zip stem so dependency names resolve.
  const byStem = useMemo(() => {
    const m = new Map<string, ModItem>();
    for (const it of items) m.set(it.filename.replace(/\.zip$/i, ""), it);
    return m;
  }, [items]);

  const resolveDeps = (it: ModItem): DepStatus => {
    const owned: ModItem[] = [];
    const missing: string[] = [];
    for (const d of it.dependencies) {
      const found = byStem.get(d);
      if (found) owned.push(found);
      else missing.push(d);
    }
    return { owned, missing };
  };

  const mods = items.filter((i) => i.kind === "mod");
  const maps = items.filter((i) => i.kind === "map");
  const q = modSearch.trim().toLowerCase();
  const visibleMods = mods
    .filter((m) => !hideIncompat || m.compatible)
    .filter(
      (m) =>
        !q ||
        (m.title + " " + m.filename + " " + m.category + " " + m.tags.join(" "))
          .toLowerCase()
          .includes(q),
    );

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const toggleEnabled = (it: ModItem) => {
    if (it.enabled) return guard(() => api.setEnabled(it.filename, false));
    // Enabling: also pull in any owned dependencies, warn about missing ones.
    const { owned, missing } = resolveDeps(it);
    const also = owned.filter((d) => !d.enabled);
    return guard(async () => {
      await api.setEnabledMany([it.filename, ...also.map((d) => d.filename)], true);
      const parts: string[] = [];
      if (also.length)
        parts.push(
          `Also enabled ${also.length} dependency${also.length === 1 ? "" : "s"}: ${also.map((d) => d.title).join(", ")}.`,
        );
      if (missing.length)
        parts.push(
          `⚠ Missing dependencies (not in your library): ${missing.join(", ")} — find them in Discover.`,
        );
      setNotice(parts.length ? parts.join(" ") : null);
    });
  };

  const setActive = (it: ModItem | null) =>
    guard(() => api.setActiveMap(it ? it.filename : null));

  const bulkEnable = (list: ModItem[], enabled: boolean) =>
    guard(() =>
      api.setEnabledMany(
        list.map((i) => i.filename),
        enabled,
      ),
    );

  const saveMeta = (it: ModItem, patch: Partial<ModItem>) =>
    guard(() =>
      api.updateMeta(it.filename, {
        kind: it.kind,
        category: patch.category ?? it.category,
        tags: patch.tags ?? it.tags,
        requires: patch.requires ?? it.requires,
        provides: patch.provides ?? it.provides,
        notes: patch.notes ?? it.notes,
      }),
    );

  // --- Profiles ---
  const [profileName, setProfileName] = useState("");
  const saveCurrentProfile = () => {
    const name = profileName.trim();
    if (!name) return;
    const enabled = items.filter((i) => i.enabled).map((i) => i.filename);
    setProfileName("");
    return guard(() =>
      api.saveProfile({ id: crypto.randomUUID(), name, mods: enabled }),
    );
  };

  // --- Update checking ---
  async function runUpdateCheck() {
    setUpdateStatus("Checking…");
    setUpdates([]);
    try {
      const catalog = await api.modhubAll();
      const { updates: found, checked } = await checkUpdates(
        items,
        catalog,
        (d, t) => setUpdateStatus(`Checking ${d}/${t}…`),
      );
      setUpdates(found);
      setUpdateStatus(
        checked === 0
          ? "No installed mods matched the ModHub catalog — fetch categories in Discover to widen coverage."
          : `${found.length} update${found.length === 1 ? "" : "s"} available (checked ${checked}).`,
      );
    } catch (e) {
      setError(String(e));
      setUpdateStatus(null);
    }
  }

  const doUpdate = (u: UpdateInfo) =>
    guard(async () => {
      const wasEnabled = items.find((i) => i.filename === u.filename)?.enabled;
      await api.downloadMod(u.modId); // overwrites the library zip (new inode)
      if (wasEnabled) {
        // re-link so the mods folder points at the fresh file
        await api.setEnabled(u.filename, false);
        await api.setEnabled(u.filename, true);
      }
    }).then(() => setUpdates((us) => us.filter((x) => x.modId !== u.modId)));

  return (
    <div className="app">
      <header>
        <h1>🚜 FS25 Mod Manager</h1>
        <nav>
          {(
            [
              "mods",
              "maps",
              "scenarios",
              "discover",
              "saves",
              "disk",
              "settings",
            ] as Tab[]
          ).map((t) => (
            <button
              key={t}
              className={tab === t ? "tab active" : "tab"}
              onClick={() => setTab(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
          <button
            className="refresh play"
            onClick={() => api.launchGame().catch((e) => setError(String(e)))}
            title="Launch Farming Simulator 25"
          >
            ▶ Play
          </button>
          <button className="refresh" onClick={refresh} disabled={busy}>
            ⟳ Rescan
          </button>
        </nav>
        <div className="mapbar">
          {activeMap ? (
            <span>
              Active map: <strong>{activeMap.title}</strong>
              <button className="link" onClick={() => setActive(null)}>
                clear
              </button>
            </span>
          ) : (
            <span className="muted">
              No active map selected — compatibility checks are off.
            </span>
          )}
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {notice && (
        <div className="banner">
          {notice}
          <button className="link" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </div>
      )}

      <main>
        {tab === "mods" && (
          <>
            {items.length === 0 && (
              <div className="onboard">
                <b>👋 Welcome!</b> Your library is empty. If you already have mods
                in the FS25 game folder, import them to get started:
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => guard(() => api.importFromMods().then(() => {}))}
                >
                  ⬇ Import from game folder
                </button>
                <button
                  className="btn ghost"
                  onClick={() => setTab("settings")}
                >
                  Settings
                </button>
              </div>
            )}
            <div className="profiles-bar">
              <span className="pb-label">Profiles:</span>
              {profiles.length === 0 && (
                <span className="muted">none yet</span>
              )}
              {profiles.map((p) => (
                <span key={p.id} className="profile-chip">
                  <button
                    className="chip-apply"
                    disabled={busy}
                    title={`Enable exactly this set (${p.mods.length} items)`}
                    onClick={() => guard(() => api.applyProfile(p.id))}
                  >
                    {p.name}
                  </button>
                  <button
                    className="chip-x"
                    disabled={busy}
                    onClick={() => guard(() => api.deleteProfile(p.id))}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <input
                className="pb-input"
                value={profileName}
                placeholder="name current set…"
                onChange={(e) => setProfileName(e.target.value)}
              />
              <button
                className="btn ghost sm"
                disabled={busy || !profileName.trim()}
                onClick={saveCurrentProfile}
              >
                Save profile
              </button>
            </div>

            <div className="toolbar">
              <input
                className="mod-search"
                value={modSearch}
                placeholder="🔍 search mods…"
                onChange={(e) => setModSearch(e.target.value)}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={hideIncompat}
                  onChange={(e) => setHideIncompat(e.target.checked)}
                />
                Hide incompatible
              </label>
              <button
                className="btn ghost sm"
                disabled={busy || visibleMods.length === 0}
                onClick={() => bulkEnable(visibleMods, true)}
              >
                Enable all shown
              </button>
              <button
                className="btn ghost sm"
                disabled={busy || visibleMods.length === 0}
                onClick={() => bulkEnable(visibleMods, false)}
              >
                Disable all shown
              </button>
              <button
                className="btn ghost sm"
                disabled={busy || updateStatus === "Checking…"}
                onClick={runUpdateCheck}
              >
                ⬆ Check updates
              </button>
              <span className="count">
                {visibleMods.length} / {mods.length} mods
              </span>
            </div>

            {updateStatus && (
              <div className="banner">
                {updateStatus}
                {updates.length > 0 && (
                  <div className="update-list">
                    {updates.map((u) => (
                      <div key={u.modId} className="update-row">
                        <span>
                          <b>{u.title}</b> {u.installed} → {u.latest}
                        </span>
                        <button
                          className="btn sm"
                          disabled={busy}
                          onClick={() => doUpdate(u)}
                        >
                          ⬆ Update
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {visibleMods.length === 0 && (
              <Empty kind="mods" library={config?.libraryDir} />
            )}
            {groupByCategory(visibleMods).map(([cat, list]) => (
              <section key={cat} className="cat-group">
                <h3 className="cat-head">
                  {cat} <span className="cat-count">{list.length}</span>
                </h3>
                {list.map((it) => (
                  <ItemCard
                    key={it.filename}
                    item={it}
                    busy={busy}
                    depStatus={resolveDeps(it)}
                    onToggle={() => toggleEnabled(it)}
                    onDetail={() => setDetail(it)}
                    onSaveMeta={(patch) => saveMeta(it, patch)}
                  />
                ))}
              </section>
            ))}
          </>
        )}

        {tab === "maps" && (
          <>
            {maps.length === 0 && (
              <Empty kind="maps" library={config?.libraryDir} />
            )}
            {maps.map((it) => (
              <ItemCard
                key={it.filename}
                item={it}
                busy={busy}
                isMap
                depStatus={resolveDeps(it)}
                onToggle={() => toggleEnabled(it)}
                onSetActive={() => setActive(it.isActiveMap ? null : it)}
                onDetail={() => setDetail(it)}
                onSaveMeta={(patch) => saveMeta(it, patch)}
              />
            ))}
          </>
        )}

        {tab === "scenarios" && (
          <Scenarios
            items={items}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onAfterApply={refresh}
          />
        )}

        {tab === "discover" && (
          <ModHub
            items={items}
            activeMap={activeMap}
            onLibraryChanged={refresh}
            setError={setError}
          />
        )}

        {tab === "saves" && <Saves setError={setError} />}

        {tab === "disk" && <Disk setError={setError} onChanged={refresh} />}

        {tab === "settings" && config && (
          <Settings config={config} busy={busy} onSaved={refresh} />
        )}
      </main>

      {detail && (
        <DetailModal
          item={detail}
          depStatus={resolveDeps(detail)}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function DetailModal({
  item,
  depStatus,
  onClose,
}: {
  item: ModItem;
  depStatus: DepStatus;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Badge item={item} />
          <h2>{item.title}</h2>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-meta">
          {item.author && (
            <span>
              <b>Author</b> {item.author}
            </span>
          )}
          {item.version && (
            <span>
              <b>Version</b> {item.version}
            </span>
          )}
          {item.size > 0 && (
            <span>
              <b>Size</b> {fmtSize(item.size)}
            </span>
          )}
          {item.category && (
            <span>
              <b>Category</b> {item.category}
            </span>
          )}
          <span>
            <b>File</b> {item.filename}
          </span>
        </div>

        {item.description ? (
          <p className="modal-desc">{item.description}</p>
        ) : (
          <p className="modal-desc muted">No description in modDesc.xml.</p>
        )}

        {item.dependencies.length > 0 && (
          <div className="modal-section">
            <h4>Dependencies</h4>
            <div className="dep-chips">
              {depStatus.owned.map((d) => (
                <span key={d.filename} className="dep-chip ok" title={d.filename}>
                  ✓ {d.title}
                </span>
              ))}
              {depStatus.missing.map((d) => (
                <span key={d} className="dep-chip missing" title="not in library">
                  ✗ {d}
                </span>
              ))}
            </div>
            {depStatus.missing.length > 0 && (
              <p className="hint">
                Missing dependencies aren’t in your library — find them in
                Discover before playing.
              </p>
            )}
          </div>
        )}

        {item.tags.length > 0 && (
          <div className="modal-section">
            <h4>Tags</h4>
            <div className="dep-chips">
              {item.tags.map((t) => (
                <span key={t} className="dep-chip">
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {item.notes && (
          <div className="modal-section">
            <h4>Notes</h4>
            <p>{item.notes}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ kind, library }: { kind: string; library?: string }) {
  return (
    <div className="empty">
      <p>No {kind} found.</p>
      <p className="muted">
        Drop mod/map <code>.zip</code> files into your library folder, then
        Rescan:
        <br />
        <code>{library ?? "…"}</code>
      </p>
    </div>
  );
}

function Badge({ item }: { item: ModItem }) {
  if (item.error)
    return (
      <span className="badge err" title={item.error}>
        unreadable
      </span>
    );
  if (item.kind === "map") return <span className="badge map">map</span>;
  return <span className="badge mod">mod</span>;
}

function ItemCard({
  item,
  busy,
  isMap,
  depStatus,
  onToggle,
  onSetActive,
  onDetail,
  onSaveMeta,
}: {
  item: ModItem;
  busy: boolean;
  isMap?: boolean;
  depStatus: DepStatus;
  onToggle: () => void;
  onSetActive?: () => void;
  onDetail: () => void;
  onSaveMeta: (patch: Partial<ModItem>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState(fromList(item.tags));
  const [caps, setCaps] = useState(
    fromList(isMap ? item.provides : item.requires),
  );
  const [category, setCategory] = useState(item.category);
  const [notes, setNotes] = useState(item.notes);

  const dirty =
    tags !== fromList(item.tags) ||
    caps !== fromList(isMap ? item.provides : item.requires) ||
    category !== item.category ||
    notes !== item.notes;

  return (
    <div
      className={
        "card" +
        (item.enabled ? " on" : "") +
        (!item.compatible ? " bad" : "") +
        (item.isActiveMap ? " active" : "")
      }
    >
      <div className="card-main">
        <div className="card-info">
          <div className="title-row">
            <Badge item={item} />
            <span className="title">{item.title}</span>
            {item.version && <span className="ver">v{item.version}</span>}
            {item.isActiveMap && <span className="badge active">active</span>}
          </div>
          <div className="sub">
            {item.author && <span>{item.author}</span>}
            <span className="muted">{item.filename}</span>
            {item.size > 0 && (
              <span className="muted">{fmtSize(item.size)}</span>
            )}
          </div>
          {!item.compatible && (
            <div className="warn">
              ⚠ Needs {item.incompatReasons.join(", ")} — not provided by the
              active map
            </div>
          )}
          {item.dependencies.length > 0 && (
            <div className="deps">
              <span className="deps-label">needs:</span>
              {depStatus.owned.map((d) => (
                <span key={d.filename} className="dep-chip ok" title={d.filename}>
                  ✓ {d.title}
                </span>
              ))}
              {depStatus.missing.map((d) => (
                <span key={d} className="dep-chip missing" title="not in library">
                  ✗ {d}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="card-actions">
          {isMap && (
            <button
              className={item.isActiveMap ? "btn ghost" : "btn"}
              onClick={onSetActive}
              disabled={busy}
            >
              {item.isActiveMap ? "Unset active" : "Set active"}
            </button>
          )}
          <button
            className={item.enabled ? "btn on" : "btn"}
            onClick={onToggle}
            disabled={busy}
          >
            {item.enabled ? "✓ In game" : "Enable"}
          </button>
          <button className="btn ghost" onClick={onDetail} title="Details">
            ℹ
          </button>
          <button className="btn ghost" onClick={() => setOpen((o) => !o)}>
            {open ? "▲" : "Edit ▾"}
          </button>
        </div>
      </div>

      {open && (
        <div className="editor">
          {!isMap && (
            <label>
              Category
              <input
                value={category}
                placeholder="Vehicles, Tools, Scripts…"
                onChange={(e) => setCategory(e.target.value)}
              />
            </label>
          )}
          <label>
            Tags
            <input
              value={tags}
              placeholder="comma, separated, tags"
              onChange={(e) => setTags(e.target.value)}
            />
          </label>
          <label>
            {isMap ? "Provides (capabilities)" : "Requires (capabilities)"}
            <input
              value={caps}
              placeholder={
                isMap ? "fields, roads, selling-points" : "fields, roads"
              }
              onChange={(e) => setCaps(e.target.value)}
            />
          </label>
          <label>
            Notes
            <input
              value={notes}
              placeholder="anything you want to remember"
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <div className="editor-actions">
            <button
              className="btn"
              disabled={!dirty || busy}
              onClick={() =>
                onSaveMeta(
                  isMap
                    ? { tags: toList(tags), provides: toList(caps), notes }
                    : {
                        tags: toList(tags),
                        requires: toList(caps),
                        category,
                        notes,
                      },
                )
              }
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Settings({
  config,
  busy,
  onSaved,
}: {
  config: Config;
  busy: boolean;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Config>(config);
  const [saved, setSaved] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthMsg, setHealthMsg] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncName, setSyncName] = useState("fs25-backup");
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [missing, setMissing] = useState<ManifestEntry[]>([]);

  useEffect(() => {
    api.syncStatus().then(setSync).catch(() => {});
  }, []);

  async function setupSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const slug = await api.syncSetup(syncName.trim());
      setSyncMsg(`Linked to ${slug}`);
      setSync(await api.syncStatus());
    } catch (e) {
      setSyncMsg(String(e));
    } finally {
      setSyncing(false);
    }
  }
  async function pushSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      setSyncMsg(await api.syncPush());
    } catch (e) {
      setSyncMsg(String(e));
    } finally {
      setSyncing(false);
    }
  }
  async function pullSync() {
    setSyncing(true);
    setSyncMsg(null);
    setMissing([]);
    try {
      const r = await api.syncPull();
      setMissing(r.missing);
      setSyncMsg(
        `Restored ${r.restored.join(", ") || "nothing"} · ${r.savesAvailable} save(s) added to Backups · ${r.missing.length} mod(s) can be re-downloaded`,
      );
      onSaved();
    } catch (e) {
      setSyncMsg(String(e));
    } finally {
      setSyncing(false);
    }
  }
  async function downloadMissing() {
    setSyncing(true);
    try {
      for (const m of missing) {
        if (m.modId) {
          try {
            await api.downloadMod(m.modId);
          } catch {
            /* skip */
          }
        }
      }
      setMissing([]);
      setSyncMsg("Re-downloaded missing mods from ModHub.");
      onSaved();
    } finally {
      setSyncing(false);
    }
  }

  async function runHealth() {
    setHealthMsg(null);
    try {
      setHealth(await api.healthCheck());
    } catch (e) {
      setHealthMsg(String(e));
    }
  }
  async function doFixLinks() {
    try {
      const n = await api.fixLinks();
      setHealthMsg(
        n === 0 ? "No symlinks to fix." : `Converted ${n} symlink(s) to hardlinks.`,
      );
      await runHealth();
      onSaved();
    } catch (e) {
      setHealthMsg(String(e));
    }
  }

  async function browse(key: "libraryDir" | "modsDir") {
    const dir = await open({ directory: true, defaultPath: draft[key] });
    if (typeof dir === "string") setDraft({ ...draft, [key]: dir });
  }

  async function save() {
    await api.saveConfig(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    onSaved();
  }

  async function importMods() {
    setImporting(true);
    setImportMsg(null);
    try {
      const r = await api.importFromMods();
      setImportMsg(
        r.imported === 0 && r.skipped === 0
          ? "Nothing to import — no loose mods in the game folder."
          : `Imported ${r.imported} mod${r.imported === 1 ? "" : "s"} into the library` +
              (r.skipped ? `, skipped ${r.skipped} already there.` : "."),
      );
      onSaved();
    } catch (e) {
      setImportMsg(String(e));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="settings">
      <label className="field">
        Library folder (your downloaded mods &amp; maps)
        <div className="path-row">
          <input
            value={draft.libraryDir}
            onChange={(e) => setDraft({ ...draft, libraryDir: e.target.value })}
          />
          <button className="btn ghost" onClick={() => browse("libraryDir")}>
            Browse…
          </button>
        </div>
      </label>

      <label className="field">
        FS25 mods folder (where the game reads mods)
        <div className="path-row">
          <input
            value={draft.modsDir}
            onChange={(e) => setDraft({ ...draft, modsDir: e.target.value })}
          />
          <button className="btn ghost" onClick={() => browse("modsDir")}>
            Browse…
          </button>
        </div>
      </label>

      <label className="field">
        Link mode
        <select
          value={draft.linkMode}
          onChange={(e) =>
            setDraft({
              ...draft,
              linkMode: e.target.value as Config["linkMode"],
            })
          }
        >
          <option value="hardlink">
            Hardlink — recommended (no duplication, works with FS25)
          </option>
          <option value="copy">Copy (uses disk, always works)</option>
          <option value="symlink">
            Symlink — ⚠ FS25 can’t load these (engine ignores symlinks)
          </option>
        </select>
        <span className="hint">
          Enabling places your library file into the mods folder. Disabling
          removes only that copy/link — your library original is never touched.
          Use <b>Hardlink</b>: FS25’s engine can’t read symlinked mods.
        </span>
      </label>

      <div className="editor-actions">
        <button className="btn on" onClick={save} disabled={busy}>
          Save settings
        </button>
        {saved && <span className="ok">Saved ✓</span>}
      </div>

      <div className="field import-box">
        Import mods already in the game folder
        <span className="hint">
          Moves any loose mod you dropped straight into the FS25 mods folder into
          your library and re-links it, so it stays active but becomes managed.
        </span>
        <div className="editor-actions">
          <button className="btn" onClick={importMods} disabled={importing}>
            {importing ? "Importing…" : "Import from mods folder"}
          </button>
          {importMsg && <span className="ok">{importMsg}</span>}
        </div>
      </div>

      <div className="field import-box">
        Health check
        <span className="hint">
          Verifies your mods load in-game: reads the FS25 log for load failures
          and checks for stray symlinks (which FS25 can’t read) or unmanaged
          files.
        </span>
        <div className="editor-actions">
          <button className="btn" onClick={runHealth} disabled={busy}>
            Run health check
          </button>
          {health && health.symlinks.length > 0 && (
            <button className="btn on" onClick={doFixLinks} disabled={busy}>
              Fix {health.symlinks.length} symlink(s) → hardlinks
            </button>
          )}
          {healthMsg && <span className="ok">{healthMsg}</span>}
        </div>
        {health && (
          <div className="health-report">
            <div className={health.symlinks.length ? "hr bad" : "hr ok"}>
              {health.symlinks.length ? "✗" : "✓"} {health.symlinks.length} stray
              symlink(s)
            </div>
            <div className="hr ok">✓ {health.healthy} healthy entr(ies)</div>
            <div className={health.failedMods.length ? "hr warn" : "hr ok"}>
              {health.failedMods.length ? "⚠" : "✓"}{" "}
              {health.failedMods.length} mod(s) failed to load last run
              {health.failedMods.length > 0 &&
                `: ${health.failedMods.slice(0, 6).join(", ")}${health.failedMods.length > 6 ? "…" : ""}`}
              {!health.logFound && " (no game log found yet)"}
            </div>
            {health.orphans.length > 0 && (
              <div className="hr warn">
                ⚠ {health.orphans.length} unmanaged file(s) in mods folder (not in
                library)
              </div>
            )}
          </div>
        )}
      </div>

      <div className="field import-box">
        External storage (GitHub backup)
        <span className="hint">
          Backs up your scenarios, profiles, savegames and a mod manifest to a
          private GitHub repo. Mods themselves aren’t stored (too big for GitHub)
          — they’re re-downloaded from ModHub on restore.
        </span>

        {sync && !sync.toolsOk ? (
          <span className="hint" style={{ color: "var(--warn)" }}>
            ⚠ GitHub sync needs the <b>git</b> and <b>gh</b> command-line tools
            installed and <code>gh</code> authenticated. Install them (e.g.
            <code>brew install git gh</code> on macOS, or winget on Windows) and
            reopen the app.
          </span>
        ) : !sync?.cloned ? (
          <div className="path-row">
            <input
              value={syncName}
              placeholder="repo name, e.g. fs25-backup"
              onChange={(e) => setSyncName(e.target.value)}
            />
            <button
              className="btn"
              disabled={syncing || !syncName.trim()}
              onClick={setupSync}
            >
              {syncing ? "Setting up…" : "Set up sync"}
            </button>
          </div>
        ) : (
          <>
            <div className="editor-actions">
              <span className="muted">
                Linked to <b>{sync.repo}</b>
              </span>
              <button className="btn on" disabled={syncing} onClick={pushSync}>
                {syncing ? "Working…" : "⬆ Back up now"}
              </button>
              <button className="btn ghost" disabled={syncing} onClick={pullSync}>
                {syncing ? "Working…" : "⬇ Restore from GitHub"}
              </button>
            </div>
            {missing.length > 0 && (
              <div className="editor-actions">
                <span className="muted">
                  {missing.length} mod(s) from the backup aren’t in your library.
                </span>
                <button className="btn" disabled={syncing} onClick={downloadMissing}>
                  ⬇ Re-download {missing.length} from ModHub
                </button>
              </div>
            )}
          </>
        )}
        {syncMsg && <span className="ok">{syncMsg}</span>}
      </div>

      <div className="field import-box">
        About
        <span className="hint">
          FS25 Mod Manager{appVersion ? ` v${appVersion}` : ""} — updates are
          signed and delivered automatically from GitHub Releases.
        </span>
        <div className="editor-actions">
          <button
            className="btn"
            disabled={checkingUpdate}
            onClick={async () => {
              setCheckingUpdate(true);
              try {
                await checkForUpdate(true);
              } finally {
                setCheckingUpdate(false);
              }
            }}
          >
            {checkingUpdate ? "Checking…" : "⬆ Check for updates"}
          </button>
        </div>
      </div>
    </div>
  );
}
