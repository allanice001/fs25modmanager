# FS25 Scenario Companion (telemetry MVP)

A tiny FS25 mod that writes your **live** scenario telemetry to the savegame so
the FS25 Mod Manager can track a run in real time — without you having to
save-and-reload the game first.

**Telemetry only.** It reads money/loan/calendar and writes a file. It never
changes gameplay, prices, or rules.

## What it writes

Every in-game hour (and once on load) it writes
`<savegameN>/scenarioCompanion.xml`:

```xml
<scenarioCompanion version="1" farmId="1">
    <money>125000</money>
    <loan>0</loan>
    <day>18</day>
    <monotonicDay>18</monotonicDay>
    <daysPerPeriod>1</daysPerPeriod>
    <period>11</period>
    <hour>14</hour>
    <updatedBy>FS25_ScenarioCompanion</updatedBy>
</scenarioCompanion>
```

The manager reads that file via its `read_companion` command and shows a live
`🟢 Live` readout on the linked scenario.

## Install / test

1. **Add an icon.** FS25 wants a DDS icon. Drop a 256×256 (or 512×512)
   `icon.dds` next to `modDesc.xml`. Any DDS works for testing — e.g. convert a
   PNG:
   ```sh
   # with ImageMagick (DXT5/BC3)
   magick icon.png -resize 256x256 -define dds:compression=dxt5 icon.dds
   ```
   (If FS25 refuses to load without it, this is why.)
2. **Zip it.** The zip's name must match the folder:
   ```sh
   cd companion-mod
   zip -r FS25_ScenarioCompanion.zip FS25_ScenarioCompanion
   ```
3. **Install.** Copy `FS25_ScenarioCompanion.zip` into your FS25 `mods` folder
   (or add it to your library and enable it in the manager).
4. **Enable** the mod when starting/loading a savegame, play for an in-game
   hour, then check that `scenarioCompanion.xml` appears in that savegame folder.

## Caveats (why this is an MVP)

- The Giants scripting globals used here (`g_localPlayer`, `g_farmManager`,
  `environment.currentHour`, `farm:getBalance()`) can change between FS25
  patches. The script guards every call with fallbacks + `pcall`, so a mismatch
  degrades to zeros/skips instead of erroring — but if a value reads 0 that
  shouldn't, verify the field names against the current game scripts
  (`.../FarmingSimulator2025/dataS/scripts/...`) and tweak `ScenarioCompanion.lua`.
- Single-player only (`multiplayer supported="false"`).
- Next steps (not in the MVP): richer telemetry (net worth, field/animal
  counts), in-game HUD for the goal/deadline, and optional **rule enforcement**.
