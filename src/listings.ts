import { loadTravelGrid, travelMinutes, type TravelGrid } from "./travel-time.ts"

export type ListingType = "rent" | "sale"

/**
 * One row of public/data/listings.json.
 * A scheduled job can overwrite that file; this module does not care how it got there.
 */
export type Listing = {
  id: string
  type: ListingType
  /** Monthly rent, or sale price, in dollars. */
  price: number
  lon: number
  lat: number
  address?: string
  isNew?: boolean
  url?: string
  beds?: number
  baths?: number
}

export type AnnotatedListing = Listing & {
  /** Minutes from the active origin, or null outside the timed grid. */
  driveMinutes: number | null
}

export const LISTINGS_URL = "/data/listings.json"

export async function loadListings(url = LISTINGS_URL): Promise<Listing[]> {
  const res = await fetch(url)
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Could not load listings (${res.status})`)
  const data: unknown = await res.json()
  if (!Array.isArray(data)) return []
  return data.filter(isListing)
}

export function annotateListings(listings: Listing[], grid: TravelGrid): AnnotatedListing[] {
  return listings.map((listing) => ({
    ...listing,
    driveMinutes: travelMinutes(grid, listing.lon, listing.lat),
  }))
}

export function formatDrive(minutes: number | null, maxMinutes = 20): string {
  if (minutes == null || minutes > maxMinutes + 0.05) return `${maxMinutes}+ min`
  const rounded = minutes < 10 ? Math.round(minutes * 10) / 10 : Math.round(minutes)
  return `${rounded} min`
}

export function formatPrice(listing: Pick<Listing, "type" | "price">): string {
  const amount = Math.round(listing.price).toLocaleString("en-US")
  return listing.type === "rent" ? `$${amount}/mo` : `$${amount}`
}

export type ListingFeature = {
  type: "Feature"
  geometry: { type: "Point"; coordinates: [number, number] }
  properties: {
    id: string
    type: ListingType
    price: number
    priceLabel: string
    driveMinutes: number | null
    driveLabel: string
    isNew: boolean
    address: string
    url: string
  }
}

export type ListingFeatureCollection = {
  type: "FeatureCollection"
  features: ListingFeature[]
}

export function listingsToGeoJSON(listings: AnnotatedListing[], maxMinutes = 20): ListingFeatureCollection {
  return {
    type: "FeatureCollection",
    features: listings.map((listing) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [listing.lon, listing.lat] },
      properties: {
        id: listing.id,
        type: listing.type,
        price: listing.price,
        priceLabel: formatPrice(listing),
        driveMinutes: listing.driveMinutes,
        driveLabel: formatDrive(listing.driveMinutes, maxMinutes),
        isNew: Boolean(listing.isNew),
        address: listing.address ?? "",
        url: listing.url ?? "",
      },
    })),
  }
}

/**
 * Load listings.json (404 → empty), join each pin to the active drive grid,
 * and return GeoJSON ready for a MapLibre pin layer.
 *
 * Pass the grid for the current origin. Without one, the baked Kendall grid is used.
 */
export async function prepareListingPins(
  grid?: TravelGrid,
  listingsUrl = LISTINGS_URL,
): Promise<ListingFeatureCollection> {
  const [listings, drive] = await Promise.all([loadListings(listingsUrl), grid ? Promise.resolve(grid) : loadTravelGrid()])
  return listingsToGeoJSON(annotateListings(listings, drive), drive.maxMinutes)
}

function isListing(value: unknown): value is Listing {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<Listing>
  return (
    typeof row.id === "string" &&
    (row.type === "rent" || row.type === "sale") &&
    typeof row.price === "number" &&
    Number.isFinite(row.price) &&
    typeof row.lon === "number" &&
    typeof row.lat === "number"
  )
}
