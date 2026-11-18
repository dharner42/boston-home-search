export type BBox = [number, number, number, number]

export type Band = {
  band: 1 | 2 | 3
  label: string
  minSec: number
  maxSec: number
  color: string
  core: string
}

export type School = {
  name: string
  shortName: string
  address: string
  street: string
  lat: number
  lon: number
  osmType: string
  osmId: number
}

export type Meta = {
  school: School
  bands: Band[]
  unlit: { band: 4; label: string; minSec: number; maxSec: number }
  /** [west, south, east, north], cumulative through that minute. */
  bounds: {
    "5": BBox
    "10": BBox
    "15": BBox
    "20": BBox
  }
  note: string
}

export type StreetFeature = {
  type: "Feature"
  properties: { t: number; band: number }
  geometry: { type: "MultiLineString"; coordinates: number[][][] }
}

export type Streets = {
  type: "FeatureCollection"
  features: StreetFeature[]
}

export type Camera = {
  lng: number
  lat: number
  zoom: number
  pitch: number
  bearing: number
}
