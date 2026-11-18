import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { meters } from "./geo.ts"
import { driveSeconds, signalSeconds, type Model } from "./model.ts"

export type Graph = {
  originLon: number
  originLat: number
  spanLon: number
  spanLat: number
  lon: Float64Array
  lat: Float64Array
  offsets: Uint32Array
  from: Uint32Array
  to: Uint32Array
  ff: Uint16Array
  classId: Uint8Array
  geomStart: Uint32Array
  geomLen: Uint16Array
  geomX: Uint16Array
  geomY: Uint16Array
  degree: Uint8Array
  /** `${from},${to}` → edge index, for the reverse direction of a street. */
  pair: Map<string, number>
  nodeCells: Map<number, number[]>
  edgeCells: Map<number, number[]>
}

export type Snap = {
  /** Directed edge whose geometry we landed on. */
  edge: number
  /** Reverse edge, when the street is two-way. */
  reverse: number | null
  /** Fraction along the forward edge from its start node to its end node. */
  g: number
  distanceMeters: number
  lon: number
  lat: number
}

const CELL = 0.0016

let cached: Graph | null = null
let cachedPath = ""

export function defaultGraphPath(): string {
  const candidates = [
    join(process.cwd(), "server", "graph.bin"),
    fileURLToPath(new URL("../../server/graph.bin", import.meta.url)),
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  throw new Error("The Boston road graph is missing")
}

export function loadGraph(path = defaultGraphPath()): Graph {
  if (cached && cachedPath === path) return cached
  const bytes = readFileSync(path)
  cached = parseGraph(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  cachedPath = path
  return cached
}

export function parseGraph(buffer: ArrayBuffer): Graph {
  const view = new DataView(buffer)
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
  if (magic !== "GRF1" || view.getUint8(4) !== 1) throw new Error("Unexpected road graph")
  const originLon = view.getFloat32(5, true)
  const originLat = view.getFloat32(9, true)
  const spanLon = view.getFloat32(13, true)
  const spanLat = view.getFloat32(17, true)
  const nodeCount = view.getUint32(21, true)
  const edgeCount = view.getUint32(25, true)
  const geomCount = view.getUint32(29, true)
  let offset = 33
  const lon = new Float64Array(nodeCount)
  const lat = new Float64Array(nodeCount)
  for (let i = 0; i < nodeCount; i++) {
    lon[i] = view.getInt32(offset, true) / 1e7
    lat[i] = view.getInt32(offset + 4, true) / 1e7
    offset += 8
  }
  const offsets = new Uint32Array(nodeCount + 1)
  for (let i = 0; i < offsets.length; i++) {
    offsets[i] = view.getUint32(offset, true)
    offset += 4
  }
  const from = new Uint32Array(edgeCount)
  const to = new Uint32Array(edgeCount)
  const ff = new Uint16Array(edgeCount)
  const classId = new Uint8Array(edgeCount)
  const geomStart = new Uint32Array(edgeCount)
  const geomLen = new Uint16Array(edgeCount)
  for (let node = 0; node < nodeCount; node++) {
    const start = offsets[node] ?? 0
    const end = offsets[node + 1] ?? start
    for (let edge = start; edge < end; edge++) from[edge] = node
  }
  for (let edge = 0; edge < edgeCount; edge++) {
    to[edge] = view.getUint32(offset, true)
    ff[edge] = view.getUint16(offset + 4, true)
    classId[edge] = view.getUint8(offset + 6)
    geomStart[edge] = view.getUint32(offset + 8, true)
    geomLen[edge] = view.getUint16(offset + 12, true)
    offset += 14
  }
  const geomX = new Uint16Array(geomCount)
  const geomY = new Uint16Array(geomCount)
  for (let i = 0; i < geomCount; i++) {
    geomX[i] = view.getUint16(offset, true)
    geomY[i] = view.getUint16(offset + 2, true)
    offset += 4
  }
  const degree = new Uint8Array(nodeCount)
  const seen: number[][] = Array.from({ length: nodeCount }, () => [])
  for (let edge = 0; edge < edgeCount; edge++) {
    seen[from[edge] ?? 0]?.push(to[edge] ?? 0)
    seen[to[edge] ?? 0]?.push(from[edge] ?? 0)
  }
  for (let node = 0; node < nodeCount; node++) {
    const list = seen[node] ?? []
    list.sort((a, b) => a - b)
    let unique = 0
    let prev = -1
    for (const next of list) {
      if (next !== prev) unique += 1
      prev = next
    }
    degree[node] = Math.min(255, unique)
  }
  const pair = new Map<string, number>()
  for (let edge = 0; edge < edgeCount; edge++) pair.set(`${from[edge]},${to[edge]}`, edge)
  const graph: Graph = {
    originLon,
    originLat,
    spanLon,
    spanLat,
    lon,
    lat,
    offsets,
    from,
    to,
    ff,
    classId,
    geomStart,
    geomLen,
    geomX,
    geomY,
    degree,
    pair,
    nodeCells: new Map(),
    edgeCells: new Map(),
  }
  indexGraph(graph)
  return graph
}

function cellKey(lon: number, lat: number): number {
  const ix = Math.floor(lon / CELL)
  const iy = Math.floor(lat / CELL)
  return ix * 100_000 + iy
}

function indexGraph(graph: Graph) {
  const push = (map: Map<number, number[]>, key: number, value: number) => {
    const list = map.get(key)
    if (list) list.push(value)
    else map.set(key, [value])
  }
  for (let node = 0; node < graph.lon.length; node++) {
    push(graph.nodeCells, cellKey(graph.lon[node] ?? 0, graph.lat[node] ?? 0), node)
  }
  for (let edge = 0; edge < graph.to.length; edge++) {
    const count = graph.geomLen[edge] ?? 0
    const start = graph.geomStart[edge] ?? 0
    for (let i = 0; i < count; i += Math.max(1, Math.floor(count / 4))) {
      const lon = graph.originLon + ((graph.geomX[start + i] ?? 0) / 65535) * graph.spanLon
      const lat = graph.originLat + ((graph.geomY[start + i] ?? 0) / 65535) * graph.spanLat
      push(graph.edgeCells, cellKey(lon, lat), edge)
      if (i + Math.max(1, Math.floor(count / 4)) >= count && i !== count - 1) {
        const endLon = graph.originLon + ((graph.geomX[start + count - 1] ?? 0) / 65535) * graph.spanLon
        const endLat = graph.originLat + ((graph.geomY[start + count - 1] ?? 0) / 65535) * graph.spanLat
        push(graph.edgeCells, cellKey(endLon, endLat), edge)
      }
    }
  }
}

export function geomPoint(graph: Graph, index: number): [number, number] {
  return [
    graph.originLon + ((graph.geomX[index] ?? 0) / 65535) * graph.spanLon,
    graph.originLat + ((graph.geomY[index] ?? 0) / 65535) * graph.spanLat,
  ]
}

export function nearestNode(graph: Graph, lon: number, lat: number, limitM: number): number | null {
  const reach = Math.ceil(limitM / 110) + 1
  const cx = Math.floor(lon / CELL)
  const cy = Math.floor(lat / CELL)
  let best = -1
  let bestD = limitM
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      const list = graph.nodeCells.get((cx + dx) * 100_000 + (cy + dy))
      if (!list) continue
      for (const node of list) {
        const dist = meters(lon, lat, graph.lon[node] ?? 0, graph.lat[node] ?? 0)
        if (dist < bestD) {
          bestD = dist
          best = node
        }
      }
    }
  }
  return best < 0 ? null : best
}

