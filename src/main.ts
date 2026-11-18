import "@fontsource-variable/fraunces"
import "@fontsource-variable/outfit"
import "maplibre-gl/dist/maplibre-gl.css"
import "./style.css"

import { AREAS, DEFAULT_AREA, DEFAULT_MINUTES, areaAt, areaById, type Area } from "./areas.ts"
import { criteriaLines, originPhrase } from "./criteria.ts"
import { mountListingUi } from "./listing-ui.ts"
import { listingsToGeoJSON, loadListingViews } from "./listings.ts"
import { mountMap, type FrameName, type MapHandle, type ReachView } from "./map-view.ts"
import { decodeReach, type ReachData } from "./reach/codec.ts"
import { nextTuesdayMorning } from "./reach/tuesday.ts"
import { geocodePlace, suggestPlaces, type Place } from "./search.ts"

const STORAGE_KEY = "bhs-trip"
const AREA_KEY = "bhs-area"
const SEARCH_COLLAPSE_KEY = "bhs-search-collapsed"
const LEGEND_COLLAPSE_KEY = "bhs-legend-collapsed"

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
const searchPanel = must(document.querySelector<HTMLElement>("#search-panel"), "search")
const searchToggle = must(document.querySelector<HTMLButtonElement>("#search-toggle"), "search toggle")
const searchHint = must(document.querySelector<HTMLElement>("#search-toggle-hint"), "search hint")
const searchName = must(document.querySelector<HTMLElement>("#search-pill-name"), "search name")
const legendPanel = must(document.querySelector<HTMLElement>("#legend"), "legend")
const legendToggle = must(document.querySelector<HTMLButtonElement>("#legend-toggle"), "legend toggle")
const legendHint = must(document.querySelector<HTMLElement>("#legend-toggle-hint"), "legend hint")
const filtersOpen = must(document.querySelector<HTMLButtonElement>("#filters-open"), "filters")
const criteria = must(document.querySelector<HTMLElement>("#criteria"), "criteria")
const criteriaList = must(document.querySelector<HTMLElement>("#criteria-list"), "criteria list")
const criteriaClose = must(document.querySelector<HTMLButtonElement>("#criteria-close"), "criteria close")
const areaOpen = must(document.querySelector<HTMLButtonElement>("#area-open"), "area button")
const areaOpenName = must(document.querySelector<HTMLElement>("#area-open-name"), "area button name")
const areaPicker = must(document.querySelector<HTMLElement>("#area-picker"), "area picker")
const areaList = must(document.querySelector<HTMLElement>("#area-list"), "area list")
const areaClose = must(document.querySelector<HTMLButtonElement>("#area-close"), "area close")

retry.addEventListener("click", () => window.location.reload())

const listingUi = mountListingUi({
  onFilter: (filter) => {
    handle?.setListingFilter(filter)
    refreshCriteria()
  },
  onFocus: (listing) => handle?.focusListing(listing.lng, listing.lat),
})
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
const frame = frameParam(new URLSearchParams(window.location.search).get("frame"))
let selected: Place | null = null
let handle: MapHandle | null = null
let suggestTimer = 0
let suggestAbort: AbortController | null = null
let updatedAt: string | null = null
let panelsSettled = false
let area: Area = DEFAULT_AREA
let pickResolve: ((picked: Area | null) => void) | null = null
let pickLocked = false

wireAreas()
void boot()
registerServiceWorker()
wireForm()
wirePanels()

