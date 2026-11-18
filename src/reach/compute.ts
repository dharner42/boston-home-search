import { encodeReach, type ReachHeader } from "./codec.ts"
import { applyContourTimes } from "./contours.ts"
import { fitModel } from "./fit.ts"
import { covers, loadGraph, nearestNode, snapToRoad, type Graph, type Snap } from "./graph.ts"
import { fetchIsochrones } from "./mapbox.ts"
import { bandsFor, contourMinutes, type Model } from "./model.ts"
import { buildMesh, marginMinutes } from "./mesh.ts"
import { graphFromTiles } from "./tiles.ts"

export type ReachQuery = {
  lon: number
  lat: number
  minutes: number
  label: string
  depart: string
}

export type Sample = {
  name: string
  lon: number
  lat: number
  /** Minutes in the calibrated model, or null when the point is off the network. */
  modelMinutes: number | null
}

const cache = new Map<string, Uint8Array>()

export async function computeReach(
  query: ReachQuery,
  options?: { samples?: Array<{ name: string; lon: number; lat: number }>; graphPath?: string },
): Promise<{ body: Uint8Array; mae: number; model: Model; samples: Sample[] }> {
  const lon = round4(query.lon)
  const lat = round4(query.lat)
  const key = `${query.depart}|${lon}|${lat}|${query.minutes}`
  const samples = options?.samples ?? []
  if (samples.length === 0) {
    const hit = cache.get(key)
    if (hit) return { body: hit, mae: Number.NaN, model: { surface: 0, secondary: 0, primary: 0, highway: 0, signal: 0 }, samples: [] }
  }
  const started = Date.now()
  let graph: Graph
  let snap: Snap | null = null
  try {
    graph = loadGraph(options?.graphPath)
    if (covers(graph, lon, lat)) snap = snapToRoad(graph, lon, lat, 130)
  } catch {
    graph = await graphFromTiles(lon - 0.35, lat - 0.28, lon + 0.35, lat + 0.28)
    snap = snapToRoad(graph, lon, lat, 160)
  }
  if (!snap) {
    const preview = await loadContours(lon, lat, query.minutes, query.depart)
    const outer = preview[preview.length - 1]
    if (outer) {
      const [west, south, east, north] = outer.bbox
      graph = await graphFromTiles(west - 0.01, south - 0.01, east + 0.01, north + 0.01)
    } else {
      const span = query.minutes * 0.012
      graph = await graphFromTiles(lon - span, lat - span * 0.7, lon + span, lat + span * 0.7)
    }
    snap = snapToRoad(graph, lon, lat, 180)
  }
  if (!snap) throw new Error("No drivable street within 180 m of that place")
  const contours = await loadContours(lon, lat, query.minutes, query.depart)
  const fitted = await fitModel(graph, snap, lon, lat, query.minutes, marginMinutes(query.minutes), query.depart, contours)
  const times = applyContourTimes(graph, fitted.times, contours)
  const bands = bandsFor(query.minutes)
  const mesh = buildMesh(graph, snap, times, query.minutes, bands, fitted.model)
  const note = `Tuesday morning traffic, about 8:00. Streets past ${query.minutes} minutes stay dark.`
  const header: Omit<ReachHeader, "span" | "grid"> & { grid: typeof mesh.grid } = {
    version: 1,
    label: query.label,
    lon,
    lat,
    snapLon: snap.lon,
    snapLat: snap.lat,
    minutes: query.minutes,
    marginMinutes: marginMinutes(query.minutes),
    departAt: query.depart,
    note,
    bands,
    bounds: { b1: mesh.bounds[0], b2: mesh.bounds[1], b3: mesh.bounds[2] },
    model: fitted.model,
    maeMinutes: round1(fitted.mae),
    grid: mesh.grid,
  }
  const body = encodeReach(header, mesh.lines)
  if (samples.length === 0) {
    cache.set(key, body)
    if (cache.size > 12) cache.delete(cache.keys().next().value ?? key)
  }
  const explained = samples.map((sample) => {
    const node = nearestNode(graph, sample.lon, sample.lat, 350)
    const seconds = node == null ? undefined : times[node]
    return {
      ...sample,
      modelMinutes: seconds !== undefined && Number.isFinite(seconds) ? round1(seconds / 60) : null,
    }
  })
  console.log(
    `[reach] ${query.label} ${query.minutes}min lines=${mesh.lines.length} mae=${round1(fitted.mae)} ${Date.now() - started}ms`,
  )
  return { body, mae: fitted.mae, model: fitted.model, samples: explained }
}

async function loadContours(lon: number, lat: number, minutes: number, depart: string) {
  try {
    return await fetchIsochrones(lon, lat, contourMinutes(minutes, marginMinutes(minutes)), depart)
  } catch (error) {
    console.warn("[reach] isochrone skipped:", error instanceof Error ? error.message : error)
    return []
  }
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}
