/**
 * Turn Zillow search dumps into one listings file per area (src/areas.ts).
 *
 *   npx tsx scripts/build-listings.ts raw/*.json -o public/data/listings.json
 *
 * Each input file is `{ total, pages, filterState, results: [...] }` or a bare array.
 * Every home is timed from every area and kept in each area's file when it is within
 * LISTING_DRIVE_MAX_MIN of that area. -o names the Kendall file (default
 * public/data/listings.json); the other areas are written beside it as
 * listings-needham.json and listings-wellesley.json. Pass --area <id> (repeatable)
 * to build only some areas. A summary goes to stderr.
 * firstSeen is copied from each existing output file, which is read before it is replaced.
 * Do not shell-redirect stdout onto that same file: the shell empties it first.
 * Pass --stdout to write one area's JSON to stdout instead (Kendall unless --area
 * names another), and --previous to name the file that holds its firstSeen.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { AREAS, DEFAULT_AREA, areaById, type Area } from "../src/areas.ts"
import { LISTING_DRIVE_MAX_MIN, MIN_BEDS, RENT_MAX, RENT_TYPES, SALE_MAX, SALE_TYPES } from "../src/criteria.ts"
import { loadGraph, nearestNode, routeTimes, snapToRoad } from "../src/reach/graph.ts"
import type { Model } from "../src/reach/model.ts"

const SEARCH_LIMIT_MIN = 45
const NODE_LIMIT_M = 400

const DROP_REASONS = [
  "invalid",
  "no-coordinates",
  "type",
  "price",
  "beds",
  "drive",
  "unroutable",
  "duplicate",
] as const

type DropReason = (typeof DROP_REASONS)[number]
type Kind = "sale" | "rent"

type Unit = { price?: unknown; beds?: unknown }

type RawResult = {
  zpid?: unknown
  url?: unknown
  address?: unknown
  lat?: unknown
  lng?: unknown
  price?: unknown
  beds?: unknown
  baths?: unknown
  sqft?: unknown
  status?: unknown
  type?: unknown
  img?: unknown
  broker?: unknown
  units?: unknown
}

type Offer = { price: number; beds: number }

export type ListingRecord = {
  id: string
  source: "zillow"
  kind: Kind
  price: number
  beds: number
  baths: number | null
  sqft: number | null
  type: string
  address: string
  lat: number
  lng: number
  url: string
  img: string
  broker: string
  driveMin: number
  firstSeen: string
  lastSeen: string
}

type Args = {
  files: string[]
  out: string
  previous: string | null
  stdout: boolean
  areas: Area[]
}

type AreaRun = {
  area: Area
  out: string
  previous: Map<string, string>
  times: Float64Array | number[]
  kept: ListingRecord[]
  drive: number
  unroutable: number
  modelNote: string
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.files.length === 0) usage(1)
  const now = new Date().toISOString()
  const graph = loadGraph()
  const runs: AreaRun[] = args.areas.map((area) => {
    const out = area.id === DEFAULT_AREA.id ? args.out : join(dirname(args.out), area.listingsFile)
    const snap = snapToRoad(graph, area.lon, area.lat, 200)
    if (!snap) throw new Error(`Could not snap ${area.name} onto the road graph`)
    const { model, note } = readModel(area)
    return {
      area,
      out,
      previous: readPrevious(args.stdout && args.previous ? args.previous : out),
      times: routeTimes(graph, snap, model, SEARCH_LIMIT_MIN * 60),
      kept: [],
      drive: 0,
      unroutable: 0,
      modelNote: note,
    }
  })
  const counts = Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as Record<DropReason, number>
  let input = 0
  const seenIds = new Set<string>()

  for (const file of args.files) {
    for (const result of readResults(file)) {
      input += 1
      const earlyId = idOf(result)
      if (earlyId && seenIds.has(earlyId)) {
        counts.duplicate += 1
        continue
      }
      const outcome = evaluate(result)
      if (typeof outcome === "string") {
        counts[outcome] += 1
        continue
      }
      seenIds.add(outcome.id)
      const node = nearestNode(graph, outcome.lng, outcome.lat, NODE_LIMIT_M)
      let keptAnywhere = false
      let routable = false
      for (const run of runs) {
        const seconds = node == null ? Number.POSITIVE_INFINITY : (run.times[node] ?? Number.POSITIVE_INFINITY)
        if (!Number.isFinite(seconds)) {
          run.unroutable += 1
          continue
        }
        routable = true
        const minutes = seconds / 60
        if (minutes > LISTING_DRIVE_MAX_MIN) {
          run.drive += 1
          continue
        }
        keptAnywhere = true
        run.kept.push({
          ...outcome,
          driveMin: Math.round(minutes * 10) / 10,
          firstSeen: run.previous.get(outcome.id) ?? now,
          lastSeen: now,
        })
      }
      if (!routable) counts.unroutable += 1
      else if (!keptAnywhere) counts.drive += 1
    }
  }

  const lines = [`in ${input}`]
  for (const reason of DROP_REASONS) {
    const scope = reason === "drive" || reason === "unroutable" ? " (kept by no area)" : ""
    lines.push(`dropped ${reason} ${counts[reason]}${scope}`)
  }
  for (const run of runs) {
    run.kept.sort((a, b) => a.driveMin - b.driveMin || a.id.localeCompare(b.id))
    const json = `${JSON.stringify({ generatedAt: now, listings: run.kept }, null, 2)}\n`
    if (args.stdout) process.stdout.write(json)
    else writeFileSync(run.out, json)
    lines.push(
      `${run.area.id}: kept ${run.kept.length}, over ${LISTING_DRIVE_MAX_MIN} min ${run.drive}, unroutable ${run.unroutable}` +
        (args.stdout ? "" : `, wrote ${run.out}`) +
        (run.modelNote ? ` (${run.modelNote})` : ""),
    )
  }
  if (args.stdout) {
    lines.push(`firstSeen read from ${args.previous ?? runs[0]?.out}`)
    lines.push("stdout was not written over that file; a shell redirect onto it would clear firstSeen first")
  }
  console.error(lines.join("\n"))
}

function evaluate(result: RawResult): Omit<ListingRecord, "driveMin" | "firstSeen" | "lastSeen"> | DropReason {
  const id = idOf(result)
  if (!id) return "invalid"
  const point = pointOf(result)
  if (!point) return "no-coordinates"
  const kind = kindOf(result)
  if (!kind) return "price"
  const type = text(result.type).toUpperCase()
  const allowed = kind === "sale" ? (SALE_TYPES as readonly string[]).includes(type) : (RENT_TYPES as readonly string[]).includes(type)
  if (!allowed) return "type"
  const offer = chooseOffer(result, kind)
  if (!offer) return missReason(result, kind)
  const sqft = positive(result.sqft)
  return {
    id,
    source: "zillow",
    kind,
    price: Math.round(offer.price),
    beds: offer.beds,
    baths: positive(result.baths),
    sqft: sqft == null ? null : Math.round(sqft),
    type,
    address: text(result.address),
    lat: point.lat,
    lng: point.lng,
    url: text(result.url),
    img: text(result.img),
    broker: text(result.broker),
  }
}

function chooseOffer(result: RawResult, kind: Kind): Offer | null {
  const offers = offersOf(result, kind).filter((offer) => offer.beds >= MIN_BEDS && offer.price <= cap(kind))
  offers.sort((a, b) => a.price - b.price || b.beds - a.beds)
  return offers[0] ?? null
}

function offersOf(result: RawResult, kind: Kind): Offer[] {
  const offers: Offer[] = []
  const price = parseMoney(result.price)
  const beds = bedsOf(result.beds)
  if (price != null && beds != null) offers.push({ price, beds })
  if (kind === "rent") {
    for (const unit of unitsOf(result)) {
      const unitPrice = parseMoney(unit.price)
      const unitBeds = bedsOf(unit.beds)
      if (unitPrice != null && unitBeds != null) offers.push({ price: unitPrice, beds: unitBeds })
    }
  }
  return offers
}

function missReason(result: RawResult, kind: Kind): "beds" | "price" {
  const offers = offersOf(result, kind)
  const roomy = offers.filter((offer) => offer.beds >= MIN_BEDS)
  if (roomy.length === 0) return "beds"
  return "price"
}

function kindOf(result: RawResult): Kind | null {
  const status = text(result.status)
  const texts = [status, text(result.price), ...unitsOf(result).map((unit) => text(unit.price))]
  if (texts.some((value) => /\/\s*mo\b/i.test(value)) || /\bfor rent\b/i.test(status)) return "rent"
  if (/\bfor sale\b/i.test(status) || parseMoney(result.price) != null) return "sale"
  return null
}

function unitsOf(result: RawResult): Unit[] {
  if (!Array.isArray(result.units)) return []
  return result.units.filter((unit): unit is Unit => Boolean(unit) && typeof unit === "object")
}

function idOf(result: RawResult): string | null {
  if (typeof result.zpid === "number" && Number.isFinite(result.zpid)) return String(Math.trunc(result.zpid))
  if (typeof result.zpid === "string" && result.zpid.trim()) return result.zpid.trim()
  return null
}

function pointOf(result: RawResult): { lat: number; lng: number } | null {
  if (typeof result.lat !== "number" || typeof result.lng !== "number") return null
  if (!Number.isFinite(result.lat) || !Number.isFinite(result.lng)) return null
  if (Math.abs(result.lat) > 90 || Math.abs(result.lng) > 180) return null
  return { lat: result.lat, lng: result.lng }
}

function parseMoney(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw
  if (typeof raw !== "string") return null
  const match = raw.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/)
  if (!match?.[1]) return null
  const amount = Number(match[1])
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

function bedsOf(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  return raw
}

function positive(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null
  return raw
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : ""
}

function cap(kind: Kind): number {
  return kind === "sale" ? SALE_MAX : RENT_MAX
}

function readResults(file: string): RawResult[] {
  const path = resolve(file)
  if (!existsSync(path)) throw new Error(`Listing input not found: ${path}`)
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (Array.isArray(parsed)) return parsed.filter(isObject)
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown }).results)) {
    return (parsed as { results: unknown[] }).results.filter(isObject)
  }
  throw new Error(`${path} is not a Zillow search payload or a results array`)
}

function isObject(value: unknown): value is RawResult {
  return Boolean(value) && typeof value === "object"
}

function readPrevious(path: string): Map<string, string> {
  const seen = new Map<string, string>()
  if (!existsSync(path)) return seen
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    console.error(`ignored unreadable previous listings at ${path}`)
    return seen
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { listings?: unknown }).listings)
      ? (parsed as { listings: unknown[] }).listings
      : null
  if (!rows) return seen
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const id = (row as { id?: unknown }).id
    const firstSeen = (row as { firstSeen?: unknown }).firstSeen
    if (typeof id !== "string" || typeof firstSeen !== "string") continue
    if (!Number.isFinite(Date.parse(firstSeen))) continue
    seen.set(id, firstSeen)
  }
  return seen
}

/**
 * The fitted model for an area, from its method file. Until an area has been
 * baked (scripts/bake-default.ts <id>), the Kendall model stands in.
 */
