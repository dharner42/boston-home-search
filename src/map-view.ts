import maplibregl from "maplibre-gl"
import { createFuseLayer } from "./fuse-layer.ts"
import type { ListingFeatureCollection } from "./listings.ts"
import type { ReachLine } from "./reach/codec.ts"
import type { ReachBand } from "./reach/model.ts"
import type { BBox, Camera } from "./types.ts"

const FALLBACK_STYLES = [
  "https://tiles.openfreemap.org/styles/dark",
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
]

const HOLD_WIDE_MS = 700
const FLY_MS = 2800
const HOLD_CLOSE_MS = 620

export type FrameName = "start" | "mid" | "end"

export type MapUi = {
  label: "Skip" | "Replay"
  state: "playing" | "ready" | "posed"
}

export type ReachView = {
  label: string
  detail: string
  lon: number
  lat: number
  minutes: number
  note: string
  bands: ReachBand[]
  bounds: { b1: BBox; b2: BBox; b3: BBox }
  lines: ReachLine[]
}

export type ListingKindFilter = "sale" | "rent" | "both"

export type MapHandle = {
  play: () => void
  skip: () => void
  replay: () => void
  pose: (frame: FrameName) => void
  show: (view: ReachView) => void
  setListings: (data: ListingFeatureCollection) => void
  setListingFilter: (filter: ListingKindFilter) => void
  focusListing: (lng: number, lat: number) => void
  onListingClick: ((id: string) => void) | null
  onListingsVisible: ((visible: boolean) => void) | null
}

type Frames = { wide: Camera; close: Camera; k1: Camera; k2: Camera; k3: Camera }

