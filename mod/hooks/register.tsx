import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import type { Limit, RosterRow, Task, Turn, Usage } from '../types'
import {
  buildRecord,
  cut,
  labelFor,
  markerName,
  MAX_FILE_BYTES,
  MAX_ROWS,
  parseRecord,
  PERSON_TOOLS,
  pruneArgv,
  promptsForPermission,
  rowFileId,
  SESSION_ID,
  sortRows,
  STALE_MS,
  statusLine,
} from './roster'
import type { Identity } from './roster'

const PANE = 'gauges'
const IDLE: Turn = { isRunning: false, startedAt: 0, endedAt: 0, tools: 0, activity: null }

const usageAtom = atom({ plugin: 'gauges', key: 'usage' } as const, null)
const modelAtom = atom({ plugin: 'gauges', key: 'model' } as const, null)
const turnAtom = atom({ plugin: 'gauges', key: 'turn' } as const, IDLE)
const tickAtom = atom({ plugin: 'gauges', key: 'tick' } as const, 0)
const tasksAtom = atom({ plugin: 'gauges', key: 'tasks' } as const, [])
const isTasksOpenAtom = atom({ plugin: 'gauges', key: 'isTasksOpen' } as const, false)
const agentsAtom = atom({ plugin: 'gauges', key: 'agentsRunning' } as const, 0)
const alertsAtom = atom({ plugin: 'gauges', key: 'alerts' } as const, {})
const needsAtom = atom({ plugin: 'gauges', key: 'needs' } as const, null)
const rosterAtom = atom({ plugin: 'gauges', key: 'roster' } as const, [])
const isSessionsOpenAtom = atom({ plugin: 'gauges', key: 'isSessionsOpen' } as const, true)

// Cross-session roster: each session writes its own file; every pane reads them all.
// The kill switch: false stops it in every session on the next reload.
const ROSTER_ENABLED = true
const WRITE_DELAY_MS = 2000
const KEEPALIVE_MS = 30_000
const READ_EVERY_MS = 5000

type Level = 0 | 1 | 2
type Reading = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

// SVG is drawn as an image, so it carries no text and uses fixed hues that
// read on light and dark; the numbers beside it are Text in theme colours.
const HEX = ['#2f9e44', '#d08700', '#d03b3b'] as const
const THEME = ['success', 'warning', 'error'] as const
const WORD = ['', '⚠ rising', '⚠ high'] as const
const TRACK = 'rgba(128,128,128,0.28)'
const MARKER = 'rgba(128,128,128,0.9)'
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ACTIVE = new Set(['pending', 'running', 'waiting'])
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }
const PACE_WARN = 100
const PACE_HIGH = 125
const MIN_ELAPSED = 0.1

let warnAt = 50
let highAt = 80
let tickTimer: Timer | undefined
let agentPoll: Timer | undefined
let sessionFile: string | undefined
let identity: Identity | undefined
let repoRoot: string | null = null
let pendingWrite: Timer | undefined
let keepalive: Timer | undefined
let rosterDir: string | undefined
let toastDir: string | undefined
let rosterPoll: Timer | undefined
let asksForPermission = false
let isTerminalSession = false
let isFirstRosterRead = true
let seenAsks = new Set<string>()
let othersWaiting: RosterRow[] = []
let shownStatus: string | undefined

function levelOf(pct?: number): Level {
  return pct === undefined ? 0 : pct >= highAt ? 2 : pct >= warnAt ? 1 : 0
}

type Pace = { level: Level; elapsed?: number; projected?: number }

// Limits follow pace: where usage lands at the reset if it keeps going.
// Raw highAt is the backstop; before MIN_ELAPSED of the window only it applies.
// A window of unknown length (a gateway's spend limit) uses the fixed levels.
function paceOf(limit: Limit, now: number): Pace {
  const windowMs = WINDOW_MS[limit.kind]
  const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
  if (windowMs === undefined || !Number.isFinite(resetsAt)) return { level: levelOf(limit.percentUsed) }
  const elapsed = Math.min(1, Math.max(0, 1 - (resetsAt - now) / windowMs))
  const isBackstop = limit.percentUsed >= highAt
  if (elapsed < MIN_ELAPSED) return { level: isBackstop ? 2 : 0, elapsed }
  const projected = limit.percentUsed / elapsed
  const level: Level = isBackstop || projected >= PACE_HIGH ? 2 : projected >= PACE_WARN ? 1 : 0
  return { level, elapsed, projected }
}

