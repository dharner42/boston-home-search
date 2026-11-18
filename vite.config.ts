import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, loadEnv, type Plugin } from "vite"

const root = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "")
  if (env.VITE_MAPBOX_TOKEN) process.env.VITE_MAPBOX_TOKEN ??= env.VITE_MAPBOX_TOKEN
  return {
  appType: "mpa",
  server: {
    host: "0.0.0.0",
    port: 4731,
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 4731,
    strictPort: true,
    allowedHosts: true,
  },
  plugins: [serviceWorkerPlugin(), manifestContentType(), reachApiPlugin()],
}})

function reachApiPlugin(): Plugin {
  const attach = (server: { ssrLoadModule: (url: string) => Promise<{ handleReach: (url: URL) => Promise<Response> }>; middlewares: { use: (fn: (req: { url?: string }, res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: Buffer | string) => void }, next: () => void) => void) => void } }) => {
    server.middlewares.use(async (req, res, next) => {
      const path = req.url?.split("?")[0] ?? ""
      if (path !== "/api/reach") return next()
      try {
        const mod = await server.ssrLoadModule("/src/reach/handler.ts")
        const response = await mod.handleReach(new URL(req.url ?? "/", "http://localhost"))
        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        res.end(Buffer.from(await response.arrayBuffer()))
      } catch (error) {
        res.statusCode = 500
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "The drive could not be timed" }))
      }
    })
  }
  return {
    name: "reach-api",
    configureServer: attach,
    configurePreviewServer: attach,
  }
}

function manifestContentType(): Plugin {
  const attach = (server: { middlewares: { use: (fn: (req: { url?: string }, res: { setHeader: (name: string, value: string) => void; writeHead: (...args: unknown[]) => unknown }, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      const path = req.url?.split("?")[0] ?? ""
      if (path.endsWith(".webmanifest")) {
        const setHeader = res.setHeader.bind(res)
        res.setHeader = (name: string, value: string) => {
          if (name.toLowerCase() === "content-type") value = "application/manifest+json"
          setHeader(name, value)
        }
      }
      next()
    })
  }
  return {
    name: "manifest-content-type",
    configurePreviewServer: attach,
    configureServer: attach,
  }
}

function serviceWorkerPlugin(): Plugin {
  return {
    name: "boston-home-search-sw",
    apply: "build",
    closeBundle() {
      const dist = join(root, "dist")
      const skip = new Set([
        "/sw.js",
        "/data/listings.json",
        "/data/streets.geojson",
        "/data/streets-15-20.geojson",
        "/data/streets.bin",
        "/data/reach.bin",
        "/data/travel-grid.json",
        "/data/method.json",
      ])
      // Per-area listings and baked drives are fetched on demand, not precached.
      const perArea = /^\/data\/(listings|reach|method)-[a-z]+\.(json|bin)$/
      const files = walk(dist).filter((file) => !skip.has(file) && !perArea.test(file))
      if (!files.includes("/")) files.unshift("/")
      const hash = createHash("sha256")
      for (const file of files) {
        if (file === "/") continue
        hash.update(file)
        hash.update(readFileSync(join(dist, file.slice(1))))
      }
      const template = readFileSync(join(root, "src/sw-template.js"), "utf8")
      const sw = template
        .replace("%%CACHE%%", `shell-${hash.digest("hex").slice(0, 12)}`)
        .replace("%%PRECACHE%%", JSON.stringify(files))
      writeFileSync(join(dist, "sw.js"), sw)
    },
  }
}

function walk(dir: string, dist = dir): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path, dist))
    else out.push(`/${relative(dist, path).split("\\").join("/")}`)
  }
  return out
}