async function boot() {
  const start = readStart()
  applyArea(start.area)
  applyTrip(start.trip)
  // On a first visit the picker opens while the basemap loads behind the curtain.
  const picking = start.needsPick ? pickArea(true) : null
  action.addEventListener("click", () => {
    if (!handle) return
    if (action.textContent === "Skip") handle.skip()
    else handle.replay()
  })
  try {
    setStatus("Opening the map…", true)
    handle = await mountMap(must(document.querySelector<HTMLElement>("#map"), "map"), start.trip, (ui) => {
      action.hidden = false
      action.textContent = ui.label
      app.dataset.state = ui.state
      if (ui.state === "ready" || (ui.state === "posed" && ui.label === "Replay")) settlePanels()
    })
    handle.onListingClick = (id) => listingUi.open(id)
    handle.onListingsVisible = (visible) => listingUi.setVisible(visible)
    let trip = start.trip
    if (picking) {
      applyArea((await picking) ?? area)
      trip = centerTrip(area, DEFAULT_MINUTES)
      applyTrip(trip)
    }
    try {
      await runTrip(trip, true)
    } catch (error) {
      if (homeView(trip)) throw error
      localStorage.removeItem(STORAGE_KEY)
      const center = centerTrip(area, DEFAULT_MINUTES)
      applyTrip(center)
      await runTrip(center, true)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message.includes("took too long") && sessionStorage.getItem("bhs-basemap-retry") !== "1") {
      sessionStorage.setItem("bhs-basemap-retry", "1")
      window.location.reload()
      return
    }
    sessionStorage.removeItem("bhs-basemap-retry")
    closeAreaPicker(null, true)
    fail(error)
  }
}

/**
 * Load and play a drive. Listings come from `target` (the area), which only
 * becomes the current area once the drive has loaded, so a failed switch
 * leaves the map, pins and labels on the previous area.
 */
async function runTrip(trip: Place & { minutes: number }, first: boolean, target: Area = area): Promise<boolean> {
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
    if (target !== area) applyArea(target)
    const loaded = await loadListingViews(`/data/${target.listingsFile}`).catch(() => ({ listings: [], updatedAt: null }))
    updatedAt = loaded.updatedAt
    listingUi.setListings(loaded.listings)
    handle?.setListings(listingsToGeoJSON(loaded.listings))
    refreshCriteria()
    window.clearInterval(timer)
    setStatus("", first)
    if (first) await fadeCurtain()
    remember(trip)
    writeUrl(trip)
    if (frame && first) handle?.pose(frame)
    else if (reducedMotion) handle?.pose("end")
    else if (first) handle?.play()
    else handle?.replay()
    return true
  } catch (error) {
    window.clearInterval(timer)
    setStatus("", first)
    if (!first) {
      status.hidden = false
      statusText.textContent = error instanceof Error ? error.message : "The drive could not be timed"
      return false
    }
    throw error
  }
}

function wirePanels() {
  applyCollapsed(searchPanel, searchToggle, searchHint, "Hide search", "Show search", readCollapsed(SEARCH_COLLAPSE_KEY))
  applyCollapsed(legendPanel, legendToggle, legendHint, "Hide drive time colors", "Show drive time colors", readCollapsed(LEGEND_COLLAPSE_KEY))
  syncSearchName()
  searchToggle.addEventListener("click", () => {
    const next = searchPanel.dataset.collapsed !== "true"
    applyCollapsed(searchPanel, searchToggle, searchHint, "Hide search", "Show search", next)
    localStorage.setItem(SEARCH_COLLAPSE_KEY, next ? "1" : "0")
  })
  legendToggle.addEventListener("click", () => {
    const next = legendPanel.dataset.collapsed !== "true"
    applyCollapsed(legendPanel, legendToggle, legendHint, "Hide drive time colors", "Show drive time colors", next)
    localStorage.setItem(LEGEND_COLLAPSE_KEY, next ? "1" : "0")
  })
  filtersOpen.addEventListener("click", () => openCriteria())
  criteriaClose.addEventListener("click", () => closeCriteria())
  document.querySelector("#criteria-backdrop")?.addEventListener("click", () => closeCriteria())
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !criteria.hidden) closeCriteria()
  })
}

