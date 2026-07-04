import { useEffect, useState } from "react";
import { api, DiskReport } from "./api";

function fmtSize(bytes: number): string {
  if (!bytes) return "0";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

/** Library disk manager: total size, biggest mods, duplicate versions,
 *  and unmanaged files sitting in the game's mods folder. */
export default function Disk({
  setError,
  onChanged,
}: {
  setError: (e: string | null) => void;
  onChanged: () => void;
}) {
  const [report, setReport] = useState<DiskReport | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      setReport(await api.diskReport());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Import an unmanaged (orphan) mods-folder file into the library.
  async function importOrphans() {
    setBusy(true);
    try {
      await api.importFromMods();
      await load();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!report) {
    return <div className="empty">{busy ? "Scanning library…" : "—"}</div>;
  }

  const wasted = report.duplicates.reduce(
    (sum, g) =>
      // every file in a dup group beyond the largest is "wasted" space
      sum +
      g
        .map((e) => e.size)
        .sort((a, b) => b - a)
        .slice(1)
        .reduce((a, b) => a + b, 0),
    0,
  );

  return (
    <div className="disk">
      <div className="disk-stats">
        <div className="stat">
          <span className="stat-num">{report.count}</span>
          <span className="stat-lbl">mods & maps</span>
        </div>
        <div className="stat">
          <span className="stat-num">{fmtSize(report.totalSize)}</span>
          <span className="stat-lbl">library size</span>
        </div>
        <div className="stat">
          <span className="stat-num">{report.duplicates.length}</span>
          <span className="stat-lbl">duplicate sets</span>
        </div>
        <div className="stat">
          <span className="stat-num">{fmtSize(wasted)}</span>
          <span className="stat-lbl">reclaimable</span>
        </div>
        <button className="btn ghost sm" onClick={load} disabled={busy}>
          ⟳ Rescan
        </button>
      </div>

      <section className="cat-group">
        <h3 className="cat-head">
          Biggest <span className="cat-count">{report.biggest.length}</span>
        </h3>
        <div className="disk-bars">
          {report.biggest.map((e) => {
            const pct = report.biggest[0].size
              ? (e.size / report.biggest[0].size) * 100
              : 0;
            return (
              <div key={e.filename} className="disk-bar-row">
                <span className="disk-bar-name" title={e.filename}>
                  {e.title || e.filename}
                </span>
                <span className="disk-bar-track">
                  <span
                    className="disk-bar-fill"
                    style={{ width: `${Math.max(pct, 2)}%` }}
                  />
                </span>
                <span className="disk-bar-size">{fmtSize(e.size)}</span>
              </div>
            );
          })}
        </div>
      </section>

      {report.duplicates.length > 0 && (
        <section className="cat-group">
          <h3 className="cat-head">
            Possible duplicate versions{" "}
            <span className="cat-count">{report.duplicates.length}</span>
          </h3>
          <p className="hint">
            These library files share a title — likely different versions of the
            same mod. Delete the older <code>.zip</code> from your library folder
            to reclaim space.
          </p>
          {report.duplicates.map((g) => (
            <div key={g[0].title} className="dup-group">
              <div className="dup-title">{g[0].title}</div>
              {g
                .slice()
                .sort((a, b) => b.size - a.size)
                .map((e, i) => (
                  <div key={e.filename} className="dup-row">
                    <span className="muted">{e.filename}</span>
                    <span>{fmtSize(e.size)}</span>
                    {i === 0 ? (
                      <span className="dep-chip ok">keep (largest)</span>
                    ) : (
                      <span className="dep-chip missing">older?</span>
                    )}
                  </div>
                ))}
            </div>
          ))}
        </section>
      )}

      {report.orphans.length > 0 && (
        <section className="cat-group">
          <h3 className="cat-head">
            Unmanaged in mods folder{" "}
            <span className="cat-count">{report.orphans.length}</span>
          </h3>
          <p className="hint">
            These files are in the FS25 mods folder but not in your library, so
            the manager can’t track them. Import them to bring them under
            management.
          </p>
          <div className="orphan-list">
            {report.orphans.map((o) => (
              <span key={o} className="dep-chip">
                {o}
              </span>
            ))}
          </div>
          <button className="btn" onClick={importOrphans} disabled={busy}>
            ⬇ Import {report.orphans.length} into library
          </button>
        </section>
      )}
    </div>
  );
}
