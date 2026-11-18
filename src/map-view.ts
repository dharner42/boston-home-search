import maplibregl from "maplibre-gl"
import type { StreetCollection } from "./load-streets.ts"
import type { BBox, Camera, Meta } from "./types.ts"

const STYLE_URLS = [
  "https://tiles.openfreemap.org/styles/dark",
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
]

const HOLD_WIDE_MS = 700
const FLY_MS = 2900
const HOLD_CLOSE_MS = 650
const SPREAD_MS = 7000
const VISUAL_SECONDS = 900
const LIGHT_POWER = 1.28
const REVEAL_STEP = 15

export type FrameName = "start" | "mid" | "end"

export type MapUi = {
  label: "Skip" | "Replay"
  state: "playing" | "ready" | "posed"
}

export type MapHandle = {
  play: () => void
  skip: () => void
  replay: () => void
  pose: (frame: FrameName) => void
}

type Frames = {
  wide: Camera
  close: Camera
  k5: Camera
  k10: Camera
  k15: Camera
}

export async function mountMap(
  container: HTMLElement,
  meta: Meta,
  meshPromise: Promise<StreetCollection>,
  onUi: (ui: MapUi) => void,
): Promise<MapHandle> {
  const style = await loadStyle()
  const compact = window.matchMedia("(max-width: 760px), (max-height: 520px)").matches
  const map = new maplibregl.Map({
    container,
    style,
    center: [meta.school.lon, meta.school.lat],
    zoom: compact ? 8.9 : 9.4,
    minZoom: 8,
    maxZoom: 18,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    fadeDuration: 0,
  })
  map.addControl(new maplibregl.AttributionControl({ compact }), "bottom-right")
  map.getCanvas().setAttribute(
    "aria-label",
    "Streets colored by drive time from The Kendall School in Belmont",
  )

  const markerEl = buildMarker(meta)
  markerEl.setAttribute("role", "img")
  markerEl.setAttribute("aria-label", `${meta.school.shortName}, ${meta.school.street}`)
  new maplibregl.Marker({ element: markerEl, anchor: "center" })
    .setLngLat([meta.school.lon, meta.school.lat])
    .addTo(map)

  await once(map, "load")
  addRoadLayers(map, meta)
  let streetsReady = false
  let shownThrough = -REVEAL_STEP
  let litSeconds = -1
  void meshPromise.then((collection) => {
    const source = map.getSource("roads") as maplibregl.GeoJSONSource | undefined
    source?.setData(collection)
    streetsReady = true
    shownThrough = -REVEAL_STEP
    setLight(litSeconds)
    map.triggerRepaint()
  })
  const frames = buildFrames(map, meta, compact)
  let latest = frames.wide
  let token = 0
  let raf = 0
  let gestures: AbortController | null = null

  const setMarker = (on: boolean) => markerEl.classList.toggle("is-on", on)

  const setLight = (seconds: number) => {
    litSeconds = seconds
    const reveal = seconds < 0 ? -REVEAL_STEP : Math.floor(seconds / REVEAL_STEP) * REVEAL_STEP
    paintLegend(seconds)
    if (!streetsReady || reveal === shownThrough) return
    const from = reveal < shownThrough ? 0 : shownThrough + REVEAL_STEP
    if (reveal < shownThrough) {
      for (let bucket = 0; bucket < VISUAL_SECONDS; bucket += REVEAL_STEP) {
        map.setLayoutProperty(`roads-glow-${bucket}`, "visibility", "none")
        map.setLayoutProperty(`roads-${bucket}`, "visibility", "none")
      }
    }
    for (let bucket = Math.max(0, from); bucket <= reveal && bucket < VISUAL_SECONDS; bucket += REVEAL_STEP) {
      map.setLayoutProperty(`roads-glow-${bucket}`, "visibility", "visible")
      map.setLayoutProperty(`roads-${bucket}`, "visibility", "visible")
    }
    shownThrough = reveal
  }

  const apply = (camera: Camera, seconds: number, markerOn: boolean) => {
    const moved = !sameCamera(latest, camera) || raf === 0
    latest = camera
    if (moved) {
      map.jumpTo({
        center: [camera.lng, camera.lat],
        zoom: camera.zoom,
        pitch: camera.pitch,
        bearing: camera.bearing,
      })
    }
    setLight(seconds)
    setMarker(markerOn)
    if (!moved) map.triggerRepaint()
  }

  const setInteractive = (on: boolean) => {
    const handlers = [
      map.dragPan,
      map.scrollZoom,
      map.boxZoom,
      map.doubleClickZoom,
      map.keyboard,
      map.touchZoomRotate,
    ]
    for (const handler of handlers) {
      if (on) handler.enable()
      else handler.disable()
    }
    map.dragRotate.disable()
    map.touchPitch.disable()
    if (on) map.touchZoomRotate.disableRotation()
  }

  const stopGestures = () => {
    gestures?.abort()
    gestures = null
  }

  const finish = () => {
    stopGestures()
    apply(frames.k15, VISUAL_SECONDS, true)
    setInteractive(true)
    onUi({ label: "Replay", state: "ready" })
  }

  const releaseAtCurrentView = () => {
    token += 1
    cancel()
    stopGestures()
    setLight(VISUAL_SECONDS)
    setMarker(true)
    map.triggerRepaint()
    setInteractive(true)
    onUi({ label: "Replay", state: "ready" })
  }

  const listenForTouch = (my: number) => {
    stopGestures()
    gestures = new AbortController()
    const signal = gestures.signal
    const stop = (event: Event) => {
      if (my !== token) return
      if (event.target instanceof Element && event.target.closest("#action, .brand, .legend")) return
      releaseAtCurrentView()
    }
    const surface = map.getCanvasContainer()
    surface.addEventListener("pointerdown", stop, { capture: true, signal })
    surface.addEventListener("wheel", stop, { capture: true, passive: true, signal })
  }

  const cancel = () => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  const play = (existing?: number) => {
    const my = existing ?? ++token
    cancel()
    setInteractive(false)
    onUi({ label: "Skip", state: "playing" })
    listenForTouch(my)
    let started = performance.now()
    const step = (now: number) => {
      if (my !== token) return
      const elapsed = now - started
      const flyEnd = HOLD_WIDE_MS + FLY_MS
      const holdEnd = flyEnd + HOLD_CLOSE_MS
      const total = holdEnd + SPREAD_MS
      if (elapsed < HOLD_WIDE_MS) {
        apply(frames.wide, -1, false)
      } else if (elapsed < flyEnd) {
        const p = smoothstep((elapsed - HOLD_WIDE_MS) / FLY_MS)
        apply(lerpCam(frames.wide, frames.close, p), -1, false)
      } else if (elapsed < holdEnd || !streetsReady) {
        if (!streetsReady && elapsed >= holdEnd) started = now - holdEnd
        apply(frames.close, -1, true)
      } else if (elapsed < total) {
        const p = (elapsed - holdEnd) / SPREAD_MS
        apply(spreadCamera(frames, p), lightSeconds(p), true)
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
      cancel()
      finish()
    },
    replay: () => {
      const my = ++token
      cancel()
      setInteractive(false)
      onUi({ label: "Skip", state: "playing" })
      listenForTouch(my)
      const from = latest
      const started = performance.now()
      const step = (now: number) => {
        if (my !== token) return
        const p = Math.min(1, (now - started) / 480)
        apply(lerpCam(from, frames.wide, smoothstep(p)), -1, false)
        if (p < 1) raf = requestAnimationFrame(step)
        else play(my)
      }
      raf = requestAnimationFrame(step)
    },
    pose: (frame) => {
      token += 1
      cancel()
      stopGestures()
      if (frame === "start") {
        apply(frames.wide, -1, false)
        setInteractive(false)
        onUi({ label: "Skip", state: "posed" })
        return
      }
      if (frame === "mid") {
        apply(spreadCamera(frames, 0.5), lightSeconds(0.5), true)
        setInteractive(false)
        onUi({ label: "Skip", state: "posed" })
        return
      }
      finish()
      onUi({ label: "Replay", state: "posed" })
    },
  }

  apply(frames.wide, -1, false)
  setInteractive(false)
  window.addEventListener("resize", () => map.resize())
  await Promise.race([once(map, "idle"), wait(1400)])
  return api
}

function spreadCamera(frames: Frames, p: number): Camera {
  const stops = [
    { at: 0, camera: frames.close },
    { at: 0.34, camera: frames.k5 },
    { at: 0.67, camera: frames.k10 },
    { at: 1, camera: frames.k15 },
  ]
  let index = 0
  while (index < stops.length - 2 && p > stops[index + 1].at) index += 1
  const left = stops[index]
  const right = stops[index + 1]
  const local = (p - left.at) / (right.at - left.at)
  return lerpCam(left.camera, right.camera, smoothstep(local))
}

function lightSeconds(p: number): number {
  const x = Math.min(1, Math.max(0, p))
  return VISUAL_SECONDS * x ** LIGHT_POWER
}

function buildFrames(map: maplibregl.Map, meta: Meta, compact: boolean): Frames {
  const short = window.innerHeight < 520
  const padding = short
    ? { top: 72, bottom: 88, left: 16, right: 16 }
    : compact
      ? { top: 96, bottom: 158, left: 16, right: 16 }
      : { top: 108, bottom: 150, left: 28, right: 32 }
  const wide: Camera = compact
    ? { lng: -71.06, lat: 42.363, zoom: 8.85, pitch: 0, bearing: 0 }
    : { lng: -71.075, lat: 42.37, zoom: 9.35, pitch: 0, bearing: 0 }
  const close: Camera = {
    lng: meta.school.lon,
    lat: meta.school.lat,
    zoom: compact ? 14.35 : 15.1,
    pitch: compact ? 18 : 34,
    bearing: -14,
  }
  const k5 = fitBounds(map, meta.bounds["5"], padding)
  const k10 = fitBounds(map, meta.bounds["10"], padding)
  const k15 = fitBounds(map, meta.bounds["15"], padding)
  k5.zoom = Math.min(k5.zoom, close.zoom - 0.25)
  k10.zoom = Math.min(k10.zoom, k5.zoom - 0.3)
  k15.zoom = Math.min(k15.zoom, k10.zoom - 0.2)
  k5.pitch = compact ? 5 : 10
  k5.bearing = -6
  k10.pitch = 0
  k10.bearing = 0
  k15.pitch = 0
  k15.bearing = 0
  return { wide, close, k5, k10, k15 }
}

function fitBounds(map: maplibregl.Map, bounds: BBox, padding: maplibregl.PaddingOptions): Camera {
  const camera = map.cameraForBounds(
    [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ],
    { padding, bearing: 0, pitch: 0, maxZoom: 14.6 },
  )
  if (!camera?.center || camera.zoom == null) {
    throw new Error("Could not frame the drive-time map")
  }
  const center = lngLatOf(camera.center)
  return {
    lng: center.lng,
    lat: center.lat,
    zoom: camera.zoom,
    pitch: 0,
    bearing: 0,
  }
}

function lngLatOf(center: maplibregl.LngLatLike): { lng: number; lat: number } {
  if (Array.isArray(center)) return { lng: center[0], lat: center[1] }
  if ("lng" in center) return { lng: center.lng, lat: center.lat }
  return { lng: center.lon, lat: center.lat }
}

function addRoadLayers(map: maplibregl.Map, meta: Meta) {
  map.addSource("roads", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  })
  const before = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id
  const color = bandColor(meta, "color")
  const core = bandColor(meta, "core")
  for (let bucket = 0; bucket < VISUAL_SECONDS; bucket += REVEAL_STEP) {
    const filter: maplibregl.FilterSpecification = [
      "all",
      [">=", ["get", "t"], bucket],
      ["<", ["get", "t"], bucket + REVEAL_STEP],
    ]
    map.addLayer(
      {
        id: `roads-glow-${bucket}`,
        type: "line",
        source: "roads",
        filter,
        layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": color,
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 3.2, 12, 6.5, 14, 10, 16, 15],
          "line-opacity": 0.55,
        },
      },
      before,
    )
    map.addLayer(
      {
        id: `roads-${bucket}`,
        type: "line",
        source: "roads",
        filter,
        layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": core,
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 12, 1.6, 14, 2.8, 16, 4.6],
          "line-opacity": 0.95,
        },
      },
      before,
    )
  }
}