export function snapToRoad(graph: Graph, lon: number, lat: number, limitM = 120): Snap | null {
  const reach = Math.ceil(limitM / 110) + 1
  const cx = Math.floor(lon / CELL)
  const cy = Math.floor(lat / CELL)
  let bestEdge = -1
  let bestD = limitM
  let bestG = 0
  let bestLon = lon
  let bestLat = lat
  const seen = new Set<number>()
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      const list = graph.edgeCells.get((cx + dx) * 100_000 + (cy + dy))
      if (!list) continue
      for (const edge of list) {
        if (seen.has(edge)) continue
        seen.add(edge)
        const hit = projectEdge(graph, edge, lon, lat)
        if (hit && hit.distance < bestD) {
          bestD = hit.distance
          bestEdge = edge
          bestG = hit.g
          bestLon = hit.lon
          bestLat = hit.lat
        }
      }
    }
  }
  if (bestEdge < 0) return null
  const from = graph.from[bestEdge] ?? 0
  const to = graph.to[bestEdge] ?? 0
  const reverse = graph.pair.get(`${to},${from}`)
  return {
    edge: bestEdge,
    reverse: reverse === undefined || reverse === bestEdge ? null : reverse,
    g: bestG,
    distanceMeters: bestD,
    lon: bestLon,
    lat: bestLat,
  }
}

function projectEdge(
  graph: Graph,
  edge: number,
  lon: number,
  lat: number,
): { distance: number; g: number; lon: number; lat: number } | null {
  const count = graph.geomLen[edge] ?? 0
  const start = graph.geomStart[edge] ?? 0
  if (count < 2) return null
  let total = 0
  const lengths: number[] = []
  for (let i = 0; i < count - 1; i++) {
    const a = geomPoint(graph, start + i)
    const b = geomPoint(graph, start + i + 1)
    const len = meters(a[0], a[1], b[0], b[1])
    lengths.push(len)
    total += len
  }
  let best = Infinity
  let bestAlong = 0
  let bestLon = lon
  let bestLat = lat
  let cursor = 0
  for (let i = 0; i < count - 1; i++) {
    const a = geomPoint(graph, start + i)
    const b = geomPoint(graph, start + i + 1)
    const len = lengths[i] ?? 0
    const hit = projectSegment(lon, lat, a[0], a[1], b[0], b[1])
    if (hit.distance < best) {
      best = hit.distance
      bestAlong = cursor + hit.frac * len
      bestLon = hit.lon
      bestLat = hit.lat
    }
    cursor += len
  }
  if (!Number.isFinite(best)) return null
  return { distance: best, g: total > 1 ? bestAlong / total : 0, lon: bestLon, lat: bestLat }
}

