import { VectorTile } from "@mapbox/vector-tile"
import { PbfReader } from "pbf"

import { meters } from "./geo.ts"
import { parseGraph, type Graph } from "./graph.ts"
import { FREEFLOW_KMH } from "./model.ts"

type Line = {
  classId: number
  forward: boolean
  backward: boolean
  coords: Array<[number, number]>
}

const CLASS_INDEX: Record<string, number> = {
  motorway: 0,
  trunk: 2,
  primary: 4,
  secondary: 6,
  tertiary: 8,
  minor: 11,
  residential: 11,
  living_street: 12,
  unclassified: 10,
}

const TILE_URLS = { value: "" }

/** Build a small routable graph from OpenFreeMap roads inside a bbox. Used outside the Boston extract. */
export async function graphFromTiles(west: number, south: number, east: number, north: number): Promise<Graph> {
  const zoom = chooseZoom(west, south, east, north)
  const tiles = tileRange(zoom, west, south, east, north)
  if (tiles.length > 140) {
    throw new Error("That drive is larger than this map can trace in one pass. Try a shorter time.")
  }
  const template = await tileTemplate()
  const lines: Line[] = []
  let cursor = 0
  const workers = Array.from({ length: 8 }, async () => {
    while (cursor < tiles.length) {
      const tile = tiles[cursor++]
      if (!tile) break
      const url = template.replace("{z}", String(zoom)).replace("{x}", String(tile.x)).replace("{y}", String(tile.y))
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(12_000) })
        if (!response.ok) continue
        const buffer = await response.arrayBuffer()
        lines.push(...roadsInTile(new Uint8Array(buffer), tile.x, tile.y, zoom))
      } catch {
        // A missing tile just leaves a gap; the fit will show it if routing fails.
      }
    }
  })
  await Promise.all(workers)
  if (lines.length < 8) throw new Error("Could not load streets around that place")
  return assemble(lines)
}

function chooseZoom(west: number, south: number, east: number, north: number): number {
  for (const zoom of [14, 13, 12]) {
    if (tileRange(zoom, west, south, east, north).length <= 100) return zoom
  }
  return 12
}

function tileRange(zoom: number, west: number, south: number, east: number, north: number): Array<{ x: number; y: number }> {
  const n = 2 ** zoom
  const x0 = lonTile(west, n)
  const x1 = lonTile(east, n)
  const y0 = latTile(north, n)
  const y1 = latTile(south, n)
  const out: Array<{ x: number; y: number }> = []
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) out.push({ x, y })
  }
  return out
}

function lonTile(lon: number, n: number): number {
  return Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)))
}

function latTile(lat: number, n: number): number {
  const rad = (lat * Math.PI) / 180
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2
  return Math.max(0, Math.min(n - 1, Math.floor(y * n)))
}

async function tileTemplate(): Promise<string> {
  if (TILE_URLS.value) return TILE_URLS.value
  const response = await fetch("https://tiles.openfreemap.org/planet", { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error("Could not reach the street tiles")
  const json = (await response.json()) as { tiles?: string[] }
  const url = json.tiles?.[0]
  if (!url) throw new Error("Street tiles did not advertise an address")
  TILE_URLS.value = url
  return url
}

function roadsInTile(bytes: Uint8Array, x: number, y: number, z: number): Line[] {
  const tile = new VectorTile(new PbfReader(bytes))
  const layer = tile.layers.transportation
  if (!layer) return []
  const out: Line[] = []
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i)
    const kind = String(feature.properties.class ?? "")
    let classId = CLASS_INDEX[kind]
    if (classId === undefined) continue
    if (feature.properties.ramp === 1 && classId === 0) classId = 1
    const oneway = Number(feature.properties.oneway ?? 0)
    const geo = feature.toGeoJSON(x, y, z)
    const lines = geo.geometry.type === "LineString" ? [geo.geometry.coordinates] : geo.geometry.type === "MultiLineString" ? geo.geometry.coordinates : []
    for (const coords of lines) {
      const cleaned: Array<[number, number]> = []
      for (const coord of coords) {
        if (!Array.isArray(coord) || coord.length < 2) continue
        const lon = Number(coord[0])
        const lat = Number(coord[1])
        const prev = cleaned[cleaned.length - 1]
        if (prev && Math.abs(prev[0] - lon) < 1e-6 && Math.abs(prev[1] - lat) < 1e-6) continue
        cleaned.push([lon, lat])
      }
      if (cleaned.length < 2) continue
      out.push({
        classId,
        forward: oneway !== -1,
        backward: oneway !== 1,
        coords: cleaned,
      })
    }
  }
  return out
}