function bandColor(meta: Meta, key: "color" | "core"): maplibregl.ExpressionSpecification | string {
  const first = meta.bands[0]
  const second = meta.bands[1]
  const third = meta.bands[2]
  if (!first || !second || !third) return "#ffffff"
  return ["match", ["get", "band"], 1, first[key], 2, second[key], 3, third[key], "#ffffff"] as maplibregl.ExpressionSpecification
}

function paintLegend(reveal: number) {
  document.querySelectorAll<HTMLLIElement>("#legend li").forEach((item) => {
    const band = Number(item.dataset.band)
    const minSec = band === 1 ? 0 : band === 2 ? 300 : 600
    item.classList.toggle("is-lit", reveal >= minSec)
  })
}

function buildMarker(meta: Meta): HTMLDivElement {
  const el = document.createElement("div")
  el.className = "school-marker"
  const pin = document.createElement("div")
  pin.className = "pin"
  pin.innerHTML = '<span class="pulse"></span><span class="dot"></span>'
  const card = document.createElement("div")
  card.className = "school-card"
  const title = document.createElement("strong")
  title.textContent = meta.school.shortName
  const street = document.createElement("span")
  street.textContent = meta.school.street
  card.append(title, street)
  el.append(pin, card)
  return el
}

async function loadStyle(): Promise<maplibregl.StyleSpecification> {
  let last = "The basemap didn't respond."
  for (const url of STYLE_URLS) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${url} returned ${res.status}`)
      const style = (await res.json()) as StyleDoc
      dimBasemapRoads(style)
      return style as maplibregl.StyleSpecification
    } catch (error) {
      last = error instanceof Error ? error.message : last
    }
  }
  throw new Error(last)
}

type StyleLayer = {
  id: string
  type: string
  paint?: Record<string, unknown>
  layout?: Record<string, unknown>
}

type StyleDoc = {
  layers: StyleLayer[]
}

function dimBasemapRoads(style: StyleDoc) {
  for (const layer of style.layers) {
    if (!/highway|road|transport/i.test(layer.id)) continue
    if (/rail|aeroway|boundary|water|poi/i.test(layer.id)) continue
    if (/path|oneway|pedestrian|foot|cycle/i.test(layer.id)) {
      layer.layout = { ...(layer.layout ?? {}), visibility: "none" }
      continue
    }
    if (layer.type !== "line") continue
    layer.paint = { ...(layer.paint ?? {}), "line-opacity": 0.22 }
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
