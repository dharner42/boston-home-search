/* Generated at build time. CACHE and PRECACHE are replaced by the Vite plugin. */
const CACHE = "%%CACHE%%"
const LISTINGS_CACHE = "listings-v1"
const TILE_CACHE = "tiles-v1"
const REACH_CACHE = "reach-v1"
const PRECACHE = %%PRECACHE%%

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE && key !== LISTINGS_CACHE && key !== TILE_CACHE && key !== REACH_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin === self.location.origin) {
    if (url.pathname === "/sw.js") return
    if (/^\/data\/listings(-[a-z]+)?\.json$/.test(url.pathname)) {
      event.respondWith(listingsFirst(request))
      return
    }
    if (url.pathname === "/api/reach") {
      event.respondWith(networkFirst(request, REACH_CACHE))
      return
    }
    if (url.pathname.startsWith("/data/")) {
      event.respondWith(staleWhileRevalidate(event))
      return
    }
    event.respondWith(appShell(request))
    return
  }
  if (isMapTile(url)) event.respondWith(tileCache(request))
})

async function listingsFirst(request) {
  try {
    const fresh = await fetch(request)
    if (fresh.ok) {
      const cache = await caches.open(LISTINGS_CACHE)
      await cache.put(request, fresh.clone())
    }
    return fresh
  } catch {
    const cached = await caches.match(request)
    if (cached) return cached
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
}

async function appShell(request) {
  if (request.mode === "navigate") {
    try {
      const fresh = await fetch(request)
      if (fresh.ok) {
        const cache = await caches.open(CACHE)
        await cache.put("/", fresh.clone())
        await cache.put("/index.html", fresh.clone())
      }
      return fresh
    } catch {
      return (await caches.match("/index.html")) || (await caches.match("/")) || Response.error()
    }
    }

  const cached = await caches.match(request)
  if (cached) return cached
  try {
    const fresh = await fetch(request)
    if (fresh.ok) {
      const cache = await caches.open(CACHE)
      await cache.put(request, fresh.clone())
    }
    return fresh
  } catch {
    return cached || Response.error()
  }
}

function staleWhileRevalidate(event) {
  const cachedPromise = caches.open(CACHE).then((cache) => cache.match(event.request))
  const update = fetch(event.request)
    .then(async (fresh) => {
      if (fresh.ok) {
        const cache = await caches.open(CACHE)
        await cache.put(event.request, fresh.clone())
      }
      return fresh
    })
    .catch(() => null)
  event.waitUntil(update.then(() => undefined))
  return cachedPromise.then((cached) => cached || update.then((fresh) => fresh || Response.error()))
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const fresh = await fetch(request)
    if (fresh.ok) await cache.put(request, fresh.clone())
    return fresh
  } catch {
    return (await cache.match(request)) || Response.error()
  }
}

function isMapTile(url) {
  const mapboxTile =
    url.hostname === "api.mapbox.com" &&
    (url.pathname.includes("/v4/") || url.pathname.includes("/tiles/") || url.pathname.endsWith(".pbf"))
  return (
    mapboxTile ||
    url.hostname.endsWith("openfreemap.org") ||
    url.hostname.endsWith("cartocdn.com") ||
    url.hostname.endsWith("basemaps.cartocdn.com")
  )
}

async function tileCache(request) {
  const cache = await caches.open(TILE_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  try {
    const fresh = await fetch(request)
    if (fresh.ok) cache.put(request, fresh.clone())
    return fresh
  } catch (error) {
    if (cached) return cached
    throw error
  }
}
