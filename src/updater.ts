import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask, message } from "@tauri-apps/plugin-dialog";

/** Check the public releases repo for a newer signed build and, if the user
 *  agrees, download + install + relaunch.
 *  - On launch (`manual` false): silent when up-to-date or offline.
 *  - From the button (`manual` true): also reports "up to date" / errors. */
export async function checkForUpdate(manual = false): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      if (manual) {
        await message("You’re on the latest version. 🎉", {
          title: "Up to date",
        });
      }
      return;
    }
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
  } catch (e) {
    if (manual) {
      await message(`Couldn’t check for updates: ${e}`, {
        title: "Update check failed",
        kind: "error",
      });
    }
    /* silent on the launch check (offline / dev build) */
  }
}