export async function mountMap(container: HTMLElement, onUi: (ui: MapUi) => void): Promise<MapHandle> {
  const compact = window.matchMedia("(max-width: 760px), (max-height: 520px)").matches
  const map = new maplibregl.Map({
    container,
    style: await loadStyle(),
    center: [-71.1764, 42.3798],
    zoom: compact ? 9.2 : 9.6,
    minZoom: 3,
    maxZoom: 18,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    fadeDuration: 0,
    validateStyle: false,
  })
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right")
  const markerEl = buildMarker("Kendall School", "577 Belmont Street")
  const marker = new maplibregl.Marker({ element: markerEl, anchor: "center" }).setLngLat([-71.1764, 42.3798]).addTo(map)
  await Promise.race([
    once(map, "load"),
    wait(25000).then(() => Promise.reject(new Error("The basemap took too long"))),
  ])
  const fuse = createFuseLayer(map)
  const before = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id
  map.addLayer(fuse, before)

  let view: ReachView | null = null
  let frames: Frames | null = null
  let latest: Camera = { lng: -71.1, lat: 42.37, zoom: 9.4, pitch: 0, bearing: 0 }
  let token = 0
  let raf = 0
  let gestures: AbortController | null = null
  let listingCount = 0
  let listingsSettled = false
  let listingFilter: ListingKindFilter = "both"
  let listingClicksBound = false
  const listingLayerIds = ["listings", "listing-labels"]

  const clock = (seconds: number) => {
    if (!view) return
    const b1 = view.bands[1]?.minSec ?? 300
    const b2 = view.bands[2]?.minSec ?? 600
    fuse.setClock(seconds, b1, b2)
    paintLegend(seconds)
    map.triggerRepaint()
  }

  const apply = (camera: Camera, seconds: number, markerOn: boolean) => {
    const moved = !sameCamera(latest, camera)
    latest = camera
    if (moved) {
      map.jumpTo({ center: [camera.lng, camera.lat], zoom: camera.zoom, pitch: camera.pitch, bearing: camera.bearing })
    }
    clock(seconds)
    markerEl.classList.toggle("is-on", markerOn)
  }

  const setInteractive = (on: boolean) => {
    const handlers = [map.dragPan, map.scrollZoom, map.boxZoom, map.doubleClickZoom, map.keyboard, map.touchZoomRotate]
    for (const handler of handlers) {
      if (on) handler.enable()
      else handler.disable()
    }
    map.dragRotate.disable()
    map.touchPitch.disable()
    if (on) map.touchZoomRotate.disableRotation()
  }

  const paintListingVisibility = () => {
    const visible = listingsSettled && listingCount > 0
    for (const id of listingLayerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none")
    }
    api.onListingsVisible?.(visible)
  }

  const hideListings = () => {
    listingsSettled = false
    paintListingVisibility()
  }

  const revealListings = () => {
    listingsSettled = true
    paintListingVisibility()
  }

  const listingFilterSpec = (): maplibregl.FilterSpecification =>
    listingFilter === "both" ? ["has", "kind"] : ["==", ["get", "kind"], listingFilter]

  const applyListingFilter = () => {
    const filter = listingFilterSpec()
    for (const id of listingLayerIds) {
      if (map.getLayer(id)) map.setFilter(id, filter)
    }
  }

  const finish = () => {
    gestures?.abort()
    gestures = null
    if (view && frames) apply(frames.k3, view.minutes * 60, true)
    setInteractive(true)
    revealListings()
    onUi({ label: "Replay", state: "ready" })
  }

  const listen = (my: number) => {
    gestures?.abort()
    gestures = new AbortController()
    const stop = (event: Event) => {
      if (my !== token) return
      if (event.target instanceof Element && event.target.closest("#action, .brand, .legend, .status")) return
      token += 1
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      gestures?.abort()
      if (view) clock(view.minutes * 60)
      markerEl.classList.add("is-on")
      setInteractive(true)
      onUi({ label: "Replay", state: "ready" })
    }
    const surface = map.getCanvasContainer()
    surface.addEventListener("pointerdown", stop, { capture: true, signal: gestures.signal })
    surface.addEventListener("wheel", stop, { capture: true, passive: true, signal: gestures.signal })
  }

  const play = (existing?: number) => {
    if (!view || !frames) return
    const my = existing ?? ++token
    if (raf) cancelAnimationFrame(raf)
    hideListings()
    setInteractive(false)
    onUi({ label: "Skip", state: "playing" })
    listen(my)
    const active = frames
    const minutes = view.minutes
    const spread = 6200 + minutes * 140
    let started = performance.now()
    const step = (now: number) => {
      if (my !== token || !view) return
      const elapsed = now - started
      const flyEnd = HOLD_WIDE_MS + FLY_MS
      const holdEnd = flyEnd + HOLD_CLOSE_MS
      const total = holdEnd + spread
      if (elapsed < HOLD_WIDE_MS) apply(active.wide, -1, false)
      else if (elapsed < flyEnd) {
        const p = smoothstep((elapsed - HOLD_WIDE_MS) / FLY_MS)
        apply(lerpCam(active.wide, active.close, p), -1, false)
      } else if (elapsed < holdEnd) apply(active.close, -1, true)
      else if (elapsed < total) {
        const p = (elapsed - holdEnd) / spread
        apply(spreadCamera(active, p), minutes * 60 * lightFraction(p), true)
      } else {
        finish()
        return
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }

  const api: MapHandle = {
    play: () => play(),
    skip: () => {
      token += 1
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      finish()
    },
    replay: () => {
      if (!frames) return
      const my = ++token
      if (raf) cancelAnimationFrame(raf)
      hideListings()
      setInteractive(false)
      onUi({ label: "Skip", state: "playing" })
      listen(my)
      const from = latest
      const active = frames
      const started = performance.now()
      const step = (now: number) => {
        if (my !== token) return
        const p = Math.min(1, (now - started) / 480)
        apply(lerpCam(from, active.wide, smoothstep(p)), -1, false)
        if (p < 1) raf = requestAnimationFrame(step)
        else play(my)
      }
      raf = requestAnimationFrame(step)
    },
    pose: (frame) => {
      token += 1
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      gestures?.abort()
      if (!view || !frames) return
      if (frame === "start") {
        apply(frames.wide, -1, false)
        hideListings()
        setInteractive(false)
        onUi({ label: "Skip", state: "posed" })
        return
      }
      if (frame === "mid") {
        apply(spreadCamera(frames, 0.5), view.minutes * 60 * lightFraction(0.5), true)
        hideListings()
        setInteractive(false)
        onUi({ label: "Skip", state: "posed" })
        return
      }
      finish()
      onUi({ label: "Replay", state: "posed" })
    },
    show: (next) => {
      view = next
      fuse.setLines(next.lines)
      frames = buildFrames(map, next, compact)
      latest = frames.wide
      marker.setLngLat([next.lon, next.lat])
      const title = markerEl.querySelector<HTMLElement>(".school-card strong")
      const detail = markerEl.querySelector<HTMLElement>(".school-card span")
      if (title) title.textContent = shortName(next.label)
      if (detail) detail.textContent = next.detail
      markerEl.setAttribute("aria-label", next.label)
      map.getCanvas().setAttribute("aria-label", `Streets colored by drive time from ${next.label}`)
      renderLegend(next)
      apply(frames.wide, -1, false)
      hideListings()
    },
    setListings: (data) => {
      listingCount = data.features.length
      const existing = map.getSource("listings") as maplibregl.GeoJSONSource | undefined
      if (existing) {
        existing.setData(data)
        paintListingVisibility()
        return
      }
      map.addSource("listings", { type: "geojson", data })
      map.addLayer({
        id: "listings",
        type: "circle",
        source: "listings",
        layout: { visibility: "none" },
        paint: {
          "circle-color": ["match", ["get", "kind"], "rent", "#FFC857", "sale", "#7EB6FF", "#ffffff"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 8, 14, 13],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#0b0e13",
        },
      })
      const font = symbolFont(map)
      if (font) {
        map.addLayer({
          id: "listing-labels",
          type: "symbol",
          source: "listings",
          layout: {
            visibility: "none",
            "text-field": [
              "case",
              ["==", ["get", "isNew"], true],
              ["concat", "NEW · ", ["get", "driveLabel"]],
              ["get", "driveLabel"],
            ],
            "text-font": font,
            "text-size": 12,
            "text-offset": [0, 1.2],
            "text-anchor": "top",
            "text-allow-overlap": true,
          },
          paint: {
            "text-color": "#f4efe4",
            "text-halo-color": "#0b0e13",
            "text-halo-width": 1.4,
          },
        })
      }
      if (!listingClicksBound) {
        const onPin = (event: maplibregl.MapLayerMouseEvent) => {
          if (!listingsSettled) return
          const raw = event.features?.[0]?.properties?.id
          const id = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : ""
          if (id) api.onListingClick?.(id)
        }
        for (const id of listingLayerIds) {
          if (!map.getLayer(id)) continue
          map.on("click", id, onPin)
          map.on("mouseenter", id, () => {
            map.getCanvas().style.cursor = "pointer"
          })
          map.on("mouseleave", id, () => {
            map.getCanvas().style.cursor = ""
          })
        }
        listingClicksBound = true
      }
      applyListingFilter()
      paintListingVisibility()
    },
    setListingFilter: (filter) => {
      listingFilter = filter
      applyListingFilter()
    },
    focusListing: (lng, lat) => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      map.easeTo({
        center: [lng, lat],
        zoom: Math.max(map.getZoom(), compact ? 13.2 : 14),
        padding: { top: compact ? 150 : 80, bottom: compact ? 300 : 80, left: 24, right: 24 },
        duration: reduced ? 0 : 650,
        essential: true,
      })
    },
    onListingClick: null,
    onListingsVisible: null,
  }

  setInteractive(false)
  window.addEventListener("resize", () => map.resize())
  await Promise.race([once(map, "idle"), wait(1600)])
  return api
}

function spreadCamera(frames: Frames, p: number): Camera {
  const stops = [
    { at: 0, camera: frames.close },
    { at: 0.34, camera: frames.k1 },
    { at: 0.67, camera: frames.k2 },
    { at: 1, camera: frames.k3 },
  ]
  let index = 0
  while (index < stops.length - 2 && p > (stops[index + 1]?.at ?? 1)) index += 1
  const left = stops[index] ?? stops[0]!
  const right = stops[index + 1] ?? left
  const local = (p - left.at) / (right.at - left.at || 1)
  return lerpCam(left.camera, right.camera, smoothstep(local))
}

function lightFraction(p: number): number {
  const x = Math.min(1, Math.max(0, p))
  return x ** 1.12
}

function buildFrames(map: maplibregl.Map, view: ReachView, compact: boolean): Frames {
  const short = window.innerHeight < 520
  const padding = short
    ? { top: 72, bottom: 88, left: 16, right: 16 }
    : compact
      ? { top: 128, bottom: 150, left: 16, right: 16 }
      : { top: 120, bottom: 150, left: 28, right: 32 }
  const close: Camera = {
    lng: view.lon,
    lat: view.lat,
    zoom: compact ? 14.2 : 15,
    pitch: compact ? 16 : 32,
    bearing: -12,
  }
  const k1 = fitBounds(map, view.bounds.b1, padding, close)
  const k2 = fitBounds(map, view.bounds.b2, padding, k1)
  const k3 = fitBounds(map, view.bounds.b3, padding, k2)
  k1.zoom = Math.min(k1.zoom, close.zoom - 0.2)
  k2.zoom = Math.min(k2.zoom, k1.zoom - 0.25)
  k3.zoom = Math.min(k3.zoom, k2.zoom - 0.15)
  const wide: Camera = { ...k3, zoom: Math.max(k3.zoom - 1.15, 8.2), pitch: 0, bearing: 0 }
  k1.pitch = compact ? 4 : 8
  k1.bearing = -4
  k2.pitch = 0
  k2.bearing = 0
  k3.pitch = 0
  k3.bearing = 0
  return { wide, close, k1, k2, k3 }
}

function fitBounds(map: maplibregl.Map, bounds: BBox, padding: maplibregl.PaddingOptions, fallback: Camera): Camera {
  const camera = map.cameraForBounds(
    [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ],
    { padding, bearing: 0, pitch: 0, maxZoom: 14.4 },
  )
  if (!camera?.center || camera.zoom == null) return fallback
  const center = lngLatOf(camera.center)
  return { lng: center.lng, lat: center.lat, zoom: camera.zoom, pitch: 0, bearing: 0 }
}

function lngLatOf(center: maplibregl.LngLatLike): { lng: number; lat: number } {
  if (Array.isArray(center)) return { lng: center[0], lat: center[1] }
  if ("lng" in center) return { lng: center.lng, lat: center.lat }
  return { lng: center.lon, lat: center.lat }
}

function renderLegend(view: ReachView) {
  const legend = document.querySelector("#legend")
  if (!legend) return
  legend.replaceChildren()
  const kicker = document.createElement("p")
  kicker.className = "legend-kicker"
  kicker.textContent = `From ${shortName(view.label)}`
  const list = document.createElement("ul")
  for (const band of view.bands) {
    const item = document.createElement("li")
    item.dataset.min = String(band.minSec)
    const swatch = document.createElement("i")
    swatch.style.background = band.color
    swatch.style.boxShadow = `0 0 12px ${band.color}`
    const label = document.createElement("span")
    label.textContent = band.label
    item.append(swatch, label)
    list.append(item)
  }
  const note = document.createElement("p")
  note.className = "legend-note"
  note.textContent = view.note
  legend.append(kicker, list, note)
}

function paintLegend(seconds: number) {
  document.querySelectorAll<HTMLLIElement>("#legend li").forEach((item) => {
    item.classList.toggle("is-lit", seconds >= Number(item.dataset.min ?? 0))
  })
}

function buildMarker(title: string, detail: string): HTMLDivElement {
  const el = document.createElement("div")
  el.className = "school-marker"
  el.setAttribute("role", "img")
  el.setAttribute("aria-label", title)
  const pin = document.createElement("div")
  pin.className = "pin"
  pin.innerHTML = '<span class="pulse"></span><span class="dot"></span>'
  const card = document.createElement("div")
  card.className = "school-card"
  const strong = document.createElement("strong")
  strong.textContent = title
  const span = document.createElement("span")
  span.textContent = detail
  card.append(strong, span)
  el.append(pin, card)
  return el
}

function shortName(label: string): string {
  const cut = label.split(",")[0]?.trim() || label
  return cut.length > 32 ? `${cut.slice(0, 31)}…` : cut
}

function symbolFont(map: maplibregl.Map): string[] | null {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== "symbol" || !layer.layout) continue
    const font = layer.layout["text-font"]
    if (!Array.isArray(font)) continue
    const names: string[] = []
    for (const item of font) {
      if (typeof item !== "string") {
        names.length = 0
        break
      }
      names.push(item)
    }
    if (names.length > 0) return names
  }
  return null
}

