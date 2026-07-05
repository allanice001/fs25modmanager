import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, BackupInfo, FarmOverview, SaveInfo, SlotInfo } from "./api";
import { mapKeyOfSave } from "./mapId";

const money = (n: number) => "$" + Math.round(n).toLocaleString();
const fmtSize = (b: number) =>
  b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;

export default function Saves({
  setError,
}: {
  setError: (e: string | null) => void;
}) {
  const [saves, setSaves] = useState<SaveInfo[]>([]);
  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [templates, setTemplates] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function reload() {
    try {
      const [s, sl, b, tpl] = await Promise.all([
        api.listSavegames(),
        api.listSlots(),
        api.listBackups(),
        api.getTemplates(),
      ]);
      setSaves(s);
      setSlots(sl);
      setBackups(b);
      setTemplates(tpl);
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleTemplate(s: SaveInfo) {
    const key = mapKeyOfSave(s);
    const isTpl = templates[key] === s.slot;
    try {
      await api.setTemplate(key, isTpl ? "" : s.slot);
      setMsg(
        isTpl
          ? `Cleared template for ${s.mapTitle}`
          : `${s.slot} is now the template for ${s.mapTitle}`,
      );
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    reload();
  }, []);

  async function backup(slot: string) {
    setBusy(slot);
    setMsg(null);
    try {
      const name = await api.backupSavegame(slot);
      setMsg(`Backed up ${slot} → ${name}`);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function restore(b: BackupInfo) {
    const ok = await ask(
      `Restore "${b.name}" into ${b.slot}? This overwrites the current save in ${b.slot}.`,
      { title: "Restore savegame", kind: "warning" },
    );
    if (!ok) return;
    setBusy(b.name);
    try {
      await api.restoreSavegame(b.name, b.slot);
      setMsg(`Restored ${b.name} → ${b.slot}`);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function setMoney(slot: string, value: number) {
    const ok = await ask(
      `Set the starting money in ${slot} to ${money(value)}? A backup is made first.`,
      { title: "Edit savegame money", kind: "warning" },
    );
    if (!ok) return;
    setBusy(slot);
    setMsg(null);
    try {
      await api.patchSavegame(slot, null, value);
      setMsg(`${slot} money set to ${money(value)} (backup saved).`);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function clone(from: string, to: string) {
    const target = slots.find((s) => s.slot === to);
    if (target?.occupied) {
      const ok = await ask(
        `${to} already has a save (${target.name}). Overwrite it with a copy of ${from}?`,
        { title: "Overwrite savegame", kind: "warning" },
      );
      if (!ok) return;
    }
    setBusy(from + to);
    setMsg(null);
    try {
      await api.cloneSavegame(from, to);
      setMsg(`Cloned ${from} → ${to}`);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="saves">
      <div className="toolbar wrap">
        <button
          className="btn on"
          onClick={() => api.launchGame().catch((e) => setError(String(e)))}
        >
          ▶ Launch FS25
        </button>
        <button className="btn ghost" onClick={reload}>
          ⟳ Refresh
        </button>
        {msg && <span className="ok">{msg}</span>}
      </div>

      <h3 className="cat-head">All slots</h3>
      <div className="slot-grid">
        {slots.map((s) => (
          <div
            key={s.slot}
            className={"slot-chip" + (s.occupied ? " full" : " empty")}
            title={
              s.occupied
                ? `${s.name} · ${s.mapTitle}${s.money != null ? ` · ${money(s.money)}` : ""}`
                : "empty"
            }
          >
            <b>{s.slot.replace("savegame", "#")}</b>
            <span>{s.occupied ? s.name || s.mapTitle || "in use" : "empty"}</span>
          </div>
        ))}
      </div>

      <h3 className="cat-head">Savegames</h3>
      {saves.length === 0 && <p className="muted">No savegames found.</p>}
      {saves.map((s) => (
        <SaveCard
          key={s.slot}
          save={s}
          slots={slots}
          busy={busy}
          isTemplate={templates[mapKeyOfSave(s)] === s.slot}
          onToggleTemplate={() => toggleTemplate(s)}
          onBackup={() => backup(s.slot)}
          onSetMoney={(v) => setMoney(s.slot, v)}
          onClone={(to) => clone(s.slot, to)}
        />
      ))}

      <h3 className="cat-head">Backups</h3>
      {backups.length === 0 && <p className="muted">No backups yet.</p>}
      {backups.map((b) => (
        <div key={b.name} className="card">
          <div className="card-main">
            <div className="card-info">
              <div className="title-row">
                <span className="title">{b.slot}</span>
                <span className="muted">{b.name}</span>
                <span className="muted">{fmtSize(b.size)}</span>
              </div>
            </div>
            <div className="card-actions">
              <button
                className="btn ghost"
                disabled={busy === b.name}
                onClick={() => restore(b)}
              >
                ↩ Restore
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SaveCard({
  save: s,
  slots,
  busy,
  isTemplate,
  onToggleTemplate,
  onBackup,
  onSetMoney,
  onClone,
}: {
  save: SaveInfo;
  slots: SlotInfo[];
  busy: string | null;
  isTemplate: boolean;
  onToggleTemplate: () => void;
  onBackup: () => void;
  onSetMoney: (v: number) => void;
  onClone: (to: string) => void;
}) {
  const [moneyInput, setMoneyInput] = useState(
    s.money != null ? String(Math.round(s.money)) : "",
  );
  const [cloneTo, setCloneTo] = useState("");
  // Net worth = cash + owned equipment − debt. Buildings (which include any the
  // map pre-places on the starting farm) are shown in the Farm overview, not here.
  const equip = s.vehicleValue ?? null;
  const net =
    s.money != null ? s.money + (equip ?? 0) - (s.loan ?? 0) : null;
  const working = busy?.startsWith(s.slot);

  // Lazily-loaded farm overview (vehicles/buildings/fields).
  const [farm, setFarm] = useState<FarmOverview | null>(null);
  const [farmOpen, setFarmOpen] = useState(false);
  const [farmErr, setFarmErr] = useState<string | null>(null);
  async function toggleFarm() {
    if (farmOpen) {
      setFarmOpen(false);
      return;
    }
    setFarmOpen(true);
    if (farm) return;
    try {
      setFarm(await api.farmOverview(s.slot));
      setFarmErr(null);
    } catch (e) {
      setFarmErr(String(e));
    }
  }

  return (
    <div className="card scenario">
      <div className="card-main">
        <div className="card-info">
          <div className="title-row">
            <span className="title">{s.name}</span>
            {s.mapTitle && <span className="badge map">{s.mapTitle}</span>}
            <span className="muted">{s.slot}</span>
            {s.mapTitle && (
              <button
                className={"chip-star" + (isTemplate ? " on" : "")}
                title={
                  isTemplate
                    ? `Template for ${s.mapTitle} — Seed clones this. Click to unset.`
                    : `Mark as the template for ${s.mapTitle} (Seed will clone it)`
                }
                onClick={onToggleTemplate}
              >
                {isTemplate ? "⭐ template" : "☆ template"}
              </button>
            )}
          </div>
          <div className="trackers">
            {s.money != null && (
              <span className="track">
                <b>Cash</b> {money(s.money)}
              </span>
            )}
            {equip != null && equip > 0 && (
              <span className="track">
                <b>Equipment</b> {money(equip)}
              </span>
            )}
            {net != null && (
              <span className="track net">
                <b>Net</b> {money(net)}
              </span>
            )}
            {s.yearsElapsed != null && (
              <span className="track muted">Year {s.yearsElapsed.toFixed(1)}</span>
            )}
          </div>
          <div className="save-tools">
            <span className="st-label">Set money $</span>
            <input
              className="st-money"
              type="number"
              value={moneyInput}
              onChange={(e) => setMoneyInput(e.target.value)}
            />
            <button
              className="btn ghost sm"
              disabled={!!working || moneyInput.trim() === ""}
              onClick={() => onSetMoney(Number(moneyInput))}
            >
              Set
            </button>
            <span className="st-sep">·</span>
            <span className="st-label">Clone to</span>
            <select value={cloneTo} onChange={(e) => setCloneTo(e.target.value)}>
              <option value="">slot…</option>
              {slots
                .filter((x) => x.slot !== s.slot)
                .map((x) => (
                  <option key={x.slot} value={x.slot}>
                    {x.slot.replace("savegame", "#")}
                    {x.occupied ? ` (${x.name || "in use"})` : " (empty)"}
                  </option>
                ))}
            </select>
            <button
              className="btn ghost sm"
              disabled={!!working || !cloneTo}
              onClick={() => onClone(cloneTo)}
            >
              Clone
            </button>
          </div>
        </div>
        <div className="card-actions">
          <button className="btn" disabled={!!working} onClick={onBackup}>
            {working ? "…" : "⬇ Back up"}
          </button>
          <button className="btn ghost" onClick={toggleFarm}>
            {farmOpen ? "▲ Farm" : "🚜 Farm ▾"}
          </button>
        </div>
      </div>

      {farmOpen && (
        <div className="farm-overview">
          {farmErr && <div className="warn">{farmErr}</div>}
          {!farm && !farmErr && <span className="muted">Reading save…</span>}
          {farm && (
            <>
              <div className="farm-stats">
                <span className="track">
                  <b>Vehicles</b> {farm.vehicleCount}
                </span>
                <span className="track">
                  <b>Fleet value</b> {money(farm.vehicleValue)}
                </span>
                <span className="track">
                  <b>Buildings</b> {farm.buildingCount}
                </span>
                <span className="track">
                  <b>Building value</b> {money(farm.buildingValue)}
                </span>
                <span className="track">
                  <b>Fields owned</b> {farm.fieldCount}
                </span>
              </div>
              {farm.topVehicles.length > 0 && (
                <div className="farm-vehicles">
                  <span className="st-label">Most valuable:</span>
                  {farm.topVehicles.map((v, i) => (
                    <span key={i} className="dep-chip" title={money(v.value)}>
                      {v.name} · {money(v.value)}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
