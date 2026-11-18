export type Place = {
  label: string
  lon: number
  lat: number
}

type GeocodeFeature = {
  place_name?: string
  center?: [number, number]
}

export function mapboxPublicToken(): string {
  return import.meta.env.VITE_MAPBOX_TOKEN ?? ""
}

export async function suggestPlaces(query: string, signal: AbortSignal): Promise<Place[]> {
  const token = mapboxPublicToken()
  const text = query.trim()
  if (!token || text.length < 3) return []
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(text)}.json` +
    `?autocomplete=true&limit=5&country=us&proximity=-71.06,42.36` +
    `&types=address,poi,place,locality,neighborhood&access_token=${token}`
  const response = await fetch(url, { signal })
  if (!response.ok) return []
  const json = (await response.json()) as { features?: GeocodeFeature[] }
  const places: Place[] = []
  for (const feature of json.features ?? []) {
    const center = feature.center
    if (!center || !feature.place_name) continue
    places.push({
      label: feature.place_name.replace(/, United States$/, ""),
      lon: center[0],
      lat: center[1],
    })
  }
  return places
}

export async function geocodePlace(query: string): Promise<Place | null> {
  const places = await suggestPlaces(query, AbortSignal.timeout(8000))
  return places[0] ?? null
}
