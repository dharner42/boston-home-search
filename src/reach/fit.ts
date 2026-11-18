import { nearestNode, routeTimes, type Graph, type Snap } from "./graph.ts"
import { fetchDriveMinutes, type Contour } from "./mapbox.ts"
import type { Model } from "./model.ts"

export type Target = {
  node: number
  minutes: number
  weight: number
}

export async function fitModel(
  graph: Graph,
  snap: Snap,
  originLon: number,
  originLat: number,
  durationMin: number,
  marginMin: number,
  depart: string,
  contours: Contour[],
): Promise<{ model: Model; mae: number; times: Float64Array }> {
  const limit = Math.max((durationMin + marginMin) * 60, 48 * 60)
  const anchors = spreadAnchors(graph, originLon, originLat, durationMin)
  const measured = await Promise.all(
    anchors.map(async (anchor) => ({
      ...anchor,
      minutes: await fetchDriveMinutes(originLon, originLat, anchor.lon, anchor.lat, depart),
    })),
  )
  const targets: Target[] = []
  for (const anchor of measured) {
    if (anchor.minutes == null) continue
    targets.push({ node: anchor.node, minutes: anchor.minutes, weight: 1 })
  }
  if (targets.length < 3) {
    for (const contour of contours) {
      const ring = contour.polygons[0]?.[0]
      const mid = ring?.[Math.floor((ring.length - 1) / 2)]
      if (!mid) continue
      const node = nearestNode(graph, mid[0] ?? 0, mid[1] ?? 0, 400)
      if (node == null) continue
      targets.push({ node, minutes: contour.minutes, weight: 0.5 })
    }
  }
  const fallback: Model = { surface: 1.8, secondary: 1.7, primary: 2.6, highway: 1.8, signal: 16 }
  if (targets.length === 0) {
    return { model: fallback, mae: Number.NaN, times: routeTimes(graph, snap, fallback, limit) }
  }
  const stopAt = targets.map((target) => target.node)
  let best = { model: fallback, mae: Infinity }
  for (const surface of [1.3, 1.9, 2.5]) {
    for (const secondary of [1.3, 1.9, 2.5]) {
      for (const primary of [1.8, 2.6, 3.4]) {
        for (const highway of [1.3, 2.0, 2.7]) {
          for (const signal of [4, 14, 24]) {
            const model = { surface, secondary, primary, highway, signal }
            const mae = score(routeTimes(graph, snap, model, limit, stopAt), targets)
            if (mae < best.mae) best = { model, mae }
          }
        }
      }
    }
  }
  const base = best.model
  for (const model of [
    { ...base, surface: base.surface * 0.9 },
    { ...base, surface: base.surface * 1.1 },
    { ...base, secondary: base.secondary * 0.9 },
    { ...base, secondary: base.secondary * 1.1 },
    { ...base, primary: base.primary * 0.9 },
    { ...base, primary: base.primary * 1.1 },
    { ...base, highway: base.highway * 0.9 },
    { ...base, highway: base.highway * 1.1 },
    { ...base, signal: Math.max(0, base.signal - 5) },
    { ...base, signal: base.signal + 5 },
  ]) {
    const mae = score(routeTimes(graph, snap, model, limit, stopAt), targets)
    if (mae < best.mae) best = { model, mae }
  }
  const times = routeTimes(graph, snap, best.model, limit)
  return { model: best.model, mae: score(times, targets), times }
}

function score(times: Float64Array, targets: Target[]): number {
  let weight = 0
  let total = 0
  for (const target of targets) {
    const predicted = times[target.node]
    const miss = predicted === undefined || !Number.isFinite(predicted) ? 12 : Math.abs(predicted / 60 - target.minutes)
    total += target.weight * miss
    weight += target.weight
  }
  return weight > 0 ? total / weight : 99
}

function spreadAnchors(
  graph: Graph,
  originLon: number,
  originLat: number,
  durationMin: number,
): Array<{ node: number; lon: number; lat: number }> {
  const radius = durationMin * 420
  const picks: Array<{ node: number; lon: number; lat: number }> = []
  const seen = new Set<number>()
  const specs: Array<[number, number]> = []
  for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) specs.push([bearing, radius * 0.5])
  for (const bearing of [20, 110, 200, 290]) specs.push([bearing, radius * 0.95])
  for (const [bearing, distance] of specs) {
    const point = offset(originLon, originLat, bearing, distance)
    const node = nearestNode(graph, point[0], point[1], 1800)
    if (node == null || seen.has(node)) continue
    seen.add(node)
    picks.push({ node, lon: graph.lon[node] ?? point[0], lat: graph.lat[node] ?? point[1] })
  }
  return picks
}

function offset(lon: number, lat: number, bearingDeg: number, distance: number): [number, number] {
  const bearing = (bearingDeg * Math.PI) / 180
  const dlat = (distance * Math.cos(bearing)) / 111_320
  const dlon = (distance * Math.sin(bearing)) / (111_320 * Math.cos((lat * Math.PI) / 180))
  return [lon + dlon, lat + dlat]
}
