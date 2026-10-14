// The pace rule for usage limits, pure so it unit-tests directly and so the
// shared contract vectors (contract-vectors.ts) can drive it. statusline.sh
// implements the same rule in jq; both suites run the same vectors.
import type { Limit } from '../types'

export type Level = 0 | 1 | 2
export type Thresholds = { warnAt: number; highAt: number }
export type Pace = { level: Level; elapsed?: number; projected?: number }

export const WARN_AT = 50
export const HIGH_AT = 80
export const PACE_WARN = 100
export const PACE_HIGH = 125
export const MIN_ELAPSED = 0.1
export const WINDOW_MS: Readonly<Record<string, number>> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }

export const DEFAULT_THRESHOLDS: Thresholds = { warnAt: WARN_AT, highAt: HIGH_AT }

export function levelOf(pct: number | undefined, t: Thresholds = DEFAULT_THRESHOLDS): Level {
  return pct === undefined ? 0 : pct >= t.highAt ? 2 : pct >= t.warnAt ? 1 : 0
}

/**
 * Limits follow pace: where usage lands at the reset if it keeps going.
 * Raw highAt is the backstop; before MIN_ELAPSED of the window only it applies.
 * A window of unknown length (a gateway's spend limit) uses the fixed levels.
 */
export function paceOf(limit: Limit, now: number, t: Thresholds = DEFAULT_THRESHOLDS): Pace {
  const windowMs = WINDOW_MS[limit.kind]
  const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
  if (windowMs === undefined || !Number.isFinite(resetsAt)) return { level: levelOf(limit.percentUsed, t) }
  const elapsed = Math.min(1, Math.max(0, 1 - (resetsAt - now) / windowMs))
  const isBackstop = limit.percentUsed >= t.highAt
  if (elapsed < MIN_ELAPSED) return { level: isBackstop ? 2 : 0, elapsed }
  const projected = limit.percentUsed / elapsed
  const level: Level = isBackstop || projected >= PACE_HIGH ? 2 : projected >= PACE_WARN ? 1 : 0
  return { level, elapsed, projected }
}

/** The projection a display shows: whole percent, and only once it is off pace. */
export function shownProjection(pace: Pace): number | null {
  return pace.projected !== undefined && pace.projected >= PACE_WARN ? Math.floor(pace.projected) : null
}

export type Eta = { kind: 'out' | 'resets'; ms: number }

/**
 * When a windowed limit runs out at the current rate, or, when it lasts, when
 * it resets. Null without a window and a reset time. Before MIN_ELAPSED the rate
 * means little, so only the reset is given.
 */
export function etaOf(limit: Limit, now: number): Eta | null {
  const windowMs = WINDOW_MS[limit.kind]
  const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
  if (windowMs === undefined || !Number.isFinite(resetsAt)) return null
  const resetsIn = Math.max(0, resetsAt - now)
  if (limit.percentUsed >= 100) return { kind: 'out', ms: 0 }
  const elapsedMs = Math.min(windowMs, Math.max(0, windowMs - resetsIn))
  if (elapsedMs / windowMs < MIN_ELAPSED || limit.percentUsed <= 0) return { kind: 'resets', ms: resetsIn }
  const outIn = ((100 - limit.percentUsed) * elapsedMs) / limit.percentUsed
  return outIn < resetsIn ? { kind: 'out', ms: outIn } : { kind: 'resets', ms: resetsIn }
}
