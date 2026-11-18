import { computeReach } from "./compute.ts"
import { isTuesdayMorning, nextTuesdayMorning } from "./tuesday.ts"

export async function handleReach(url: URL): Promise<Response> {
  try {
    const lon = Number(url.searchParams.get("lon") ?? url.searchParams.get("lng"))
    const lat = Number(url.searchParams.get("lat"))
    const minutes = Number(url.searchParams.get("min") ?? url.searchParams.get("minutes"))
    const label = cleanLabel(url.searchParams.get("q") ?? url.searchParams.get("label") ?? "Start")
    const departParam = url.searchParams.get("depart") ?? ""
    const depart = isTuesdayMorning(departParam) ? departParam : nextTuesdayMorning()
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return json({ error: "Enter a place on the map." }, 400)
    }
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 30) {
      return json({ error: "Drive time needs to be a whole number from 5 to 30 minutes." }, 400)
    }
    const result = await computeReach({ lon, lat, minutes, label, depart })
    const bytes = result.body.buffer.slice(result.body.byteOffset, result.body.byteOffset + result.body.byteLength)
    return new Response(bytes as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=3600, s-maxage=43200, stale-while-revalidate=86400",
        "X-Reach-Mae": String(Math.round(result.mae * 10) / 10),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "The drive could not be timed"
    console.error("[reach]", message)
    return json({ error: message }, 502)
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

function cleanLabel(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120)
  return cleaned || "Start"
}
