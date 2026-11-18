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

export type ListingView = Listing & { isNew: boolean }

export const LISTINGS_URL = "/data/listings.json"
const NEW_WINDOW_MS = 24 * 60 * 60 * 1000

export async function loadListings(url = LISTINGS_URL): Promise<Listing[]> {
  const res = await fetch(url)
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Could not load listings (${res.status})`)
  const data: unknown = await res.json()
  if (!Array.isArray(data)) return []
  return data.filter(isListing).map(normalizeListing)
}

export async function loadListingViews(url = LISTINGS_URL, now = Date.now()): Promise<ListingView[]> {
  const listings = await loadListings(url)
  return listings
    .map((listing) => ({ ...listing, isNew: isNewListing(listing.firstSeen, now) }))
    .sort((a, b) => a.driveMin - b.driveMin || a.id.localeCompare(b.id))
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