function settlePanels() {
  if (panelsSettled) return
  panelsSettled = true
  if (!window.matchMedia("(max-width: 760px)").matches) return
  if (localStorage.getItem(SEARCH_COLLAPSE_KEY) == null) {
    applyCollapsed(searchPanel, searchToggle, searchHint, "Hide search", "Show search", true)
    localStorage.setItem(SEARCH_COLLAPSE_KEY, "1")
  }
  if (localStorage.getItem(LEGEND_COLLAPSE_KEY) == null) {
    applyCollapsed(legendPanel, legendToggle, legendHint, "Hide drive time colors", "Show drive time colors", true)
    localStorage.setItem(LEGEND_COLLAPSE_KEY, "1")
  }
}

function readCollapsed(key: string): boolean {
  return localStorage.getItem(key) === "1"
}

function applyCollapsed(
  panel: HTMLElement,
  toggle: HTMLButtonElement,
  hint: HTMLElement,
  hideLabel: string,
  showLabel: string,
  collapsed: boolean,
) {
  panel.dataset.collapsed = collapsed ? "true" : "false"
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true")
  hint.textContent = collapsed ? showLabel : hideLabel
  app.dataset.legend = legendPanel.dataset.collapsed === "true" ? "closed" : "open"
}

function syncSearchName() {
  const label = placeInput.value.trim() || area.name
  searchName.textContent = label.length > 28 ? `${label.slice(0, 27)}…` : label
}

function openCriteria() {
  refreshCriteria()
  criteria.hidden = false
  filtersOpen.setAttribute("aria-expanded", "true")
  criteriaClose.focus()
}

function closeCriteria() {
  criteria.hidden = true
  filtersOpen.setAttribute("aria-expanded", "false")
  filtersOpen.focus()
}

function refreshCriteria() {
  const lines = criteriaLines({
    origin: originPhrase(placeInput.value || area.name),
    listingOrigin: area.origin,
    streetMinutes: clampMinutes(Number(minutesInput.value)),
    filter: listingUi.getFilter(),
    updatedAt,
  })
  criteriaList.replaceChildren()
  for (const line of lines) {
    const item = document.createElement("li")
    item.textContent = line
    criteriaList.append(item)
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
  // An area's own 15-minute view reads its baked file. An area that has not
  // been baked yet (404) falls through to /api/reach like any other address.
  const home = homeView(trip)
  if (home) {
    const saved = await fetch(`/data/${home.reachFile}`).catch(() => null)
    if (saved?.ok) return decodeReach(await saved.arrayBuffer())
    if (home.id === DEFAULT_AREA.id) throw new Error(`The saved ${home.name} drive didn't load.`)
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

/** The area whose own default view this trip is (its center at 15 minutes). */
function homeView(trip: { lon: number; lat: number; minutes: number }): Area | null {
  return trip.minutes === DEFAULT_MINUTES ? areaAt(trip.lon, trip.lat) : null
}

type Trip = Place & { minutes: number }

type Start = { trip: Trip; area: Area; needsPick: boolean }

/**
 * What to open on. A shared link or a remembered area opens straight away.
 * A first visit, or ?reset=1, opens the area picker.
 */
function readStart(): Start {
  const params = new URLSearchParams(window.location.search)
  if (params.get("reset") === "1") {
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(AREA_KEY)
    const url = new URL(window.location.href)
    url.searchParams.delete("reset")
    history.replaceState(null, "", url)
  }
  const savedArea = areaById(localStorage.getItem(AREA_KEY))
  const urlArea = areaById(params.get("area"))
  const fromUrl = tripFromParams(params)
  if (fromUrl) {
    const chosen = urlArea ?? areaAt(fromUrl.lon, fromUrl.lat) ?? savedArea ?? DEFAULT_AREA
    return { trip: fromUrl, area: chosen, needsPick: false }
  }
  if (urlArea) return { trip: centerTrip(urlArea, DEFAULT_MINUTES), area: urlArea, needsPick: false }
  if (savedArea) {
    return { trip: readSavedTrip() ?? centerTrip(savedArea, DEFAULT_MINUTES), area: savedArea, needsPick: false }
  }
  // Screenshot frames (?frame=) skip the picker and use the default area.
  return { trip: centerTrip(DEFAULT_AREA, DEFAULT_MINUTES), area: DEFAULT_AREA, needsPick: frame == null }
}

function readSavedTrip(): Trip | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as Partial<Trip>
    if (typeof saved.lon === "number" && typeof saved.lat === "number" && typeof saved.label === "string") {
      return { lon: saved.lon, lat: saved.lat, label: saved.label, minutes: clampMinutes(Number(saved.minutes)) }
    }
  } catch {
    // Ignore a broken saved trip and use the area center.
  }
  return null
}

function centerTrip(target: Area, minutes: number): Trip {
  return { lon: target.lon, lat: target.lat, label: target.name, minutes }
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
  syncSearchName()
}

function remember(trip: Trip) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trip))
  localStorage.setItem(AREA_KEY, area.id)
}

