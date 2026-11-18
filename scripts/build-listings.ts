/**
 * Turn Zillow search dumps into public/data/listings.json.
 *
 *   npx tsx scripts/build-listings.ts raw/*.json -o public/data/listings.json
 *
 * Each input file is `{ total, pages, filterState, results: [...] }` or a bare array.
 * JSON is written to -o (default public/data/listings.json). A summary goes to stderr.
 * firstSeen is copied from the existing output file, which is read before it is replaced.
 * Do not shell-redirect stdout onto that same file: the shell empties it first.
 * Pass --stdout to write the JSON to stdout instead, and --previous to name the file
 * that holds firstSeen.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { loadGraph, nearestNode, routeTimes, snapToRoad } from "../src/reach/graph.ts"
import type { Model } from "../src/reach/model.ts"

const SALE_MAX = 1_500_000
const RENT_MAX = 9_000
const MIN_BEDS = 4
const DRIVE_LIMIT_MIN = 20
const SEARCH_LIMIT_MIN = 45
const NODE_LIMIT_M = 400
const RENT_TYPES = new Set(["SINGLE_FAMILY", "TOWNHOUSE", "MULTI_FAMILY"])

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
  previous: string
  stdout: boolean
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.files.length === 0) usage(1)
  const now = new Date().toISOString()
  const previous = readPrevious(args.previous)
  const school = readSchool()
  const model = readModel()
  const graph = loadGraph()
  const snap = snapToRoad(graph, school.lon, school.lat, 200)
  if (!snap) throw new Error("Could not snap The Kendall School onto the road graph")
  const times = routeTimes(graph, snap, model, SEARCH_LIMIT_MIN * 60)
  const counts = Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as Record<DropReason, number>
  let input = 0
  const kept: ListingRecord[] = []
  const keptIds = new Set<string>()

    for (const file of args.files) {
    for (const result of readResults(file)) {
      input += 1
      const earlyId = idOf(result)
      if (earlyId && keptIds.has(earlyId)) {
        counts.duplicate += 1
        continue
      }
      const outcome = evaluate(result)
      if (typeof outcome === "string") {
        counts[outcome] += 1
        continue
      }
      const node = nearestNode(graph, outcome.lng, outcome.lat, NODE_LIMIT_M)
      const seconds = node == null ? Number.POSITIVE_INFINITY : (times[node] ?? Number.POSITIVE_INFINITY)
      if (node == null || !Number.isFinite(seconds)) {
        counts.unroutable += 1
        continue
      }
      const minutes = seconds / 60
      if (minutes > DRIVE_LIMIT_MIN) {
        counts.drive += 1
        continue
      }
      keptIds.add(outcome.id)
      kept.push({
        ...outcome,
        driveMin: Math.round(minutes * 10) / 10,
        firstSeen: previous.get(outcome.id) ?? now,
        lastSeen: now,
      })
    }
  }

  kept.sort((a, b) => a.driveMin - b.driveMin || a.id.localeCompare(b.id))
  const json = `${JSON.stringify(kept, null, 2)}\n`
  if (args.stdout) process.stdout.write(json)
  else writeFileSync(args.out, json)

  const lines = [`in ${input}`, `kept ${kept.length}`]
  for (const reason of DROP_REASONS) lines.push(`dropped ${reason} ${counts[reason]}`)
  if (args.stdout) {
    lines.push(`firstSeen read from ${args.previous}`)
    lines.push("stdout was not written over that file; a shell redirect onto it would clear firstSeen first")
  } else {
    lines.push(`wrote ${args.out}`)
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
  const allowed = kind === "sale" ? type === "SINGLE_FAMILY" : RENT_TYPES.has(type)
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
  if (!Array.isArray(parsed)) return seen
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue
    const id = (row as { id?: unknown }).id
    const firstSeen = (row as { firstSeen?: unknown }).firstSeen
    if (typeof id !== "string" || typeof firstSeen !== "string") continue
    if (!Number.isFinite(Date.parse(firstSeen))) continue
    seen.set(id, firstSeen)
  }
  return seen
}

function readSchool(): { lat: number; lon: number } {
  const parsed = JSON.parse(readFileSync(resolve("public/data/meta.json"), "utf8")) as {
    school?: { lat?: unknown; lon?: unknown }
  }
  const lat = parsed.school?.lat
  const lon = parsed.school?.lon
  if (typeof lat !== "number" || typeof lon !== "number") {
    throw new Error("public/data/meta.json is missing the school coordinate")
  }
  return { lat, lon }
}

function readModel(): Model {
  const parsed = JSON.parse(readFileSync(resolve("public/data/method.json"), "utf8")) as { model?: Partial<Model> }
  const model = parsed.model ?? {}
  return {
    surface: modelNumber(model, "surface"),
    secondary: modelNumber(model, "secondary"),
    primary: modelNumber(model, "primary"),
    highway: modelNumber(model, "highway"),
    signal: modelNumber(model, "signal"),
  }
}

function modelNumber(model: Partial<Model>, key: keyof Model): number {
  const value = model[key]
  if (typeof value !== "number") throw new Error(`public/data/method.json is missing model.${key}`)
  return value
}

function parseArgs(argv: string[]): Args {
  const files: string[] = []
  let out = resolve("public/data/listings.json")
  let previous = out
  let previousSet = false
  let stdout = false
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
      if (!previousSet) previous = out
      continue
    }
    if (arg === "--previous") {
      const next = argv[++i]
      if (!next) usage(1)
      previous = resolve(next)
      previousSet = true
      continue
    }
    if (arg === "--help" || arg === "-h") usage(0)
    if (arg.startsWith("-")) {
      console.error(`Unknown option ${arg}`)
      usage(1)
    }
    files.push(arg)
  }
  return { files, out, previous, stdout }
}

function usage(code: number): never {
  console.error(
    "usage: npx tsx scripts/build-listings.ts raw/*.json -o public/data/listings.json\n" +
      "       npx tsx scripts/build-listings.ts [--stdout] [--previous public/data/listings.json] raw/*.json",
  )
  process.exit(code)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not build listings")
  process.exit(1)
}
