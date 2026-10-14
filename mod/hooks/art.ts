// Drawings: the header cat, per-session critters (decoration only: status is
// always a word and a colour), and the SVGs. Pure, so each is tested.
//
// SVGs are drawn in a sandboxed frame that follows the app's light or dark
// scheme and the OS reduced-motion setting, both through CSS media queries.
// Animation plays only for a change: each one is anchored to when the value
// changed, with a negative delay, so a redraw mid-way resumes rather than
// restarts, and once ANIM_MS has passed the drawing carries none.
import type { Motion, Mood } from './copy'
import type { Level } from './pace'
import { fnv1a } from './roster'

export const ANIM_MS = 700

/** Hues that read on light and dark; the numbers beside them are themed Text. */
export const HEX = ['#2f9e44', '#d08700', '#d03b3b'] as const

const CAT_FACE: Record<Mood, string> = { calm: '( -.- )', alert: '( o.o )', sweaty: '( O.O;)' }

/** The header cat (playful style): two ASCII lines, its face following context. */
export function cat(mood: Mood): [string, string] {
  return [' /\\_/\\ ', CAT_FACE[mood]]
}

export const CRITTERS = ['=^.^=', '(o.o)', '<:3)~', '(\\_/)', ">('')<", '{o,o}', '/\\oo/\\', '(=^w^)', '~(oo)~', '<(-.-)']

/** A session's critter, the same in every pane for that id: ASCII, 6 cells wide. */
export function critterFor(id: string): string {
  return (CRITTERS[fnv1a(id) % CRITTERS.length] ?? '(o.o)').padEnd(6)
}

/** A text bar for surfaces without Svg; `marker` (0 to 1) marks the window's clock. */
export function blocks(pct: number, width: number, marker?: number): string {
  const filled = Math.round((clamp(pct) / 100) * width)
  const cells = ('█'.repeat(filled) + '░'.repeat(width - filled)).split('')
  if (marker !== undefined) cells[Math.min(width - 1, Math.round(marker * (width - 1)))] = '┃'
  return cells.join('')
}

/** A value's last change, for animating from where it was. */
export type Change = { from: number; at: number }

/** CSS that animates class `a` once, mid-way if `now` is past the change; '' when none should play. */
function animation(keyframes: string, change: Change | undefined, now: number, motion: Motion): string {
  if (motion === 'off' || change === undefined) return ''
  const elapsed = now - change.at
  if (elapsed < 0 || elapsed >= ANIM_MS) return ''
  return (
    '@media (prefers-reduced-motion: no-preference){' +
    `.a{animation:g ${ANIM_MS}ms ease-out ${-Math.round(elapsed)}ms 1 both}}` +
    `@keyframes g{${keyframes}}`
  )
}

const SCHEME =
  '.t{fill:rgba(0,0,0,0.12)}.m{fill:rgba(0,0,0,0.55)}.r{stroke:rgba(0,0,0,0.12)}' +
  '@media (prefers-color-scheme: dark){.t{fill:rgba(255,255,255,0.16)}.m{fill:rgba(255,255,255,0.7)}.r{stroke:rgba(255,255,255,0.16)}}'

function svg(width: number, height: number, title: string, style: string, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<title>${escapeXml(title)}</title><style>${SCHEME}${style}</style>${body}</svg>`
  )
}

/** A limit's tank: fill to `pct`, a tick where the window's clock stands. */
export function tankSvg(o: {
  pct: number
  level: Level
  width: number
  title: string
  marker?: number
  change?: Change
  now: number
  motion: Motion
}): string {
  const h = 10
  const w = (clamp(o.pct) / 100) * o.width
  const from = o.change === undefined || w === 0 ? 1 : (clamp(o.change.from) / 100) * o.width / w
  const anim = animation(`from{transform:scaleX(${from.toFixed(3)})}to{transform:scaleX(1)}`, o.change, o.now, o.motion)
  const tick =
    o.marker === undefined
      ? ''
      : `<rect class="m" x="${Math.min(o.width - 2, Math.max(0, o.marker * o.width - 1)).toFixed(1)}" width="2" height="${h}"/>`
  return svg(
    o.width,
    h,
    o.title,
    `.a{transform-box:fill-box;transform-origin:0 50%}${anim}`,
    `<rect class="t" width="${o.width}" height="${h}" rx="5"/>` +
      `<rect class="a" width="${w.toFixed(1)}" height="${h}" rx="5" fill="${HEX[o.level]}"/>${tick}`,
  )
}

/** The context donut; a dashed ring when there is no reading. */
export function donutSvg(o: {
  pct: number | undefined
  level: Level
  title: string
  change?: Change
  now: number
  motion: Motion
}): string {
  const r = 26
  const c = 2 * Math.PI * r
  const dash = (pct: number) => `${((clamp(pct) / 100) * c).toFixed(1)} ${c.toFixed(1)}`
  const track = `<circle class="r" cx="32" cy="32" r="${r}" fill="none" stroke-width="8"${o.pct === undefined ? ' stroke-dasharray="4 4"' : ''}/>`
  if (o.pct === undefined) return svg(64, 64, o.title, '', track)
  const anim =
    o.change === undefined
      ? ''
      : animation(`from{stroke-dasharray:${dash(o.change.from)}}to{stroke-dasharray:${dash(o.pct)}}`, o.change, o.now, o.motion)
  const arc = `<circle class="a" cx="32" cy="32" r="${r}" fill="none" stroke="${HEX[o.level]}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${dash(o.pct)}" transform="rotate(-90 32 32)"/>`
  return svg(64, 64, o.title, anim, track + arc)
}

/** The week: one bar per day of the window, scaled to the busiest day. */
export function weekSvg(o: { days: { used: number; isFuture: boolean; isToday: boolean }[]; title: string }): string {
  const bw = 14
  const gap = 6
  const h = 28
  const most = Math.max(1, ...o.days.map(d => d.used))
  const bars = o.days
    .map((d, i) => {
      const x = i * (bw + gap)
      if (d.isFuture) return `<rect class="t" x="${x}" y="${h - 2}" width="${bw}" height="2" rx="1"/>`
      const bh = Math.max(2, (d.used / most) * h)
      return `<rect class="${d.isToday ? 'm' : 't'}" x="${x}" y="${(h - bh).toFixed(1)}" width="${bw}" height="${bh.toFixed(1)}" rx="2"/>`
    })
    .join('')
  return svg(o.days.length * (bw + gap) - gap, h, o.title, '', bars)
}

function clamp(pct: number): number {
  return Math.min(100, Math.max(0, pct))
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, ch => `&#${ch.charCodeAt(0)};`)
}
