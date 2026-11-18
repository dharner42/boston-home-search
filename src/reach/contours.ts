import { pointInPolygon } from "./geo.ts"
import type { Graph } from "./graph.ts"
import type { Contour } from "./mapbox.ts"

/**
 * Pull node times into the bracket implied by the traffic isochrone.
 * A node outside the 15-minute polygon cannot stay at 12 minutes.
 * Delay only moves forward along the original route, so a street still
 * lights after the road that reaches it.
 */
export function applyContourTimes(graph: Graph, times: Float64Array, contours: Contour[]): Float64Array {
  if (contours.length === 0) return times
  const adjusted = new Float64Array(times)
  const ordered = [...contours].sort((a, b) => a.minutes - b.minutes)
  for (let node = 0; node < times.length; node++) {
    const current = times[node] ?? Infinity
    if (!Number.isFinite(current)) continue
    const lon = graph.lon[node] ?? 0
    const lat = graph.lat[node] ?? 0
    let lower = 0
    let upper = Infinity
    for (const contour of ordered) {
      if (!inBox(lon, lat, contour.bbox)) {
        lower = Math.max(lower, contour.minutes)
        continue
      }
      if (insideContour(lon, lat, contour)) upper = Math.min(upper, contour.minutes)
      else lower = Math.max(lower, contour.minutes)
    }
    const minutes = current / 60
    if (minutes >= lower) continue
    const span = Number.isFinite(upper) ? Math.max(0, upper - lower) : 0
    adjusted[node] = (lower + 0.7 * span) * 60
  }
  for (let pass = 0; pass < 6; pass++) {
    let changed = false
    for (let edge = 0; edge < graph.to.length; edge++) {
      const from = graph.from[edge] ?? 0
      const to = graph.to[edge] ?? 0
      const fromOrig = times[from] ?? Infinity
      const toOrig = times[to] ?? Infinity
      const fromNow = adjusted[from] ?? Infinity
      const toNow = adjusted[to] ?? Infinity
      if (!(fromOrig <= toOrig) || !Number.isFinite(fromNow) || !Number.isFinite(toNow)) continue
      if (toNow + 0.4 < fromNow) {
        adjusted[to] = fromNow
        changed = true
      }
    }
    if (!changed) break
  }
  return adjusted
}

function insideContour(lon: number, lat: number, contour: Contour): boolean {
  for (const polygon of contour.polygons) {
    if (pointInPolygon(lon, lat, polygon)) return true
  }
  return false
}

function inBox(lon: number, lat: number, box: [number, number, number, number]): boolean {
  return lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3]
}
