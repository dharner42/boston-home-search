export type TravelGrid = {
  version: 1
  maxMinutes: number
  /** Stored cell value meaning "no drive time". */
  nullValue: number
  /** Cell values are minutes × 10 (0.1 minute precision). */
  tenths: true
  /** Southwest corner of cell (0, 0). Row 0 is the southern edge. */
  originLon: number
  originLat: number
  cellLon: number
  cellLat: number
  cols: number
  rows: number
  /** A cell farther than this from any reached road is left empty. */
  searchMeters: number
  values: Uint8Array
}

type TravelGridFile = Omit<TravelGrid, "values"> & { values: string }

export const TRAVEL_GRID_URL = "/data/travel-grid.json"

export async function loadTravelGrid(url = TRAVEL_GRID_URL): Promise<TravelGrid> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load drive-time grid (${res.status})`)
  const raw = (await res.json()) as TravelGridFile
  const values = decodeBase64(raw.values)
  if (values.length !== raw.cols * raw.rows) {
    throw new Error("Drive-time grid size does not match its header")
  }
  return { ...raw, values }
}

/**
 * Free-flow drive time in minutes from The Kendall School, or null when the
 * point is outside the 20-minute window (or farther than the grid's search
 * radius from a reached road).
 */
export function travelMinutes(grid: TravelGrid, lon: number, lat: number): number | null {
  const col = Math.floor((lon - grid.originLon) / grid.cellLon)
  const row = Math.floor((lat - grid.originLat) / grid.cellLat)
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return null
  const value = grid.values[row * grid.cols + col]
  if (value === undefined || value === grid.nullValue) return null
  return value / 10
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
