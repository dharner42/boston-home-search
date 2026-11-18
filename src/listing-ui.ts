import { formatDrive, formatFacts, formatPrice, type ListingKind, type ListingView } from "./listings.ts"

export type ListingFilter = ListingKind | "both"

export type ListingUi = {
  setListings: (listings: ListingView[]) => void
  setVisible: (visible: boolean) => void
  open: (id: string) => void
  getFilter: () => ListingFilter
  /** Name of the place listing drive times are measured from. */
  setOrigin: (name: string) => void
}

/**
 * Filter, list, and detail card for the pin layer.
 * Drive times shown here are the times stored on each listing, measured from
 * the chosen area (see src/areas.ts), not from the map's current origin.
 */
export function mountListingUi(options: {
  onFilter: (filter: ListingFilter) => void
  onFocus: (listing: ListingView) => void
}): ListingUi {
  const tools = must(document.querySelector<HTMLElement>("#listing-tools"), "listing tools")
  const sheet = must(document.querySelector<HTMLElement>("#listing-sheet"), "listing list")
  const rows = must(document.querySelector<HTMLElement>("#listing-rows"), "listing rows")
  const card = must(document.querySelector<HTMLElement>("#listing-card"), "listing card")
  const listToggle = must(document.querySelector<HTMLButtonElement>("#listing-list-toggle"), "list toggle")
  const filters = [...tools.querySelectorAll<HTMLButtonElement>("[data-kind]")]
  const photo = must(document.querySelector<HTMLImageElement>("#listing-card-img"), "listing photo")
  let listings: ListingView[] = []
  let filter: ListingFilter = "both"
  let visible = false
  let openId: string | null = null
  let originName = "Kendall School"
  let photoToken = 0
  let mixedOrigins = false
  photo.addEventListener("error", () => {
    if (photo.dataset.token === String(photoToken)) photo.hidden = true
  })

  for (const button of filters) {
    button.addEventListener("click", () => {
      const next = button.dataset.kind
      if (next !== "sale" && next !== "rent" && next !== "both") return
      filter = next
      paintFilters()
      renderRows()
      if (openId) {
        const listing = listings.find((item) => item.id === openId)
        if (!listing || !matches(listing)) closeCard()
      }
      options.onFilter(filter)
    })
  }

  listToggle.addEventListener("click", () => {
    const open = sheet.hidden
    sheet.hidden = !open
    listToggle.setAttribute("aria-expanded", open ? "true" : "false")
    listToggle.textContent = open ? "Map" : "List"
    if (open) renderRows()
  })
  document.querySelector("#listing-sheet-close")?.addEventListener("click", closeSheet)
  document.querySelector("#listing-card-close")?.addEventListener("click", closeCard)
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    if (!card.hidden) closeCard()
    else if (!sheet.hidden) closeSheet()
  })

  paintFilters()

  return {
    setListings(next) {
      listings = next
      mixedOrigins = new Set(next.map((listing) => listing.origin)).size > 1
      if (openId && !next.some((listing) => listing.id === openId)) closeCard()
      renderRows()
      applyVisibility()
    },
    setVisible(next) {
      visible = next
      applyVisibility()
    },
    open(id) {
      const listing = listings.find((item) => item.id === id)
      if (!listing || !matches(listing)) return
      openCard(listing)
    },
    getFilter: () => filter,
    setOrigin(name) {
      originName = name
      for (const note of document.querySelectorAll<HTMLElement>("[data-listing-origin]")) {
        note.textContent = `from ${name}`
      }
    },
  }

  function applyVisibility() {
    const show = visible && listings.length > 0
    tools.hidden = !show
    if (!show) {
      closeSheet()
      closeCard()
    }
  }

  function paintFilters() {
    for (const button of filters) {
      button.setAttribute("aria-pressed", button.dataset.kind === filter ? "true" : "false")
    }
  }

  function renderRows() {
    const shown = listings.filter(matches)
    rows.replaceChildren()
    if (shown.length === 0) {
      const empty = document.createElement("li")
      empty.className = "listing-empty"
      empty.textContent = "Nothing in this view."
      rows.append(empty)
      return
    }
    for (const listing of shown) {
      const item = document.createElement("li")
      const button = document.createElement("button")
      button.type = "button"
      button.className = "listing-row"
      button.dataset.kind = listing.kind
      const from = mixedOrigins && listing.originShort ? ` from ${listing.originShort}` : ""
      button.append(
        line("listing-row-top", `${formatPrice(listing)} · ${formatDrive(listing.driveMin)}${from}`),
        line("listing-row-facts", formatFacts(listing)),
        line("listing-row-address", listing.address || "Address unavailable"),
      )
      if (listing.isNew) button.append(line("listing-new", "New"))
      button.addEventListener("click", () => openCard(listing))
      item.append(button)
      rows.append(item)
    }
  }

  function openCard(listing: ListingView) {
    openId = listing.id
    const badge = must(document.querySelector<HTMLElement>("#listing-card-badge"), "listing badge")
    const price = must(document.querySelector<HTMLElement>("#listing-card-price"), "listing price")
    const facts = must(document.querySelector<HTMLElement>("#listing-card-facts"), "listing facts")
    const address = must(document.querySelector<HTMLElement>("#listing-card-address"), "listing address")
    const drive = must(document.querySelector<HTMLElement>("#listing-card-drive"), "listing drive")
    const broker = must(document.querySelector<HTMLElement>("#listing-card-broker"), "listing broker")
    const link = must(document.querySelector<HTMLAnchorElement>("#listing-card-link"), "listing link")
    price.textContent = formatPrice(listing)
    facts.textContent = `${listing.kind === "rent" ? "For rent" : "For sale"} · ${formatFacts(listing)}`
    address.textContent = listing.address || "Address unavailable"
    drive.textContent = `${formatDrive(listing.driveMin)} from ${listing.origin ?? originName}`
    broker.textContent = listing.broker
    broker.hidden = listing.broker.length === 0
    badge.hidden = !listing.isNew
    if (listing.img) {
      photoToken += 1
      photo.dataset.token = String(photoToken)
      photo.hidden = false
      photo.alt = listing.address ? `Photo of ${listing.address}` : "Listing photo"
      photo.src = listing.img
    } else {
      photoToken += 1
      photo.removeAttribute("src")
      photo.hidden = true
      photo.alt = ""
    }
    if (listing.url) {
      link.hidden = false
      link.href = listing.url
    } else {
      link.hidden = true
      link.removeAttribute("href")
    }
    card.hidden = false
    options.onFocus(listing)
  }

  function closeCard() {
    openId = null
    card.hidden = true
  }

  function closeSheet() {
    sheet.hidden = true
    listToggle.setAttribute("aria-expanded", "false")
    listToggle.textContent = "List"
  }

  function matches(listing: ListingView): boolean {
    return filter === "both" || listing.kind === filter
  }
}

function line(className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span")
  span.className = className
  span.textContent = text
  return span
}

function must<T>(value: T | null, name: string): T {
  if (value == null) throw new Error(`Map page is missing ${name}`)
  return value
}
