import type { IncomingMessage } from "node:http"

import { handleReach } from "../src/reach/handler.ts"
import { reachRequestUrl, type HeaderLookup } from "../src/reach/request-url.ts"

export const config = { maxDuration: 30 }

type MaybeResponse = {
  writeHead?: (status: number, headers: Record<string, string>) => void
  end?: (body?: Buffer | string) => void
}

/**
 * Vercel's Node runtime calls this with a Node request whose `url` is a path
 * (`/api/reach?...`), not an absolute URL. A Web `Request` has an absolute `url`.
 */
export default async function handler(req: IncomingMessage | Request, res?: MaybeResponse): Promise<Response | void> {
  const response = await handleReach(reachRequestUrl(readUrl(req), headerLookup(req)))
  if (res && typeof res.writeHead === "function" && typeof res.end === "function") {
    const body = Buffer.from(await response.arrayBuffer())
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    res.writeHead(response.status, headers)
    res.end(body)
    return
  }
  return response
}

function readUrl(req: IncomingMessage | Request): string {
  return typeof req.url === "string" ? req.url : ""
}

function headerLookup(req: IncomingMessage | Request): HeaderLookup {
  const headers = req.headers as { get?: (name: string) => string | null } & IncomingMessage["headers"]
  if (typeof headers?.get === "function") {
    const read = headers.get.bind(headers)
    return { get: (name) => read(name) }
  }
  return {
    get(name: string) {
      const value = headers[name.toLowerCase()]
      if (Array.isArray(value)) return value[0] ?? null
      return value ?? null
    },
  }
}
