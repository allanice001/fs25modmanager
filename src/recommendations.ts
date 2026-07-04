import { ModItem } from "./api";

/** A mod recommended for a playstyle. `search` is the ModHub search term used
 *  to find + download it when it isn't already in the library. */
export interface RecMod {
  title: string;
  search: string;
  why: string;
}

/** Recommendations keyed by scenario mode (preset id) or generator theme id. */
export const RECS: Record<string, RecMod[]> = {
  // --- preset modes ---
  realistic: [
    { title: "Enhanced Loan System", search: "enhanced loan system", why: "real interest + credit limits" },
    { title: "Line of Credit", search: "line of credit", why: "borrow against your assets" },
    { title: "MoreRealistic", search: "morerealistic", why: "tougher physics + economy" },
    { title: "Advanced Damage System", search: "advanced damage system", why: "wear, repairs, breakdowns" },
    { title: "Better Contracts", search: "better contracts", why: "richer, fairer contract income" },
    { title: "Vehicle Years", search: "vehicle years", why: "period-correct equipment aging" },
  ],
  "flatmap-millionaire": [
    { title: "Sell Everything", search: "sell everything", why: "sell anywhere on an empty map" },
    { title: "Universal Selling Station", search: "universal selling station", why: "a place to sell without base points" },
    { title: "GlobalCompany", search: "global company", why: "productions + selling infrastructure" },
    { title: "Mow Anywhere", search: "mow anywhere", why: "earn from grass anywhere to start" },
    { title: "Store Deliveries", search: "store deliveries", why: "get goods delivered on a bare map" },
  ],
  scratch: [
    { title: "EasyDevControls", search: "easy dev controls", why: "set your $0 start (base game floors at ~$100k)" },
    { title: "PowerTools", search: "powertools", why: "money + utilities console" },
    { title: "Hand Tools", search: "hand tools", why: "work manually before you can afford machines" },
    { title: "Line of Credit", search: "line of credit", why: "borrow to bootstrap during the warm-up" },
    { title: "Better Contracts", search: "better contracts", why: "contracts are your Aug–Dec capital" },
    { title: "Buy Used Equipment", search: "buy used equipment", why: "cheap second-hand machines to start" },
    { title: "Universal Autoload", search: "universal autoload", why: "haul goods without expensive loaders" },
    { title: "Hire Purchasing", search: "hire purchasing", why: "lease-to-own to start with little cash" },
    { title: "Sell Anywhere", search: "sell anywhere", why: "turn early harvests into cash on a bare map" },
    { title: "Mow Anywhere", search: "mow anywhere", why: "earn from grass before you own fields" },
  ],
  // Earn-every-dollar grind: no money cheats, tough economy, contracts + used gear.
  grind: [
    { title: "Better Contracts", search: "better contracts", why: "your main income — more, fairer jobs" },
    { title: "Contracts Booster", search: "contracts booster", why: "bigger rewards + bonuses for using owned gear" },
    { title: "Sell Anywhere", search: "sell anywhere", why: "sell produce without hauling to base points" },
    { title: "Mow Anywhere", search: "mow anywhere", why: "early grass income while cash is tight" },
    { title: "Buy Used Equipment", search: "buy used equipment", why: "second-hand machines keep costs down" },
    { title: "Hire Purchasing", search: "hire purchasing", why: "lease-to-own instead of a big cash outlay" },
    { title: "Universal Autoload", search: "universal autoload", why: "haul efficiently with a minimal fleet" },
    { title: "MoreRealistic", search: "morerealistic", why: "tougher economy so the grind means something" },
    { title: "Advanced Damage System", search: "advanced damage system", why: "upkeep costs keep the pressure on" },
  ],
  // --- generator themes ---
  livestock: [
    { title: "Enhanced Animal System", search: "enhanced animal system", why: "deeper husbandry mechanics" },
    { title: "Sheep & Goat Barn", search: "sheep goat barn", why: "housing to start a herd" },
    { title: "Animal Products AutoShipping", search: "animal products autoshipping", why: "auto-sell milk/eggs/wool" },
    { title: "Universal Autoload", search: "universal autoload", why: "move animals + feed easily" },
  ],
  contracting: [
    { title: "Courseplay", search: "courseplay", why: "AI drivers for field work" },
    { title: "AutoDrive", search: "autodrive", why: "AI road transport" },
    { title: "Better Contracts", search: "better contracts", why: "more, better-paying jobs" },
    { title: "FollowMe", search: "followme", why: "convoy helpers" },
    { title: "Hire Purchasing", search: "hire purchasing", why: "finance the contracting rig" },
  ],
  bigiron: [
    { title: "Big Bud", search: "big bud", why: "iconic oversized tractor" },
    { title: "Quadtrac / 9RX", search: "quadtrac", why: "articulated monster tractors" },
    { title: "XXL Header Pack", search: "xxl header", why: "huge harvest headers" },
    { title: "Kroeger Agroliner XXL", search: "agroliner", why: "high-capacity trailers" },
  ],
  minimalist: [
    { title: "Hand Tools Pack", search: "hand tools", why: "do it the hard way" },
    { title: "Push Mower", search: "push mower", why: "smallest possible start" },
    { title: "Compact Tractor", search: "compact tractor", why: "tiny starter machine" },
  ],
  forestry: [
    { title: "Chainsaw Pack", search: "chainsaw", why: "fell trees by hand" },
    { title: "Forwarder", search: "forwarder", why: "haul logs out of the forest" },
    { title: "Forestry Pack", search: "forestry pack", why: "harvesters + processors" },
  ],
  crops: [
    { title: "Precision Farming", search: "precision farming", why: "soil sampling + variable rate" },
    { title: "Planter Pack", search: "planter", why: "efficient seeding" },
    { title: "GlobalCompany", search: "global company", why: "crop productions to add value" },
  ],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Recommendations for a scenario mode/theme (empty if none). */
export function recsFor(key: string): RecMod[] {
  return RECS[key] ?? [];
}

/** Does the library already contain a mod matching this recommendation? */
export function ownedMatch(rec: RecMod, items: ModItem[]): ModItem | null {
  const terms = norm(rec.search).match(/[a-z0-9]+/g) ?? [norm(rec.title)];
  const key = norm(rec.title);
  return (
    items.find((i) => i.kind === "mod" && norm(i.title) === key) ??
    items.find(
      (i) =>
        i.kind === "mod" &&
        terms.every((t) => norm(i.title + i.filename).includes(t)),
    ) ??
    null
  );
}

/** Library filenames matching a mode/theme's recommendations. */
export function recommendedOwned(key: string, items: ModItem[]): string[] {
  return recsFor(key)
    .map((r) => ownedMatch(r, items)?.filename)
    .filter((f): f is string => !!f);
}
