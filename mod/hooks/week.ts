// The week's per-day bars. Each session leaves an empty marker file
// ~/.claude/gauges/week/<reset>-<pct> the first time it sees the weekly limit at
// a whole percent (reset in epoch seconds); the file's mtime says when. Any
// session can then rebuild the week from the folder. Names are untrusted.
import type { WeekDay } from '../types'

export const WEEK_MS = 7 * 86_400_000
const DAY_MS = 86_400_000
const MARKER = /^(\d{9,11})-(\d{1,3})$/

/** The marker for a reading, or null when it is not a usable one. */
export function weekMarkerName(resetsAtMs: number, pct: number): string | null {
  if (!Number.isFinite(resetsAtMs) || !Number.isFinite(pct) || pct < 0 || pct > 100) return null
  return `${Math.floor(resetsAtMs / 1000)}-${Math.floor(pct)}`
}

export function parseWeekMarker(name: string): { reset: number; pct: number } | null {
  const m = MARKER.exec(name)
  if (m === null) return null
  const pct = Number(m[2])
  return pct <= 100 ? { reset: Number(m[1]), pct } : null
}

/**
 * Seven slices of the window that resets at `resetsAtMs`, each the weekly
 * percentage used during it: the highest marker by its end, less the one
 * before. Markers of another window, or dated outside this one, are ignored.
 */
export function weekDays(entries: { name: string; mtimeMs: number }[], resetsAtMs: number, now: number): WeekDay[] {
  const start = resetsAtMs - WEEK_MS
  const reset = Math.floor(resetsAtMs / 1000)
  const marks = entries.flatMap(e => {
    const m = parseWeekMarker(e.name)
    return m !== null && m.reset === reset && e.mtimeMs >= start && e.mtimeMs < resetsAtMs ? [{ pct: m.pct, at: e.mtimeMs }] : []
  })
  const days: WeekDay[] = []
  let before = 0
  for (let i = 0; i < 7; i++) {
    const dayStart = start + i * DAY_MS
    const dayEnd = dayStart + DAY_MS
    const byEnd = Math.max(before, ...marks.filter(m => m.at < dayEnd).map(m => m.pct))
    const isFuture = dayStart > now
    days.push({ start: dayStart, used: isFuture ? 0 : byEnd - before, isToday: now >= dayStart && now < dayEnd, isFuture })
    before = byEnd
  }
  return days
}
