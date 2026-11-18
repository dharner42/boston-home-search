import { ringBBox } from "./geo.ts"

export type Contour = {
  minutes: number
  polygons: number[][][][]
  bbox: [number, number, number, number]
}

type GeoJson = {
  features?: Array<{
    properties?: { contour?: number }
    geometry?: { type?: string; coordinates?: number[][][] | number[][][][] }
  }>
}

export function mapboxToken(): string {
  const token = process.env.VITE_MAPBOX_TOKEN || process.env.MAPBOX_TOKEN || ""
  if (!token) throw new Error("Mapbox token is not configured")
  return token
}

export async function fetchIsochrones(
  lon: number,
  lat: number,
  minutes: number[],
  depart: string,
): Promise<Contour[]> {
  const token = mapboxToken()
  const url =
    `https://api.mapbox.com/isochrone/v1/mapbox/driving-traffic/${lon},${lat}` +
    `?contours_minutes=${minutes.join(",")}` +
    `&polygons=true&denoise=1&generalize=60&depart_at=${encodeURIComponent(depart)}` +
    `&access_token=${token}`
  const json = (await getJson(url)) as GeoJson
  const contours: Contour[] = []
  for (const feature of json.features ?? []) {
    const value = feature.properties?.contour
    const geometry = feature.geometry
    if (typeof value !== "number" || !geometry?.coordinates) continue
    const polygons = normalizePolygons(geometry.type, geometry.coordinates)
    if (polygons.length === 0) continue
    let bbox: [number, number, number, number] = [180, 90, -180, -90]
    for (const polygon of polygons) {
      const ring = polygon[0]
      if (!ring) continue
      const box = ringBBox(ring)
      bbox = [Math.min(bbox[0], box[0]), Math.min(bbox[1], box[1]), Math.max(bbox[2], box[2]), Math.max(bbox[3], box[3])]
    }
    contours.push({ minutes: value, polygons, bbox })
  }
  contours.sort((a, b) => a.minutes - b.minutes)
  if (contours.length === 0) throw new Error("Mapbox did not return a drive-time area for that place")
  return contours
}

export async function fetchDriveMinutes(
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number,
  depart: string,
): Promise<number | null> {
  const token = mapboxToken()
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${fromLon},${fromLat};${toLon},${toLat}` +
    `?overview=false&depart_at=${encodeURIComponent(depart)}&access_token=${token}`
  try {
    const json = (await getJson(url)) as { routes?: Array<{ duration?: number }> }
    const duration = json.routes?.[0]?.duration
    return typeof duration === "number" && duration > 0 ? duration / 60 : null
  } catch {
    return null
  }
}

async function getJson(url: string): Promise<unknown> {
  let last = "Mapbox did not respond"
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) })
    if (response.status === 429 || response.status >= 500) {
      last = `Mapbox returned ${response.status}`
      continue
    }
    const json = (await response.json()) as { message?: string }
    if (!response.ok) throw new Error(json.message || `Mapbox returned ${response.status}`)
    return json
  }
  throw new Error(last)
}

function normalizePolygons(type: string | undefined, coordinates: number[][][] | number[][][][]): number[][][][] {
  if (type === "Polygon") return [coordinates as number[][][]]
  if (type === "MultiPolygon") return coordinates as number[][][][]
  return []
}
