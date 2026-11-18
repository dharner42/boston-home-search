import type { TravelGrid } from "../travel-time.ts"
import type { ReachBand } from "./model.ts"
import type { Polyline } from "./mesh.ts"
import type { Model } from "./model.ts"

export type ReachHeader = {
  version: 1
  label: string
  lon: number
  lat: number
  snapLon: number
  snapLat: number
  minutes: number
  marginMinutes: number
  departAt: string
  note: string
  bands: ReachBand[]
  bounds: {
    b1: [number, number, number, number]
    b2: [number, number, number, number]
    b3: [number, number, number, number]
  }
  span: { originLon: number; originLat: number; spanLon: number; spanLat: number }
  model: Model
  maeMinutes: number
  grid: Omit<TravelGrid, "values">
}

export type ReachLine = {
  lon: Float64Array
  lat: Float64Array
  t: Float32Array
}

export type ReachData = {
  header: ReachHeader
  lines: ReachLine[]
  grid: TravelGrid
}

export function encodeReach(
  header: Omit<ReachHeader, "span" | "grid"> & { grid: TravelGrid },
  lines: Polyline[],
): Uint8Array {
  const grid = header.grid
  let minLon = header.snapLon
  let minLat = header.snapLat
  let maxLon = header.snapLon
  let maxLat = header.snapLat
  for (const line of lines) {
    for (let i = 0; i < line.lon.length; i++) {
      const lon = line.lon[i] ?? minLon
      const lat = line.lat[i] ?? minLat
      if (lon < minLon) minLon = lon
      if (lon > maxLon) maxLon = lon
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
  }
  const pad = 1e-4
  const originLon = minLon - pad
  const originLat = minLat - pad
  const spanLon = Math.max(1e-6, maxLon - minLon + 2 * pad)
  const spanLat = Math.max(1e-6, maxLat - minLat + 2 * pad)
  const packed: Array<Array<[number, number, number]>> = []
  for (const line of lines) {
    const points: Array<[number, number, number]> = []
    for (let i = 0; i < line.lon.length; i++) {
      const x = quant(line.lon[i] ?? 0, originLon, spanLon)
      const y = quant(line.lat[i] ?? 0, originLat, spanLat)
      const t = Math.max(0, Math.min(65535, Math.round((line.t[i] ?? 0) * 10)))
      const prev = points[points.length - 1]
      if (prev && prev[0] === x && prev[1] === y) continue
      points.push([x, y, t])
    }
    for (let i = 0; i < points.length; i += 254) {
      const chunk = points.slice(i, i + 255)
      if (chunk.length >= 2) packed.push(chunk)
    }
  }
  const json = JSON.stringify({
    ...header,
    grid: { ...grid, values: undefined },
    span: { originLon, originLat, spanLon, spanLat },
  })
  const jsonBytes = new TextEncoder().encode(json)
  let bytes = 8 + jsonBytes.length + 4
  for (const line of packed) bytes += 2 + line.length * 6
  bytes += grid.values.byteLength
  const buffer = new Uint8Array(bytes)
  const view = new DataView(buffer.buffer)
  buffer[0] = 82
  buffer[1] = 67
  buffer[2] = 72
  buffer[3] = 49
  view.setUint32(4, jsonBytes.length, true)
  buffer.set(jsonBytes, 8)
  let offset = 8 + jsonBytes.length
  view.setUint32(offset, packed.length, true)
  offset += 4
  for (const line of packed) {
    view.setUint16(offset, line.length, true)
    offset += 2
    for (const [x, y, t] of line) {
      view.setUint16(offset, x, true)
      view.setUint16(offset + 2, y, true)
      view.setUint16(offset + 4, t, true)
      offset += 6
    }
  }
  const raw = new Uint8Array(grid.values.buffer, grid.values.byteOffset, grid.values.byteLength)
  buffer.set(raw, offset)
  return buffer
}

export function decodeReach(buffer: ArrayBuffer): ReachData {
  const view = new DataView(buffer)
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
  if (magic !== "RCH1") throw new Error("Unexpected drive-time file")
  const jsonLen = view.getUint32(4, true)
  const jsonText = new TextDecoder().decode(new Uint8Array(buffer, 8, jsonLen))
  const header = JSON.parse(jsonText) as ReachHeader
  let offset = 8 + jsonLen
  const lineCount = view.getUint32(offset, true)
  offset += 4
  const lines: ReachLine[] = []
  const { originLon, originLat, spanLon, spanLat } = header.span
  for (let line = 0; line < lineCount; line++) {
    const count = view.getUint16(offset, true)
    offset += 2
    const lon = new Float64Array(count)
    const lat = new Float64Array(count)
    const t = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      lon[i] = originLon + (view.getUint16(offset, true) / 65535) * spanLon
      lat[i] = originLat + (view.getUint16(offset + 2, true) / 65535) * spanLat
      t[i] = view.getUint16(offset + 4, true) / 10
      offset += 6
    }
    lines.push({ lon, lat, t })
  }
  const cells = header.grid.cols * header.grid.rows
  const values = new Uint16Array(cells)
  for (let i = 0; i < cells; i++) {
    values[i] = view.getUint16(offset, true)
    offset += 2
  }
  return { header, lines, grid: { ...header.grid, values } }
}

function quant(value: number, origin: number, span: number): number {
  return Math.max(0, Math.min(65535, Math.round(((value - origin) / span) * 65535)))
}
