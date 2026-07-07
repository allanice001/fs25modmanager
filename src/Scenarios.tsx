import { useEffect, useMemo, useState } from "react";
import {
  api,
  CompanionData,
  CompanionEvent,
  ModHubEntry,
  ModItem,
  SaveInfo,
  Scenario,
  SlotInfo,
  VehicleInfo,
} from "./api";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  PRESETS,
  RULES,
  ruleById,
  scenarioFromPreset,
  withMoneyMod,
} from "./presets";
import { RecMod, ownedMatch, recsFor } from "./recommendations";
import { modhubSearch, modhubMapsLive } from "./ModHub";
import {
  saveMapStem,
  fileStem,
  mapKeyOfFile,
  saveOnMap,
  BASE_MAPS,
  isBaseMap,
  baseMapTitle,
  baseMapValue,
} from "./mapId";
import { buildScenarioShare } from "./export";
import {
  Rule,
  Sample,
  Metric,
  Op,
  When,
  RULE_PRESETS,
  describeRule,
  evaluateRule,
} from "./rules";
import {
  DIFFICULTIES,
  Difficulty,
  GenOptions,
  THEMES,
  generateScenario,
  randomOptions,
} from "./generator";

const money = (n: number) =>
  "$" + Math.round(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

// FS25 games start in August (period 6); the following January is 5 periods
// later. A warm-up scenario gives those Aug–Dec months away free.
const WARMUP_YEARS = 5 / 12;

/** What to do with the seeded save's equipment: keep it all, keep only one
 *  chosen vehicle, remove all for a bare start, or remove all and seed a cash
 *  allowance so the player buys their own first vehicle. */
type EquipMode = "keep" | "one" | "none" | "allowance";

const METRIC_OPTS: { v: Metric; label: string }[] = [
  { v: "cash", label: "Cash" },
  { v: "debt", label: "Debt" },
  { v: "net", label: "Net worth" },
  { v: "equipment", label: "Equipment" },
  { v: "vehicles", label: "Vehicles owned" },
];
const OP_OPTS: { v: Op; label: string }[] = [
  { v: "gte", label: "≥" },
  { v: "lte", label: "≤" },
  { v: "gt", label: ">" },
  { v: "lt", label: "<" },
  { v: "eq", label: "=" },
  { v: "neq", label: "≠" },
];
const WHEN_OPTS: { v: When; label: string }[] = [
  { v: "now", label: "right now" },
  { v: "ever", label: "at some point" },
  { v: "always", label: "at all times" },
  { v: "never", label: "never" },
  { v: "sustained", label: "sustained for…" },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Human-readable rule lines for the in-game overlay (built-in + engine rules). */
function scenarioRuleTexts(s: Scenario): string[] {
  const builtin = s.rules
    .map((r) => ruleById(r)?.label)
    .filter((x): x is string => !!x);
  const engine = (s.engineRules ?? []).map(describeRule);
  return [...builtin, ...engine];
}

/** Reverse-engineer a scenario from an existing savegame: its map, mod list,
 *  current money (as the start), and a suggested goal/deadline. */
function scenarioFromSave(save: SaveInfo, items: ModItem[]): Scenario {
  const maps = items.filter((i) => i.kind === "map");
  const mods = items.filter((i) => i.kind === "mod");

  const stem = saveMapStem(save);
  const mapItem =
    (stem ? maps.find((m) => fileStem(m.filename) === stem) : undefined) ??
    maps.find((m) => norm(m.title) === norm(save.mapTitle)) ??
    maps.find(
      (m) => save.mapTitle && norm(m.filename).includes(norm(save.mapTitle)),
    );
  // Fall back to a base-game map matched by title.
  const baseMatch = BASE_MAPS.find((t) => norm(t) === norm(save.mapTitle));

  // save.mods are modNames = the library filename without ".zip".
  const wanted = new Set(save.mods.map((m) => m.toLowerCase()));
  const requiredMods = mods
    .filter((m) => wanted.has(m.filename.replace(/\.zip$/i, "").toLowerCase()))
    .map((m) => m.filename);

  const cur = save.money ?? 0;
  // Suggest a goal: the next $100k step above 5× current, at least +$250k.
  const goal = Math.max(Math.ceil((cur * 5) / 100_000) * 100_000, cur + 250_000);
  const startYear = save.yearsElapsed != null ? Math.floor(save.yearsElapsed) : 0;

  return {
    id: crypto.randomUUID(),
    name: `${save.name} — ${save.mapTitle || "save"}`.trim(),
    description: `Built from ${save.slot}: grow from ${money(cur)} to the goal.`,
    mode: "from-save",
    rules: (save.loan ?? 0) > 0 ? ["must-have-debt"] : [],
    map: mapItem?.filename ?? (baseMatch ? baseMapValue(baseMatch) : null),
    requiredMods: withMoneyMod(requiredMods, items),
    startingKit: "",
    startMoney: cur,
    goalMoney: goal,
    deadlineYears: startYear + 5,
    savegameSlot: save.slot,
  };
}

function blankScenario(): Scenario {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    mode: "",
    rules: [],
    map: null,
    requiredMods: [],
    startingKit: "",
    startMoney: null,
    goalMoney: null,
    deadlineYears: null,
    savegameSlot: null,
  };
}

export default function Scenarios({
  items,
  busy,
  setBusy,
  setError,
  onAfterApply,
}: {
  items: ModItem[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onAfterApply: () => void;
}) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [saves, setSaves] = useState<SaveInfo[]>([]);
  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [templates, setTemplates] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<ModHubEntry[]>([]);
  const [companions, setCompanions] = useState<Record<string, CompanionData>>(
    {},
  );
  const [histories, setHistories] = useState<Record<string, Sample[]>>({});
  const [events, setEvents] = useState<Record<string, CompanionEvent[]>>({});
  const [overlays, setOverlays] = useState<Record<string, boolean>>({});
  const [shareText, setShareText] = useState<string | null>(null);
  const [seedMsg, setSeedMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<Scenario | null>(null);
  const [generating, setGenerating] = useState(false);
  const [pickingSave, setPickingSave] = useState(false);

  const maps = useMemo(() => items.filter((i) => i.kind === "map"), [items]);
  const mods = useMemo(() => items.filter((i) => i.kind === "mod"), [items]);
  const titleOf = (filename: string) =>
    items.find((i) => i.filename === filename)?.title ?? filename;
  // Display label for a scenario's map (a base-game map, else a library map).
  const mapLabel = (map: string | null) =>
    map ? (isBaseMap(map) ? baseMapTitle(map) : titleOf(map)) : "";

  async function reload() {
    try {
      const [s, sg, sl, tpl, cat] = await Promise.all([
        api.listScenarios(),
        api.listSavegames(),
        api.listSlots(),
        api.getTemplates(),
        api.modhubAll(), // ModHub catalog for share links (empty until fetched)
      ]);
      setScenarios(s);
      setSaves(sg);
      setSlots(sl);
      setTemplates(tpl);
      setCatalog(cat);
      // Live telemetry from the in-game companion mod, for linked slots.
      const linked = [
        ...new Set(
          s.map((x) => x.savegameSlot).filter((v): v is string => !!v),
        ),
      ];
      const comps: Record<string, CompanionData> = {};
      const evs: Record<string, CompanionEvent[]> = {};
      const ovl: Record<string, boolean> = {};
      await Promise.all(
        linked.map(async (slot) => {
          const c = await api.readCompanion(slot).catch(() => null);
          if (c) comps[slot] = c;
          const e = await api.readCompanionEvents(slot).catch(() => []);
          if (e.length) evs[slot] = e;
          ovl[slot] = await api.hasScenarioOverlay(slot).catch(() => false);
        }),
      );
      setCompanions(comps);
      setEvents(evs);
      setOverlays(ovl);
      // History for scenarios that have engine rules + a linked slot.
      const hist: Record<string, Sample[]> = {};
      await Promise.all(
        s
          .filter((x) => x.savegameSlot && (x.engineRules?.length ?? 0) > 0)
          .map(async (x) => {
            const h = await api
              .scenarioHistory(x.id, x.savegameSlot!)
              .catch(() => []);
            hist[x.id] = h;
          }),
      );
      setHistories(hist);
    } catch (e) {
      setError(String(e));
    }
  }

  // Re-read savegames + slots (they change outside the app, as you play).
  async function refreshSaves() {
    try {
      const [sg, sl, tpl] = await Promise.all([
        api.listSavegames(),
        api.listSlots(),
        api.getTemplates(),
      ]);
      setSaves(sg);
      setSlots(sl);
      setTemplates(tpl);
    } catch (e) {
      setError(String(e));
    }
  }

  // Create a savegame for a scenario: clone a source save (same map) into a
  // target slot, then stamp the scenario's money + name onto it.
  async function seedSave(
    scenario: Scenario,
    from: string,
    to: string,
    equip: EquipMode,
    keepVehicle: string | null,
    allowance: number,
    resetClock: boolean,
  ) {
    // A from-scratch scenario expects the source to be a fresh save (made via
    // FS25's "Start From Scratch"). Judge that by owned *equipment* value, not
    // total assets — a map's pre-placed farmstead buildings are on your farm
    // even on a scratch start and shouldn't count.
    const zeroStart = scenario.mode === "scratch" || !!scenario.warmupToJanuary;
    const src = saves.find((s) => s.slot === from);
    if (zeroStart && src && (src.vehicleValue ?? 0) > 200_000) {
      const ok = await ask(
        `${from} already has ~${money(src.vehicleValue ?? 0)} of owned equipment, so it isn't a fresh start. For a true from-scratch run, start a New Game in FS25 with "Start From Scratch", save it, ⭐ it as this map's template, then seed from that.\n\nSeed from ${from} anyway?`,
        { title: "Not a fresh start", kind: "warning" },
      );
      if (!ok) return;
    }
    const target = slots.find((s) => s.slot === to);
    if (target?.occupied) {
      const ok = await ask(
        `${to} already has a save (${target.name}). Overwrite it with this scenario?`,
        { title: "Overwrite savegame", kind: "warning" },
      );
      if (!ok) return;
    }
    await guard(async () => {
      await api.cloneSavegame(from, to);
      // "allowance" mode seeds cash to buy a first vehicle; else the scenario's.
      const seedMoney =
        equip === "allowance" ? allowance : scenario.startMoney;
      await api.patchSavegame(to, scenario.name || null, seedMoney);
      if (equip !== "keep") {
        const keep = equip === "one" ? keepVehicle : null;
        const n = await api.stripEquipment(to, keep);
        setSeedMsg(
          `Seeded ${to}: removed ${n} vehicle${n === 1 ? "" : "s"}` +
            (keep
              ? ` (kept ${keep}).`
              : equip === "allowance"
                ? ` — seeded ${money(allowance)} to buy your own.`
                : "."),
        );
      }
      if (resetClock) await api.resetClock(to);
      // Push the scenario goal/rules into the save for the in-game HUD.
      await api
        .writeScenarioOverlay(
          to,
          scenario.name || "Scenario",
          scenario.goalMoney,
          scenario.startMoney,
          scenario.deadlineYears,
          !!scenario.warmupToJanuary,
          scenarioRuleTexts(scenario),
        )
        .catch(() => {});
      await refreshSaves();
    });
  }

  useEffect(() => {
    reload();
  }, []);

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await reload();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const saveOf = (slot: string | null) =>
    slot ? saves.find((s) => s.slot === slot) ?? null : null;

  if (pickingSave) {
    return (
      <FromSavePanel
        saves={saves}
        items={items}
        onRefreshSaves={refreshSaves}
        onCancel={() => setPickingSave(false)}
        onPick={(s) => {
          setPickingSave(false);
          setEditing(scenarioFromSave(s, items));
        }}
      />
    );
  }

  if (generating) {
    return (
      <GeneratorPanel
        items={items}
        setError={setError}
        onLibraryChanged={onAfterApply}
        onCancel={() => setGenerating(false)}
        onGenerate={(s) => {
          setGenerating(false);
          setEditing(s);
        }}
      />
    );
  }

  if (editing) {
    return (
      <Editor
        scenario={editing}
        maps={maps}
        mods={mods}
        saves={saves}
        busy={busy}
        onLibraryChanged={onAfterApply}
        onRefreshSaves={refreshSaves}
        onCancel={() => setEditing(null)}
        onSave={(s) =>
          guard(() => api.saveScenario(s)).then(() => setEditing(null))
        }
      />
    );
  }

  return (
    <div className="scenarios">
      <div className="toolbar wrap">
        <button className="btn" onClick={() => setEditing(blankScenario())}>
          + Blank
        </button>
        <button className="btn" onClick={() => setGenerating(true)}>
          🎲 Generate
        </button>
        <button
          className="btn"
          onClick={() => {
            refreshSaves();
            setPickingSave(true);
          }}
        >
          💾 From save
        </button>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className="btn ghost"
            title={p.description}
            onClick={() => setEditing(scenarioFromPreset(p, items))}
          >
            + {p.name}
          </button>
        ))}
        <span className="count">{scenarios.length} scenarios</span>
      </div>

      {seedMsg && (
        <div className="banner">
          {seedMsg}
          <button className="link" onClick={() => setSeedMsg(null)}>
            dismiss
          </button>
        </div>
      )}

      {scenarios.length === 0 && (
        <div className="empty">
          <p>No scenarios yet.</p>
          <p className="muted">
            A scenario bundles a map, a starting kit of mods, and a money goal —
            e.g. “Flat Map: start with a mower + a universal selling point, reach
            $1,000,000.”
          </p>
        </div>
      )}

      {scenarios.map((s) => {
        const save = saveOf(s.savegameSlot);
        const cur = save?.money ?? null;
        const pct =
          s.goalMoney && cur != null
            ? Math.max(0, Math.min(100, (cur / s.goalMoney) * 100))
            : null;
        const rawYrs = save?.yearsElapsed ?? null;
        // With a warm-up window, the clock only starts the following January.
        const inWarmup =
          rawYrs != null && !!s.warmupToJanuary && rawYrs < WARMUP_YEARS;
        const yrs =
          rawYrs != null && s.warmupToJanuary
            ? Math.max(0, rawYrs - WARMUP_YEARS)
            : rawYrs;
        const debt = save?.loan ?? null;
        // Net worth counts cash + owned equipment − debt. Buildings are shown
        // separately: a map's pre-placed farmstead would otherwise inflate it.
        const equip = save?.vehicleValue ?? null;
        const buildings =
          save && save.assetValue != null && save.vehicleValue != null
            ? save.assetValue - save.vehicleValue
            : null;
        const net = cur != null ? cur + (equip ?? 0) - (debt ?? 0) : null;
        const goalReached = pct != null && pct >= 100;
        const overDeadline =
          s.deadlineYears != null && yrs != null && yrs > s.deadlineYears;
        return (
          <div key={s.id} className="card scenario">
            <div className="card-main">
              <div className="card-info">
                <div className="title-row">
                  <span className="title">{s.name || "Untitled scenario"}</span>
                  {s.savegameSlot && (
                    <span
                      className={
                        "badge hud " +
                        (overlays[s.savegameSlot] ? "live" : "fallback")
                      }
                      title={
                        overlays[s.savegameSlot]
                          ? "Scenario pushed — the in-game HUD shows the goal, deadline & rules."
                          : "Not pushed — the in-game HUD only shows raw telemetry. Click “To game”."
                      }
                    >
                      {overlays[s.savegameSlot] ? "🖥 live" : "🖥 fallback"}
                    </span>
                  )}
                  {s.mode && <span className="badge mode">{s.mode}</span>}
                  {s.map && <span className="badge map">{mapLabel(s.map)}</span>}
                </div>
                {s.description && <div className="sub">{s.description}</div>}

                {(() => {
                  const mapItem = s.map
                    ? items.find((i) => i.filename === s.map)
                    : null;
                  const missing = (mapItem?.dependencies ?? []).filter(
                    (d) => !items.some((i) => i.filename === `${d}.zip`),
                  );
                  return missing.length > 0 ? (
                    <div className="warn">
                      ⚠ Map “{mapItem!.title}” needs mods not in your library:{" "}
                      {missing.join(", ")} — grab them in Discover.
                    </div>
                  ) : null;
                })()}

                <div className="scen-meta">
                  {s.startMoney != null && (
                    <span>Start: {money(s.startMoney)}</span>
                  )}
                  {s.goalMoney != null && (
                    <span>Goal: {money(s.goalMoney)}</span>
                  )}
                  <span className="muted">
                    {s.requiredMods.length} starting mod
                    {s.requiredMods.length === 1 ? "" : "s"}
                  </span>
                </div>

                {s.startingKit && (
                  <div className="sub kit">🧰 {s.startingKit}</div>
                )}

                {pct != null && (
                  <div className="progress-wrap">
                    <div className="progress">
                      <div
                        className={"bar" + (pct >= 100 ? " done" : "")}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="progress-label">
                      {money(cur!)} / {money(s.goalMoney!)} ({pct.toFixed(0)}%)
                      {pct >= 100 && " ✓ goal reached!"}
                    </div>
                  </div>
                )}
                {save && (cur != null || debt != null) && (
                  <div className="trackers">
                    {cur != null && (
                      <span className="track">
                        <b>Cash</b> {money(cur)}
                      </span>
                    )}
                    {equip != null && equip > 0 && (
                      <span className="track">
                        <b>Equipment</b> {money(equip)}
                      </span>
                    )}
                    {buildings != null && buildings > 0 && (
                      <span
                        className="track muted"
                        title="Value of buildings on your farm (includes any the map pre-places) — not counted in net worth"
                      >
                        <b>Buildings</b> {money(buildings)}
                      </span>
                    )}
                    {debt != null && debt > 0 && (
                      <span className="track debt">
                        <b>Debt</b> {money(debt)}
                      </span>
                    )}
                    {net != null && (
                      <span className="track net" title="cash + equipment − debt">
                        <b>Net</b> {money(net)}
                      </span>
                    )}
                    {save.playTimeHours != null && (
                      <span className="track muted">
                        {save.playTimeHours.toFixed(1)}h played
                      </span>
                    )}
                  </div>
                )}

                {s.savegameSlot &&
                  companions[s.savegameSlot] &&
                  (() => {
                    const c = companions[s.savegameSlot!];
                    const fresh =
                      c.updatedMs != null &&
                      Date.now() - c.updatedMs < 5 * 60 * 1000;
                    return (
                      <div
                        className="live-telemetry"
                        title="Live from the Scenario Companion in-game mod (updates each in-game hour while you play)"
                      >
                        {fresh ? "🟢" : "⚪"} Live
                        {c.money != null && ` · ${money(c.money)}`}
                        {c.day != null && ` · Day ${c.day}`}
                        {c.loan != null && c.loan > 0 && ` · debt ${money(c.loan)}`}
                        {c.vehicleCount != null &&
                          ` · 🚜 ${c.vehicleCount}`}
                        {c.vehicles.length > 0 && (
                          <span
                            className="muted"
                            title={c.vehicles.join(", ")}
                          >
                            {" "}
                            ({c.vehicles.slice(0, 3).join(", ")}
                            {c.vehicles.length > 3
                              ? ` +${c.vehicles.length - 3}`
                              : ""}
                            )
                          </span>
                        )}
                        {!fresh && (
                          <span className="muted"> · from last session</span>
                        )}
                      </div>
                    );
                  })()}

                {s.savegameSlot &&
                  (events[s.savegameSlot]?.length ?? 0) > 0 && (
                    <div className="purchase-log">
                      {events[s.savegameSlot!].slice(0, 5).map((e, i) => (
                        <div key={i} className={"pev " + e.kind}>
                          {e.kind === "sold" ? "💸 sold" : "🛒 bought"} {e.name}
                          <span className="muted"> · day {e.day}</span>
                        </div>
                      ))}
                    </div>
                  )}

                {s.rules.length > 0 && (
                  <div className="rules">
                    {s.rules.map((rid) => {
                      const rule = ruleById(rid);
                      if (!rule) return null;
                      const state = save ? rule.check(save) : null;
                      const icon =
                        state == null ? "•" : state ? "✓" : "✗";
                      const cls =
                        state == null ? "unknown" : state ? "pass" : "fail";
                      return (
                        <div key={rid} className={"rule " + cls}>
                          {icon} {rule.label}
                        </div>
                      );
                    })}
                  </div>
                )}
                {s.rules
                  .map((rid) => ruleById(rid))
                  .filter((r) => r?.needsMod)
                  .filter((r) => {
                    const owned = ownedMatch(r!.needsMod!, mods);
                    return !owned || !s.requiredMods.includes(owned.filename);
                  })
                  .map((r) => (
                    <div key={r!.id} className="warn">
                      ⚠ “{r!.label}” has no {r!.needsMod!.title} mod in this
                      scenario’s kit — Edit to add one.
                    </div>
                  ))}

                {(s.engineRules?.length ?? 0) > 0 && (
                  <div className="engine-rules">
                    {s.engineRules!.map((r) => {
                      const st = evaluateRule(r, histories[s.id] ?? []);
                      const icon =
                        st.state === "pass"
                          ? "✓"
                          : st.state === "fail"
                            ? "✗"
                            : st.state === "pending"
                              ? "•"
                              : "…";
                      return (
                        <div key={r.id} className={"erule " + st.state}>
                          <span>
                            {icon} {st.detail}
                          </span>
                          {st.progress != null && st.progress < 1 && (
                            <span className="erule-bar">
                              <span
                                className="erule-fill"
                                style={{ width: `${Math.round(st.progress * 100)}%` }}
                              />
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {s.deadlineYears != null && (
                  <div
                    className={
                      "deadline " +
                      (overDeadline && !goalReached ? "over" : "ok")
                    }
                  >
                    {inWarmup ? (
                      <>
                        🌱 Warm-up (Aug–Dec) — build capital; the {s.deadlineYears}
                        -year clock starts in January.
                      </>
                    ) : yrs != null ? (
                      <>
                        ⏱ Year {yrs.toFixed(1)} of {s.deadlineYears}
                        {goalReached
                          ? " — made it! ✓"
                          : overDeadline
                            ? " — deadline passed ✗"
                            : ` (${Math.max(0, s.deadlineYears - yrs).toFixed(1)} yrs left)`}
                        {s.warmupToJanuary && " · counted from Jan"}
                      </>
                    ) : (
                      <>
                        ⏱ Deadline: {s.deadlineYears} in-game years
                        {s.warmupToJanuary && " (from January)"}
                      </>
                    )}
                  </div>
                )}

                {s.savegameSlot && !save && (
                  <div className="warn">
                    ⚠ Linked savegame ({s.savegameSlot}) not found or empty.
                  </div>
                )}
              </div>

              <div className="card-actions col">
                <ApplyButton
                  busy={busy}
                  onApply={(exclusive) =>
                    guard(() =>
                      api.applyScenario(s.id, exclusive).then(onAfterApply),
                    )
                  }
                />
                <SeedButton
                  scenario={s}
                  mapFile={s.map}
                  mapTitle={mapLabel(s.map)}
                  saves={saves}
                  slots={slots}
                  templateSlot={s.map ? templates[mapKeyOfFile(s.map)] : undefined}
                  busy={busy}
                  onRefreshSaves={refreshSaves}
                  onSeed={(from, to, equip, keep, allowance, reset) =>
                    seedSave(s, from, to, equip, keep, allowance, reset)
                  }
                />
                <button
                  className="btn ghost sm"
                  disabled={busy}
                  title="Copy a shareable text summary (map, mods, rules) with links"
                  onClick={() => setShareText(buildScenarioShare(s, items, catalog))}
                >
                  🔗 Share
                </button>
                {s.savegameSlot && (
                  <button
                    className="btn ghost sm"
                    disabled={busy}
                    title="Push this scenario's goal, deadline & rules into the linked save so the in-game HUD shows them"
                    onClick={() =>
                      guard(() =>
                        api
                          .writeScenarioOverlay(
                            s.savegameSlot!,
                            s.name || "Scenario",
                            s.goalMoney,
                            s.startMoney,
                            s.deadlineYears,
                            !!s.warmupToJanuary,
                            scenarioRuleTexts(s),
                          )
                          .then(() =>
                            setSeedMsg(`Pushed goal to ${s.savegameSlot}.`),
                          ),
                      )
                    }
                  >
                    📤 To game
                  </button>
                )}
                <button
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={() => setEditing(s)}
                >
                  Edit
                </button>
                <button
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={() => guard(() => api.deleteScenario(s.id))}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {shareText !== null && (
        <ShareModal text={shareText} onClose={() => setShareText(null)} />
      )}
    </div>
  );
}

function ShareModal({
  text,
  onClose,
}: {
  text: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the textarea is selectable as a fallback */
    }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Share scenario</h2>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="hint">
          Paste into a video description, forum post or Discord. ModHub links
          appear for mods in your catalog (fetch categories in Discover for more).
        </p>
        <textarea
          className="share-box"
          readOnly
          value={text}
          rows={14}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="editor-actions">
          <button className="btn on" onClick={copy}>
            {copied ? "Copied ✓" : "📋 Copy"}
          </button>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ApplyButton({
  busy,
  onApply,
}: {
  busy: boolean;
  onApply: (exclusive: boolean) => void;
}) {
  const [exclusive, setExclusive] = useState(true);
  return (
    <div className="apply">
      <button className="btn" disabled={busy} onClick={() => onApply(exclusive)}>
        Apply
      </button>
      <label
        className="check tiny"
        title="Force-clean the mods folder to exactly this scenario, removing anything else (auto-downloaded deps are kept by moving them into your library)."
      >
        <input
          type="checkbox"
          checked={exclusive}
          onChange={(e) => setExclusive(e.target.checked)}
        />
        clean slate
      </label>
    </div>
  );
}

function SeedButton({
  scenario,
  mapFile,
  mapTitle,
  saves,
  slots,
  templateSlot,
  busy,
  onRefreshSaves,
  onSeed,
}: {
  scenario: Scenario;
  mapFile: string | null;
  mapTitle: string;
  saves: SaveInfo[];
  slots: SlotInfo[];
  templateSlot?: string;
  busy: boolean;
  onRefreshSaves: () => void;
  onSeed: (
    from: string,
    to: string,
    equip: EquipMode,
    keepVehicle: string | null,
    allowance: number,
    resetClock: boolean,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  // Saves on the scenario's map (clone can't change a save's map). Match by the
  // map mod's identity so bundled variants (e.g. Ronîda "No Trees") still line up.
  const sameMap =
    mapFile || mapTitle
      ? saves.filter((s) => saveOnMap(s, mapFile, mapTitle))
      : saves;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // From-scratch scenarios default to a bare garage; others keep equipment.
  const zeroStart = scenario.mode === "scratch" || !!scenario.warmupToJanuary;
  const [equip, setEquip] = useState<EquipMode>(zeroStart ? "none" : "keep");
  // Vehicles in the chosen source save, for the "keep one vehicle" picker.
  const [vehicles, setVehicles] = useState<VehicleInfo[]>([]);
  const [keepVehicle, setKeepVehicle] = useState("");
  const [allowance, setAllowance] = useState(25000);
  // From-scratch seeds default to resetting the clock to a fresh start.
  const [resetClock, setResetClock] = useState(zeroStart);
  useEffect(() => {
    if (equip !== "one" || !from) return;
    api
      .listVehicles(from)
      .then((v) => {
        setVehicles(v);
        setKeepVehicle((k) => (v.some((x) => x.name === k) ? k : v[0]?.name ?? ""));
      })
      .catch(() => setVehicles([]));
  }, [equip, from]);

  // Whenever the popover opens or a refresh brings new saves, (re)pick a sensible
  // source: the designated template, else the first same-map save.
  const sameMapKey = sameMap.map((s) => s.slot).join(",");
  useEffect(() => {
    if (!open || sameMap.some((s) => s.slot === from)) return;
    setFrom(
      templateSlot && sameMap.some((s) => s.slot === templateSlot)
        ? templateSlot
        : (sameMap[0]?.slot ?? ""),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sameMapKey, templateSlot]);

  return (
    <div className="seed">
      <button
        className="btn ghost sm"
        disabled={busy}
        title="Create a savegame for this scenario by cloning a save on the same map and stamping the scenario's money + name onto it. Mark a fresh save as the map's template (Saves tab) to auto-pick it."
        onClick={() =>
          setOpen((o) => {
            // Re-read savegames on open — they change as you play outside the app.
            if (!o) onRefreshSaves();
            return !o;
          })
        }
      >
        💾 Seed save
      </button>
      {open && (
        <div className="seed-form">
          {sameMap.length === 0 ? (
            <span className="hint">
              No save on <b>{mapTitle || "this map"}</b> yet. Start one in FS25,
              save it, then ⭐ it in the Saves tab.
            </span>
          ) : (
            <>
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                {sameMap.map((s) => (
                  <option key={s.slot} value={s.slot}>
                    {s.slot === templateSlot ? "⭐ " : ""}
                    {s.slot}: {s.name}
                  </option>
                ))}
              </select>
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">into slot…</option>
                {slots.map((sl) => (
                  <option key={sl.slot} value={sl.slot}>
                    {sl.slot.replace("savegame", "#")}
                    {sl.occupied ? ` (${sl.name || "in use"})` : " (empty)"}
                  </option>
                ))}
              </select>
              <select
                value={equip}
                title="What to do with the cloned save's owned vehicles (a backup is made first)"
                onChange={(e) => setEquip(e.target.value as EquipMode)}
              >
                <option value="keep">🚜 Keep equipment</option>
                <option value="one">🚜 Keep one vehicle…</option>
                <option value="none">🚜 Remove all equipment</option>
                <option value="allowance">💰 Cash for a vehicle…</option>
              </select>
              {equip === "one" && (
                <select
                  value={keepVehicle}
                  title="Which vehicle to keep — the rest are removed"
                  onChange={(e) => setKeepVehicle(e.target.value)}
                >
                  {vehicles.length === 0 && <option value="">(none found)</option>}
                  {vehicles.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} · {money(v.price)}
                    </option>
                  ))}
                </select>
              )}
              {equip === "allowance" && (
                <label
                  className="allowance"
                  title="Remove all vehicles and seed this much cash so you buy your own first vehicle"
                >
                  $
                  <input
                    className="rule-value"
                    type="number"
                    min={0}
                    max={30000}
                    value={allowance}
                    onChange={(e) =>
                      setAllowance(
                        Math.min(30000, Math.max(0, Number(e.target.value))),
                      )
                    }
                  />
                </label>
              )}
              <label
                className="check tiny"
                title="Reset the in-game clock to a fresh August start, so the deadline counts from day one (recommended when cloning a played template)"
              >
                <input
                  type="checkbox"
                  checked={resetClock}
                  onChange={(e) => setResetClock(e.target.checked)}
                />
                ⏱ reset clock
              </label>
              <button
                className="btn sm"
                disabled={busy || !from || !to || (equip === "one" && !keepVehicle)}
                onClick={() => {
                  onSeed(
                    from,
                    to,
                    equip,
                    equip === "one" ? keepVehicle : null,
                    allowance,
                    resetClock,
                  );
                  setOpen(false);
                }}
              >
                Create
                {equip === "allowance"
                  ? ` with ${money(allowance)}`
                  : scenario.startMoney != null
                    ? ` with ${money(scenario.startMoney)}`
                    : ""}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Compose engine rules (metric/op/value/when + sustained duration). */
function RuleBuilder({
  rules,
  onChange,
}: {
  rules: Rule[];
  onChange: (r: Rule[]) => void;
}) {
  const [d, setD] = useState<Rule>({
    id: "",
    metric: "debt",
    op: "eq",
    value: 0,
    when: "sustained",
    months: 6,
    consecutive: true,
  });
  const add = () => onChange([...rules, { ...d, id: crypto.randomUUID() }]);
  const remove = (id: string) => onChange(rules.filter((r) => r.id !== id));

  const addPreset = (r: Omit<Rule, "id">) =>
    onChange([...rules, { ...r, id: crypto.randomUUID() }]);

  return (
    <div className="field">
      Rules (evaluated against your savegame history)
      <div className="rule-presets">
        <span className="muted">quick add:</span>
        {RULE_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="btn ghost sm"
            title={describeRule({ ...p.rule, id: "x" })}
            onClick={() => addPreset(p.rule)}
          >
            + {p.label}
          </button>
        ))}
      </div>
      <div className="rule-list">
        {rules.length === 0 && <span className="muted">no rules yet</span>}
        {rules.map((r) => (
          <span key={r.id} className="rule-chip">
            {describeRule(r)}
            <button
              type="button"
              className="chip-x"
              onClick={() => remove(r.id)}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="rule-builder">
        <select
          value={d.metric}
          onChange={(e) => setD({ ...d, metric: e.target.value as Metric })}
        >
          {METRIC_OPTS.map((m) => (
            <option key={m.v} value={m.v}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          value={d.op}
          onChange={(e) => setD({ ...d, op: e.target.value as Op })}
        >
          {OP_OPTS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          className="rule-value"
          type="number"
          value={d.value}
          onChange={(e) => setD({ ...d, value: Number(e.target.value) })}
        />
        <select
          value={d.when}
          onChange={(e) => setD({ ...d, when: e.target.value as When })}
        >
          {WHEN_OPTS.map((w) => (
            <option key={w.v} value={w.v}>
              {w.label}
            </option>
          ))}
        </select>
        {d.when === "sustained" && (
          <>
            <input
              className="rule-value"
              type="number"
              value={d.months ?? 6}
              onChange={(e) => setD({ ...d, months: Number(e.target.value) })}
            />
            <span className="muted">months</span>
            <label className="check tiny" title="Clock resets if the condition breaks">
              <input
                type="checkbox"
                checked={d.consecutive !== false}
                onChange={(e) => setD({ ...d, consecutive: e.target.checked })}
              />
              consecutive
            </label>
          </>
        )}
        <button type="button" className="btn ghost sm" onClick={add}>
          + Add
        </button>
      </div>
      <span className="hint">Preview: {describeRule({ ...d, id: "x" })}</span>
    </div>
  );
}

function Editor({
  scenario,
  maps,
  mods,
  saves,
  busy,
  onLibraryChanged,
  onRefreshSaves,
  onCancel,
  onSave,
}: {
  scenario: Scenario;
  maps: ModItem[];
  mods: ModItem[];
  saves: SaveInfo[];
  busy: boolean;
  onLibraryChanged: () => void;
  onRefreshSaves: () => void;
  onCancel: () => void;
  onSave: (s: Scenario) => void;
}) {
  const [d, setD] = useState<Scenario>(scenario);
  const [filter, setFilter] = useState("");
  const [dl, setDl] = useState<string | null>(null);
  const [recMsg, setRecMsg] = useState<Record<string, string>>({});
  const [recResults, setRecResults] = useState<Record<string, ModHubEntry[]>>({});
  const recs = recsFor(d.mode);

  // ModHub search is fuzzy, so instead of guessing, show the matches (best-
  // ranked first) and let the user pick the correct mod.
  async function searchRec(rec: RecMod) {
    setDl(rec.title);
    setRecMsg((m) => ({ ...m, [rec.title]: "searching ModHub…" }));
    try {
      const results = await modhubSearch(rec.search);
      const words = rec.search.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      const ranked = results
        .map((r) => ({
          r,
          score: words.filter((w) => norm(r.title).includes(w)).length,
        }))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.r)
        .slice(0, 6);
      setRecResults((m) => ({ ...m, [rec.title]: ranked }));
      setRecMsg((m) => ({
        ...m,
        [rec.title]: ranked.length ? "pick the right one:" : "no results",
      }));
    } catch (e) {
      setRecMsg((m) => ({ ...m, [rec.title]: `✗ ${e}` }));
    } finally {
      setDl(null);
    }
  }

  async function pickResult(recTitle: string, entry: ModHubEntry) {
    setDl(entry.modId);
    setRecMsg((m) => ({ ...m, [recTitle]: `downloading ${entry.title}…` }));
    try {
      const filename = await api.downloadMod(entry.modId);
      onLibraryChanged();
      setD((prev) =>
        prev.requiredMods.includes(filename)
          ? prev
          : { ...prev, requiredMods: [...prev.requiredMods, filename] },
      );
      setRecResults((m) => ({ ...m, [recTitle]: [] }));
      setRecMsg((m) => ({ ...m, [recTitle]: `✓ added ${entry.title}` }));
    } catch (e) {
      setRecMsg((m) => ({ ...m, [recTitle]: `✗ ${e}` }));
    } finally {
      setDl(null);
    }
  }

  // Savegames change as you play, so re-read them whenever the editor opens.
  useEffect(() => {
    onRefreshSaves();
  }, []);
  const set = (patch: Partial<Scenario>) => setD({ ...d, ...patch });

  const toggleMod = (filename: string) =>
    set({
      requiredMods: d.requiredMods.includes(filename)
        ? d.requiredMods.filter((f) => f !== filename)
        : [...d.requiredMods, filename],
    });

  const toggleRule = (id: string) =>
    set({
      rules: d.rules.includes(id)
        ? d.rules.filter((r) => r !== id)
        : [...d.rules, id],
    });

  // Pick a random 2–6 mod starting kit from the whole library.
  const randomizeMods = () => {
    const pool = [...mods];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const count = Math.min(pool.length, 2 + Math.floor(Math.random() * 5));
    set({ requiredMods: pool.slice(0, count).map((m) => m.filename) });
  };

  const shown = mods.filter((m) =>
    (m.title + m.filename).toLowerCase().includes(filter.toLowerCase()),
  );

  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

  return (
    <div className="settings">
      <label className="field">
        Name
        <input
          value={d.name}
          placeholder="Flat Map Millionaire"
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>

      <label className="field">
        Description
        <input
          value={d.description}
          placeholder="Start from nothing on the flat map, build to a million."
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>

      <label className="field">
        Map
        <select
          value={d.map ?? ""}
          onChange={(e) => set({ map: e.target.value || null })}
        >
          <option value="">— none —</option>
          <optgroup label="Base-game maps">
            {BASE_MAPS.map((t) => (
              <option key={t} value={baseMapValue(t)}>
                {t}
              </option>
            ))}
          </optgroup>
          {maps.length > 0 && (
            <optgroup label="Your library">
              {maps.map((m) => (
                <option key={m.filename} value={m.filename}>
                  {m.title}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>

      <div className="field">
        <div className="field-head">
          <span>Starting mods ({d.requiredMods.length} selected)</span>
          <span className="field-head-btns">
            <button
              type="button"
              className="btn ghost sm"
              onClick={randomizeMods}
              disabled={mods.length === 0}
            >
              🎲 Randomize
            </button>
            {d.requiredMods.length > 0 && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => set({ requiredMods: [] })}
              >
                Clear
              </button>
            )}
          </span>
        </div>
        <input
          className="mod-filter"
          value={filter}
          placeholder="filter mods…"
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="mod-picker">
          {shown.map((m) => (
            <label key={m.filename} className="pick-row">
              <input
                type="checkbox"
                checked={d.requiredMods.includes(m.filename)}
                onChange={() => toggleMod(m.filename)}
              />
              {m.title}
            </label>
          ))}
          {shown.length === 0 && <span className="muted">no matches</span>}
        </div>
      </div>

      {recs.length > 0 && (
        <div className="field">
          ✨ Recommended mods for this style
          <div className="mod-picker short">
            {recs.map((r) => {
              const owned = ownedMatch(r, mods);
              const inKit = owned && d.requiredMods.includes(owned.filename);
              const results = recResults[r.title] ?? [];
              return (
                <div key={r.title}>
                  <div className="hubmap-row" title={r.why}>
                    <span className={owned ? "" : "muted"}>
                      {owned ? (inKit ? "✓ " : "○ ") : "⬇ "}
                      <b>{r.title}</b>
                      <span className="rec-why">
                        {" "}
                        — {recMsg[r.title] ?? r.why}
                      </span>
                    </span>
                    {owned ? (
                      !inKit && (
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() =>
                            set({
                              requiredMods: [...d.requiredMods, owned.filename],
                            })
                          }
                        >
                          Add
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={dl !== null}
                        onClick={() => searchRec(r)}
                      >
                        {dl === r.title ? "Searching…" : "🔍 Find"}
                      </button>
                    )}
                  </div>
                  {results.length > 0 && (
                    <div className="rec-results">
                      {results.map((e) => (
                        <button
                          key={e.modId}
                          type="button"
                          className="rec-result"
                          disabled={dl !== null}
                          title={`by ${e.author}`}
                          onClick={() => pickResult(r.title, e)}
                        >
                          {dl === e.modId ? "⏳ " : "⬇ "}
                          {e.title}
                          {e.author && (
                            <span className="rec-why"> · {e.author}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <label className="field">
        Starting kit (notes)
        <input
          value={d.startingKit}
          placeholder="Husqvarna mower + universal selling point"
          onChange={(e) => set({ startingKit: e.target.value })}
        />
      </label>

      <div className="two-col">
        <label className="field">
          Start money
          <input
            type="number"
            value={d.startMoney ?? ""}
            placeholder="e.g. 5000"
            onChange={(e) => set({ startMoney: numOrNull(e.target.value) })}
          />
        </label>
        <label className="field">
          Goal money
          <input
            type="number"
            value={d.goalMoney ?? ""}
            placeholder="e.g. 1000000"
            onChange={(e) => set({ goalMoney: numOrNull(e.target.value) })}
          />
        </label>
        <label className="field">
          Deadline (in-game years)
          <input
            type="number"
            value={d.deadlineYears ?? ""}
            placeholder="e.g. 5"
            onChange={(e) => set({ deadlineYears: numOrNull(e.target.value) })}
          />
        </label>
      </div>

      <label className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={!!d.warmupToJanuary}
            onChange={(e) => set({ warmupToJanuary: e.target.checked })}
          />
          Warm-up window (Aug–Dec free)
        </label>
        <span className="hint">
          FS25 starts in August. With this on, the first Aug–Dec is free time to
          build capital (contracts, odd jobs) and the deadline clock only starts
          the following <b>January</b>. Pair with a $0 start for a true grind.
        </span>
      </label>

      <label className="field">
        <span className="field-head">
          <span>Track progress from savegame</span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={onRefreshSaves}
          >
            ↻ Rescan saves
          </button>
        </span>
        <select
          value={d.savegameSlot ?? ""}
          onChange={(e) => set({ savegameSlot: e.target.value || null })}
        >
          <option value="">— none —</option>
          {saves.map((s) => (
            <option key={s.slot} value={s.slot}>
              {s.slot}: {s.name}
              {s.mapTitle ? ` — ${s.mapTitle}` : ""}
              {s.money != null ? ` (${money(s.money)})` : ""}
            </option>
          ))}
        </select>
        <span className="hint">
          Money is read live from this save to show goal progress.
        </span>
      </label>

      <div className="field">
        Quick rules (single-snapshot, tracked against the savegame)
        <div className="mod-picker short">
          {RULES.map((r) => (
            <label key={r.id} className="pick-row" title={r.hint ?? ""}>
              <input
                type="checkbox"
                checked={d.rules.includes(r.id)}
                onChange={() => toggleRule(r.id)}
              />
              {r.label}
            </label>
          ))}
        </div>
      </div>

      <RuleBuilder
        rules={d.engineRules ?? []}
        onChange={(r) => set({ engineRules: r })}
      />

      {/* A selected rule that needs a supporting mod (e.g. a loan mod for the
          "carry a line of credit" rule) — offer to add or download one. */}
      {d.rules.map((rid) => {
        const rule = ruleById(rid);
        const rec = rule?.needsMod;
        if (!rule || !rec) return null;
        const owned = ownedMatch(rec, mods);
        const inKit = !!owned && d.requiredMods.includes(owned.filename);
        if (inKit) return null;
        const results = recResults[rec.title] ?? [];
        return (
          <div key={rid} className="field">
            <div className="warn">⚠ “{rule.label}” — {rule.hint}</div>
            <div className="hubmap-row" title={rec.why}>
              <span className={owned ? "" : "muted"}>
                {owned ? "○ " : "⬇ "}
                <b>{rec.title}</b>
                <span className="rec-why"> — {recMsg[rec.title] ?? rec.why}</span>
              </span>
              {owned ? (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    set({ requiredMods: [...d.requiredMods, owned.filename] })
                  }
                >
                  Add to kit
                </button>
              ) : (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={dl !== null}
                  onClick={() => searchRec(rec)}
                >
                  {dl === rec.title ? "Searching…" : "🔍 Find on ModHub"}
                </button>
              )}
            </div>
            {results.length > 0 && (
              <div className="rec-results">
                {results.map((e) => (
                  <button
                    key={e.modId}
                    type="button"
                    className="rec-result"
                    disabled={dl !== null}
                    title={`by ${e.author}`}
                    onClick={() => pickResult(rec.title, e)}
                  >
                    {dl === e.modId ? "⏳ " : "⬇ "}
                    {e.title}
                    {e.author && <span className="rec-why"> · {e.author}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="editor-actions">
        <button
          className="btn on"
          disabled={busy || !d.name.trim()}
          onClick={() => onSave(d)}
        >
          Save scenario
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function GeneratorPanel({
  items,
  setError,
  onLibraryChanged,
  onCancel,
  onGenerate,
}: {
  items: ModItem[];
  setError: (e: string | null) => void;
  onLibraryChanged: () => void;
  onCancel: () => void;
  onGenerate: (s: Scenario) => void;
}) {
  const maps = useMemo(() => items.filter((i) => i.kind === "map"), [items]);
  const [opts, setOpts] = useState<GenOptions>({
    difficulty: "balanced",
    themeId: "any",
    map: null,
  });
  const [hubMaps, setHubMaps] = useState<ModHubEntry[]>([]);
  const [dl, setDl] = useState<string | null>(null);
  const set = (patch: Partial<GenOptions>) => setOpts({ ...opts, ...patch });

  useEffect(() => {
    api
      .modhubAll()
      .then((all) =>
        setHubMaps(all.filter((e) => e.category.startsWith("map"))),
      )
      .catch(() => {});
  }, []);

  const roll = () => onGenerate(generateScenario(opts, items));
  const surprise = () => onGenerate(generateScenario(randomOptions(items), items));

  // Download a ModHub map, then generate a scenario that starts on it.
  async function useHubMap(e: ModHubEntry) {
    setDl(e.modId);
    setError(null);
    try {
      const filename = await api.downloadMod(e.modId);
      onLibraryChanged();
      const scenario = generateScenario(opts, items);
      scenario.map = filename;
      onGenerate(scenario);
    } catch (err) {
      setError(`Couldn't download ${e.title}: ${err}`);
    } finally {
      setDl(null);
    }
  }

  // Fully random: roll every knob AND the map — pulling a fresh map off ModHub
  // (downloading it) even if none is cached or in the library.
  async function fullRandom() {
    setError(null);
    setDl("full");
    try {
      let pool = hubMaps;
      if (pool.length === 0) pool = await modhubMapsLive();
      if (pool.length === 0) {
        // No ModHub maps reachable — fall back to a library-only surprise.
        surprise();
        return;
      }
      const pick = pool[Math.floor(Math.random() * pool.length)];
      const filename = await api.downloadMod(pick.modId);
      onLibraryChanged();
      const scenario = generateScenario(randomOptions(items), items);
      scenario.map = filename;
      scenario.description =
        `${scenario.description} Map: ${pick.title} (fresh from ModHub).`.trim();
      onGenerate(scenario);
    } catch (err) {
      setError(`Fully-random roll failed: ${err}`);
    } finally {
      setDl(null);
    }
  }

  const cfg = DIFFICULTIES[opts.difficulty];

  return (
    <div className="settings">
      <div className="gen-head">
        🎲 Generate a scenario
        <span className="hint">
          Rolls a challenge from your library — pick the knobs, or hit Surprise me.
        </span>
      </div>

      <div className="two-col">
        <label className="field">
          Difficulty
          <select
            value={opts.difficulty}
            onChange={(e) => set({ difficulty: e.target.value as Difficulty })}
          >
            {(Object.keys(DIFFICULTIES) as Difficulty[]).map((k) => (
              <option key={k} value={k}>
                {DIFFICULTIES[k].label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          Theme
          <select
            value={opts.themeId}
            onChange={(e) => set({ themeId: e.target.value })}
          >
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        Map
        <select
          value={opts.map ?? ""}
          onChange={(e) => set({ map: e.target.value || null })}
        >
          <option value="">🎲 Random from library</option>
          <optgroup label="Base-game maps">
            {BASE_MAPS.map((t) => (
              <option key={t} value={baseMapValue(t)}>
                {t}
              </option>
            ))}
          </optgroup>
          {maps.length > 0 && (
            <optgroup label="Your library">
              {maps.map((m) => (
                <option key={m.filename} value={m.filename}>
                  {m.title}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {maps.length === 0 && (
          <span className="hint">
            No maps in your library yet — pick a ModHub map below, or the scenario
            will have no map set.
          </span>
        )}
      </label>

      {hubMaps.length > 0 && (
        <div className="field">
          🌐 …or start on a fresh ModHub map (downloads into your library)
          <div className="mod-picker">
            {hubMaps.slice(0, 40).map((e) => (
              <div key={e.modId} className="hubmap-row">
                <span>{e.title}</span>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={dl !== null}
                  onClick={() => useHubMap(e)}
                >
                  {dl === e.modId ? "Downloading…" : "⬇ Download & use"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {hubMaps.length === 0 && (
        <span className="hint">
          Tip: fetch a map category in the <b>Discover</b> tab to unlock ModHub
          maps here.
        </span>
      )}

      <div className="gen-preview">
        <b>{cfg.label}</b> · goal {money(cfg.goal)} · start {money(cfg.startMoney)}{" "}
        · {cfg.deadline} yr deadline
        {cfg.rules.length > 0 && " · must carry debt"}
      </div>

      <div className="editor-actions">
        <button className="btn on" onClick={roll} disabled={dl !== null}>
          Generate
        </button>
        <button className="btn" onClick={surprise} disabled={dl !== null}>
          🎲 Surprise me
        </button>
        <button
          className="btn"
          onClick={fullRandom}
          disabled={dl !== null}
          title="Roll everything — including a fresh map downloaded from ModHub, even if you have none in your library."
        >
          {dl === "full" ? "Rolling…" : "🌐 Fully random"}
        </button>
        <button className="btn ghost" onClick={onCancel} disabled={dl !== null}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function FromSavePanel({
  saves,
  items,
  onRefreshSaves,
  onCancel,
  onPick,
}: {
  saves: SaveInfo[];
  items: ModItem[];
  onRefreshSaves: () => void;
  onCancel: () => void;
  onPick: (s: SaveInfo) => void;
}) {
  // Savegames change as you play — re-read them when this panel opens.
  useEffect(() => {
    onRefreshSaves();
  }, []);

  const libMods = new Set(
    items
      .filter((i) => i.kind === "mod")
      .map((m) => m.filename.replace(/\.zip$/i, "").toLowerCase()),
  );
  const matchCount = (s: SaveInfo) =>
    s.mods.filter((m) => libMods.has(m.toLowerCase())).length;

  return (
    <div className="settings">
      <div className="gen-head">
        💾 Build a scenario from a savegame
        <span className="hint">
          Reads the save’s map, mods, money and year, then drafts a scenario that
          tracks it — review and tweak before saving.
        </span>
      </div>

      {saves.length === 0 && (
        <p className="muted">
          No savegames found yet — start a game, then ↻ Rescan.
        </p>
      )}

      {saves.map((s) => (
        <div key={s.slot} className="card scenario">
          <div className="card-main">
            <div className="card-info">
              <div className="title-row">
                <span className="title">{s.name}</span>
                {s.mapTitle && <span className="badge map">{s.mapTitle}</span>}
              </div>
              <div className="scen-meta">
                {s.money != null && <span>Cash {money(s.money)}</span>}
                {s.yearsElapsed != null && (
                  <span>Year {s.yearsElapsed.toFixed(1)}</span>
                )}
                <span className="muted">
                  {matchCount(s)}/{s.mods.length} mods in library · {s.slot}
                </span>
              </div>
            </div>
            <div className="card-actions">
              <button className="btn" onClick={() => onPick(s)}>
                Build scenario
              </button>
            </div>
          </div>
        </div>
      ))}

      <div className="editor-actions">
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn ghost sm" onClick={onRefreshSaves}>
          ↻ Rescan saves
        </button>
      </div>
    </div>
  );
}
