import "@fontsource-variable/fraunces"
import "@fontsource-variable/outfit"
import "maplibre-gl/dist/maplibre-gl.css"
import "./style.css"

import { prepareListingPins } from "./listings.ts"
import { mountMap, type FrameName, type MapHandle, type ReachView } from "./map-view.ts"
import { decodeReach, type ReachData } from "./reach/codec.ts"
import { nextTuesdayMorning } from "./reach/tuesday.ts"
import { geocodePlace, suggestPlaces, type Place } from "./search.ts"

const KENDALL = { lon: -71.1764, lat: 42.37981, label: "Kendall School", minutes: 15 }
const STORAGE_KEY = "bhs-trip"

const app = must(document.querySelector<HTMLElement>("#app"), "app")
const curtain = must(document.querySelector<HTMLElement>("#curtain"), "curtain")
const curtainStatus = must(document.querySelector<HTMLElement>("#curtain-status"), "curtain status")
const errorPanel = must(document.querySelector<HTMLElement>("#error"), "error")
const errorText = must(document.querySelector<HTMLElement>("#error-text"), "error text")
const action = must(document.querySelector<HTMLButtonElement>("#action"), "action")
const retry = must(document.querySelector<HTMLButtonElement>("#retry"), "retry")
const form = must(document.querySelector<HTMLFormElement>("#trip"), "trip form")
const placeInput = must(document.querySelector<HTMLInputElement>("#place"), "place")
const minutesInput = must(document.querySelector<HTMLInputElement>("#minutes"), "minutes")
const suggestions = must(document.querySelector<HTMLElement>("#suggestions"), "suggestions")
const status = must(document.querySelector<HTMLElement>("#status"), "status")
const statusText = must(document.querySelector<HTMLElement>("#status-text"), "status text")
const go = must(document.querySelector<HTMLButtonElement>("#go"), "go")

retry.addEventListener("click", () => window.location.reload())

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
const frame = frameParam(new URLSearchParams(window.location.search).get("frame"))
let selected: Place | null = null
let handle: MapHandle | null = null
let suggestTimer = 0
let suggestAbort: AbortController | null = null

void boot()
registerServiceWorker()
wireForm()

async function boot() {
  const trip = readTrip()
  applyTrip(trip)
  action.addEventListener("click", () => {
    if (!handle) return
    if (action.textContent === "Skip") handle.skip()
    else handle.replay()
  })
  try {
    setStatus("Opening the map…", true)
    handle = await mountMap(must(document.querySelector<HTMLElement>("#map"), "map"), (ui) => {
      action.hidden = false
      action.textContent = ui.label
      app.dataset.state = ui.state
    })
    try {
      await runTrip(trip, true)
    } catch (error) {
      if (trip.minutes === KENDALL.minutes && nearKendall(trip)) throw error
      localStorage.removeItem(STORAGE_KEY)
      applyTrip({ ...KENDALL })
      await runTrip({ ...KENDALL }, true)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message.includes("took too long") && sessionStorage.getItem("bhs-basemap-retry") !== "1") {
      sessionStorage.setItem("bhs-basemap-retry", "1")
      window.location.reload()
      return
    }
    sessionStorage.removeItem("bhs-basemap-retry")
    fail(error)
  }
}

async function runTrip(trip: Place & { minutes: number }, first: boolean) {
  const messages = ["Reading Tuesday morning traffic…", "Tracing the streets…", "Timing the drive…"]
  let tick = 0
  setStatus(messages[0] ?? "", first)
  const timer = window.setInterval(() => {
    tick = (tick + 1) % messages.length
    setStatus(messages[tick] ?? "", first)
  }, 1600)
  try {
    const reach = await loadReach(trip)
    const view = toView(reach, trip)
    handle?.show(view)
    const pins = await prepareListingPins(reach.grid).catch(() => null)
    if (pins && pins.features.length > 0) handle?.setListings(pins)
    window.clearInterval(timer)
    setStatus("", first)
    if (first) await fadeCurtain()
    remember(trip)
    writeUrl(trip)
    if (frame && first) handle?.pose(frame)
    else if (reducedMotion) handle?.pose("end")
    else if (first) handle?.play()
    else handle?.replay()
  } catch (error) {
    window.clearInterval(timer)
    setStatus("", first)
    if (!first) {
      status.hidden = false
      statusText.textContent = error instanceof Error ? error.message : "The drive could not be timed"
      return
    }
    throw error
  }
}

