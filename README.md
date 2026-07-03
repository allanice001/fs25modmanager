# FS25 Mod Manager

A small cross-platform desktop app (Tauri + React + Rust) for managing Farming
Simulator 25 mods and maps.

Your downloaded mod/map `.zip` files live in one **library folder**. The app
lets you flip each one in or out of the game's **mods folder**, auto-detects
which archives are maps, and flags mods that won't work on the map you're
currently playing (e.g. Courseplay/AutoDrive on a flat, field-less map).

## How it works

- **Library** = your source of truth (`~/Documents/FS25ModLibrary` by default).
  Every downloaded zip lives here.
- **Enable** places a link to that zip into the FS25 mods folder; **Disable**
  removes only that link. Your library copy is never touched.
- **Link mode** (Settings):
  - `hardlink` — **default & recommended**. No data duplication (same inode),
    instant even for huge maps, and appears to the game as a real file.
  - `copy` — always works, uses disk. Auto-fallback when a hardlink can't be
    made (e.g. library and mods folder on different volumes).
  - `symlink` — **do not use for FS25**: the Giants engine does not follow
    symlinks in the mods folder, so symlinked mods silently fail to load
    (`Failed to open xml file '.../mods/<Mod>/modDesc.xml'` in the game log).
    Kept only as an option for other uses.
- **Compatibility**: maps *provide* capability tags (`fields`, `roads`,
  `selling-points`, …); mods *require* them. Pick an active map and any mod that
  needs something the map doesn't provide gets flagged. Tags are seeded for
  well-known mods and fully editable per item (Edit ▾ on each card).

Config and the tag catalog are stored as JSON in the app config dir
(`~/Library/Application Support/com.dragon.fs25modmanager/` on macOS).

## Paths (auto-detected)

- **macOS** — `~/Library/Application Support/FarmingSimulator2025/mods`
- **Windows** — `Documents\My Games\FarmingSimulator2025\mods`
- **Linux** — `~/.local/share/FarmingSimulator2025/mods`

Both paths are overridable in Settings (with a Browse… picker).

## Develop

```sh
pnpm install
pnpm tauri dev          # run the app with hot reload
```

## Build a real app

```sh
pnpm tauri build        # produces a .app / .dmg (macOS), .msi/.exe (Windows)
```

Output lands in `src-tauri/target/release/bundle/` (`macos/*.app`, `dmg/*.dmg`).

### Signing & notarization (macOS)

Builds are **code-signed** with a Developer ID (`tauri.conf.json` →
`bundle.macOS.signingIdentity`), which gives a stable identity so macOS keeps
granted permissions across rebuilds.

To **notarize** (so it opens with no Gatekeeper warning on any Mac):

```sh
pnpm tauri build            # sign
./scripts/notarize.sh       # notarize + staple (prompts for an app-specific pw once)
```

Create the app-specific password at appleid.apple.com → Sign-In and Security →
App-Specific Passwords. The script stores it in your keychain (profile
`fs25-notary`) so later runs don't ask again.

**CI:** `.github/workflows/release.yml` signs + notarizes automatically when
these repo secrets are set: `APPLE_CERTIFICATE` (base64 of your exported
Developer ID `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`.

Cross-platform note: the codebase is OS-aware, but a Windows binary must be
built **on Windows** (or in Windows CI) — you can't produce it from macOS.

## Scenarios

A scenario bundles a **map**, a **starting kit** of mods, a **money goal**, and a
**deadline** in in-game years (e.g. "Flat Map: start with a mower + a universal
selling point, reach $1,000,000 within 5 years"). **Apply** enables the map + its
mods and sets it active (with an optional "clean slate" that disables everything
else first).

**Modes** are built-in presets that pre-fill a scenario and auto-pick a map + mods
from *your* library:
- **Realistic** — hardcore economy; rule: carry a line of credit (debt > 0).
- **Flat Map Millionaire** — flat map, reach $1M in 5 years.
- **From Scratch** — minimal start.

**🎲 Generate** rolls a fresh scenario from your library: pick a difficulty
(Easy/Balanced/Hard/Brutal) and theme (Livestock, Contracting, Big Iron,
Minimalist, Forestry, Crops), and it assembles a map + starting kit + scaled goal
+ deadline + rules, with a generated name. "Surprise me" randomizes everything.
The result opens in the editor so you can tweak before saving.

**Live trackers** (link a savegame): cash + goal-progress bar, debt (from
`farms.xml`), net (cash − debt), in-game year vs deadline, and playtime — all read
live from the save. **Rules** (e.g. "carry a line of credit") show ✓/✗ against the
save; they're tracked, not enforced in-game.

Import loose mods from the game folder in **Settings → Import from mods folder**.

## Roadmap

- True net-worth (sum vehicle/land/building assets — not in the save directly).
- Scenario start-money enforcement (needs savegame editing).
- ModHub-based discovery of new mods to download.
