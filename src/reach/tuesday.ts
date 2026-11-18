/** Next Tuesday 08:00 in America/New_York, as Mapbox `depart_at` local time. */

const TZ = "America/New_York"

export function nextTuesdayMorning(now = new Date()): string {
  for (let add = 0; add < 8; add++) {
    const date = new Date(now.getTime() + add * 86_400_000)
    const parts = nyParts(date)
    if (parts.weekday !== "Tue") continue
    const instant = zonedTimeToUtc(parts.year, parts.month, parts.day, 8, 0)
    if (instant.getTime() > now.getTime() + 60_000) {
      return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T08:00`
    }
  }
  throw new Error("Could not find the next Tuesday morning")
}

export function isTuesdayMorning(value: string, now = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T08:00$/.test(value)) return false
  const [date] = value.split("T")
  const [year, month, day] = date.split("-").map(Number)
  if (!year || !month || !day) return false
  const instant = zonedTimeToUtc(year, month, day, 8, 0)
  const delta = instant.getTime() - now.getTime()
  const dayMs = 86_400_000
  if (delta < -60_000 || delta > 21 * dayMs) return false
  return nyParts(instant).weekday === "Tue"
}

function nyParts(date: Date): { weekday: string; year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const bag: Record<string, string> = {}
  for (const part of fmt.formatToParts(date)) bag[part.type] = part.value
  return { weekday: bag.weekday ?? "", year: Number(bag.year), month: Number(bag.month), day: Number(bag.day) }
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute))
  const offset = tzOffset(guess, TZ)
  const instant = new Date(guess.getTime() - offset)
  const drift = tzOffset(instant, TZ) - offset
  return drift === 0 ? instant : new Date(instant.getTime() - drift)
}

function tzOffset(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const bag: Record<string, string> = {}
  for (const part of fmt.formatToParts(date)) bag[part.type] = part.value
  const asUtc = Date.UTC(
    Number(bag.year),
    Number(bag.month) - 1,
    Number(bag.day),
    Number(bag.hour) % 24,
    Number(bag.minute),
    Number(bag.second),
  )
  return asUtc - date.getTime()
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0")
}