function wireForm() {
  placeInput.addEventListener("input", () => {
    selected = null
    window.clearTimeout(suggestTimer)
    suggestAbort?.abort()
    const query = placeInput.value
    if (query.trim().length < 3) {
      suggestions.replaceChildren()
      suggestions.hidden = true
      return
    }
    suggestTimer = window.setTimeout(() => {
      suggestAbort = new AbortController()
      void suggestPlaces(query, suggestAbort.signal)
        .then((places) => showSuggestions(places))
        .catch(() => undefined)
    }, 180)
  })
  placeInput.addEventListener("keydown", (event) => {
    const buttons = [...suggestions.querySelectorAll("button")]
    const current = buttons.findIndex((button) => button.dataset.active === "true")
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const next = event.key === "ArrowDown" ? current + 1 : current - 1
      const button = buttons[(next + buttons.length) % buttons.length]
      buttons.forEach((item) => delete item.dataset.active)
      if (button) button.dataset.active = "true"
    } else if (event.key === "Enter" && current >= 0) {
      event.preventDefault()
      buttons[current]?.click()
    } else if (event.key === "Escape") {
      suggestions.hidden = true
    }
  })
  document.querySelector("#min-down")?.addEventListener("click", () => bumpMinutes(-1))
  document.querySelector("#min-up")?.addEventListener("click", () => bumpMinutes(1))
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    void submitTrip()
  })
}

async function submitTrip() {
  const minutes = clampMinutes(Number(minutesInput.value))
  minutesInput.value = String(minutes)
  let place = selected
  if (!place || place.label !== placeInput.value.trim()) {
    go.disabled = true
    place = await geocodePlace(placeInput.value).catch(() => null)
    go.disabled = false
  }
  if (!place) {
    status.hidden = false
    statusText.textContent = "No matching address. Try a street or a place name."
    return
  }
  selected = place
  placeInput.value = place.label
  suggestions.hidden = true
  const trip = { ...place, minutes }
  await runTrip(trip, false)
}

function showSuggestions(places: Place[]) {
  suggestions.replaceChildren()
  if (places.length === 0) {
    suggestions.hidden = true
    return
  }
  for (const place of places) {
    const item = document.createElement("li")
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = place.label
    button.addEventListener("click", () => {
      selected = place
      placeInput.value = place.label
      suggestions.hidden = true
      minutesInput.focus()
    })
    item.append(button)
    suggestions.append(item)
  }
  suggestions.hidden = false
}

function bumpMinutes(delta: number) {
  minutesInput.value = String(clampMinutes(Number(minutesInput.value) + delta))
}

function clampMinutes(value: number): number {
  if (!Number.isFinite(value)) return 15
  return Math.max(5, Math.min(30, Math.round(value)))
}

async function loadReach(trip: Place & { minutes: number }): Promise<ReachData> {
  // The opening Kendall 15-minute view is the baked file only. Other durations
  // and other addresses go through /api/reach.
  if (isDefaultKendall(trip)) {
    const baked = await fetch("/data/reach.bin")
    if (!baked.ok) throw new Error("The saved Kendall drive didn't load.")
    return decodeReach(await baked.arrayBuffer())
  }
  const depart = nextTuesdayMorning()
  const url =
    `/api/reach?lon=${trip.lon}&lat=${trip.lat}&min=${trip.minutes}` +
    `&depart=${encodeURIComponent(depart)}&q=${encodeURIComponent(trip.label)}`
  const cached = await caches.open("reach-v1").then((cache) => cache.match(url)).catch(() => undefined)
  if (cached) return decodeReach(await cached.arrayBuffer())
  const response = await fetch(url)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || "The drive could not be timed")
  }
  const bytes = await response.arrayBuffer()
  void caches.open("reach-v1").then((cache) => cache.put(url, new Response(bytes.slice(0)))).catch(() => undefined)
  return decodeReach(bytes)
}