function startTick($: EngineInterface) {
  tickTimer ??= $.clock.every(1000, () => {
    void $.clock.now().then(now => update($, tickAtom, () => now))
  })
}

async function refreshAgents($: EngineInterface) {
  const running = (await $.agent.list()).filter(a => ACTIVE.has(a.status)).length
  await update($, agentsAtom, () => running)
  scheduleWrite($)
  if (running > 0) {
    agentPoll ??= $.clock.every(5000, () => void refreshAgents($))
  } else {
    agentPoll?.cancel()
    agentPoll = undefined
  }
}

// One toast per upward crossing; dropping back below re-arms it.
async function checkAlerts($: EngineInterface, usage: Usage) {
  const now = await $.clock.now()
  const readings = [
    { id: 'context', label: 'Context', pct: usage.percent, pace: { level: levelOf(usage.percent) } as Pace, resetsAt: undefined as string | undefined },
    ...usage.limits.map(l => ({ id: l.kind, label: `${limitLabel(l.kind)} limit`, pct: l.percentUsed, pace: paceOf(l, now), resetsAt: l.resetsAt })),
  ]
  const seen = await read($, alertsAtom)
  const levels: Record<string, number> = { ...seen }
  for (const r of readings) {
    const level = r.pace.level
    if (level > (seen[r.id] ?? 0) && r.pct !== undefined) {
      // Limits are the account's, seen by every session alike: one toast per
      // window and level. Context is this session's own.
      const isMine = r.id === 'context' || (await claimToast($, markerName('limit', r.id, r.resetsAt ?? 'none', level)))
      if (isMine) $.ui.toast(alertText(r.id, r.label, r.pct, level, r.resetsAt, now, r.pace.projected))
    }
    levels[r.id] = level
  }
  await update($, alertsAtom, () => levels)
}

async function startRoster($: EngineInterface, cwd: string) {
  if (!ROSTER_ENABLED) return
  const home = await $.env.get('HOME')
  const id = await $.session.id()
  if (home === undefined || !home.startsWith('/') || !SESSION_ID.test(id)) return
  const dir = `${home}/.claude/gauges/sessions`
  repoRoot = (await $.session.repo())?.root ?? null
  identity = { id, label: labelFor(cwd, repoRoot), branch: await branchOf($, repoRoot) }
  sessionFile = `${dir}/${id}.json`
  rosterDir = dir
  toastDir = `${home}/.claude/gauges/toasts`
  await prune($, [dir, toastDir])
  await writeRecord($)
  await $.process.run(['chmod', '700', `${home}/.claude/gauges`, dir])
  keepalive ??= $.clock.every(KEEPALIVE_MS, () => void writeRecord($))
  await readRoster($)
  rosterPoll ??= $.clock.every(READ_EVERY_MS, () => void readRoster($))
}

// Removes rows and toast markers untouched for a day; concurrent sessions
// pruning at once only race to delete the same files, which is harmless.
async function prune($: EngineInterface, dirs: string[]) {
  for (const dir of dirs) {
    const argv = pruneArgv(dir)
    if (argv !== null) await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)
  }
}

// Every session's row, freshest first. A file that fails to parse (caught
// mid-write, or planted) keeps that session's last good row; links, oversized
// and stale files are skipped; ended sessions drop out.
async function readRoster($: EngineInterface) {
  if (rosterDir === undefined) return
  try {
    const now = await $.clock.now()
    const entries = (await $.fs.list(rosterDir))
      .filter(f => f.kind === 'file' && !f.isLink && f.size <= MAX_FILE_BYTES && now - f.mtimeMs <= STALE_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_ROWS)
    const current = await read($, rosterAtom)
    const lastGood = new Map(current.map(row => [row.id, row]))
    const rows: RosterRow[] = []
    for (const entry of entries) {
      const id = rowFileId(entry.name)
      if (id === null) continue
      const text = await $.fs.read(`${rosterDir}/${entry.name}`).catch(() => null)
      const row = (typeof text === 'string' ? parseRecord(text, id) : null) ?? lastGood.get(id) ?? null
      if (row !== null && row.status !== 'ended') rows.push(row)
    }
    const sorted = sortRows(rows)
    if (JSON.stringify(sorted) !== JSON.stringify(current)) await update($, rosterAtom, () => sorted)
    await noticeOthers($, sorted)
  } catch {
    // the next poll tries again
  }
}