function assemble(lines: Line[]): Graph {
  const keyOf = (lon: number, lat: number) => `${Math.round(lon * 1e5)},${Math.round(lat * 1e5)}`
  const usage = new Map<string, number>()
  for (const line of lines) {
    for (const [lon, lat] of line.coords) usage.set(keyOf(lon, lat), (usage.get(keyOf(lon, lat)) ?? 0) + 1)
  }
  type Edge = { u: string; v: string; ff: number; classId: number; line: Array<[number, number]> }
  const edges: Edge[] = []
  for (const line of lines) {
    let span: Array<[number, number]> = [line.coords[0]!]
    const pieces: Array<Array<[number, number]>> = []
    for (let i = 1; i < line.coords.length; i++) {
      const point = line.coords[i]!
      span.push(point)
      const key = keyOf(point[0], point[1])
      const end = i === line.coords.length - 1
      if (end || (usage.get(key) ?? 0) >= 2) {
        pieces.push(span)
        span = [point]
      }
    }
    for (const piece of pieces) {
      if (piece.length < 2) continue
      let length = 0
      for (let i = 1; i < piece.length; i++) length += meters(piece[i - 1]![0], piece[i - 1]![1], piece[i]![0], piece[i]![1])
      if (length < 1) continue
      const speed = FREEFLOW_KMH[line.classId] ?? 40
      const ff = Math.max(1, Math.min(65535, Math.round(length / (speed / 3.6))))
      const u = keyOf(piece[0]![0], piece[0]![1])
      const v = keyOf(piece[piece.length - 1]![0], piece[piece.length - 1]![1])
      if (u === v) continue
      if (line.forward) edges.push({ u, v, ff, classId: line.classId, line: piece })
      if (line.backward) edges.push({ u: v, v: u, ff, classId: line.classId, line: [...piece].reverse() })
    }
  }
  const index = new Map<string, number>()
  const coords: Array<[number, number]> = []
  const node = (key: string, lon: number, lat: number) => {
    const existing = index.get(key)
    if (existing !== undefined) return existing
    const id = coords.length
    index.set(key, id)
    coords.push([lon, lat])
    return id
  }
  const resolved: Array<{ u: number; v: number; ff: number; classId: number; line: Array<[number, number]> }> = []
  for (const edge of edges) {
    const [ulon, ulat] = edge.u.split(",").map((value) => Number(value) / 1e5)
    const [vlon, vlat] = edge.v.split(",").map((value) => Number(value) / 1e5)
    if (ulon === undefined || ulat === undefined || vlon === undefined || vlat === undefined) continue
    resolved.push({
      u: node(edge.u, ulon, ulat),
      v: node(edge.v, vlon, vlat),
      ff: edge.ff,
      classId: edge.classId,
      line: edge.line,
    })
  }
  return parseGraph(encodeTemporary(coords, resolved))
}

function encodeTemporary(
  coords: Array<[number, number]>,
  edges: Array<{ u: number; v: number; ff: number; classId: number; line: Array<[number, number]> }>,
): ArrayBuffer {
  let minLon = 180
  let minLat = 90
  let maxLon = -180
  let maxLat = -90
  for (const [lon, lat] of coords) {
    minLon = Math.min(minLon, lon)
    maxLon = Math.max(maxLon, lon)
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
  }
  const pad = 1e-4
  const originLon = minLon - pad
  const originLat = minLat - pad
  const spanLon = maxLon - minLon + 2 * pad
  const spanLat = maxLat - minLat + 2 * pad
  const buckets: typeof edges[] = Array.from({ length: coords.length }, () => [])
  for (const edge of edges) buckets[edge.u]?.push(edge)
  const flat = buckets.flat()
  const offsets: number[] = [0]
  for (const bucket of buckets) offsets.push((offsets[offsets.length - 1] ?? 0) + bucket.length)
  const geom: Array<[number, number]> = []
  const packed = flat.map((edge) => {
    const start = geom.length
    for (const [lon, lat] of edge.line) {
      const x = Math.max(0, Math.min(65535, Math.round(((lon - originLon) / spanLon) * 65535)))
      const y = Math.max(0, Math.min(65535, Math.round(((lat - originLat) / spanLat) * 65535)))
      geom.push([x, y])
    }
    return { ...edge, start, count: edge.line.length }
  })
  const bytes = 33 + coords.length * 8 + offsets.length * 4 + packed.length * 14 + geom.length * 4
  const buffer = new ArrayBuffer(bytes)
  const view = new DataView(buffer)
  view.setUint8(0, 71)
  view.setUint8(1, 82)
  view.setUint8(2, 70)
  view.setUint8(3, 49)
  view.setUint8(4, 1)
  view.setFloat32(5, originLon, true)
  view.setFloat32(9, originLat, true)
  view.setFloat32(13, spanLon, true)
  view.setFloat32(17, spanLat, true)
  view.setUint32(21, coords.length, true)
  view.setUint32(25, packed.length, true)
  view.setUint32(29, geom.length, true)
  let offset = 33
  for (const [lon, lat] of coords) {
    view.setInt32(offset, Math.round(lon * 1e7), true)
    view.setInt32(offset + 4, Math.round(lat * 1e7), true)
    offset += 8
  }
  for (const value of offsets) {
    view.setUint32(offset, value, true)
    offset += 4
  }
  for (const edge of packed) {
    view.setUint32(offset, edge.v, true)
    view.setUint16(offset + 4, edge.ff, true)
    view.setUint8(offset + 6, edge.classId)
    view.setUint8(offset + 7, 0)
    view.setUint32(offset + 8, edge.start, true)
    view.setUint16(offset + 12, edge.count, true)
    offset += 14
  }
  for (const [x, y] of geom) {
    view.setUint16(offset, x, true)
    view.setUint16(offset + 2, y, true)
    offset += 4
  }
  return buffer
}