function projectSegment(
  lon: number,
  lat: number,
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): { distance: number; frac: number; lon: number; lat: number } {
  const cos = Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180))
  const x = (lon - lon1) * cos
  const y = lat - lat1
  const dx = (lon2 - lon1) * cos
  const dy = lat2 - lat1
  const denom = dx * dx + dy * dy
  const frac = denom < 1e-12 ? 0 : Math.max(0, Math.min(1, (x * dx + y * dy) / denom))
  const px = lon1 + (lon2 - lon1) * frac
  const py = lat1 + (lat2 - lat1) * frac
  return { distance: meters(lon, lat, px, py), frac, lon: px, lat: py }
}

export function routeTimes(graph: Graph, snap: Snap, model: Model, limitSec: number, stopAt?: number[]): Float64Array {
  const count = graph.lon.length
  const time = new Float64Array(count)
  time.fill(Number.POSITIVE_INFINITY)
  let heapT = new Float64Array(Math.max(1024, graph.to.length))
  let heapN = new Uint32Array(heapT.length)
  let size = 0
  const push = (t: number, node: number) => {
    if (size >= heapT.length) {
      const nextT = new Float64Array(heapT.length * 2)
      const nextN = new Uint32Array(heapN.length * 2)
      nextT.set(heapT)
      nextN.set(heapN)
      heapT = nextT
      heapN = nextN
    }
    let i = size++
    while (i > 0) {
      const parent = (i - 1) >> 1
      if ((heapT[parent] ?? 0) <= t) break
      heapT[i] = heapT[parent] ?? 0
      heapN[i] = heapN[parent] ?? 0
      i = parent
    }
    heapT[i] = t
    heapN[i] = node
  }
  const pop = (): [number, number] => {
    const t = heapT[0] ?? 0
    const node = heapN[0] ?? 0
    size -= 1
    const lastT = heapT[size] ?? 0
    const lastN = heapN[size] ?? 0
    let i = 0
    while (true) {
      const left = i * 2 + 1
      if (left >= size) break
      const right = left + 1
      const child = right < size && (heapT[right] ?? 0) < (heapT[left] ?? 0) ? right : left
      if ((heapT[child] ?? 0) >= lastT) break
      heapT[i] = heapT[child] ?? 0
      heapN[i] = heapN[child] ?? 0
      i = child
    }
    if (size > 0) {
      heapT[i] = lastT
      heapN[i] = lastN
    }
    return [t, node]
  }
  const seed = (node: number, t: number) => {
    if (t < (time[node] ?? Infinity) && t <= limitSec) {
      time[node] = t
      push(t, node)
    }
  }
  const forward = snap.edge
  const u = graph.from[forward] ?? 0
  const v = graph.to[forward] ?? 0
  const driveForward = driveSeconds(graph.ff[forward] ?? 1, graph.classId[forward] ?? 0, model)
  seed(v, (1 - snap.g) * driveForward + signalSeconds(graph.classId[forward] ?? 0, graph.degree[v] ?? 0, model))
  if (snap.reverse != null) {
    const rev = snap.reverse
    const driveBack = driveSeconds(graph.ff[rev] ?? 1, graph.classId[rev] ?? 0, model)
    seed(u, snap.g * driveBack + signalSeconds(graph.classId[rev] ?? 0, graph.degree[u] ?? 0, model))
  }
  const pending = new Set(stopAt ?? [])
  while (size > 0) {
    const [t, node] = pop()
    if (t !== time[node]) continue
    if (pending.delete(node) && pending.size === 0) break
    if (t > limitSec) continue
    const start = graph.offsets[node] ?? 0
    const end = graph.offsets[node + 1] ?? start
    for (let edge = start; edge < end; edge++) {
      const next = graph.to[edge] ?? 0
      const step =
        driveSeconds(graph.ff[edge] ?? 1, graph.classId[edge] ?? 0, model) +
        signalSeconds(graph.classId[edge] ?? 0, graph.degree[next] ?? 0, model)
      const alt = t + step
      if (alt <= limitSec && alt < (time[next] ?? Infinity)) {
        time[next] = alt
        push(alt, next)
      }
    }
  }
  return time
}

export function covers(graph: Graph, lon: number, lat: number): boolean {
  const west = graph.originLon + 0.01
  const south = graph.originLat + 0.01
  const east = graph.originLon + graph.spanLon - 0.01
  const north = graph.originLat + graph.spanLat - 0.01
  return lon >= west && lon <= east && lat >= south && lat <= north
}
