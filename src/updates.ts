import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import { ModHubEntry, ModItem } from "./api";
import { cmpVersion, parseVersion } from "./scraper";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface UpdateInfo {
  filename: string;
  title: string;
  installed: string;
  latest: string;
  modId: string;
  url: string;
}

/** For every installed mod that matches a cached ModHub entry, fetch its detail
 *  page and report those with a newer version available. */
export async function checkUpdates(
  items: ModItem[],
  catalog: ModHubEntry[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ updates: UpdateInfo[]; checked: number }> {
  const byTitle = new Map(catalog.map((e) => [norm(e.title), e]));
  const candidates = items.filter((i) => i.version && byTitle.has(norm(i.title)));
  const updates: UpdateInfo[] = [];
  const queue = [...candidates];
  let done = 0;

  async function worker() {
    while (queue.length) {
      const it = queue.shift()!;
      const e = byTitle.get(norm(it.title))!;
      try {
        const res = await httpFetch(e.url, {
          method: "GET",
          headers: { "User-Agent": UA },
        });
        const latest = parseVersion(await res.text());
        if (latest && cmpVersion(latest, it.version) > 0) {
          updates.push({
            filename: it.filename,
            title: it.title,
            installed: it.version,
            latest,
            modId: e.modId,
            url: e.url,
          });
        }
      } catch {
        /* skip mods we can't reach */
      }
      done++;
      onProgress?.(done, candidates.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(5, candidates.length) }, worker),
  );
  return { updates, checked: candidates.length };
}
