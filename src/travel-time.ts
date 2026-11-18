export type TravelGrid = {
  version: 1 | 2
  maxMinutes: number
  /** Stored cell value meaning "no drive time". */
  nullValue: number
  /** Cell values are minutes × scale. Version 1 files are tenths (scale 10) in uint8. */
  scale: number
  /** Southwest corner of cell (0, 0). Row 0 is the southern edge. */
  originLon: number
  originLat: number
  cellLon: number
  cellLat: number
  cols: number
  rows: number
  /** A cell farther than this from any reached road is left empty. */
  searchMeters: number
  values: Uint8Array | Uint16Array
}

type TravelGridFile = Omit<TravelGrid, "values" | "scale"> & {
  values: string
  scale?: number
  tenths?: boolean
}

export const TRAVEL_GRID_URL = "/data/travel-grid.json"

export async function loadTravelGrid(url = TRAVEL_GRID_URL): Promise<TravelGrid> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load drive-time grid (${res.status})`)
  const raw = (await res.json()) as TravelGridFile
  const bytes = decodeBase64(raw.values)
  const scale = raw.scale ?? (raw.tenths === false ? 1 : 10)
  const values = raw.version === 2 ? decodeUint16(bytes) : bytes
  if (values.length !== raw.cols * raw.rows) {
    throw new Error("Drive-time grid size does not match its header")
  }
  return { ...raw, scale, values }
}

/**
 * Traffic-aware drive time in minutes from the active origin, or null when the
 * point is outside the timed window or farther than the grid's search radius.
 */
export function travelMinutes(grid: TravelGrid, lon: number, lat: number): number | null {
  const col = Math.floor((lon - grid.originLon) / grid.cellLon)
  const row = Math.floor((lat - grid.originLat) / grid.cellLat)
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return null
  const value = grid.values[row * grid.cols + col]
  if (value === undefined || value === grid.nullValue) return null
  return value / grid.scale
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function decodeUint16(bytes: Uint8Array): Uint16Array {
  const out = new Uint16Array(Math.floor(bytes.length / 2))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true)
  return out
}
