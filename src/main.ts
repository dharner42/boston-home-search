import "@fontsource-variable/fraunces"
import "@fontsource-variable/outfit"
import "maplibre-gl/dist/maplibre-gl.css"
import "./style.css"

import { mountMap, type FrameName, type MapHandle } from "./map-view.ts"
import type { Meta, Streets } from "./types.ts"

// Milestone 2 pins: call prepareListingPins() from src/listings.ts and add a
// circle/symbol layer. Drive times through 20 minutes are already on the
// features. A missing /data/listings.json is an empty set, not an error.

const app = must(document.querySelector<HTMLElement>("#app"), "app")
const curtain = must(document.querySelector<HTMLElement>("#curtain"), "curtain")
const curtainStatus = must(document.querySelector<HTMLElement>("#curtain-status"), "curtain status")
const errorPanel = must(document.querySelector<HTMLElement>("#error"), "error")
const errorText = must(document.querySelector<HTMLElement>("#error-text"), "error text")
const action = must(document.querySelector<HTMLButtonElement>("#action"), "action")
const legend = must(document.querySelector<HTMLElement>("#legend"), "legend")
const retry = must(document.querySelector<HTMLButtonElement>("#retry"), "retry")

retry.addEventListener("click", () => window.location.reload())

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
const frame = frameParam(new URLSearchParams(window.location.search).get("frame"))

void boot()
registerServiceWorker()

async function boot() {
  let handle: MapHandle | null = null
  action.addEventListener("click", () => {
    if (!handle) return
    if (action.textContent === "Skip") handle.skip()
    else handle.replay()
  })

  try {
    const [meta, streets] = await Promise.all([loadJson<Meta>("/data/meta.json"), loadJson<Streets>("/data/streets.geojson")])
    if (!streets.features?.length) throw new Error("The drive-time streets file is empty.")
    renderLegend(meta)
    handle = await mountMap(document.querySelector<HTMLElement>("#map")!, meta, streets, (ui) => {
      action.hidden = false
      action.textContent = ui.label
      app.dataset.state = ui.state
    })
    await fadeCurtain()
    if (frame) handle.pose(frame)
    else if (reducedMotion) handle.pose("end")
    else handle.play()
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong loading the map."
    curtain.classList.add("is-gone")
    errorPanel.hidden = false
    errorText.textContent = message
    app.dataset.state = "error"
  }
}

function renderLegend(meta: Meta) {
  legend.replaceChildren()
  const kicker = document.createElement("p")
  kicker.className = "legend-kicker"
  kicker.textContent = "From the school"
  const list = document.createElement("ul")
  for (const band of meta.bands) {
    const item = document.createElement("li")
    item.dataset.band = String(band.band)
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
  note.textContent = meta.note
  legend.append(kicker, list, note)
}

async function fadeCurtain() {
  curtain.classList.add("is-fading")
  await wait(520)
  curtain.classList.add("is-gone")
  curtainStatus.textContent = ""
}

async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`)
  return (await res.json()) as T
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
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The map still works online if the worker fails to install.
    })
  })
}
