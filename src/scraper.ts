// Pure ModHub HTML parsing + version helpers — no Tauri deps, so they're unit
// testable (jsdom provides DOMParser). Used by ModHub.tsx and updates.ts.
import type { ModHubEntry } from "./api";

/** Parse a ModHub listing page's `.mod-item` cards out of raw HTML. */
export function parseModhub(html: string, category: string): ModHubEntry[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll(".mod-item")]
    .map((el): ModHubEntry => {
      const href =
        el.querySelector('a[href*="mod_id="]')?.getAttribute("href") ?? "";
      const modId = href.match(/mod_id=(\d+)/)?.[1] ?? "";
      const title = el.querySelector("h4")?.textContent?.trim() ?? "";
      const author = (
        el.querySelector(".mod-item__content p span")?.textContent ?? ""
      )
        .replace(/^By:\s*/i, "")
        .trim();
      return {
        modId,
        title,
        author,
        image: el.querySelector("img")?.getAttribute("src") ?? "",
        label: el.querySelector(".mod-label")?.textContent?.trim() ?? "",
        category,
        url: `https://www.farming-simulator.com/mod.php?mod_id=${modId}&title=fs2025`,
      };
    })
    .filter((e) => e.modId && e.title);
}

/** Compare dotted version strings: >0 if a newer than b. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Pull the version out of a ModHub detail page (<b>Version</b> → next cell). */
export function parseVersion(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const label = [...doc.querySelectorAll("b")].find(
    (b) => b.textContent?.trim().toLowerCase() === "version",
  );
  const cell = label?.closest(".table-cell")?.nextElementSibling;
  return cell?.textContent?.trim() || null;
}
