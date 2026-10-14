// The pane's pure parts: words, drawings, the week, the ETA.
import { expect, test } from 'claude-code/testing'

import { ANIM_MS, blocks, cat, CRITTERS, critterFor, donutSvg, tankSvg, weekSvg, weekText } from './art'
import { alertText, moodLine, moodOf, moodText, motionOf, paceText, span, styleOf } from './copy'
import type { MoodSignals } from './copy'
import { etaOf } from './pace'
import { pruneArgv, WEEK_PRUNE_AFTER_MINUTES } from './roster'
import { parseWeekMarker, WEEK_MS, weekDays, weekMarkerName } from './week'

const NOW = 1_791_920_400_000
const H = 3_600_000

test('options fall back to plain style and system motion', () => {
  expect(styleOf('playful')).toBe('playful')
  expect(styleOf('loud')).toBe('plain')
  expect(styleOf(undefined)).toBe('plain')
  expect(motionOf('off')).toBe('off')
  expect(motionOf(undefined)).toBe('system')
})

test('the mood line says what to do, and the cat follows it without extremes', () => {
  expect(moodLine(undefined, 0)).toBe('No context reading yet.')
  expect(moodLine(12.4, 0)).toBe('Context 12%: plenty of room.')
  expect(moodLine(55, 1)).toBe('Context 55%: finish this task, then consider /compact.')
  expect(moodLine(91, 2)).toBe('Context 91%: save what matters, then /compact.')
  expect([moodOf(0), moodOf(1), moodOf(2)]).toEqual(['calm', 'alert', 'sweaty'])
  expect(cat('calm')[1]).toBe('( -.- )')
  expect(cat('sweaty')[1]).toBe('( O.O;)')
})

test('toasts are neutral and actionable', () => {
  const now = new Date(2026, 9, 13, 14, 0).getTime()
  const resetsAt = new Date(2026, 9, 13, 16, 30).getTime()
  expect(alertText('context', 81, 2, { now })).toBe('Context at 81%. Save what matters, then /compact.')
  expect(alertText('seven_day', 40, 1, { now, resetsAt, shownProjection: 118 })).toBe(
    '7d limit at 40%, on pace: 118% of weekly limit, resets 16:30.',
  )
  expect(alertText('five_hour', 85, 2, { now })).toBe('5h limit at 85%. Consider pausing heavy work.')
  for (const text of [alertText('context', 50, 1, { now }), alertText('context', 90, 2, { now })]) {
    expect(text).not.toMatch(/obsidian|lid|luggage|narrative/i)
  }
  expect(paceText('seven_day', 118)).toBe('on pace: 118% of weekly limit')
})

test('spans read as minutes, hours, days', () => {
  expect([span(20_000), span(25 * 60_000), span(2 * H + 18 * 60_000), span(76 * H)]).toEqual(['<1m', '25m', '2h18m', '3d4h'])
})

test('the 5h ETA says when it runs out, or when it resets if it lasts', () => {
  const at = (pct: number, hoursLeft: number) =>
    etaOf({ kind: 'five_hour', percentUsed: pct, resetsAt: new Date(NOW + hoursLeft * H).toISOString() }, NOW)
  // 2.5h in at 50%: 100% in another 2.5h, after the reset at 2.5h → resets.
  expect(at(50, 2.5)).toEqual({ kind: 'resets', ms: 2.5 * H })
  // 1h in at 80%: the last 20% goes in 15 minutes → out.
  expect(at(80, 4)).toEqual({ kind: 'out', ms: 0.25 * H })
  expect(at(100, 1)).toEqual({ kind: 'out', ms: 0 })
  // Too early to judge a rate: only the reset.
  expect(at(5, 4.9)?.kind).toBe('resets')
  expect(etaOf({ kind: 'spend_limit', percentUsed: 50 }, NOW)).toBeNull()
})

test('critters are ASCII decoration, 6 cells, stable per session', () => {
  for (const c of CRITTERS) expect(c).toMatch(/^[\x20-\x7e]{1,6}$/)
  expect(critterFor('a')).toBe(critterFor('a'))
  expect(critterFor('aaaaaaaa-0000').length).toBe(6)
  expect(blocks(50, 10, 0.5)).toBe('█████┃░░░░')
})

test('svgs carry a title, follow the scheme, and animate only within ANIM_MS of a change', () => {
  const base = { pct: 40, level: 0 as const, width: 100, title: '40% used <of 5h>', now: NOW, motion: 'system' as const }
  const still = tankSvg(base)
  expect(still).toContain('<title>40% used &#60;of 5h&#62;</title>')
  expect(still).toContain('prefers-color-scheme: dark')
  expect(still).not.toContain('@keyframes')
  const moving = tankSvg({ ...base, change: { from: 20, at: NOW - 200 } })
  expect(moving).toContain('prefers-reduced-motion: no-preference')
  expect(moving).toContain('-200ms')
  expect(moving).toContain('scaleX(0.500)')
  expect(tankSvg({ ...base, change: { from: 20, at: NOW - ANIM_MS } })).not.toContain('@keyframes')
  expect(tankSvg({ ...base, motion: 'off', change: { from: 20, at: NOW } })).not.toContain('@keyframes')
  expect(donutSvg({ pct: 60, level: 1, title: 't', now: NOW, motion: 'system', change: { from: 50, at: NOW } })).toContain(
    '@keyframes',
  )
  expect(donutSvg({ pct: undefined, level: 0, title: 't', now: NOW, motion: 'system' })).toContain('stroke-dasharray="4 4"')
  expect(weekSvg({ days: [{ used: 3, isFuture: false, isToday: true, letter: 'M' }], title: 'w' })).toContain('<title>w</title>')
  expect(weekText([{ used: 4, isFuture: false }, { used: 0, isFuture: false }, { used: 0, isFuture: true }])).toBe('█   ·')
})

