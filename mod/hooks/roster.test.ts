import { expect, test } from 'claude-code/testing'

import { buildRecord, labelFor } from './roster'
import type { Snapshot } from './roster'

const IDLE = { isRunning: false, startedAt: 0, endedAt: 0, tools: 0, activity: null }
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  usage: null,
  model: 'claude-opus-5-5',
  turn: IDLE,
  tasks: [],
  agents: 0,
  needs: null,
  ...over,
})

test('labels come from the repo root, the folder, or say No folder', () => {
  expect(labelFor('/code/groupyBot/src', '/code/groupyBot')).toBe('groupyBot')
  expect(labelFor('/tmp/scratchy/', null)).toBe('scratchy')
  expect(labelFor('/Users/x/Library/Application Support/Claude/scratch-workspaces/a/b', null)).toBe('No folder')
})

test('needs-you outranks working, and names the ask', () => {
  const record = buildRecord(
    { id: 'a', label: 'x', branch: null },
    snapshot({ turn: { ...IDLE, isRunning: true, startedAt: 5 }, needs: { what: 'approve Bash', since: 9 } }),
  )
  expect(record).toMatchObject({ status: 'needs-you', needs: 'approve Bash', since: 9 })
})

test('the in-progress task is written cut to length', () => {
  const long = 'x'.repeat(200)
  const record = buildRecord(
    { id: 'a', label: 'x', branch: null },
    snapshot({ tasks: [{ id: '1', subject: 's', status: 'in_progress', activeForm: long }] }),
  )
  expect(record.task?.length).toBe(80)
})

import { parseRecord, rowFileId, sortRows } from './roster'
import type { RosterRow } from '../types'

const record = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, id: 'abc', label: 'groupyBot', branch: 'main', status: 'idle', needs: null, since: 1, model: 'm', contextPct: 40, costUsd: 1.5, task: null, agents: 0, startedAt: 0, ...over })

test('only well-formed row file names map to a session id', () => {
  expect(rowFileId('abc-123.json')).toBe('abc-123')
  expect(rowFileId('../etc.json')).toBe(null)
  expect(rowFileId('abc.json.tmp')).toBe(null)
  expect(rowFileId(`${'a'.repeat(65)}.json`)).toBe(null)
})

test('a row is refused when broken, oversized, or claiming another id', () => {
  expect(parseRecord('{"v":1,"id":"abc"', 'abc')).toBe(null)
  expect(parseRecord(record({ id: 'someone-else' }), 'abc')).toBe(null)
  expect(parseRecord(record({ pad: 'x'.repeat(5000) }), 'abc')).toBe(null)
  expect(parseRecord('[1,2]', 'abc')).toBe(null)
})

test('escape sequences, control and bidi characters are stripped and fields cut', () => {
  const row = parseRecord(record({ label: '\u001b]52;c;cGF3bmVk\u0007evil‮exe', task: 'y'.repeat(300) }), 'abc')
  expect(row?.label).toBe(']52;c;cGF3bmVkevilexe')
  expect(row?.task?.length).toBe(80)
})

test('numbers are clamped and wrong types dropped', () => {
  const row = parseRecord(record({ contextPct: 900, costUsd: 'lots', agents: -4 }), 'abc')
  expect(row).toMatchObject({ contextPct: 100, costUsd: null, agents: 0 })
})

test('a newer record version is shown minimally', () => {
  const row = parseRecord(record({ v: 2, status: 'working', task: 'secret plan' }), 'abc')
  expect(row).toMatchObject({ isMinimal: true, status: 'working', task: null, label: 'groupyBot' })
})

test('needs-you sorts first, then working, then most recently idle', () => {
  const row = (id: string, status: RosterRow['status'], since: number) =>
    ({ id, label: id, branch: null, status, needs: null, since, model: null, contextPct: null, costUsd: null, task: null, agents: 0, isMinimal: false }) as RosterRow
  const sorted = sortRows([row('idle-old', 'idle', 1), row('work', 'working', 5), row('idle-new', 'idle', 9), row('ask', 'needs-you', 7)])
  expect(sorted.map(r => r.id)).toEqual(['ask', 'work', 'idle-new', 'idle-old'])
})

import { pruneArgv } from './roster'

test('pruning only ever targets the two gauges folders, one level, plain files', () => {
  expect(pruneArgv('/Users/x/.claude/gauges/sessions')).toEqual([
    'find', '/Users/x/.claude/gauges/sessions', '-maxdepth', '1', '-type', 'f', '-mmin', '+1440', '-delete',
  ])
  expect(pruneArgv('/Users/x/.claude/gauges/toasts')?.[1]).toBe('/Users/x/.claude/gauges/toasts')
  for (const bad of [
    '/.claude/gauges/sessions/..',
    'relative/.claude/gauges/sessions',
    '/Users/x/.claude/gauges',
    '/Users/x/.claude/gauges/sessions/sub',
    '/Users/x/../y/.claude/gauges/sessions',
    '/Users/x/.claude/projects',
    '',
  ]) {
    expect(pruneArgv(bad)).toBe(null)
  }
})