function toView(reach: ReachData, trip: Place & { minutes: number }): ReachView {
  const header = reach.header
  return {
    label: header.label || trip.label,
    detail: `${header.minutes} min · Tue 8:00`,
    lon: header.lon,
    lat: header.lat,
    minutes: header.minutes,
    note: header.note,
    bands: header.bands,
    bounds: header.bounds,
    lines: reach.lines,
  }
}

function isDefaultKendall(trip: { lon: number; lat: number; minutes: number }): boolean {
  return trip.minutes === KENDALL.minutes && nearKendall(trip)
}

function nearKendall(trip: { lon: number; lat: number }): boolean {
  const cos = Math.cos((KENDALL.lat * Math.PI) / 180)
  const dx = (trip.lon - KENDALL.lon) * 111_320 * cos
  const dy = (trip.lat - KENDALL.lat) * 111_320
  return Math.hypot(dx, dy) < 80
}

type Trip = Place & { minutes: number }

function readTrip(): Trip {
  const params = new URLSearchParams(window.location.search)
  if (params.get("reset") === "1") {
    localStorage.removeItem(STORAGE_KEY)
    params.delete("reset")
    const url = new URL(window.location.href)
    url.searchParams.delete("reset")
    history.replaceState(null, "", url)
  }
  const fromUrl = tripFromParams(params)
  if (fromUrl) return fromUrl
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as Partial<Trip>
    if (typeof saved.lon === "number" && typeof saved.lat === "number" && typeof saved.label === "string") {
      return { lon: saved.lon, lat: saved.lat, label: saved.label, minutes: clampMinutes(Number(saved.minutes)) }
    }
  } catch {
    // Ignore a broken saved trip and use the school.
  }
  return { ...KENDALL }
}

function tripFromParams(params: URLSearchParams): Trip | null {
  if (!params.has("lat") || (!params.has("lng") && !params.has("lon"))) return null
  const lat = Number(params.get("lat"))
  const lon = Number(params.get("lng") ?? params.get("lon"))
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const label = params.get("q") || "Start"
  const minutes = clampMinutes(Number(params.get("min") ?? 15))
  return { lon, lat, label, minutes }
}

function applyTrip(trip: Trip) {
  selected = { label: trip.label, lon: trip.lon, lat: trip.lat }
  placeInput.value = trip.label
  minutesInput.value = String(trip.minutes)
}

function remember(trip: Trip) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trip))
}

function writeUrl(trip: Trip) {
  const url = new URL(window.location.href)
  url.searchParams.set("lat", trip.lat.toFixed(5))
  url.searchParams.set("lng", trip.lon.toFixed(5))
  url.searchParams.set("min", String(trip.minutes))
  url.searchParams.set("q", trip.label)
  history.replaceState(null, "", url)
}

function setStatus(text: string, curtainToo: boolean) {
  status.hidden = text.length === 0
  statusText.textContent = text
  if (curtainToo) curtainStatus.textContent = text
  go.disabled = text.length > 0 && curtainToo
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : "Something went wrong loading the map."
  curtain.classList.add("is-gone")
  errorPanel.hidden = false
  errorText.textContent = message
  app.dataset.state = "error"
}

async function fadeCurtain() {
  curtain.classList.add("is-fading")
  await wait(520)
  curtain.classList.add("is-gone")
  curtainStatus.textContent = ""
}

function frameParam(value: string | null): FrameName | null {
  if (value === "start" || value === "mid" || value === "end") return value
  return null
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function must<T>(value: T | null, name: string): T {
  if (value == null) throw new Error(`Map page is missing ${name}`)
  return value
}

function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined)
  })
}
