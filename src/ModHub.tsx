import { useEffect, useMemo, useState } from "react";
import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, ModHubEntry, ModItem } from "./api";
import { parseModhub } from "./scraper";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** Curated ModHub category filters (key = the site's `filter` param). */
export const CATEGORIES: { key: string; label: string }[] = [
  { key: "latest", label: "Newest" },
  { key: "mostDownloaded", label: "Most Downloaded" },
  { key: "mapEurope", label: "Maps — Europe" },
  { key: "mapNorthAmerica", label: "Maps — N. America" },
  { key: "mapSouthAmerica", label: "Maps — S. America" },
  { key: "mapOthers", label: "Maps — Other/Fantasy" },
  { key: "sellingPoints", label: "Selling Points" },
  { key: "gameplay", label: "Gameplay / Scripts" },
  { key: "tractorsL", label: "Tractors — Large" },
  { key: "tractorsM", label: "Tractors — Medium" },
  { key: "harvesters", label: "Harvesters" },
  { key: "trailers", label: "Trailers" },
  { key: "placeableMisc", label: "Placeables" },
];

function modhubUrl(category: string, search: string, page: number): string {
  const q = new URLSearchParams({ title: "fs2025", lang: "en", country: "us" });
  if (search.trim()) q.set("searchMod", search.trim());
  else q.set("filter", category || "latest");
  q.set("page", String(page));
  return `https://www.farming-simulator.com/mods.php?${q.toString()}`;
}

/** Search ModHub for a term and return the parsed first-page results. */
export async function modhubSearch(term: string): Promise<ModHubEntry[]> {
  const res = await httpFetch(modhubUrl("", term, 0), {
    method: "GET",
    headers: { "User-Agent": UA },
  });
  if (!res.ok) return [];
  return parseModhub(await res.text(), "");
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// The CDN blocks hot-linked images (no farming-simulator.com Referer), so the
// backend fetches them with the Referer and returns a data URI. Cache per URL.
const imgCache = new Map<string, string>();
function CdnImg({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(imgCache.get(url) ?? null);
  useEffect(() => {
    if (!url || src) return;
    let alive = true;
    api
      .fetchImage(url)
      .then((d) => {
        imgCache.set(url, d);
        if (alive) setSrc(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);
  return src ? (
    <img src={src} alt="" loading="lazy" />
  ) : (
    <div className="img-ph" />
  );
}

/** Which ModHub categories to suggest given the active map's capability gaps. */
function recommendedCategories(
  activeMap: ModItem | null,
): { key: string; label: string; reason: string }[] {
  const recs: { key: string; label: string; reason: string }[] = [];
  const provides = activeMap?.provides ?? [];
  if (activeMap && !provides.includes("selling-points")) {
    recs.push({
      key: "sellingPoints",
      label: "Selling Points",
      reason: `${activeMap.title} has no selling points — you'll need somewhere to sell`,
    });
  }
  recs.push({
    key: "gameplay",
    label: "Gameplay / Scripts",
    reason: "quality-of-life scripts (Courseplay, AutoDrive…) help on any map",
  });
  recs.push({
    key: "tractorsS",
    label: "Small Tractors",
    reason: "affordable starter machines",
  });
  return recs;
}

export default function ModHub({
  items,
  activeMap,
  onLibraryChanged,
  setError,
}: {
  items: ModItem[];
  activeMap: ModItem | null;
  onLibraryChanged: () => void;
  setError: (e: string | null) => void;
}) {
  const [entries, setEntries] = useState<ModHubEntry[]>([]);
  const [category, setCategory] = useState("latest");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [onlyNew, setOnlyNew] = useState(false);
  const [recommend, setRecommend] = useState(false);
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});

  const recCats = useMemo(() => recommendedCategories(activeMap), [activeMap]);

  const owned = useMemo(() => new Set(items.map((i) => norm(i.title))), [items]);
  const isOwned = (e: ModHubEntry) => owned.has(norm(e.title));

  async function reload() {
    try {
      setEntries(await api.modhubAll());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    reload();
  }, []);

  // Fetch a category (or a search) from ModHub and upsert into the catalog.
  async function fetchPages(cat: string, search: string): Promise<void> {
    const collected: ModHubEntry[] = [];
    const pages = search.trim() ? 1 : 3;
    for (let page = 0; page < pages; page++) {
      const res = await httpFetch(modhubUrl(cat, search, page), {
        method: "GET",
        headers: { "User-Agent": UA },
      });
      if (!res.ok) throw new Error(`ModHub returned HTTP ${res.status}`);
      const parsed = parseModhub(await res.text(), search.trim() ? "" : cat);
      if (parsed.length === 0) break;
      collected.push(...parsed);
    }
    if (collected.length > 0) await api.modhubUpsert(collected, Date.now());
  }

  async function fetchFromModhub() {
    setLoading(true);
    setError(null);
    try {
      await fetchPages(category, query);
      await reload();
    } catch (e) {
      setError(
        `Couldn't reach ModHub: ${e}. Check your connection, or the site layout may have changed.`,
      );
    } finally {
      setLoading(false);
    }
  }

  async function fetchRecommended() {
    setLoading(true);
    setError(null);
    try {
      for (const c of recCats) await fetchPages(c.key, "");
      await reload();
      setRecommend(true);
    } catch (e) {
      setError(`Couldn't reach ModHub: ${e}.`);
    } finally {
      setLoading(false);
    }
  }

  async function download(e: ModHubEntry) {
    setDownloading((d) => ({ ...d, [e.modId]: true }));
    setError(null);
    try {
      await api.downloadMod(e.modId);
      onLibraryChanged(); // rescan library so it shows as owned
    } catch (err) {
      setError(`Download failed for ${e.title}: ${err}`);
    } finally {
      setDownloading((d) => ({ ...d, [e.modId]: false }));
    }
  }

  const recKeys = new Set(recCats.map((c) => c.key));
  const shown = recommend
    ? entries.filter((e) => !isOwned(e) && recKeys.has(e.category))
    : entries
        .filter((e) => !onlyNew || !isOwned(e))
        .filter((e) => {
          // When browsing a category, only show entries tagged with it.
          if (!query.trim() && category && e.category && e.category !== category)
            return category === "latest";
          return true;
        })
        .filter((e) => {
          const q = query.trim().toLowerCase();
          return !q || (e.title + " " + e.author).toLowerCase().includes(q);
        });

  return (
    <div className="modhub">
      <div className="toolbar wrap">
        <button
          className={recommend ? "btn" : "btn ghost"}
          onClick={() => setRecommend((r) => !r)}
          title="Suggestions tailored to your active map"
        >
          ✨ Recommended
        </button>
        <select
          value={category}
          disabled={recommend}
          onChange={(e) => setCategory(e.target.value)}
          title="ModHub category to fetch/browse"
        >
          {CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          className="mh-search"
          value={query}
          placeholder="search ModHub…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && fetchFromModhub()}
        />
        <button className="btn" disabled={loading} onClick={fetchFromModhub}>
          {loading ? "Fetching…" : query.trim() ? "Search ModHub" : "Fetch category"}
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={onlyNew}
            onChange={(e) => setOnlyNew(e.target.checked)}
          />
          Only ones I don't own
        </label>
        <span className="count">{shown.length} shown</span>
      </div>

      {entries.length === 0 && !loading && (
        <div className="empty">
          <p>No ModHub data cached yet.</p>
          <p className="muted">
            Pick a category and hit <b>Fetch category</b>, or type a search. Results
            are cached in a local SQLite catalog so you can browse offline. Use{" "}
            <b>Download</b> to pull a mod straight into your library.
          </p>
        </div>
      )}

      {recommend && (
        <div className="rec-panel">
          <div className="rec-head">
            ✨ Recommended{activeMap ? ` for ${activeMap.title}` : ""}
            <button
              className="btn ghost sm"
              disabled={loading}
              onClick={fetchRecommended}
            >
              {loading ? "Fetching…" : "Fetch these from ModHub"}
            </button>
          </div>
          <ul className="rec-reasons">
            {recCats.map((c) => (
              <li key={c.key}>
                <b>{c.label}</b> — {c.reason}
              </li>
            ))}
          </ul>
          {shown.length === 0 && !loading && (
            <p className="muted">
              Nothing cached in these categories yet — hit “Fetch these from
              ModHub”.
            </p>
          )}
        </div>
      )}

      <div className="mh-grid">
        {shown.map((e) => (
          <div key={e.modId} className={"mh-card" + (isOwned(e) ? " owned" : "")}>
            {e.image && <CdnImg url={e.image} />}
            <div className="mh-body">
              <div className="mh-title">
                {e.title}
                {e.label && <span className="badge new">{e.label}</span>}
                {isOwned(e) && <span className="badge map">in library</span>}
              </div>
              {e.author && <div className="muted">{e.author}</div>}
              <div className="mh-actions">
                {isOwned(e) ? (
                  <span className="ok">✓ in library</span>
                ) : (
                  <button
                    className="btn sm"
                    disabled={downloading[e.modId]}
                    onClick={() => download(e)}
                  >
                    {downloading[e.modId] ? "Downloading…" : "⬇ Download"}
                  </button>
                )}
                <button className="btn ghost sm" onClick={() => openUrl(e.url)}>
                  Page ↗
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
