import { describe, it, expect } from "vitest";
import { buildScenarioShare } from "./export";
import { ModHubEntry, ModItem, Scenario } from "./api";

const item = (filename: string, title: string): ModItem =>
  ({ filename, title }) as ModItem;
const entry = (title: string, modId: string): ModHubEntry =>
  ({
    title,
    url: `https://www.farming-simulator.com/mod.php?mod_id=${modId}&title=fs2025`,
  }) as ModHubEntry;

const scenario: Scenario = {
  id: "1",
  name: "Scratch Ranch",
  description: "Build a ranch from nothing.",
  mode: "scratch",
  rules: ["must-have-debt"],
  map: "FS25_Ronida.zip",
  requiredMods: ["FS25_Courseplay.zip", "FS25_Unknown.zip"],
  startingKit: "",
  startMoney: 0,
  goalMoney: 1_000_000,
  deadlineYears: 5,
  savegameSlot: null,
  warmupToJanuary: true,
};
const items = [
  item("FS25_Ronida.zip", "Ronîda Island"),
  item("FS25_Courseplay.zip", "Courseplay"),
  item("FS25_Unknown.zip", "Mystery Mod"),
];
const catalog = [entry("Ronîda Island", "111"), entry("Courseplay", "222")];

describe("buildScenarioShare", () => {
  const t = buildScenarioShare(scenario, items, catalog);

  it("includes the map with its ModHub link", () => {
    expect(t).toContain("🗺 Map: Ronîda Island");
    expect(t).toContain("mod_id=111");
  });

  it("links catalog mods and still lists unmatched ones", () => {
    expect(t).toContain("Courseplay — https://");
    expect(t).toContain("mod_id=222");
    expect(t).toContain("• Mystery Mod"); // no link, still listed
    expect(t).not.toContain("Mystery Mod —");
  });

  it("shows goal, warm-up note and the rule + app CTA", () => {
    expect(t).toContain("reach $1,000,000");
    expect(t).toContain("clock starts in January");
    expect(t).toContain("Carry a line of credit");
    expect(t).toContain("releases/latest");
  });
});
