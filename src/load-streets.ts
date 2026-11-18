export type StreetCollection = {
  type: "FeatureCollection"
  features: Array<{
    type: "Feature"
    id: number
    properties: { t: number; band: number }
    geometry: { type: "MultiLineString"; coordinates: number[][][] }
  }>
}

export async function loadStreetMesh(): Promise<StreetCollection> {
  const response = await fetch("/data/streets.bin")
  if (!response.ok) throw new Error(`Could not load streets (${response.status})`)
  return decodeStreets(await response.arrayBuffer())
}

function decodeStreets(buffer: ArrayBuffer): StreetCollection {
  const view = new DataView(buffer)
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
  if (magic !== "KRD1" || view.getUint8(4) !== 1) throw new Error("Unexpected street data")
  const originLon = view.getFloat32(5, true)
  const originLat = view.getFloat32(9, true)
  const spanLon = view.getFloat32(13, true)
  const spanLat = view.getFloat32(17, true)
  const lineCount = view.getUint32(21, true)
  const groups = new Map<number, { band: number; lines: number[][][] }>()
  let offset = 25
  for (let line = 0; line < lineCount; line++) {
    const seconds = view.getUint16(offset, true)
    const band = view.getUint8(offset + 2)
    const count = view.getUint8(offset + 3)
    offset += 4
    const coordinates: number[][] = new Array(count)
    for (let point = 0; point < count; point++) {
      const x = view.getUint16(offset, true)
      const y = view.getUint16(offset + 2, true)
      offset += 4
      coordinates[point] = [
        originLon + (x / 65535) * spanLon,
        originLat + (y / 65535) * spanLat,
      ]
    }
    if (count < 2) continue
    const group = groups.get(seconds)
    if (group) group.lines.push(coordinates)
    else groups.set(seconds, { band, lines: [coordinates] })
  }
  const features = [...groups.keys()]
    .sort((a, b) => a - b)
    .map((seconds) => {
      const group = groups.get(seconds)
      return {
        type: "Feature" as const,
        id: seconds,
        properties: { t: seconds, band: group?.band ?? 1 },
        geometry: { type: "MultiLineString" as const, coordinates: group?.lines ?? [] },
      }
    })
  return { type: "FeatureCollection", features }
}
