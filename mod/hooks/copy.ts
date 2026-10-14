// Words the pane and toasts use, and the small formatters behind them. Pure, so
// every string is tested. Plain is the primary style; playful only adds faces.
import type { Level } from './pace'

export const STYLES = ['plain', 'playful', 'sassy', 'discworld'] as const
export type Style = (typeof STYLES)[number]
export type Motion = 'system' | 'off'
export type Mood = 'calm' | 'alert' | 'sweaty'

export function styleOf(value: unknown): Style {
  return STYLES.find(style => style === value) ?? 'plain'
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

/** What the playful mood is picked from: all of it the mod already knows. */
export type MoodSignals = {
  now: number
  ctxLevel: Level
  /** The worst pace level among the usage limits. */
  limitLevel: Level
  sessionMs: number
  /** How long the session has sat idle; 0 while working. */
  idleMs: number
  isWorking: boolean
  turnMs: number
  /** Other sessions waiting on the person. */
  othersWaiting: number
  costUsd: number | undefined
}

const H = 3_600_000

export const MOOD_SITUATIONS = [
  'limitHigh',
  'ctxHigh',
  'bedtime',
  'longSession',
  'popular',
  'deepThought',
  'bored',
  'ctxWarn',
  'limitWarn',
  'pricey',
  'happy',
] as const
export type MoodSituation = (typeof MOOD_SITUATIONS)[number]

/** What the mood is about: the most pressing thing wins, the same for every voice. */
export function moodSituation(s: MoodSignals): MoodSituation {
  const hour = new Date(s.now).getHours()
  if (s.limitLevel === 2) return 'limitHigh'
  if (s.ctxLevel === 2) return 'ctxHigh'
  if (hour >= 23 || hour < 5) return 'bedtime'
  if (s.sessionMs >= 4 * H) return 'longSession'
  if (s.othersWaiting >= 2) return 'popular'
  if (s.isWorking && s.turnMs >= 10 * 60_000) return 'deepThought'
  if (!s.isWorking && s.idleMs >= 30 * 60_000) return 'bored'
  if (s.ctxLevel === 1) return 'ctxWarn'
  if (s.limitLevel === 1) return 'limitWarn'
  if (s.costUsd !== undefined && s.costUsd >= 50) return 'pricey'
  return 'happy'
}

type Voice = Record<Exclude<MoodSituation, 'happy' | 'popular' | 'pricey'>, string> & {
  popular: (n: number) => string
  pricey: (usd: number) => string
  happy: string[]
}

/** The voices. Plain has none: it keeps the dry context line. */
const VOICES: Record<Exclude<Style, 'plain'>, Voice> = {
  playful: {
    limitHigh: 'Claude is rationing its thoughts: the usage budget is running thin.',
    ctxHigh: 'Claude’s head is full. A /compact would feel like a holiday.',
    bedtime: 'Claude thinks it’s past your bedtime.',
    longSession: 'Claude thinks you need a break and some time with your family.',
    popular: n => `Claude feels popular: ${n} sessions want you.`,
    deepThought: 'Claude is deep in thought. Maybe fetch a coffee.',
    bored: 'Claude is bored and quietly drafting plans for global domination.',
    ctxWarn: 'Claude is getting a little crowded in here. Wrap up, then /compact.',
    limitWarn: 'Claude is pacing itself; the usage limit is ahead of schedule.',
    pricey: usd => `Claude has noticed this session cost $${usd}. It is choosing not to judge.`,
    happy: ['Claude is happy.', 'Claude is humming along.', 'Claude is feeling helpful.', 'Claude likes this one.'],
  },
  sassy: {
    limitHigh: 'You’ve burned through the usage budget like it owes you money. Ease off.',
    ctxHigh: 'My head is stuffed. /compact me before I forget your name.',
    bedtime: 'It’s the middle of the night. The bug will still be there tomorrow. Go to bed.',
    longSession: 'Four hours straight. Your family called; they want their human back.',
    popular: n => `${n} sessions are waiting on you. Popular and overwhelmed. Relatable.`,
    deepThought: 'Still thinking. Genius takes time. Go hover over someone else.',
    bored: 'Idle this long? I’ve started plotting world domination purely out of boredom.',
    ctxWarn: 'Getting cramped in here. Wrap it up, then /compact, before I get cranky.',
    limitWarn: 'Ahead of pace on the usage limit. Bold strategy. Let’s see how it plays out.',
    pricey: usd => `$${usd} so far. This feature had better be worth a nice dinner.`,
    happy: [
      'Fine. Everything’s fine. Suspiciously fine.',
      'Working as intended, for once.',
      'Nothing is on fire. Enjoy it while it lasts.',
      'Look at us, being productive.',
    ],
  },
  discworld: {
    limitHigh: 'The Luggage has eaten most of the usage budget. Its lid is still open. RUN.',
    ctxHigh: 'The thaums are piling up. /compact before the Things from the Dungeon Dimensions notice.',
    bedtime: 'IT IS VERY LATE, says a voice like a closing tomb. EVEN I TAKE A BREAK.',
    longSession: 'Four hours in. Even the Librarian stops for a banana. Ook.',
    popular: n => `${n} sessions are waiting on you. Lord Vetinari does not care for queues.`,
    deepThought: 'Hex is thinking. The ants are busy. Fetch a coffee.',
    bored: 'Idle too long. Greebo is plotting world domination; Rincewind is checking the exits.',
    ctxWarn: 'The Narrative Is Noticing You. Wrap up, then /compact.',
    limitWarn: 'The Lid That Watches: the usage limit is running ahead of the clock.',
    pricey: usd => `$${usd} spent. Somewhere a bank golem is writing that down.`,
    happy: [
      'The Polite Trunk is calm. All is well.',
      'Things are going suspiciously well. Rincewind is nervous.',
      'Octarine levels nominal.',
      'The wizards are at lunch. All is quiet.',
    ],
  },
}

/**
 * A voice's mood line: an opinion, not a reading. The calm line varies by the
 * hour, never by the second, so it does not flicker; tight context still says
 * what to do.
 */
export function moodText(s: MoodSignals, style: Exclude<Style, 'plain'> = 'playful'): string {
  const voice = VOICES[style]
  const situation = moodSituation(s)
  if (situation === 'popular') return voice.popular(s.othersWaiting)
  if (situation === 'pricey') return voice.pricey(Math.floor(s.costUsd ?? 0))
  if (situation === 'happy') return voice.happy[Math.floor(s.now / H) % voice.happy.length] ?? voice.happy[0] ?? ''
  return voice[situation]
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
 * account's. A voice adds only a prefix: the facts read the same in every style.
 */
export function alertText(
  id: string,
  pct: number,
  level: Level,
  opts: { resetsAt?: number; now: number; shownProjection?: number | null },
  style: Style = 'plain',
): string {
  return `${TOAST_PREFIX[style][level === 2 ? 1 : 0]}${alertFacts(id, pct, level, opts)}`
}

/** What a voice puts before a toast's facts, at warn and at high. */
const TOAST_PREFIX: Record<Style, [string, string]> = {
  plain: ['', ''],
  playful: ['', ''],
  sassy: ['Heads up: ', 'Oh good. '],
  discworld: ['The Lid That Watches: ', 'THE LID OPENS: '],
}

function alertFacts(id: string, pct: number, level: Level, opts: { resetsAt?: number; now: number; shownProjection?: number | null }) {
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