function writeUrl(trip: Trip) {
  const url = new URL(window.location.href)
  url.searchParams.set("lat", trip.lat.toFixed(5))
  url.searchParams.set("lng", trip.lon.toFixed(5))
  url.searchParams.set("min", String(trip.minutes))
  url.searchParams.set("q", trip.label)
  url.searchParams.set("area", area.id)
  history.replaceState(null, "", url)
}

function applyArea(next: Area) {
  area = next
  areaOpenName.textContent = next.name.split(" ")[0] ?? next.name
  areaOpen.setAttribute("aria-label", `Area: ${next.name}. Change area`)
  listingUi.setOrigin(next.name)
  syncSearchName()
}

function wireAreas() {
  for (const item of AREAS) {
    const row = document.createElement("li")
    const button = document.createElement("button")
    button.type = "button"
    button.dataset.area = item.id
    const name = document.createElement("strong")
    name.textContent = item.name
    const detail = document.createElement("span")
    detail.textContent = item.detail
    button.append(name, detail)
    button.addEventListener("click", () => closeAreaPicker(item))
    row.append(button)
    areaList.append(row)
  }
  areaOpen.addEventListener("click", () => {
    void pickArea(false).then((picked) => {
      if (!picked) return
      const before = { ...(selected ?? centerTrip(area, DEFAULT_MINUTES)), minutes: clampMinutes(Number(minutesInput.value)) }
      const trip = centerTrip(picked, before.minutes)
      applyTrip(trip)
      void runTrip(trip, false, picked).then((ok) => {
        if (!ok) applyTrip(before)
      })
    })
  })
  areaClose.addEventListener("click", () => closeAreaPicker(null))
  document.querySelector("#area-backdrop")?.addEventListener("click", () => closeAreaPicker(null))
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !areaPicker.hidden) closeAreaPicker(null)
  })
}

/**
 * Show the area picker. On a first visit it is locked (no Close, no backdrop
 * dismiss) and the curtain card steps aside. Resolves with the chosen area, or
 * null when dismissed.
 */
function pickArea(locked: boolean): Promise<Area | null> {
  closeAreaPicker(null, true)
  pickLocked = locked
  areaPicker.hidden = false
  areaPicker.dataset.locked = locked ? "true" : "false"
  areaClose.hidden = locked
  curtain.classList.toggle("is-picking", locked)
  areaOpen.setAttribute("aria-expanded", "true")
  const buttons = [...areaList.querySelectorAll<HTMLButtonElement>("button")]
  for (const button of buttons) {
    if (!locked && button.dataset.area === area.id) button.setAttribute("aria-current", "true")
    else button.removeAttribute("aria-current")
  }
  const current = buttons.find((button) => button.dataset.area === area.id) ?? buttons[0]
  current?.focus()
  return new Promise((resolve) => {
    pickResolve = resolve
  })
}

function closeAreaPicker(picked: Area | null, force = false) {
  const resolve = pickResolve
  if (!resolve) return
  if (!picked && pickLocked && !force) return
  pickResolve = null
  areaPicker.hidden = true
  curtain.classList.remove("is-picking")
  areaOpen.setAttribute("aria-expanded", "false")
  if (!pickLocked) areaOpen.focus()
  resolve(picked)
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