async function branchOf($: EngineInterface, root: string | null): Promise<string | null> {
  if (root === null) return null
  const git = await $.process.run(['git', 'branch', '--show-current'], { cwd: root, timeoutMs: 3000 }).catch(() => undefined)
  const branch = git?.exitCode === 0 ? git.stdout.trim() : ''
  return branch === '' ? null : cut(branch, 60)
}

// Coalesces bursts of changes into one write at most every WRITE_DELAY_MS.
function scheduleWrite($: EngineInterface) {
  if (sessionFile === undefined) return
  pendingWrite ??= $.clock.after(WRITE_DELAY_MS, () => {
    pendingWrite = undefined
    void writeRecord($)
  })
}

// Best effort: a failed write leaves the last one in place, and the pane goes on.
async function writeRecord($: EngineInterface, isEnded = false) {
  if (sessionFile === undefined || identity === undefined) return
  try {
    const [usage, model, turn, tasks, agents, needs] = await Promise.all([
      read($, usageAtom),
      read($, modelAtom),
      read($, turnAtom),
      read($, tasksAtom),
      read($, agentsAtom),
      read($, needsAtom),
    ])
    const record = buildRecord(identity, { usage, model, turn, tasks, agents, needs }, isEnded)
    await $.fs.write(sessionFile, JSON.stringify(record))
    await $.process.run(['chmod', '600', sessionFile])
  } catch {
    // the keepalive tries again
  }
}

// Toasts once when another session starts waiting on the person (not for asks
// already open when this session started), and keeps the terminal's line current.
async function noticeOthers($: EngineInterface, rows: RosterRow[]) {
  othersWaiting = rows.filter(r => r.status === 'needs-you' && r.id !== identity?.id)
  const keys = othersWaiting.map(r => `${r.id}:${r.since}`)
  if (!isFirstRosterRead) {
    for (const r of othersWaiting) {
      const isNew = !seenAsks.has(`${r.id}:${r.since}`)
      if (isNew && (await claimToast($, markerName('ask', r.id, r.since)))) {
        $.ui.toast(`◆ ${r.label} needs you: ${r.needs ?? 'input'}`)
      }
    }
  }
  seenAsks = new Set(keys)
  isFirstRosterRead = false
  await refreshStatus($)
}

// Terminal only: the status line stays blank unless something needs the person.
async function refreshStatus($: EngineInterface) {
  if (!isTerminalSession) return
  const usage = await read($, usageAtom)
  const now = await $.clock.now()
  const warnings = (usage?.limits ?? []).flatMap(l => {
    const pace = paceOf(l, now)
    if (pace.level === 0) return []
    const label = limitLabel(l.kind)
    return [pace.projected === undefined ? `${label} at ${Math.round(l.percentUsed)}%` : `${label} on pace for ${Math.round(pace.projected)}%`]
  })
  const text = statusLine(othersWaiting, warnings)
  if (text !== shownStatus) {
    shownStatus = text
    $.ui.status(text)
  }
}

// True when this session should show the toast for `marker`: the first session
// to claim it does, the rest stay quiet. A race costs one duplicate at worst;
// with no marker folder (no usable HOME) every session toasts, as before.
async function claimToast($: EngineInterface, marker: string): Promise<boolean> {
  if (toastDir === undefined) return true
  const path = `${toastDir}/${marker}`
  try {
    if (await $.fs.exists(path)) return false
    await $.fs.write(path, '')
    return true
  } catch {
    return true
  }
}

async function setNeeds($: EngineInterface, what: string, callId?: string) {
  const since = await $.clock.now()
  await update($, needsAtom, () => ({ what, since, callId }))
  await writeRecord($)
}

// Clears this call's ask, or with no id any ask (the turn ended).
async function clearNeeds($: EngineInterface, callId?: string) {
  const needs = await read($, needsAtom)
  if (needs === null || (callId !== undefined && needs.callId !== callId)) return
  await update($, needsAtom, () => null)
  await writeRecord($)
}

