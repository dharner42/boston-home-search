export type ListingKind = "sale" | "rent"

/**
 * One row of public/data/listings.json, written by scripts/build-listings.ts.
 * driveMin is the Tuesday 8:00 drive from The Kendall School, not the map's current origin.
 */
export type Listing = {
  id: string
  source: "zillow"
  kind: ListingKind
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

/** `origin` names the area driveMin is measured from (the nearest one when areas are combined). */
export type ListingView = Listing & { isNew: boolean; origin?: string; originShort?: string }

export const LISTINGS_URL = "/data/listings.json"
const NEW_WINDOW_MS = 24 * 60 * 60 * 1000

export type LoadedListings = { listings: ListingView[]; updatedAt: string | null }

export async function loadListings(url = LISTINGS_URL): Promise<Listing[]> {
  const loaded = await loadListingViews(url)
  return loaded.listings
}

export async function loadListingViews(url = LISTINGS_URL, now = Date.now()): Promise<LoadedListings> {
  const res = await fetch(url)
  if (res.status === 404) return { listings: [], updatedAt: null }
  if (!res.ok) throw new Error(`Could not load listings (${res.status})`)
  const data: unknown = await res.json()
  const file = unwrapListings(data)
  const listings = file.rows
    .filter(isListing)
    .map(normalizeListing)
    .map((listing) => ({ ...listing, isNew: isNewListing(listing.firstSeen, now) }))
    .sort((a, b) => a.driveMin - b.driveMin || a.id.localeCompare(b.id))
  return { listings, updatedAt: file.generatedAt ?? newestLastSeen(listings) }
}

/**
 * Load several area files and keep each home once, with its shortest drive and
 * the area that drive is from. A file that fails to load is skipped.
 */
export async function loadMergedListings(
  sources: Array<{ url: string; origin: string; originShort: string }>,
  now = Date.now(),
): Promise<LoadedListings> {
  const loaded = await Promise.all(
    sources.map((source) =>
      loadListingViews(source.url, now)
        .then((file) => ({ file, source }))
        .catch(() => null),
    ),
  )
  const best = new Map<string, ListingView>()
  let updatedAt: string | null = null
  for (const item of loaded) {
    if (!item) continue
    const { file, source } = item
    if (file.updatedAt && (!updatedAt || Date.parse(file.updatedAt) > Date.parse(updatedAt))) updatedAt = file.updatedAt
    for (const listing of file.listings) {
      const current = best.get(listing.id)
      if (current && current.driveMin <= listing.driveMin) continue
      best.set(listing.id, { ...listing, origin: source.origin, originShort: source.originShort })
    }
  }
  const listings = [...best.values()].sort((a, b) => a.driveMin - b.driveMin || a.id.localeCompare(b.id))
  return { listings, updatedAt }
}

function unwrapListings(data: unknown): { rows: unknown[]; generatedAt: string | null } {
  if (Array.isArray(data)) return { rows: data, generatedAt: null }
  if (data && typeof data === "object" && Array.isArray((data as { listings?: unknown }).listings)) {
    const generatedAt = (data as { generatedAt?: unknown }).generatedAt
    return {
      rows: (data as { listings: unknown[] }).listings,
      generatedAt: typeof generatedAt === "string" && Number.isFinite(Date.parse(generatedAt)) ? generatedAt : null,
    }
  }
  return { rows: [], generatedAt: null }
}

function newestLastSeen(listings: Listing[]): string | null {
  let best = ""
  let bestTime = Number.NEGATIVE_INFINITY
  for (const listing of listings) {
    const time = Date.parse(listing.lastSeen)
    if (Number.isFinite(time) && time >= bestTime) {
      bestTime = time
      best = listing.lastSeen
    }
  }
  return best || null
}

export function isNewListing(firstSeen: string, now = Date.now()): boolean {
  const seen = Date.parse(firstSeen)
  if (!Number.isFinite(seen)) return false
  const age = now - seen
  return age <= NEW_WINDOW_MS && seen <= now + 5 * 60 * 1000
}

export function formatDrive(minutes: number): string {
  const rounded = Math.round(minutes * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${text} min`
}

export function formatPrice(listing: Pick<Listing, "kind" | "price">): string {
  const amount = Math.round(listing.price).toLocaleString("en-US")
  return listing.kind === "rent" ? `$${amount}/mo` : `$${amount}`
}

export function formatFacts(listing: Pick<Listing, "beds" | "baths" | "sqft">): string {
  const parts = [`${formatCount(listing.beds)} bd`]
  if (listing.baths != null) parts.push(`${formatCount(listing.baths)} ba`)
  if (listing.sqft != null) parts.push(`${Math.round(listing.sqft).toLocaleString("en-US")} sqft`)
  return parts.join(" · ")
}

export type ListingFeature = {
  type: "Feature"
  geometry: { type: "Point"; coordinates: [number, number] }
  properties: {
    id: string
    kind: ListingKind
    driveMin: number
    driveLabel: string
    isNew: boolean
  }
}

export type ListingFeatureCollection = {
  type: "FeatureCollection"
  features: ListingFeature[]
}

export function listingsToGeoJSON(listings: ListingView[]): ListingFeatureCollection {
  return {
    type: "FeatureCollection",
    features: listings.map((listing) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [listing.lng, listing.lat] },
      properties: {
        id: listing.id,
        kind: listing.kind,
        driveMin: listing.driveMin,
        driveLabel: formatDrive(listing.driveMin),
        isNew: listing.isNew,
      },
    })),
  }
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
}

function isListing(value: unknown): value is Listing {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<Listing>
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    row.source === "zillow" &&
    (row.kind === "sale" || row.kind === "rent") &&
    typeof row.price === "number" &&
    Number.isFinite(row.price) &&
    typeof row.beds === "number" &&
    Number.isFinite(row.beds) &&
    typeof row.lat === "number" &&
    Number.isFinite(row.lat) &&
    typeof row.lng === "number" &&
    Number.isFinite(row.lng) &&
    typeof row.driveMin === "number" &&
    Number.isFinite(row.driveMin) &&
    typeof row.firstSeen === "string"
  )
}

function normalizeListing(row: Listing): Listing {
  return {
    id: row.id,
    source: "zillow",
    kind: row.kind,
    price: row.price,
    beds: row.beds,
    baths: typeof row.baths === "number" && Number.isFinite(row.baths) ? row.baths : null,
    sqft: typeof row.sqft === "number" && Number.isFinite(row.sqft) ? row.sqft : null,
    type: typeof row.type === "string" ? row.type : "",
    address: typeof row.address === "string" ? row.address : "",
    lat: row.lat,
    lng: row.lng,
    url: typeof row.url === "string" ? row.url : "",
    img: typeof row.img === "string" ? row.img : "",
    broker: typeof row.broker === "string" ? row.broker : "",
    driveMin: row.driveMin,
    firstSeen: row.firstSeen,
    lastSeen: typeof row.lastSeen === "string" ? row.lastSeen : row.firstSeen,
  }
}
