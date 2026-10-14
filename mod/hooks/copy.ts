// Words the pane and toasts use, and the small formatters behind them. Pure, so
// every string is tested. Plain is the primary style; playful only adds faces.
import type { Level } from './pace'

export type Style = 'plain' | 'playful'
export type Motion = 'system' | 'off'
export type Mood = 'calm' | 'alert' | 'sweaty'

export function styleOf(value: unknown): Style {
  return value === 'playful' ? 'playful' : 'plain'
}

export function motionOf(value: unknown): Motion {
  return value === 'off' ? 'off' : 'system'
}

export function moodOf(level: Level): Mood {
  return level === 2 ? 'sweaty' : level === 1 ? 'alert' : 'calm'
}

/** One line under the header: what context means for the person, and what to do. */
export function moodLine(pct: number | undefined, level: Level): string {
  if (pct === undefined) return 'No context reading yet.'
  if (level === 2) return `Context ${Math.round(pct)}%: save what matters, then /compact.`
  if (level === 1) return `Context ${Math.round(pct)}%: finish this task, then consider /compact.`
  return `Context ${Math.round(pct)}%: plenty of room.`
}

export const STATUS_WORD = {
  'needs-you': 'needs you',
  working: 'working',
  idle: 'idle',
  ended: 'ended',
  unknown: 'unknown',
} as const

export function limitLabel(kind: string): string {
  return kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'Spend' : kind
}

function windowName(kind: string): string {
  return kind === 'seven_day' ? 'weekly limit' : kind === 'five_hour' ? '5h limit' : `${limitLabel(kind)} limit`
}

/** "on pace: 118% of weekly limit" */
export function paceText(kind: string, shown: number): string {
  return `on pace: ${shown}% of ${windowName(kind)}`
}

/**
 * The toast for a crossing. Context speaks for this session; limits are the
 * account's. No style changes the words, so a toast reads the same to everyone.
 */
export function alertText(
  id: string,
  pct: number,
  level: Level,
  opts: { resetsAt?: number; now: number; shownProjection?: number | null },
): string {
  if (id === 'context') {
    return level === 2
      ? `Context at ${Math.round(pct)}%. Save what matters, then /compact.`
      : `Context at ${Math.round(pct)}%. Finish this task, then consider /compact.`
  }
  const parts = [`${limitLabel(id)} limit at ${Math.round(pct)}%`]
  if (opts.shownProjection != null) parts.push(paceText(id, opts.shownProjection))
  if (opts.resetsAt !== undefined) parts.push(`resets ${clock(opts.resetsAt, opts.now)}`)
  return `${parts.join(', ')}.${level === 2 ? ' Consider pausing heavy work.' : ''}`
}

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A local wall-clock time; a weekday too when it is not within the day. */
export function clock(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return '?'
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return Math.abs(ms - now) > 20 * 3600 * 1000 ? `${DAYS[d.getDay()]} ${hm}` : hm
}

/** A running turn's length: "42s", "3m07s". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** A span ahead or behind: "25m", "2h18m", "3d4h"; under a minute is "<1m". */
export function span(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

export function kilo(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`
}