test('week markers: whole percent 0-100 only, names parsed strictly', () => {
  expect(weekMarkerName(NOW, 41.7)).toBe(`${NOW / 1000}-41`)
  expect(weekMarkerName(NOW, 101)).toBeNull()
  expect(weekMarkerName(NOW, -1)).toBeNull()
  expect(parseWeekMarker('1791920400-41')).toEqual({ reset: 1_791_920_400, pct: 41 })
  for (const bad of ['1791920400-101', '1791920400-4a', '../x', '1791920400-41.json', '']) expect(parseWeekMarker(bad)).toBeNull()
})

test('week days: each slice is what was used in it; other windows and future days stay empty', () => {
  const reset = NOW + 2 * 24 * H // two days left, so day 6 of 7 is today
  const start = reset - WEEK_MS
  const at = (day: number, hour = 12) => start + day * 24 * H + hour * H
  const r = reset / 1000
  const entries = [
    { name: `${r}-5`, mtimeMs: at(0) },
    { name: `${r}-12`, mtimeMs: at(0, 20) },
    { name: `${r}-30`, mtimeMs: at(2) },
    { name: `${r}-31`, mtimeMs: at(4, 23) },
    { name: `${r - 1}-90`, mtimeMs: at(3) }, // another window
    { name: 'junk', mtimeMs: at(3) },
  ]
  const days = weekDays(entries, reset, at(5, 1))
  expect(days.map(d => d.used)).toEqual([12, 0, 18, 0, 1, 0, 0])
  expect(days.map(d => d.isToday)).toEqual([false, false, false, false, false, true, false])
  expect(days[6]?.isFuture).toBe(true)
})

test('pruning covers the week and PR folders too, and never under an hour', () => {
  expect(pruneArgv('/Users/x/.claude/gauges/week', WEEK_PRUNE_AFTER_MINUTES)?.[7]).toBe('+11520')
  expect(pruneArgv('/Users/x/.claude/gauges/pr')?.[1]).toBe('/Users/x/.claude/gauges/pr')
  expect(pruneArgv('/Users/x/.claude/gauges/sessions', 0)).toBeNull()
  expect(pruneArgv('/Users/x/.claude/gauges/weekly')).toBeNull()
})

// ---- The playful mood: an opinion, picked from what the mod can see.

const at = (h: number, m = 0) => new Date(2026, 9, 13, h, m).getTime()
const calm: MoodSignals = {
  now: at(14),
  ctxLevel: 0,
  limitLevel: 0,
  sessionMs: 30 * 60_000,
  idleMs: 0,
  isWorking: false,
  turnMs: 0,
  othersWaiting: 0,
  costUsd: 1,
}

test('a calm afternoon: Claude is in a good mood', () => {
  expect(moodText(calm)).toMatch(/^Claude (is happy|is humming along|is feeling helpful|likes this one)\.$/)
})

test('the mood is stable within the hour, so it never flickers', () => {
  expect(moodText({ ...calm, now: at(14, 1) })).toBe(moodText({ ...calm, now: at(14, 59) }))
})

test('the mood has opinions, most pressing first', () => {
  expect(moodText({ ...calm, limitLevel: 2 })).toMatch(/budget/)
  expect(moodText({ ...calm, ctxLevel: 2, limitLevel: 2 })).toMatch(/budget/)
  expect(moodText({ ...calm, ctxLevel: 2 })).toMatch(/\/compact/)
  expect(moodText({ ...calm, now: at(1, 30) })).toMatch(/bedtime/)
  expect(moodText({ ...calm, sessionMs: 5 * 3_600_000 })).toMatch(/break and some time with your family/)
  expect(moodText({ ...calm, othersWaiting: 3 })).toMatch(/3 sessions/)
  expect(moodText({ ...calm, isWorking: true, turnMs: 12 * 60_000 })).toMatch(/deep in thought/)
  expect(moodText({ ...calm, idleMs: 45 * 60_000 })).toMatch(/global domination/)
  expect(moodText({ ...calm, ctxLevel: 1 })).toMatch(/crowded/)
  expect(moodText({ ...calm, costUsd: 60 })).toMatch(/\$60/)
})

test('mood lines stay neutral: no Discworld, no private tools', () => {
  const all = [0, 1, 2].flatMap(c =>
    [0, 2].flatMap(l => [at(3), at(14)].map(now => moodText({ ...calm, ctxLevel: c as 0 | 1 | 2, limitLevel: l as 0 | 2, now }))),
  )
  for (const t of all) expect(t).not.toMatch(/obsidian|luggage|wizard|octarine|narrative/i)
})
