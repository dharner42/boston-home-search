import { meters } from "./geo.ts"
import { geomPoint, type Graph, type Snap } from "./graph.ts"
import { bandOf, driveSeconds, signalSeconds, type Model, type ReachBand } from "./model.ts"
import type { TravelGrid } from "../travel-time.ts"

export type Polyline = {
  lon: number[]
  lat: number[]
  t: number[]
}

export type Mesh = {
  lines: Polyline[]
  bounds: Array<[number, number, number, number]>
  grid: TravelGrid
}

const MARGIN_MIN = 5

export function marginMinutes(duration: number): number {
  return Math.min(MARGIN_MIN, 60 - duration)
}

export function buildMesh(
  graph: Graph,
  snap: Snap,
  times: Float64Array,
  durationMin: number,
  bands: ReachBand[],
  model: Model,
): Mesh {
  const drawLimit = durationMin * 60
  const gridLimit = (durationMin + marginMinutes(durationMin)) * 60
  const lines: Polyline[] = []
  const boxes: Array<[number, number, number, number] | null> = [null, null, null]
  const samples: Array<{ lon: number; lat: number; seconds: number }> = []

  const emit = (line: Polyline, forGrid: boolean) => {
    if (line.lon.length < 2) return
    const drawn = clip(line, drawLimit)
    if (drawn.lon.length >= 2) {
      lines.push(drawn)
      for (let i = 0; i < drawn.lon.length; i++) {
        const seconds = drawn.t[i] ?? 0
        const band = bandOf(seconds, bands) - 1
        const lon = drawn.lon[i] ?? 0
        const lat = drawn.lat[i] ?? 0
        const box = boxes[band]
        boxes[band] = box
          ? [Math.min(box[0], lon), Math.min(box[1], lat), Math.max(box[2], lon), Math.max(box[3], lat)]
          : [lon, lat, lon, lat]
      }
    }
    if (!forGrid) return
    for (let i = 0; i < line.lon.length; i++) {
      const seconds = line.t[i]
      if (seconds === undefined || seconds > gridLimit) continue
      samples.push({ lon: line.lon[i] ?? 0, lat: line.lat[i] ?? 0, seconds })
    }
  }

  emit(splitFromSnap(graph, snap, times, false), true)
  if (snap.reverse != null) emit(splitFromSnap(graph, snap, times, true), true)

  const seen = new Set<number>([snap.edge])
  if (snap.reverse != null) seen.add(snap.reverse)
  for (let edge = 0; edge < graph.to.length; edge++) {
    if (seen.has(edge)) continue
    const u = graph.from[edge] ?? 0
    const v = graph.to[edge] ?? 0
    const reverse = graph.pair.get(`${v},${u}`)
    if (reverse !== undefined && u > v) continue
    if (reverse !== undefined) seen.add(reverse)
    const tu = times[u] ?? Infinity
    const tv = times[v] ?? Infinity
    if (!Number.isFinite(tu) && !Number.isFinite(tv)) continue
    if (Number.isFinite(tu) && Number.isFinite(tv)) {
      emit(lineBetween(graph, edge, tu, tv), true)
      continue
    }
    if (Number.isFinite(tu)) emit(lineOneSide(graph, edge, tu, model, gridLimit), true)
    else if (reverse !== undefined) emit(lineOneSide(graph, reverse, tv, model, gridLimit), true)
  }

  const bounds = boxes.map((box, index) => {
    const fallback = boxes[2] ?? boxes[1] ?? boxes[0]
    const chosen = box ?? fallback ?? [snap.lon, snap.lat, snap.lon, snap.lat]
    const pad = 0.004 * (index + 1)
    return [chosen[0] - pad, chosen[1] - pad, chosen[2] + pad, chosen[3] + pad] as [number, number, number, number]
  })
  return {
    lines,
    bounds: bounds as Mesh["bounds"],
    grid: rasterGrid(samples, durationMin + marginMinutes(durationMin), snap.lat),
  }
}