async function loadStyle(): Promise<maplibregl.StyleSpecification> {
  let last = "The basemap didn't respond."
  for (const url of FALLBACK_STYLES) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${url} returned ${response.status}`)
      const style = (await response.json()) as StyleDoc
      dimBasemapRoads(style)
      return style as maplibregl.StyleSpecification
    } catch (error) {
      last = error instanceof Error ? error.message : last
    }
  }
  throw new Error(last)
}

type StyleLayer = { id: string; type: string; paint?: Record<string, unknown>; layout?: Record<string, unknown> }
type StyleDoc = { layers: StyleLayer[] }

function dimBasemapRoads(style: StyleDoc) {
  for (const layer of style.layers ?? []) {
    if (!/highway|road|transport|bridge|tunnel/i.test(layer.id)) continue
    if (/rail|aeroway|boundary|water|poi|label|shield|oneway/i.test(layer.id)) continue
    if (layer.type !== "line") continue
    layer.paint = { ...(layer.paint ?? {}), "line-opacity": 0.28 }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

function sameCamera(a: Camera, b: Camera): boolean {
  return (
    Math.abs(a.lng - b.lng) < 1e-8 &&
    Math.abs(a.lat - b.lat) < 1e-8 &&
    Math.abs(a.zoom - b.zoom) < 1e-4 &&
    Math.abs(a.pitch - b.pitch) < 0.05 &&
    Math.abs(a.bearing - b.bearing) < 0.05
  )
}

function lerpCam(a: Camera, b: Camera, t: number): Camera {
  return {
    lng: lerp(a.lng, b.lng, t),
    lat: lerp(a.lat, b.lat, t),
    zoom: lerp(a.zoom, b.zoom, t),
    pitch: lerp(a.pitch, b.pitch, t),
    bearing: lerp(a.bearing, b.bearing, t),
  }
}

function once(map: maplibregl.Map, event: "load" | "idle"): Promise<void> {
  return new Promise((resolve) => {
    map.once(event, () => resolve())
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}
