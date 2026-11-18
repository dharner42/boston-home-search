/** Turn a Vercel Node `req.url` (a path) or an absolute URL into a URL with query params. */

export type HeaderLookup = {
  get(name: string): string | null
}

export function reachRequestUrl(rawUrl: string | undefined, headers: HeaderLookup): URL {
  const raw = rawUrl && rawUrl.length > 0 ? rawUrl : "/api/reach"
  if (/^https?:\/\//i.test(raw)) return new URL(raw)
  const host = firstValue(headers.get("x-forwarded-host")) || firstValue(headers.get("host")) || "localhost"
  const proto = firstValue(headers.get("x-forwarded-proto")) || "https"
  return new URL(raw, `${proto}://${host}`)
}

function firstValue(value: string | null): string {
  if (!value) return ""
  return value.split(",")[0]?.trim() ?? ""
}