function splitFromSnap(graph: Graph, snap: Snap, times: Float64Array, backward: boolean): Polyline {
  const edge = backward ? snap.reverse : snap.edge
  if (edge == null) return { lon: [], lat: [], t: [] }
  const points = edgePoints(graph, edge)
  const cum = cumulative(points)
  const total = cum[cum.length - 1] ?? 0
  const g = backward ? 1 - snap.g : snap.g
  const end = graph.to[edge] ?? 0
  const endTime = times[end]
  if (endTime === undefined || !Number.isFinite(endTime) || total <= 0) return { lon: [], lat: [], t: [] }
  const line: Polyline = { lon: [], lat: [], t: [] }
  const pushAt = (distance: number) => {
    const frac = Math.max(0, Math.min(1, distance / total))
    const point = pointAt(points, cum, frac)
    const remain = Math.max(1e-3, (1 - g) * total)
    const local = (distance - g * total) / remain
    line.lon.push(point[0])
    line.lat.push(point[1])
    line.t.push(Math.max(0, local) * endTime)
  }
  pushAt(g * total)
  for (let i = 0; i < points.length; i++) {
    if ((cum[i] ?? 0) > g * total + 0.5) pushAt(cum[i] ?? 0)
  }
  return line
}

function lineBetween(graph: Graph, edge: number, tu: number, tv: number): Polyline {
  const points = edgePoints(graph, edge)
  const cum = cumulative(points)
  const total = cum[cum.length - 1] ?? 0
  const line: Polyline = { lon: [], lat: [], t: [] }
  for (let i = 0; i < points.length; i++) {
    const frac = total > 0 ? (cum[i] ?? 0) / total : 0
    const point = points[i]
    if (!point) continue
    line.lon.push(point[0])
    line.lat.push(point[1])
    line.t.push(tu + (tv - tu) * frac)
  }
  if (tu > tv) {
    line.lon.reverse()
    line.lat.reverse()
    line.t.reverse()
  }
  return line
}

function lineOneSide(graph: Graph, edge: number, startTime: number, model: Model, limit: number): Polyline {
  const classId = graph.classId[edge] ?? 0
  const drive = driveSeconds(graph.ff[edge] ?? 1, classId, model)
  const wait = signalSeconds(classId, graph.degree[graph.to[edge] ?? 0] ?? 0, model)
  const points = edgePoints(graph, edge)
  const cum = cumulative(points)
  const total = cum[cum.length - 1] ?? 0
  const line: Polyline = { lon: [], lat: [], t: [] }
  for (let i = 0; i < points.length; i++) {
    const frac = total > 0 ? (cum[i] ?? 0) / total : 0
    const t = startTime + frac * drive + (frac > 0.98 ? wait : 0)
    if (t > limit) continue
    const point = points[i]
    if (!point) continue
    line.lon.push(point[0])
    line.lat.push(point[1])
    line.t.push(t)
  }
  return line
}

function edgePoints(graph: Graph, edge: number): Array<[number, number]> {
  const count = graph.geomLen[edge] ?? 0
  const start = graph.geomStart[edge] ?? 0
  const points: Array<[number, number]> = []
  for (let i = 0; i < count; i++) points.push(geomPoint(graph, start + i))
  return points
}

function cumulative(points: Array<[number, number]>): number[] {
  const cum = [0]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    cum.push((cum[i - 1] ?? 0) + (a && b ? meters(a[0], a[1], b[0], b[1]) : 0))
  }
  return cum
}

function pointAt(points: Array<[number, number]>, cum: number[], frac: number): [number, number] {
  const total = cum[cum.length - 1] ?? 0
  const target = frac * total
  for (let i = 1; i < points.length; i++) {
    const end = cum[i] ?? 0
    const start = cum[i - 1] ?? 0
    if (end >= target || i === points.length - 1) {
      const span = end - start
      const local = span > 0 ? (target - start) / span : 0
      const a = points[i - 1] ?? points[0] ?? [0, 0]
      const b = points[i] ?? a
      return [a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local]
    }
  }
  return points[0] ?? [0, 0]
}

