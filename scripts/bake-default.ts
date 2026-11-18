/**
 * Bake an area's 15-minute Tuesday 8:00 drive so its first view skips Mapbox.
 *
 *   node --experimental-strip-types scripts/bake-default.ts            # kendall
 *   node --experimental-strip-types scripts/bake-default.ts needham
 *
 * Kendall writes reach.bin, comparison.json, travel-grid.json, meta.json and
 * method.json. Other areas write reach-<id>.bin and method-<id>.json.
 */
import { readFileSync, writeFileSync } from "node:fs"

import { AREAS, DEFAULT_MINUTES, areaById } from "../src/areas.ts"
import { decodeReach } from "../src/reach/codec.ts"
import { computeReach } from "../src/reach/compute.ts"
import { loadGraph, nearestNode, routeTimes, snapToRoad } from "../src/reach/graph.ts"
import { fetchDriveMinutes } from "../src/reach/mapbox.ts"
import { nextTuesdayMorning } from "../src/reach/tuesday.ts"

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
const token = env.match(/VITE_MAPBOX_TOKEN=(.+)/)?.[1]?.trim()
if (!token) throw new Error("missing token")
process.env.VITE_MAPBOX_TOKEN = token

const area = areaById(process.argv[2] ?? "kendall")
if (!area) throw new Error(`area must be one of ${AREAS.map((item) => item.id).join(", ")}`)
const isKendall = area.id === "kendall"
const SCHOOL = { lon: area.lon, lat: area.lat, label: area.name, minutes: DEFAULT_MINUTES }
const depart = nextTuesdayMorning()

type Check = { name: string; lon: number; lat: number; freeFlow: number | null }
const checks: Record<string, Check[]> = {
  kendall: [
    { name: "Harvard Square", lon: -71.1189431, lat: 42.3734734, freeFlow: 6.5 },
    { name: "Arlington Center", lon: -71.1485439, lat: 42.4124649, freeFlow: 7.1 },
    { name: "Waltham Common", lon: -71.235709, lat: 42.3753543, freeFlow: 6.4 },
    { name: "Lexington Center", lon: -71.2307236, lat: 42.4493035, freeFlow: 13.1 },
    { name: "Boston Common", lon: -71.066071, lat: 42.35504, freeFlow: 13.4 },
    { name: "Cambridge Kendall Square", lon: -71.08515, lat: 42.3629, freeFlow: null },
  ],
  needham: [
    { name: "Wellesley Square", lon: -71.2925, lat: 42.2966, freeFlow: null },
    { name: "Newton Centre", lon: -71.1925, lat: 42.3295, freeFlow: null },
    { name: "Dedham Square", lon: -71.1765, lat: 42.2492, freeFlow: null },
    { name: "Westwood Center", lon: -71.2245, lat: 42.2140, freeFlow: null },
    { name: "Natick Center", lon: -71.3489, lat: 42.2834, freeFlow: null },
  ],
  wellesley: [
    { name: "Needham Center", lon: -71.2365, lat: 42.2811, freeFlow: null },
    { name: "Natick Center", lon: -71.3489, lat: 42.2834, freeFlow: null },
    { name: "Newton Lower Falls", lon: -71.2563, lat: 42.3270, freeFlow: null },
    { name: "Framingham Center", lon: -71.4162, lat: 42.2973, freeFlow: null },
    { name: "Dover Center", lon: -71.2830, lat: 42.2459, freeFlow: null },
  ],
}
const places = checks[area.id] ?? []

const graph = loadGraph()
const snap = snapToRoad(graph, SCHOOL.lon, SCHOOL.lat, 130)
if (!snap) throw new Error(`could not snap ${area.name}`)
const free = routeTimes(graph, snap, { surface: 1, secondary: 1, primary: 1, highway: 1, signal: 0 }, 20 * 60)
for (const place of places) {
  if (place.freeFlow != null) continue
  const node = nearestNode(graph, place.lon, place.lat, 400)
  place.freeFlow = node == null || !Number.isFinite(free[node] ?? Infinity) ? null : Math.round(((free[node] ?? 0) / 60) * 10) / 10
}

