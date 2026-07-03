import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask, message } from "@tauri-apps/plugin-dialog";

/** On launch: quietly check GitHub releases for a newer signed build and, if the
 *  user agrees, download + install + relaunch. Fails silently when offline or
 *  running an unpackaged/dev build. */
export async function checkForUpdate(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;
    const ok = await ask(
      `FS25 Mod Manager ${update.version} is available (you have ${update.currentVersion}).\n\n${update.body ?? ""}\n\nDownload and install now?`,
      { title: "Update available", kind: "info" },
    );
    if (!ok) return;
    await update.downloadAndInstall();
    await message("Update installed — the app will now restart.", {
      title: "Update complete",
    });
    await relaunch();
  } catch {
    /* offline, no update, or dev build — ignore */
  }
}
