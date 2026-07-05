import { ModItem, SaveInfo, Scenario } from "./api";
import { RecMod, recommendedOwned } from "./recommendations";

/** A scenario rule, evaluated live against a linked savegame. */
export interface Rule {
  id: string;
  label: string;
  /** true = passing, false = failing, null = can't tell (no save data). */
  check: (s: SaveInfo) => boolean | null;
  /** A mod that makes this rule meaningful/practical, if any. The editor
   *  offers to add or download it when the rule is selected. */
  needsMod?: RecMod;
  /** Short in-game guidance on how to satisfy the rule. */
  hint?: string;
}

export const RULES: Rule[] = [
  {
    id: "must-have-debt",
    label: "Carry a line of credit (debt > 0)",
    check: (s) => (s.loan == null ? null : s.loan > 0),
    needsMod: {
      title: "Line of Credit",
      search: "line of credit",
      why: "raises your credit limit so running on debt is meaningful",
    },
    hint: "You can borrow at the bank in the base game, but a loan mod raises the ceiling and makes a credit run interesting.",
  },
  {
    id: "debt-free",
    label: "Stay debt-free (debt = 0)",
    check: (s) => (s.loan == null ? null : s.loan <= 0),
  },
];

export const ruleById = (id: string) => RULES.find((r) => r.id === id);

/** Rules that can't be active together — each maps to the rule it contradicts. */
export const RULE_CONFLICTS: Record<string, string> = {
  "must-have-debt": "debt-free",
  "debt-free": "must-have-debt",
};

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
  /** Starting money to stamp (e.g. 0 for a from-scratch grind). */
  startMoney?: number | null;
  /** Give the Aug–Dec window free; deadline counts from January. */
  warmupToJanuary?: boolean;
  /** Override the auto-generated starting-kit note. */
  startingKit?: string;
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
    name: "From Scratch (zero start)",
    description:
      "Start-From-Scratch grind: $0, no land, only a base truck + hand tools. Aug–Dec is a free warm-up to build capital from contracts; the deadline clock starts in January.",
    goalMoney: 500_000,
    deadlineYears: 8,
    rules: [],
    mapKeywords: [],
    modKeywords: [],
    startMoney: 0,
    warmupToJanuary: true,
    startingKit:
      "Keep only a base pickup/truck + hand tools; sell everything else. Seed a true zero-asset save: in FS25 start a New Game → economic difficulty ‘Start From Scratch’, save immediately, then ⭐ it as this map’s template.",
  },
  {
    id: "grind",
    name: "Grind",
    description:
      "Earn every dollar — start at $0, no money cheats, tough economy, income from contracts, used gear and selling anywhere. Aug–Dec warm-up, then the clock runs to a million.",
    goalMoney: 1_000_000,
    deadlineYears: 10,
    rules: [],
    mapKeywords: [],
    modKeywords: [],
    startMoney: 0,
    warmupToJanuary: true,
    startingKit:
      "No console money — earn it. Lean on contracts, second-hand equipment and sell-anywhere to build capital, and let a realistic economy keep the pressure on.",
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
    startingKit:
      preset.startingKit ??
      (moneyControlMod(items)
        ? "Use EasyDevControls/PowerTools to set your starting money."
        : ""),
    startMoney: preset.startMoney ?? null,
    goalMoney: preset.goalMoney,
    deadlineYears: preset.deadlineYears,
    savegameSlot: null,
    warmupToJanuary: preset.warmupToJanuary ?? false,
  };
}
