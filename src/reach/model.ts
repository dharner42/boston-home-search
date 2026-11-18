export type Model = {
  /** Multiplier on free-flow time for residential, tertiary, unclassified, living. */
  surface: number
  /** Multiplier for secondary streets. */
  secondary: number
  /** Multiplier for primary streets, which crawl at school-drop-off time. */
  primary: number
  /** Multiplier for motorways and trunks. */
  highway: number
  /** Seconds added on arrival at a surface-street intersection. */
  signal: number
}

export const CLASS_NAME = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
] as const

/** Free-flow km/h used when a tile road has no posted speed. Matches the OSM graph defaults. */
export const FREEFLOW_KMH = [105, 64, 80, 48, 56, 40, 48, 40, 40, 40, 40, 40, 16]

export type RoadGroup = "highway" | "primary" | "secondary" | "surface"

export function roadGroup(classId: number): RoadGroup {
  if (classId <= 3) return "highway"
  if (classId <= 5) return "primary"
  if (classId <= 7) return "secondary"
  return "surface"
}

export function driveSeconds(ffSeconds: number, classId: number, model: Model): number {
  const group = roadGroup(classId)
  const factor =
    group === "highway"
      ? model.highway
      : group === "primary"
        ? model.primary
        : group === "secondary"
          ? model.secondary
          : model.surface
  return ffSeconds * factor
}

/** Signal delay applies when the car arrives at a junction that is not a highway ramp. */
export function signalSeconds(classId: number, degree: number, model: Model): number {
  if (model.signal <= 0 || degree < 3 || classId <= 3) return 0
  return model.signal
}

export function contourMinutes(duration: number, margin: number): number[] {
  const first = Math.max(1, Math.round(duration / 3))
  const second = Math.max(first + 1, Math.round((2 * duration) / 3))
  const outer = Math.min(60, duration + margin)
  const raw = [first, second, duration, outer]
  const out: number[] = []
  for (const value of raw) {
    if (value < 1 || value > 60) continue
    if (out[out.length - 1] === value) continue
    out.push(value)
  }
  return out
}

export const BAND_COLORS = [
  { color: "#FFC857", core: "#FFF3CC" },
  { color: "#FF6B3D", core: "#FFD0C4" },
  { color: "#7EB6FF", core: "#E7F1FF" },
] as const

export type ReachBand = {
  band: 1 | 2 | 3
  label: string
  minSec: number
  maxSec: number
  color: string
  core: string
}

export function bandsFor(duration: number): ReachBand[] {
  const first = Math.max(1, Math.round(duration / 3))
  const second = Math.max(first + 1, Math.min(duration - 1, Math.round((2 * duration) / 3)))
  const cuts = [0, first * 60, second * 60, duration * 60]
  const labels = [`0–${first} min`, `${first}–${second} min`, `${second}–${duration} min`]
  return BAND_COLORS.map((colors, index) => ({
    band: (index + 1) as 1 | 2 | 3,
    label: labels[index] ?? "",
    minSec: cuts[index] ?? 0,
    maxSec: cuts[index + 1] ?? duration * 60,
    color: colors.color,
    core: colors.core,
  }))
}

export function bandOf(seconds: number, bands: ReachBand[]): 1 | 2 | 3 {
  if (seconds < bands[1]!.minSec) return 1
  if (seconds < bands[2]!.minSec) return 2
  return 3
}