function readModel(area: Area): { model: Model; note: string } {
  const own = resolve("public/data", area.methodFile)
  const path = existsSync(own) ? own : resolve("public/data", DEFAULT_AREA.methodFile)
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { model?: Partial<Model> }
  const model = parsed.model ?? {}
  return {
    model: {
      surface: modelNumber(model, "surface"),
      secondary: modelNumber(model, "secondary"),
      primary: modelNumber(model, "primary"),
      highway: modelNumber(model, "highway"),
      signal: modelNumber(model, "signal"),
    },
    note: path === own ? "" : `no ${area.methodFile} yet, used the Kendall model`,
  }
}

function modelNumber(model: Partial<Model>, key: keyof Model): number {
  const value = model[key]
  if (typeof value !== "number") throw new Error(`method file is missing model.${key}`)
  return value
}

function parseArgs(argv: string[]): Args {
  const files: string[] = []
  let out = resolve("public/data/listings.json")
  let previous: string | null = null
  let stdout = false
  const areas: Area[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    if (arg === "--stdout") {
      stdout = true
      continue
    }
    if (arg === "--out" || arg === "-o") {
      const next = argv[++i]
      if (!next) usage(1)
      out = resolve(next)
      continue
    }
    if (arg === "--previous") {
      const next = argv[++i]
      if (!next) usage(1)
      previous = resolve(next)
      continue
    }
    if (arg === "--area") {
      const area = areaById(argv[++i])
      if (!area) {
        console.error(`--area must be one of ${AREAS.map((item) => item.id).join(", ")}`)
        usage(1)
      }
      if (!areas.includes(area)) areas.push(area)
      continue
    }
    if (arg === "--help" || arg === "-h") usage(0)
    if (arg.startsWith("-")) {
      console.error(`Unknown option ${arg}`)
      usage(1)
    }
    files.push(arg)
  }
  if (stdout && areas.length > 1) {
    console.error("--stdout writes one area; pass a single --area")
    usage(1)
  }
  const chosen = areas.length > 0 ? areas : stdout ? [DEFAULT_AREA] : [...AREAS]
  return { files, out, previous, stdout, areas: chosen }
}

function usage(code: number): never {
  console.error(
    "usage: npx tsx scripts/build-listings.ts raw/*.json -o public/data/listings.json\n" +
      "       npx tsx scripts/build-listings.ts [--area kendall|needham|wellesley]... raw/*.json\n" +
      "       npx tsx scripts/build-listings.ts --stdout [--area <id>] [--previous public/data/listings.json] raw/*.json",
  )
  process.exit(code)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not build listings")
  process.exit(1)
}
