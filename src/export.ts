import { ModHubEntry, ModItem, Scenario } from "./api";
import { ruleById } from "./presets";
import { isBaseMap, baseMapTitle } from "./mapId";

/** Public download link for the app (the repo's latest release). */
export const APP_URL =
  "https://github.com/allanice001/fs25modmanager/releases/latest";

const money = (n: number) => "$" + Math.round(n).toLocaleString();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Build a copy-paste shareable text block (YouTube-description style) for a
 *  scenario: map, goal, rules and mod list — with ModHub links where the mod is
 *  in the local catalog, plus a link to the app for tracking the run. */
export function buildScenarioShare(
  scenario: Scenario,
  items: ModItem[],
  catalog: ModHubEntry[],
): string {
  const byNorm = new Map(catalog.map((e) => [norm(e.title), e]));
  const linkFor = (title: string) => byNorm.get(norm(title))?.url;
  const itemByFile = new Map(items.map((i) => [i.filename, i]));

  const out: string[] = [];
  out.push(`🚜 FS25 Scenario: ${scenario.name || "Untitled scenario"}`);
  if (scenario.description) out.push(scenario.description);
  out.push("");

  if (scenario.map && isBaseMap(scenario.map)) {
    out.push(`🗺 Map: ${baseMapTitle(scenario.map)} (base game)`);
  } else {
    const mapItem = scenario.map ? itemByFile.get(scenario.map) : null;
    if (mapItem) {
      const l = linkFor(mapItem.title);
      out.push(`🗺 Map: ${mapItem.title}${l ? ` — ${l}` : ""}`);
    }
  }

  const goal: string[] = [];
  if (scenario.startMoney != null) goal.push(`start ${money(scenario.startMoney)}`);
  if (scenario.goalMoney != null) goal.push(`reach ${money(scenario.goalMoney)}`);
  if (scenario.deadlineYears != null)
    goal.push(
      `within ${scenario.deadlineYears} in-game years${scenario.warmupToJanuary ? " (clock starts in January)" : ""}`,
    );
  if (goal.length) out.push(`🎯 Goal: ${goal.join(", ")}`);
  if (scenario.startingKit) out.push(`🧰 Start: ${scenario.startingKit}`);

  const hasRules = scenario.rules.length > 0;
  if (hasRules) {
    const labels = scenario.rules
      .map((r) => ruleById(r)?.label ?? r)
      .join(" · ");
    out.push(`📋 Rules: ${labels}`);
    out.push(`   ↳ Track these live with FS25 Mod Manager → ${APP_URL}`);
  }

  const mods = scenario.requiredMods
    .map((f) => itemByFile.get(f))
    .filter((m): m is ModItem => !!m);
  if (mods.length) {
    out.push("");
    out.push(`🧰 Mods (${mods.length}):`);
    for (const m of mods) {
      const l = linkFor(m.title);
      out.push(` • ${m.title}${l ? ` — ${l}` : ""}`);
    }
  }

  out.push("");
  out.push(
    hasRules
      ? "— Generated with FS25 Mod Manager 🚜"
      : `— Generated with FS25 Mod Manager 🚜 → ${APP_URL}`,
  );
  return out.join("\n");
}
