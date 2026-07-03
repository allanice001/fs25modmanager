// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { parseModhub, cmpVersion, parseVersion } from "./scraper";

const MOD_ITEM = `
<div class="mod-item">
  <div class="mod-item__img">
    <div class="mod-label mod-label-new">NEW!</div>
    <a href="mod.php?mod_id=364608&title=fs2025"><img src="https://cdn40.giants-software.com/modHub/storage/00364608/iconBig.jpg"></a>
  </div>
  <div class="mod-item__content">
    <h4> Bijlsma Hercules 1400</h4>
    <p><span>By: [DMI]20mmNormandy and Interfan</span></p>
  </div>
  <a href="mod.php?mod_id=364608&title=fs2025" class="button">MORE INFO</a>
</div>`;

describe("parseModhub", () => {
  it("extracts fields from a mod-item card", () => {
    const [e] = parseModhub(MOD_ITEM, "mapEurope");
    expect(e.modId).toBe("364608");
    expect(e.title).toBe("Bijlsma Hercules 1400");
    expect(e.author).toBe("[DMI]20mmNormandy and Interfan");
    expect(e.label).toBe("NEW!");
    expect(e.category).toBe("mapEurope");
    expect(e.image).toContain("iconBig.jpg");
    expect(e.url).toBe(
      "https://www.farming-simulator.com/mod.php?mod_id=364608&title=fs2025",
    );
  });

  it("skips cards without a mod id", () => {
    expect(parseModhub(`<div class="mod-item"><h4>No link</h4></div>`, "")).toHaveLength(0);
  });
});

describe("cmpVersion", () => {
  it("orders dotted versions", () => {
    expect(cmpVersion("8.1.0.4", "8.1.0.3")).toBe(1);
    expect(cmpVersion("8.1.0.3", "8.1.0.3")).toBe(0);
    expect(cmpVersion("1.0", "1.0.1")).toBe(-1);
    expect(cmpVersion("2.0", "1.9.9")).toBe(1);
  });
});

describe("parseVersion", () => {
  it("reads the Version table cell from a detail page", () => {
    const html = `<div class="table-cell"><b>Version</b></div><div class="table-cell">1.2.3.4</div>`;
    expect(parseVersion(html)).toBe("1.2.3.4");
  });
  it("returns null when absent", () => {
    expect(parseVersion(`<div>nothing here</div>`)).toBeNull();
  });
});
