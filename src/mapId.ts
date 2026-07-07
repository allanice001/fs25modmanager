import { SaveInfo } from "./api";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** FS25 base-game maps — not in the library (they ship with the game), so a
 *  scenario references them as `base:<title>`. */
export const BASE_MAPS = ["Riverbend Springs", "Zielonka", "Hutan Pantai"];
const BASE_PREFIX = "base:";
export const isBaseMap = (map: string | null | undefined): map is string =>
  !!map && map.startsWith(BASE_PREFIX);
export const baseMapTitle = (map: string): string => map.slice(BASE_PREFIX.length);
export const baseMapValue = (title: string): string => BASE_PREFIX + title;

/** The map mod's zip stem from a save's mapId
 *  ("FS25_ronidaIslandCp.ronidaIslandCP_nt" → "fs25_ronidaislandcp"). FS25 map
 *  ids are "<modName>.<internalMapId>", and modName is the zip filename stem. */
export const saveMapStem = (s: SaveInfo): string | null =>
  s.mapId ? s.mapId.split(".")[0].toLowerCase() : null;

/** A library map filename's stem, lowercased ("FS25_X.zip" → "fs25_x"). */
export const fileStem = (filename: string) =>
  filename.replace(/\.zip$/i, "").toLowerCase();

/** Stable template/identity key for a save's map: the map mod's zip stem, or a
 *  normalized title as a last resort for saves without a mapId. */
export const mapKeyOfSave = (s: SaveInfo): string =>
  saveMapStem(s) ?? norm(s.mapTitle);

/** Stable template/identity key for a library map file (its zip stem). */
export const mapKeyOfFile = (filename: string) => fileStem(filename);

/** Does a save run on a given library map? Matches by the map mod's zip stem
 *  (reliable even when a mod bundles several map variants under one title),
 *  then falls back to a fuzzy title match for saves/maps without a mapId. */
export function saveOnMap(
  save: SaveInfo,
  mapFile: string | null,
  mapTitle: string,
): boolean {
  if (isBaseMap(mapFile)) {
    return norm(save.mapTitle) === norm(baseMapTitle(mapFile));
  }
  const stem = saveMapStem(save);
  if (mapFile && stem && stem === fileStem(mapFile)) return true;
  return !!mapTitle && norm(save.mapTitle) === norm(mapTitle);
}
