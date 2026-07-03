import { ModItem, SaveInfo, Scenario } from "./api";
import { recommendedOwned } from "./recommendations";

/** A scenario rule, evaluated live against a linked savegame. */
export interface Rule {
  id: string;
  label: string;
  /** true = passing, false = failing, null = can't tell (no save data). */
  check: (s: SaveInfo) => boolean | null;
}

export const RULES: Rule[] = [
  {
    id: "must-have-debt",
    label: "Carry a line of credit (debt > 0)",
    check: (s) => (s.loan == null ? null : s.loan > 0),
  },
  {
    id: "debt-free",
    label: "Stay debt-free (debt = 0)",
    check: (s) => (s.loan == null ? null : s.loan <= 0),
  },
];

export const ruleById = (id: string) => RULES.find((r) => r.id === id);

/** A built-in scenario "mode" the user can instantiate from their library. */
export interface Preset {
  id: string;
  name: string;
  description: string;
  goalMoney: number | null;
  deadlineYears: number | null;
  rules: string[];
  mapKeywords: string[];
  modKeywords: string[];
}

export const PRESETS: Preset[] = [
  {
    id: "realistic",
    name: "Realistic",
    description: "Hardcore economy — run on credit and survive the interest.",
    goalMoney: 1_000_000,
    deadlineYears: 10,
    rules: ["must-have-debt"],
    mapKeywords: [],
    modKeywords: [
      "loan",
      "credit",
      "seasons",
      "realistic",
      "economy",
      "difficulty",
    ],
  },
  {
    id: "flatmap-millionaire",
    name: "Flat Map Millionaire",
    description: "Start from nothing on the flat map, build to a million.",
    goalMoney: 1_000_000,
    deadlineYears: 5,
    rules: [],
    mapKeywords: ["flat", "empty"],
    modKeywords: ["selling", "sell", "mower", "husqvarna"],
  },
  {
    id: "scratch",
    name: "From Scratch",
    description: "Minimal start, grow a farm the honest way.",
    goalMoney: 500_000,
    deadlineYears: 8,
    rules: [],
    mapKeywords: [],
    modKeywords: [],
  },
];

const matches = (item: ModItem, keywords: string[]) =>
  keywords.some((k) =>
    (item.title + " " + item.filename).toLowerCase().includes(k),
  );

// Base-game FS25 can't start below ~$100k; these mods let you set money via
// console, so scenarios include one so their start-money target is reachable.
const MONEY_MODS = ["easydevcontrols", "powertools"];

export function moneyControlMod(items: ModItem[]): string | null {
  const mods = items.filter((i) => i.kind === "mod");
  for (const kw of MONEY_MODS) {
    const m = mods.find((x) =>
      (x.title + x.filename).toLowerCase().replace(/[^a-z0-9]/g, "").includes(kw),
    );
    if (m) return m.filename;
  }
  return null;
}

/** Ensure a money-control mod is in the kit (so start-money targets are reachable). */
export function withMoneyMod(requiredMods: string[], items: ModItem[]): string[] {
  const mm = moneyControlMod(items);
  return mm && !requiredMods.includes(mm) ? [...requiredMods, mm] : requiredMods;
}

/** Build a fresh scenario from a preset, auto-matching a map + mods the user
 *  actually owns in their library. */
export function scenarioFromPreset(preset: Preset, items: ModItem[]): Scenario {
  const maps = items.filter((i) => i.kind === "map");
  const mods = items.filter((i) => i.kind === "mod");
  const map =
    preset.mapKeywords.length > 0
      ? (maps.find((m) => matches(m, preset.mapKeywords))?.filename ?? null)
      : null;
  // Prefer curated recommendations for this mode; fall back to keyword matches.
  const curated = recommendedOwned(preset.id, items);
  const requiredMods =
    curated.length > 0
      ? curated
      : preset.modKeywords.length > 0
        ? mods.filter((m) => matches(m, preset.modKeywords)).map((m) => m.filename)
        : [];
  return {
    id: crypto.randomUUID(),
    name: preset.name,
    description: preset.description,
    mode: preset.id,
    rules: preset.rules,
    map,
    requiredMods: withMoneyMod(requiredMods, items),
    startingKit: moneyControlMod(items)
      ? "Use EasyDevControls/PowerTools to set your starting money."
      : "",
    startMoney: null,
    goalMoney: preset.goalMoney,
    deadlineYears: preset.deadlineYears,
    savegameSlot: null,
  };
}
