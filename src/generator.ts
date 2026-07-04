import { ModItem, Scenario } from "./api";
import { moneyControlMod, withMoneyMod } from "./presets";
import { recommendedOwned } from "./recommendations";

export type Difficulty =
  | "easy"
  | "balanced"
  | "realistic"
  | "hard"
  | "brutal";

interface DiffConfig {
  label: string;
  goal: number;
  startMoney: number;
  deadline: number;
  rules: string[];
}

export const DIFFICULTIES: Record<Difficulty, DiffConfig> = {
  easy: { label: "Easy", goal: 250_000, startMoney: 100_000, deadline: 8, rules: [] },
  balanced: { label: "Balanced", goal: 500_000, startMoney: 50_000, deadline: 6, rules: [] },
  realistic: {
    label: "Realistic",
    goal: 1_000_000,
    startMoney: 20_000,
    deadline: 8,
    rules: ["must-have-debt"],
  },
  hard: { label: "Hard", goal: 1_000_000, startMoney: 15_000, deadline: 5, rules: [] },
  brutal: {
    label: "Brutal",
    goal: 2_000_000,
    startMoney: 5_000,
    deadline: 4,
    rules: ["must-have-debt"],
  },
};

export interface Theme {
  id: string;
  label: string;
  keywords: string[];
  kit: string;
  noun: string;
}

export const THEMES: Theme[] = [
  { id: "any", label: "Any", keywords: [], kit: "", noun: "Homestead" },
  {
    id: "livestock",
    label: "Livestock",
    keywords: ["animal", "cow", "sheep", "pig", "barn", "chicken", "husband", "dairy", "horse"],
    kit: "A barn + feeding gear — live off the herd",
    noun: "Herd",
  },
  {
    id: "contracting",
    label: "Contracting",
    keywords: ["contract", "courseplay", "autodrive", "helper", "mission"],
    kit: "A contracting rig — earn by taking jobs",
    noun: "Contractor Run",
  },
  {
    id: "bigiron",
    label: "Big Iron",
    keywords: ["xxl", "large", "big", "cat", "challenger", "fendt", "1290", "9rx", "quad"],
    kit: "One oversized machine — make it pay for itself",
    noun: "Big Iron",
  },
  {
    id: "minimalist",
    label: "Minimalist",
    keywords: ["mower", "hand", "push", "small", "compact", "lawn"],
    kit: "Smallest tools only — no shortcuts",
    noun: "Shoestring",
  },
  {
    id: "forestry",
    label: "Forestry",
    keywords: ["forest", "wood", "log", "timber", "chainsaw", "harvester", "forwarder"],
    kit: "Chainsaw + logging gear — from the trees up",
    noun: "Timber Run",
  },
  {
    id: "crops",
    label: "Crops",
    keywords: ["plow", "seeder", "harvester", "combine", "cultivator", "planter", "header"],
    kit: "A basic tillage + harvest chain",
    noun: "Harvest",
  },
  {
    id: "grind",
    label: "Grind",
    keywords: ["contract", "used", "autoload", "sell", "mow", "realistic", "economy", "loan", "credit", "hire"],
    kit: "Contracts + used gear + sell-anywhere — earn every dollar",
    noun: "Grind",
  },
];

export const themeById = (id: string) =>
  THEMES.find((t) => t.id === id) ?? THEMES[0];

const pick = <T>(arr: T[]): T | undefined =>
  arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined;

const shuffle = <T>(arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const matches = (item: ModItem, keywords: string[]) =>
  keywords.some((k) =>
    (item.title + " " + item.filename).toLowerCase().includes(k),
  );

const ADJ: Record<Difficulty, string[]> = {
  easy: ["Sunny", "Gentle", "Easygoing", "Lazy Sunday"],
  balanced: ["Steady", "Honest", "Down-to-Earth"],
  realistic: ["No-Frills", "By-the-Books", "Hard-Graft"],
  hard: ["Grueling", "Iron", "No-Mercy"],
  brutal: ["Brutal", "Bankrupt-or-Bust", "Merciless", "Debt-Ridden"],
};

export interface GenOptions {
  difficulty: Difficulty;
  themeId: string;
  /** library filename of a specific map, or null for a random one. */
  map: string | null;
}

export function randomOptions(items: ModItem[]): GenOptions {
  const maps = items.filter((i) => i.kind === "map");
  const diff = pick(Object.keys(DIFFICULTIES) as Difficulty[])!;
  return {
    difficulty: diff,
    themeId: pick(THEMES)!.id,
    map: pick(maps)?.filename ?? null,
  };
}

/** Roll a scenario from the options, drawing a map + starting kit from the
 *  user's own library. */
export function generateScenario(opts: GenOptions, items: ModItem[]): Scenario {
  const cfg = DIFFICULTIES[opts.difficulty];
  const theme = themeById(opts.themeId);
  const maps = items.filter((i) => i.kind === "map");
  const mods = items.filter((i) => i.kind === "mod");

  const mapFile = opts.map ?? pick(maps)?.filename ?? null;
  const mapTitle =
    (mapFile && items.find((i) => i.filename === mapFile)?.title) || "the map";

  // Prefer curated mods for the theme, then keyword matches, then random flavor.
  const curated = recommendedOwned(theme.id, items);
  let picks = curated;
  if (picks.length === 0) {
    let kit = mods.filter((m) => matches(m, theme.keywords));
    if (kit.length === 0) kit = shuffle(mods).slice(0, 3);
    picks = shuffle(kit).slice(0, 6).map((m) => m.filename);
  }
  const requiredMods = withMoneyMod(picks, items);

  const adj = pick(ADJ[opts.difficulty])!;
  const name = `${adj} ${mapTitle} ${theme.noun}`.replace(/\s+/g, " ").trim();
  const goalStr = "$" + cfg.goal.toLocaleString();
  const description =
    `${cfg.label} run on ${mapTitle}: reach ${goalStr} in ${cfg.deadline} in-game years` +
    (theme.id !== "any" ? `, ${theme.label.toLowerCase()} style.` : ".");

  return {
    id: crypto.randomUUID(),
    name,
    description,
    // Store the theme as the mode when picked, so the editor can show its
    // recommended mods; otherwise fall back to the difficulty label.
    mode: theme.id !== "any" ? theme.id : `generated·${opts.difficulty}`,
    rules: cfg.rules,
    map: mapFile,
    requiredMods,
    startingKit: moneyControlMod(items)
      ? `${theme.kit || "Starter kit"} · set money with EasyDevControls/PowerTools`
      : theme.kit,
    startMoney: cfg.startMoney,
    goalMoney: cfg.goal,
    deadlineYears: cfg.deadline,
    savegameSlot: null,
    // Grind runs give away the Aug–Dec warm-up, matching the Grind mode.
    warmupToJanuary: theme.id === "grind",
  };
}
