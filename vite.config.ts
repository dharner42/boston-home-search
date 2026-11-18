import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, type Plugin } from "vite"

const root = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
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
  plugins: [serviceWorkerPlugin(), manifestContentType()],
})

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
      const files = walk(dist).filter((file) => file !== "/sw.js" && !file.endsWith("/listings.json"))
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