const result = await computeReach(
  { ...SCHOOL, depart },
  { samples: places.map(({ name, lon, lat }) => ({ name, lon, lat })) },
)
const reach = decodeReach(result.body.buffer.slice(result.body.byteOffset, result.body.byteOffset + result.body.byteLength))
const rows = []
for (const place of places) {
  const model = result.samples.find((sample) => sample.name === place.name)?.modelMinutes ?? null
  const mapbox = await fetchDriveMinutes(SCHOOL.lon, SCHOOL.lat, place.lon, place.lat, depart)
  rows.push({
    place: place.name,
    freeFlowMinutes: place.freeFlow,
    mapboxTuesday8amMinutes: mapbox == null ? null : Math.round(mapbox * 10) / 10,
    thisMapMinutes: model,
  })
  console.log(place.name, "free", place.freeFlow, "mapbox", mapbox?.toFixed(1), "model", model)
}

writeFileSync(new URL(`../public/data/${area.reachFile}`, import.meta.url), result.body)
const grid = reach.grid
// The comparison table, listings grid and meta file describe Kendall only.
if (isKendall) {
writeFileSync(
  new URL("../public/data/comparison.json", import.meta.url),
  JSON.stringify(
    {
      departAt: depart,
      origin: "The Kendall School, 577 Belmont Street, Belmont, MA",
      profile: "mapbox/driving-traffic",
      model: result.model,
      maeMinutes: Math.round(result.mae * 10) / 10,
      rows,
    },
    null,
    2,
  ) + "\n",
)

const bytes = Buffer.alloc(grid.values.byteLength)
const view = new DataView(bytes.buffer)
for (let i = 0; i < grid.values.length; i++) view.setUint16(i * 2, grid.values[i] ?? 0, true)
const gridJson = {
  version: 2,
  maxMinutes: grid.maxMinutes,
  nullValue: grid.nullValue,
  scale: grid.scale,
  originLon: grid.originLon,
  originLat: grid.originLat,
  cellLon: grid.cellLon,
  cellLat: grid.cellLat,
  cols: grid.cols,
  rows: grid.rows,
  searchMeters: grid.searchMeters,
  values: bytes.toString("base64"),
}
writeFileSync(new URL("../public/data/travel-grid.json", import.meta.url), JSON.stringify(gridJson))
writeFileSync(
  new URL("../public/data/meta.json", import.meta.url),
  JSON.stringify(
    {
      school: {
        name: "The Kendall School",
        shortName: "Kendall School",
        address: "577 Belmont Street, Belmont, MA",
        street: "577 Belmont Street",
        lat: SCHOOL.lat,
        lon: SCHOOL.lon,
        osmType: "way",
        osmId: 29580670,
      },
      bands: reach.header.bands,
      bounds: {
        "5": reach.header.bounds.b1,
        "10": reach.header.bounds.b2,
        "15": reach.header.bounds.b3,
      },
      departAt: depart,
      note: reach.header.note,
    },
    null,
    2,
  ) + "\n",
)
}
writeFileSync(
  new URL(`../public/data/${area.methodFile}`, import.meta.url),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      origin: area.origin,
      summary:
        "Street times are free-flow OpenStreetMap lengths scaled separately for highways, primary roads, secondary roads, and local streets, plus a signal delay at surface intersections. Parameters are fit to Mapbox driving-traffic for a Tuesday 8:00 departure, then bracketed by the traffic isochrone.",
      departAt: depart,
      model: result.model,
      maeMinutes: Math.round(result.mae * 10) / 10,
      lines: reach.lines.length,
      checks: rows,
    },
    null,
    2,
  ) + "\n",
)
console.log("lines", reach.lines.length, "grid", grid.cols, "x", grid.rows, "bytes", result.body.byteLength)
