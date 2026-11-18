/** Thresholds shared by the listings build and the on-map criteria sheet. */

export const SALE_MAX = 1_500_000
export const RENT_MAX = 9_000
export const MIN_BEDS = 4
export const LISTING_DRIVE_MAX_MIN = 20
export const SALE_TYPES = ["SINGLE_FAMILY"] as const
export const RENT_TYPES = ["SINGLE_FAMILY", "TOWNHOUSE", "MULTI_FAMILY"] as const
export const DEFAULT_ORIGIN = "The Kendall School, Belmont"

export type ListingFilterName = "sale" | "rent" | "both"

export function streetBandCuts(duration: number): [number, number, number] {
  const first = Math.max(1, Math.round(duration / 3))
  const second = Math.max(first + 1, Math.min(duration - 1, Math.round((2 * duration) / 3)))
  return [first, second, duration]
}

export function criteriaLines(input: {
  origin: string
  streetMinutes: number
  filter: ListingFilterName
  updatedAt: string | null
}): string[] {
  const [first, second, outer] = streetBandCuts(input.streetMinutes)
  const showing =
    input.filter === "sale"
      ? "Right now the list is for sale only."
      : input.filter === "rent"
        ? "Right now the list is for rent only."
        : "Right now the list shows for sale and for rent."
  return [
    `Drive times are measured from ${input.origin} and use weekday morning rush-hour traffic (Tuesday at 8:00 AM).`,
    `The street colors show ${first}/${second}/${outer}-minute bands, and listings are shown out to a ${LISTING_DRIVE_MAX_MIN}-minute drive.`,
    `For sale: ${saleCap()} or less, ${MIN_BEDS}+ bedrooms, single-family only.`,
    `For rent: ${rentCap()} or less, ${MIN_BEDS}+ bedrooms, single-family, townhouse, or multi-family unit.`,
    "Source: Zillow, refreshed around 6 AM, 1 PM, and 7 PM ET.",
    formatUpdated(input.updatedAt),
    showing,
    "A yard is wanted, but homes are not filtered by yard.",
  ]
}

export function originPhrase(label: string): string {
  const trimmed = label.trim()
  if (trimmed === "Kendall School" || trimmed.startsWith("The Kendall School")) return DEFAULT_ORIGIN
  return trimmed || DEFAULT_ORIGIN
}

function saleCap(): string {
  const millions = SALE_MAX / 1_000_000
  return `$${Number.isInteger(millions) ? millions : millions}M`
}

function rentCap(): string {
  return `$${RENT_MAX.toLocaleString("en-US")}/mo`
}

function formatUpdated(iso: string | null): string {
  if (!iso) return "Last updated time is not in this file yet."
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "Last updated time is not in this file yet."
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)
  return `Last updated ${formatted} ET.`
}
