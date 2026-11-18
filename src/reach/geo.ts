const M_PER_DEG_LAT = 111_320

export function meters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const cos = Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180))
  return Math.hypot((lon2 - lon1) * M_PER_DEG_LAT * cos, (lat2 - lat1) * M_PER_DEG_LAT)
}

export function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]?.[0] ?? 0
    const yi = ring[i]?.[1] ?? 0
    const xj = ring[j]?.[0] ?? 0
    const yj = ring[j]?.[1] ?? 0
    const intersect = (yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** Outer ring plus holes. */
export function pointInPolygon(lon: number, lat: number, rings: number[][][]): boolean {
  const outer = rings[0]
  if (!outer || !pointInRing(lon, lat, outer)) return false
  for (let h = 1; h < rings.length; h++) {
    const hole = rings[h]
    if (hole && pointInRing(lon, lat, hole)) return false
  }
  return true
}

export function ringBBox(ring: number[][]): [number, number, number, number] {
  let west = 180
  let south = 90
  let east = -180
  let north = -90
  for (const coord of ring) {
    const lon = coord[0] ?? 0
    const lat = coord[1] ?? 0
    if (lon < west) west = lon
    if (lon > east) east = lon
    if (lat < south) south = lat
    if (lat > north) north = lat
  }
  return [west, south, east, north]
}

export function expandBox(
  box: [number, number, number, number],
  lon: number,
  lat: number,
): [number, number, number, number] {
  return [Math.min(box[0], lon), Math.min(box[1], lat), Math.max(box[2], lon), Math.max(box[3], lat)]
}

export function sampleRing(ring: number[][], count: number): number[][] {
  if (ring.length === 0) return []
  const out: number[][] = []
  const step = Math.max(1, Math.floor((ring.length - 1) / count))
  for (let i = 0; i < ring.length - 1 && out.length < count; i += step) {
    const coord = ring[i]
    if (coord) out.push(coord)
  }
  return out
}
