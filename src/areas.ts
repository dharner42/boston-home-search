/**
 * The places the map can be centered on. Each area has its own listings file,
 * timed from the area's point, and can have a baked 15-minute drive so the
 * first view does not call Mapbox. Until it is baked, the app falls back to
 * /api/reach. Shared by the app and the build scripts.
 */

export type AreaId = "kendall" | "needham" | "wellesley"

export type Area = {
  id: AreaId
  /** Short name on the map pin, the area button, and listing labels. */
  name: string
  /** Name used in sentences ("Drive times are measured from …"). */
  origin: string
  /** One line under the name in the picker and on the pin. */
  detail: string
  lon: number
  lat: number
  /** Baked 15-minute drive, written by scripts/bake-default.ts. */
  reachFile: string
  /** Fitted model for listings, written by scripts/bake-default.ts. */
  methodFile: string
  /** Listings timed from this area, written by scripts/build-listings.ts. */
  listingsFile: string
}

export const DEFAULT_MINUTES = 15

export const AREAS: readonly Area[] = [
  {
    id: "kendall",
    name: "Kendall School",
    origin: "The Kendall School, Belmont",
    detail: "577 Belmont Street, Belmont",
    lon: -71.1764013,
    lat: 42.3798098,
    reachFile: "reach.bin",
    methodFile: "method.json",
    listingsFile: "listings.json",
  },
  {
    id: "needham",
    name: "Needham Center",
    origin: "Needham Center (Town Hall)",
    detail: "Town Hall, 1471 Highland Avenue",
    lon: -71.2364613,
    lat: 42.2810896,
    reachFile: "reach-needham.bin",
    methodFile: "method-needham.json",
    listingsFile: "listings-needham.json",
  },
  {
    id: "wellesley",
    name: "Wellesley Square",
    origin: "Wellesley Square (Town Hall)",
    detail: "Town Hall, 525 Washington Street",
    lon: -71.2916839,
    lat: 42.297945,
    reachFile: "reach-wellesley.bin",
    methodFile: "method-wellesley.json",
    listingsFile: "listings-wellesley.json",
  },
]

export const DEFAULT_AREA: Area = AREAS[0] as Area

export function areaById(id: string | null | undefined): Area | null {
  return AREAS.find((area) => area.id === id) ?? null
}

/** Metres between a point and an area's center. */
export function metersFrom(area: Pick<Area, "lon" | "lat">, lon: number, lat: number): number {
  const cos = Math.cos((area.lat * Math.PI) / 180)
  const dx = (lon - area.lon) * 111_320 * cos
  const dy = (lat - area.lat) * 111_320
  return Math.hypot(dx, dy)
}

/** The area whose center this point is, within 80 m. */
export function areaAt(lon: number, lat: number): Area | null {
  return AREAS.find((area) => metersFrom(area, lon, lat) < 80) ?? null
}

/** First word of the area name ("Kendall", "Needham", "Wellesley"). */
export function areaShort(area: Area): string {
  return area.name.split(" ")[0] ?? area.name
}

/**
 * Areas from a comma-separated id list ("kendall,needham"), in AREAS order,
 * without repeats. Null when nothing in it is a known area.
 */
export function parseAreas(value: string | null | undefined): Area[] | null {
  if (!value) return null
  const ids = new Set(value.split(",").map((part) => part.trim()))
  const list = AREAS.filter((area) => ids.has(area.id))
  return list.length > 0 ? list : null
}

export function areaIds(list: readonly Area[]): string {
  return list.map((area) => area.id).join(",")
}

export function sameAreas(a: readonly Area[], b: readonly Area[]): boolean {
  return a.length === b.length && a.every((area, index) => area.id === b[index]?.id)
}

/** Label for several areas shown together ("Kendall + Needham", "All three areas"). */
export function groupName(list: readonly Area[]): string {
  if (list.length === 1 && list[0]) return list[0].name
  if (list.length === AREAS.length) return AREAS.length === 3 ? "All three areas" : `All ${AREAS.length} areas`
  return list.map(areaShort).join(" + ")
}

/** "Kendall School, Needham Center, and Wellesley Square" */
export function listPhrase(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`
}