function clip(line: Polyline, maxT: number): Polyline {
  const out: Polyline = { lon: [], lat: [], t: [] }
  const push = (lon: number, lat: number, t: number) => {
    const prevLon = out.lon[out.lon.length - 1]
    const prevLat = out.lat[out.lat.length - 1]
    if (prevLon !== undefined && prevLat !== undefined && Math.abs(prevLon - lon) < 1e-7 && Math.abs(prevLat - lat) < 1e-7) return
    out.lon.push(lon)
    out.lat.push(lat)
    out.t.push(t)
  }
  for (let i = 1; i < line.lon.length; i++) {
    const t0 = line.t[i - 1] ?? 0
    const t1 = line.t[i] ?? 0
    const a = [line.lon[i - 1] ?? 0, line.lat[i - 1] ?? 0]
    const b = [line.lon[i] ?? 0, line.lat[i] ?? 0]
    if (t0 <= maxT && t1 <= maxT) {
      push(a[0], a[1], t0)
      push(b[0], b[1], t1)
      continue
    }
    if (t0 <= maxT && t1 > maxT && t1 !== t0) {
      const f = (maxT - t0) / (t1 - t0)
      push(a[0], a[1], t0)
      push(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, maxT)
      continue
    }
    if (t0 > maxT && t1 <= maxT && t1 !== t0) {
      const f = (maxT - t0) / (t1 - t0)
      push(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, maxT)
      push(b[0], b[1], t1)
    }
  }
  return out
}

function rasterGrid(
  samples: Array<{ lon: number; lat: number; seconds: number }>,
  maxMinutes: number,
  lat0: number,
): TravelGrid {
  if (samples.length === 0) {
    return {
      version: 2,
      maxMinutes,
      nullValue: 65535,
      scale: 10,
      originLon: 0,
      originLat: 0,
      cellLon: 0.001,
      cellLat: 0.001,
      cols: 1,
      rows: 1,
      searchMeters: 175,
      values: Uint16Array.of(65535),
    }
  }
  let west = 180
  let south = 90
  let east = -180
  let north = -90
  for (const sample of samples) {
    west = Math.min(west, sample.lon)
    east = Math.max(east, sample.lon)
    south = Math.min(south, sample.lat)
    north = Math.max(north, sample.lat)
  }
  const cellM = 110
  const cellLat = cellM / 111_320
  const cellLon = cellM / (111_320 * Math.cos((lat0 * Math.PI) / 180))
  const pad = 2
  const originLon = west - pad * cellLon
  const originLat = south - pad * cellLat
  const cols = Math.max(1, Math.ceil((east - west) / cellLon) + pad * 2)
  const rows = Math.max(1, Math.ceil((north - south) / cellLat) + pad * 2)
  const values = new Uint16Array(cols * rows)
  values.fill(65535)
  const colOf = (lon: number) => Math.max(0, Math.min(cols - 1, Math.floor((lon - originLon) / cellLon)))
  const rowOf = (lat: number) => Math.max(0, Math.min(rows - 1, Math.floor((lat - originLat) / cellLat)))
  for (const sample of samples) {
    const idx = rowOf(sample.lat) * cols + colOf(sample.lon)
    const tenths = Math.max(0, Math.min(65534, Math.round((sample.seconds / 60) * 10)))
    if (tenths < (values[idx] ?? 65535)) values[idx] = tenths
  }
  const seeds: number[] = []
  for (let i = 0; i < values.length; i++) if (values[i] !== 65535) seeds.push(i)
  const queue = seeds.slice()
  const dist = new Uint8Array(values.length)
  dist.fill(255)
  for (const seed of seeds) dist[seed] = 0
  const maxStep = 2
  let head = 0
  while (head < queue.length) {
    const idx = queue[head++] ?? 0
    const step = dist[idx] ?? 255
    if (step >= maxStep) continue
    const col = idx % cols
    const row = Math.floor(idx / cols)
    const neighbors = [
      [col - 1, row],
      [col + 1, row],
      [col, row - 1],
      [col, row + 1],
    ]
    for (const [nc, nr] of neighbors) {
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const next = nr * cols + nc
      if ((dist[next] ?? 255) <= step + 1) continue
      dist[next] = step + 1
      if (values[next] === 65535) values[next] = values[idx] ?? 65535
      queue.push(next)
    }
  }
  return {
    version: 2,
    maxMinutes,
    nullValue: 65535,
    scale: 10,
    originLon,
    originLat,
    cellLon,
    cellLat,
    cols,
    rows,
    searchMeters: cellM * maxStep,
    values,
  }
}