async function storeUsage($: EngineInterface, reading: Reading) {
  const previous = await read($, usageAtom)
  const startedAt = 'startedAt' in reading ? Number(reading.startedAt) : (previous?.startedAt ?? 0)
  const usage = toUsage(reading, startedAt)
  await update($, usageAtom, () => usage)
  await checkAlerts($, usage)
  await refreshStatus($)
  return usage
}

export const register: Register = (on, options) => {
  warnAt = Number(options.warnPercent ?? 50)
  highAt = Number(options.highPercent ?? 80)
  tickTimer = undefined
  agentPoll = undefined
  sessionFile = undefined
  identity = undefined
  repoRoot = null
  pendingWrite = undefined
  keepalive = undefined
  rosterDir = undefined
  toastDir = undefined
  rosterPoll = undefined
  asksForPermission = false
  isTerminalSession = false
  isFirstRosterRead = true
  seenAsks = new Set()
  othersWaiting = []
  shownStatus = undefined

  on('session.start', async ($, e, next) => {
    isTerminalSession = e.surface === 'terminal'
    asksForPermission = promptsForPermission(await $.settings.read().catch(() => ({})))
    await $.command.register({
      name: 'gauges',
      description: 'Toggle the gauges pane: model, context, limits, cost and progress',
    })
    const [model, usage] = await Promise.all([$.session.model(), $.session.usage()])
    await update($, modelAtom, () => model)
    await storeUsage($, usage)
    if ((await read($, turnAtom)).isRunning) startTick($)
    await refreshAgents($)
    await startRoster($, e.cwd).catch(() => undefined)
    // The terminal has a status line; the pane opens itself only where one is missing.
    if ((await $.session.surfaces()).some(s => s !== 'terminal')) void $.ui.open({ id: PANE, title: 'Gauges' })

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    if (e.surface !== 'terminal') void $.ui.open({ id: PANE, title: 'Gauges' })
    return next(e)
  })

  on('command.run', { command: 'gauges' }, async $ => {
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane?.isShown) {
      await $.ui.close({ id: PANE })
      return { text: 'Gauges pane closed.' }
    }
    await $.ui.open({ id: PANE, title: 'Gauges' })
    return { text: 'Gauges pane opened.' }
  })

  on('session.measure', async ($, e, next) => {
    await storeUsage($, e)
    scheduleWrite($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    pendingWrite?.cancel()
    keepalive?.cancel()
    rosterPoll?.cancel()
    await writeRecord($, true)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const usage = await read($, usageAtom)
    await update($, turnAtom, t => ({
      ...t,
      isRunning: true,
      startedAt: now,
      tools: 0,
      activity: null,
      costAtStart: usage?.costUsd,
    }))
    await update($, tickAtom, () => now)
    const model = await $.session.model()
    await update($, modelAtom, () => model)
    if (identity !== undefined) identity = { ...identity, branch: await branchOf($, repoRoot) }
    startTick($)
    scheduleWrite($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      tickTimer?.cancel()
      tickTimer = undefined
      const now = await $.clock.now()
      const cost = (await $.session.usage()).cost?.usd
      await update($, turnAtom, t => ({
        ...t,
        isRunning: false,
        endedAt: now,
        activity: null,
        lastCostUsd: cost !== undefined && t.costAtStart !== undefined ? cost - t.costAtStart : t.lastCostUsd,
      }))
      await clearNeeds($)
      scheduleWrite($)
    }
    await refreshAgents($)

    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    await refreshAgents($)
    return result
  }).catch(($, e, next) => next(e))

  // An ask the mode puts to the person: the dialog is up until the call resolves.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const isDialog = verdict.decision === 'ask' && asksForPermission && PERSON_TOOLS[e.tool] === undefined
    if (isDialog && e.agentId === undefined && e.tool_use_id !== undefined) {
      await setNeeds($, `approve ${e.tool}`, e.tool_use_id)
    }
    return verdict
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await update($, turnAtom, t => ({ ...t, tools: t.tools + 1, activity: e.tool }))
    const asks = PERSON_TOOLS[e.tool]
    if (asks !== undefined) await setNeeds($, asks, e.tool_use_id)
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      await clearNeeds($, e.tool_use_id)
    }
    if (ran.deny !== undefined || ran.isError === true) return ran

    if (e.tool === 'TodoWrite') {
      const tasks: Task[] = e.todos.map((t, i) => ({
        id: String(i),
        subject: t.content,
        status: t.status,
        activeForm: t.activeForm,
      }))
      await update($, tasksAtom, () => tasks)
    } else if (e.tool === 'TaskCreate') {
      const created = (ran.result as { task?: { id: string } } | undefined)?.task
      if (created !== undefined) {
        const task: Task = { id: created.id, subject: e.subject, status: 'pending', activeForm: e.activeForm }
        await update($, tasksAtom, list => [...list.filter(t => t.id !== task.id), task])
      }
    } else if (e.tool === 'TaskUpdate') {
      const { taskId, status, subject, activeForm } = e
      await update($, tasksAtom, list =>
        status === 'deleted'
          ? list.filter(t => t.id !== taskId)
          : list.map(t =>
              t.id === taskId
                ? { ...t, status: status ?? t.status, subject: subject ?? t.subject, activeForm: activeForm ?? t.activeForm }
                : t,
            ),
      )
    } else if (e.tool === 'Agent') {
      await refreshAgents($)
    }
    scheduleWrite($)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The terminal's table still resolves Svg (drawn as an empty box), so the
    // surface decides, not the table.
    const isTerminal = e.surface === 'terminal'
    const Svg = !isTerminal && 'Svg' in elements ? elements.Svg : undefined
    const barWidth = Math.max(8, Math.min(30, e.props.bodyColumns - 24))

    const [roster, isSessionsOpen] = await Promise.all([read($, rosterAtom), read($, isSessionsOpenAtom)])
    const [usage, model, turn, tick, tasks, isTasksOpen, agentsRunning] = await Promise.all([
      read($, usageAtom),
      read($, modelAtom),
      read($, turnAtom),
      read($, tickAtom),
      read($, tasksAtom),
      read($, isTasksOpenAtom),
      read($, agentsAtom),
    ])
    const now = Math.max(tick, turn.endedAt, turn.startedAt)

    const clockNow = await $.clock.now()
    const meter = (key: string, pct: number, level: Level, svgWidth: number, elapsed?: number) =>
      Svg !== undefined ? (
        <Svg
          key={key}
          source={meterSvg(pct, HEX[level], svgWidth, elapsed)}
          alt={`${Math.round(pct)}% used${elapsed === undefined ? '' : `, ${Math.round(elapsed * 100)}% of the window elapsed`}`}
          width={svgWidth}
          height={8}
        />
      ) : (
        <Text color={THEME[level]}>{blocks(pct, barWidth, elapsed)}</Text>
      )

    // Sessions: every local session's row, needs-you first
    const glyph = (status: RosterRow['status']) =>
      isTerminal
        ? { 'needs-you': '!', working: '>', idle: '-', ended: 'x', unknown: '?' }[status]
        : { 'needs-you': '◆', working: '●', idle: '○', ended: '×', unknown: '?' }[status]
    const waiting = roster.filter(r => r.status === 'needs-you').length
    const sessionRow = (row: RosterRow) => {
      const isSelf = row.id === identity?.id
      const since = row.since > 0 ? clock(row.since, clockNow) : '?'
      const state = row.isMinimal
        ? row.status
        : row.status === 'needs-you'
          ? `needs you: ${row.needs ?? 'input'} · since ${since}`
          : row.status === 'working'
            ? `working since ${since}${row.task === null ? '' : ` · ${row.task}`}`
            : `${row.status} since ${since}`
      const numbers = row.isMinimal
        ? ''
        : [row.contextPct === null ? null : `ctx ${Math.round(row.contextPct)}%`, row.costUsd === null ? null : money(row.costUsd)]
            .filter(part => part !== null)
            .join(' · ')
      return (
        <Box key={`session-${row.id}`} flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={row.status === 'needs-you' ? 'warning' : row.status === 'working' ? 'claude' : undefined}>
              {glyph(row.status)}
            </Text>{' '}
            <Text bold={isSelf}>{row.label}</Text>
            {row.branch !== null && <Text dimColor> · {row.branch}</Text>}
            {isSelf && <Text dimColor> (this)</Text>}
          </Text>
          <Text dimColor={row.status !== 'needs-you'} color={row.status === 'needs-you' ? 'warning' : undefined} wrap="truncate-end">
            {`  ${state}${numbers === '' ? '' : ` · ${numbers}`}`}
          </Text>
        </Box>
      )
    }
    const sessions =
      roster.length === 0 ? null : (
        <Box flexDirection="column" marginBottom={1}>
          <Button key="sessions-toggle" plain onPress={() => update($, isSessionsOpenAtom, open => !open)}>
            {`${isSessionsOpen ? '▾' : '▸'} Sessions (${roster.length})${waiting > 0 ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''}`}
          </Button>
          {isSessionsOpen && roster.map(sessionRow)}
        </Box>
      )

    // Header and turn status
    const status = turn.isRunning ? (
      <Text color="claude">
        {isTerminal ? '>' : '●'} Working {duration(now - turn.startedAt)} · {turn.tools} tools
      </Text>
    ) : (
      <Text dimColor>
        {isTerminal ? '-' : '○'} Idle{turn.endedAt > 0 ? ` since ${clock(turn.endedAt, now)}` : ''}
      </Text>
    )
    const current = tasks.find(t => t.status === 'in_progress')
    const activity = turn.isRunning ? (current?.activeForm ?? current?.subject ?? turn.activity) : null

    // Context
    const pct = usage?.percent
    const ctxLevel = levelOf(pct)
    const ctxNumbers =
      usage?.tokens !== undefined ? `${kilo(usage.tokens)} / ${kilo(usage.window)}` : 'No reading yet'
    const context =
      Svg !== undefined ? (
        <Box flexDirection="row" alignItems="center" gap={2}>
          <Svg
            key="donut"
            source={donutSvg(pct, HEX[ctxLevel])}
            alt={pct === undefined ? 'Context: no reading yet' : `Context ${pct}% used`}
            width={64}
            height={64}
          />
          <Box flexDirection="column">
            <Text bold color={pct === undefined ? undefined : THEME[ctxLevel]}>
              {pct === undefined ? '—' : `${pct}%`} {WORD[ctxLevel]}
            </Text>
            <Text dimColor>{ctxNumbers}</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text>
            <Text color={pct === undefined ? undefined : THEME[ctxLevel]}>{blocks(pct ?? 0, barWidth)}</Text>{' '}
            {pct === undefined ? '—' : `${pct}%`} {WORD[ctxLevel]}
          </Text>
          <Text dimColor>{ctxNumbers}</Text>
        </Box>
      )

    // Usage limits
    const limits =
      usage === null || usage.limits.length === 0 ? (
        <Text dimColor>No limit readings (API billing, or none yet)</Text>
      ) : (
        <Box flexDirection="column">
          {usage.limits.map(l => {
            const pace = paceOf(l, clockNow)
            const detail = [
              pace.projected === undefined ? null : `on pace for ${Math.round(pace.projected)}%`,
              l.resetsAt === undefined ? null : `resets ${clock(Date.parse(l.resetsAt), clockNow)}`,
            ].filter(part => part !== null)
            return (
              <Box key={`limit-${l.kind}`} flexDirection="column">
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Text>{limitLabel(l.kind).padEnd(5)}</Text>
                  {meter(`meter-${l.kind}`, l.percentUsed, pace.level, 110, pace.elapsed)}
                  <Text color={THEME[pace.level]}>
                    {`${Math.round(l.percentUsed)}%`.padStart(4)} {WORD[pace.level]}
                  </Text>
                </Box>
                {detail.length > 0 && <Text dimColor>{`      ${detail.join(' · ')}`}</Text>}
              </Box>
            )
          })}
        </Box>
      )

    // Cost
    const cost =
      usage?.costUsd === undefined ? (
        <Text dimColor>No cost ledger for this session</Text>
      ) : (
        <Text>
          <Text bold>{money(usage.costUsd)}</Text> this session
          {turn.lastCostUsd !== undefined && <Text dimColor> · last turn {money(turn.lastCostUsd)}</Text>}
        </Text>
      )

    // Tasks (hidden while there are none)
    const done = tasks.filter(t => t.status === 'completed').length
    const taskSection =
      tasks.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Button key="tasks-toggle" plain onPress={() => update($, isTasksOpenAtom, open => !open)}>
            {`${isTasksOpen ? '▾' : '▸'} Tasks ${done}/${tasks.length}`}
          </Button>
          {meter('meter-tasks', (done / tasks.length) * 100, 0, 200)}
          {isTasksOpen
            ? tasks.map(t => (
                <Text key={`task-${t.id}`} dimColor={t.status === 'completed'} wrap="truncate-end">
                  {taskMark(t.status, isTerminal)} {t.status === 'in_progress' ? (t.activeForm ?? t.subject) : t.subject}
                </Text>
              ))
            : current !== undefined && (
                <Text wrap="truncate-end">
                  {taskMark('in_progress', isTerminal)} {current.activeForm ?? current.subject}
                </Text>
              )}
        </Box>
      )

    return (
      <Box flexDirection="column">
        {sessions}
        <Text wrap="truncate-end">
          <Text bold>{model ?? '…'}</Text>
          {usage !== null && usage.startedAt > 0 && <Text dimColor> · since {clock(usage.startedAt, now)}</Text>}
        </Text>
        {status}
        {activity !== null && (
          <Text dimColor wrap="truncate-end">
            {'  '}
            {activity}
          </Text>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Context</Text>
          {context}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Usage limits</Text>
          {limits}
        </Box>

        {taskSection}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Cost</Text>
          {cost}
        </Box>

        {agentsRunning > 0 && (
          <Box marginTop={1}>
            <Text>
              {agentsRunning} subagent{agentsRunning === 1 ? '' : 's'} running
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}

function toUsage(reading: Reading, startedAt: number): Usage {
  const limits: Limit[] = reading.rateLimits.map(r => ({
    kind: r.kind,
    percentUsed: r.percentUsed,
    resetsAt: r.resetsAt,
  }))
  return {
    tokens: reading.context.tokens,
    window: reading.context.window,
    percent: reading.context.percent,
    limits,
    costUsd: reading.cost?.usd,
    startedAt,
  }
}

function alertText(
  id: string,
  label: string,
  pct: number,
  level: number,
  resetsAt: string | undefined,
  now: number,
  projected?: number,
) {
  const at = `${label} at ${Math.round(pct)}%${projected === undefined ? '' : `, on pace for ${Math.round(projected)}%`}`
  const resets = resetsAt === undefined ? '' : `, resets ${clock(Date.parse(resetsAt), now)}`
  if (id === 'context') {
    return level >= 2
      ? `THE LID OPENS: ${at}. Save to Obsidian now, then compact.`
      : `The Narrative Is Noticing You: ${at}. Consider obsidian-summary.`
  }
  return level >= 2
    ? `The Homicidal Suitcase: ${at}${resets}. Type faster.`
    : `The Lid That Watches: ${at}${resets}.`
}

function limitLabel(kind: string) {
  return kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'Spend' : kind
}

function taskMark(status: Task['status'], isTerminal: boolean) {
  if (isTerminal) return status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]'
  return status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'
}

// `marker` (0 to 1) puts a tick where the window's clock stands.
function blocks(pct: number, width: number, marker?: number) {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  const cells = ('█'.repeat(filled) + '░'.repeat(width - filled)).split('')
  if (marker !== undefined) cells[Math.min(width - 1, Math.round(marker * (width - 1)))] = '┃'
  return cells.join('')
}

function donutSvg(pct: number | undefined, color: string) {
  const r = 26
  const c = 2 * Math.PI * r
  const track = `<circle cx="32" cy="32" r="${r}" fill="none" stroke="${TRACK}" stroke-width="8"${pct === undefined ? ' stroke-dasharray="4 4"' : ''}/>`
  const arc =
    pct === undefined
      ? ''
      : `<circle cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${((Math.min(100, pct) / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 32 32)"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${track}${arc}</svg>`
}

function meterSvg(pct: number, color: string, width: number, marker?: number) {
  const w = (Math.min(100, Math.max(0, pct)) / 100) * width
  const tick =
    marker === undefined
      ? ''
      : `<rect x="${Math.min(width - 2, Math.max(0, marker * width - 1)).toFixed(1)}" width="2" height="8" fill="${MARKER}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 8" width="${width}" height="8"><rect width="${width}" height="8" rx="4" fill="${TRACK}"/><rect width="${w.toFixed(1)}" height="8" rx="4" fill="${color}"/>${tick}</svg>`
}

function kilo(n: number) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function money(usd: number) {
  return `$${usd.toFixed(2)}`
}

function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function clock(ms: number, now: number) {
  if (!Number.isFinite(ms)) return '?'
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return Math.abs(ms - now) > 20 * 3600 * 1000 ? `${DAYS[d.getDay()]} ${hm}` : hm
}
