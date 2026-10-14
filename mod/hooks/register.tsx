import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import type { Limit, PrInfo, RepoInfo, RosterRow, Task, Turn, Usage } from '../types'
import { ANIM_MS, blocks, cat, critterFor, donutSvg, tankSvg, weekSvg, weekText } from './art'
import {
  alertText,
  clock,
  DAYS,
  duration,
  kilo,
  limitLabel,
  money,
  moodLine,
  moodOf,
  moodText,
  motionOf,
  paceText,
  span,
  STATUS_WORD,
  styleOf,
} from './copy'
import type { Motion, Style } from './copy'
import {
  cleanBranch,
  FILTER_CHECK,
  GH_ENV,
  GH_TIMEOUT_MS,
  GIT_ENV,
  GIT_TIMEOUT_MS,
  gitArgv,
  hasRepoFilter,
  LAST_COMMIT,
  ownerRepo,
  parsePr,
  parsePrCache,
  parseStatus,
  prArgv,
  prDue,
  REMOTE,
  STATUS,
} from './git'
import type { PrCache } from './git'
import { DEFAULT_THRESHOLDS, etaOf, levelOf, paceOf, shownProjection } from './pace'
import type { Level, Thresholds } from './pace'
import {
  buildRecord,
  cut,
  fnv1a,
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
  WEEK_PRUNE_AFTER_MINUTES,
} from './roster'
import type { Identity } from './roster'
import { weekDays, weekMarkerName } from './week'

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
const repoAtom = atom({ plugin: 'gauges', key: 'repo' } as const, null)
const prAtom = atom({ plugin: 'gauges', key: 'pr' } as const, null)
const weekAtom = atom({ plugin: 'gauges', key: 'week' } as const, [])
const changesAtom = atom({ plugin: 'gauges', key: 'changes' } as const, {})

// Cross-session roster: each session writes its own file; every pane reads them all.
// The kill switch: false stops it in every session on the next reload.
const ROSTER_ENABLED = true
const WRITE_DELAY_MS = 2000
const KEEPALIVE_MS = 30_000
const READ_EVERY_MS = 5000
// While the pane is on screen: the repo and PR rows, and the week, stay current.
const VISIBLE_EVERY_MS = 15_000

type Reading = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

const THEME = ['success', 'warning', 'error'] as const
const WORD = ['', '⚠ rising', '⚠ high'] as const
const ACTIVE = new Set(['pending', 'running', 'waiting'])

let thresholds: Thresholds = DEFAULT_THRESHOLDS
let style: Style = 'plain'
let motion: Motion = 'system'
let isTerminalStatusOn = false
let tickTimer: Timer | undefined
let agentPoll: Timer | undefined
let sessionFile: string | undefined
let identity: Identity | undefined
let repoRoot: string | null = null
let pendingWrite: Timer | undefined
let keepalive: Timer | undefined
let rosterDir: string | undefined
let toastDir: string | undefined
let weekDir: string | undefined
let prDir: string | undefined
let rosterPoll: Timer | undefined
let visiblePoll: Timer | undefined
let animTimer: Timer | undefined
let asksForPermission = false
let isTerminalSession = false
let isFirstRosterRead = true
let isRepoBusy = false
let isPrBusy = false
// The branch exactly as git named it, for gh only; the pane shows the cleaned one.
let prBranch: string | null = null
let seenAsks = new Set<string>()
let seenWeekMarkers = new Set<string>()
let othersWaiting: RosterRow[] = []
let shownStatus: string | undefined

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
    { id: 'context', pct: usage.percent, level: levelOf(usage.percent, thresholds), shown: null as number | null, resetsAt: undefined as string | undefined },
    ...usage.limits.map(l => {
      const pace = paceOf(l, now, thresholds)
      return { id: l.kind, pct: l.percentUsed as number | undefined, level: pace.level, shown: shownProjection(pace), resetsAt: l.resetsAt }
    }),
  ]
  const seen = await read($, alertsAtom)
  const levels: Record<string, number> = { ...seen }
  for (const r of readings) {
    if (r.level > (seen[r.id] ?? 0) && r.pct !== undefined) {
      // Limits are the account's, seen by every session alike: one toast per
      // window and level. Context is this session's own.
      const isMine = r.id === 'context' || (await claimToast($, markerName('limit', r.id, r.resetsAt ?? 'none', r.level)))
      const resetsAt = r.resetsAt === undefined ? undefined : Date.parse(r.resetsAt)
      if (isMine) $.ui.toast(alertText(r.id, r.pct, r.level, { now, resetsAt, shownProjection: r.shown }))
    }
    levels[r.id] = r.level
  }
  await update($, alertsAtom, () => levels)
}

async function startRoster($: EngineInterface, cwd: string) {
  if (!ROSTER_ENABLED) return
  const home = await $.env.get('HOME')
  const id = await $.session.id()
  if (home === undefined || !home.startsWith('/') || !SESSION_ID.test(id)) return
  const gauges = `${home}/.claude/gauges`
  const dir = `${gauges}/sessions`
  const repo = await read($, repoAtom)
  identity = { id, label: labelFor(cwd, repoRoot), branch: repo?.branch ?? null, dirty: repo === null || repo.guarded ? null : repo.changed }
  sessionFile = `${dir}/${id}.json`
  rosterDir = dir
  toastDir = `${gauges}/toasts`
  weekDir = `${gauges}/week`
  prDir = `${gauges}/pr`
  await prune($, [
    [dir, undefined],
    [toastDir, undefined],
    [weekDir, WEEK_PRUNE_AFTER_MINUTES],
    [prDir, undefined],
  ])
  // Every folder private, including ones made before this version or not yet written to.
  await $.process.run(['mkdir', '-p', '-m', '700', dir, toastDir, weekDir, prDir])
  await writeRecord($)
  await $.process.run(['chmod', '700', gauges, dir, toastDir, weekDir, prDir])
  keepalive ??= $.clock.every(KEEPALIVE_MS, () => void writeRecord($))
  await readRoster($)
  rosterPoll ??= $.clock.every(READ_EVERY_MS, () => void readRoster($))
}

// Removes rows, markers and caches past their age; concurrent sessions pruning
// at once only race to delete the same files, which is harmless.
async function prune($: EngineInterface, dirs: [string, number | undefined][]) {
  for (const [dir, minutes] of dirs) {
    const argv = pruneArgv(dir, minutes)
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

// ---- The repo and PR rows (git.ts holds the rules and the reasons).

async function git($: EngineInterface, root: string, args: string[]) {
  return $.process.run(gitArgv(root, ...args), { env: { ...GIT_ENV }, timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined)
}

// Single-flight: a refresh asked for while one runs is dropped, not queued.
async function refreshRepo($: EngineInterface) {
  if (repoRoot === null || isRepoBusy) return
  isRepoBusy = true
  try {
    const root = repoRoot
    // `--get-regexp` exits 1 when nothing matches; anything else unread fails closed.
    const filters = await git($, root, FILTER_CHECK)
    const isReadable = filters !== undefined && (filters.exitCode === 0 || filters.exitCode === 1) && !filters.isStdoutTruncated
    let info: RepoInfo | null
    if (!isReadable || hasRepoFilter(filters.stdout)) {
      info = { guarded: true, branch: null, ahead: 0, behind: 0, changed: 0, lastCommitAt: null, repo: null }
      prBranch = null
    } else {
      const status = await git($, root, STATUS)
      const parsed = status?.exitCode === 0 && !status.isStdoutTruncated ? parseStatus(status.stdout) : null
      if (parsed === null) {
        info = null
        prBranch = null
      } else {
        const [log, remote] = [await git($, root, LAST_COMMIT), await git($, root, REMOTE)]
        const seconds = log?.exitCode === 0 ? Number(log.stdout.trim()) : NaN
        info = {
          guarded: false,
          branch: parsed.branch === null ? null : cleanBranch(parsed.branch),
          ahead: parsed.ahead,
          behind: parsed.behind,
          changed: parsed.changed,
          lastCommitAt: Number.isInteger(seconds) && seconds > 0 ? seconds * 1000 : null,
          repo: remote?.exitCode === 0 ? ownerRepo(remote.stdout) : null,
        }
        prBranch = parsed.branch
      }
    }
    if (JSON.stringify(info) !== JSON.stringify(await read($, repoAtom))) await update($, repoAtom, () => info)
    if (identity !== undefined) {
      const dirty = info === null || info.guarded ? null : info.changed
      if (identity.branch !== (info?.branch ?? null) || identity.dirty !== dirty) {
        identity = { ...identity, branch: info?.branch ?? null, dirty }
        scheduleWrite($)
      }
    }
  } catch {
    // the next refresh tries again
  } finally {
    isRepoBusy = false
  }
}

// gh is asked at most once a minute per repo and branch across all sessions
// (the shared cache), backing off after failures, and only while a pane shows it.
async function refreshPr($: EngineInterface) {
  if (isPrBusy) return
  isPrBusy = true
  try {
    const repo = await read($, repoAtom)
    const branch = prBranch
    const argv = repo?.repo != null && branch !== null ? prArgv(branch, repo.repo) : null
    if (argv === null || prDir === undefined || repo?.repo == null || branch === null) {
      if ((await read($, prAtom)) !== null) await update($, prAtom, () => null)
      return
    }
    const path = `${prDir}/${markerName(repo.repo)}-${fnv1a(branch).toString(16)}.json`
    const text = await $.fs.read(path).catch(() => null)
    const cache = typeof text === 'string' ? parsePrCache(text, repo.repo, branch) : null
    const now = await $.clock.now()
    let fresh: PrCache | null = cache
    if (prDue(cache, now)) {
      const ran = await $.process.run(argv, { env: { ...GH_ENV }, timeoutMs: GH_TIMEOUT_MS }).catch(() => undefined)
      const pr = ran?.exitCode === 0 ? parsePr(ran.stdout) : null
      // stderr is only matched, never shown: "no pull requests found" is an answer, not a failure.
      const isNoPr = ran !== undefined && ran.exitCode !== 0 && /no pull requests found/i.test(ran.stderr)
      fresh =
        pr !== null || isNoPr
          ? { v: 1, repo: repo.repo, branch, fetchedAt: now, failures: 0, pr }
          : { v: 1, repo: repo.repo, branch, fetchedAt: now, failures: (cache?.failures ?? 0) + 1, pr: cache?.pr ?? null }
      await $.fs.write(path, JSON.stringify(fresh))
      await $.process.run(['chmod', '600', path]).catch(() => undefined)
    }
    const pr: PrInfo | null = fresh?.pr ?? null
    if (JSON.stringify(pr) !== JSON.stringify(await read($, prAtom))) await update($, prAtom, () => pr)
  } catch {
    // the next refresh tries again
  } finally {
    isPrBusy = false
  }
}

// ---- The week: marker files written as the weekly limit moves, read back as bars.

async function noteWeek($: EngineInterface, usage: Usage) {
  if (weekDir === undefined) return
  const week = usage.limits.find(l => l.kind === 'seven_day')
  const resetsAt = week?.resetsAt === undefined ? NaN : Date.parse(week.resetsAt)
  if (week === undefined || !Number.isFinite(resetsAt)) return
  const name = weekMarkerName(resetsAt, week.percentUsed)
  if (name === null || seenWeekMarkers.has(name)) return
  seenWeekMarkers.add(name)
  const path = `${weekDir}/${name}`
  try {
    if (!(await $.fs.exists(path))) await $.fs.write(path, '')
  } catch {
    // a marker another session already wrote, or none at all: the bars do without
  }
  await refreshWeek($)
}

async function refreshWeek($: EngineInterface) {
  if (weekDir === undefined) return
  try {
    const week = (await read($, usageAtom))?.limits.find(l => l.kind === 'seven_day')
    const resetsAt = week?.resetsAt === undefined ? NaN : Date.parse(week.resetsAt)
    if (!Number.isFinite(resetsAt)) return
    const entries = (await $.fs.list(weekDir)).filter(f => f.kind === 'file' && !f.isLink)
    const days = weekDays(entries, resetsAt, await $.clock.now())
    if (JSON.stringify(days) !== JSON.stringify(await read($, weekAtom))) await update($, weekAtom, () => days)
  } catch {
    // no folder yet
  }
}

async function isPaneVisible($: EngineInterface): Promise<boolean> {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  return pane !== undefined && pane.isShown && pane.isPlaced
}

// Best effort, and often unawaited: nothing here may reject.
async function refreshVisible($: EngineInterface) {
  try {
    if (!(await isPaneVisible($))) return
    // The playful mood follows the clock (idle, bedtime), which no state write marks.
    if (style === 'playful') $.ui.invalidate('ui.render')
    await refreshRepo($)
    await refreshPr($)
    await refreshWeek($)
  } catch {
    // the next tick tries again
  }
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

// Terminal only, and only with terminalStatus on (statusline.sh owns the
// terminal otherwise): blank unless something needs the person.
async function refreshStatus($: EngineInterface) {
  if (!isTerminalSession || !isTerminalStatusOn) return
  const usage = await read($, usageAtom)
  const now = await $.clock.now()
  const warnings = (usage?.limits ?? []).flatMap(l => {
    const pace = paceOf(l, now, thresholds)
    if (pace.level === 0) return []
    const label = limitLabel(l.kind)
    const shown = shownProjection(pace)
    return [shown === null ? `${label} at ${Math.round(l.percentUsed)}%` : `${label} ${paceText(l.kind, shown)}`]
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

// A gauge that moved by a whole percent animates from where it was; the
// changes are dropped once the animation is over, which redraws it still.
async function noteChanges($: EngineInterface, previous: Usage | null, usage: Usage) {
  if (previous === null) return
  const now = await $.clock.now()
  const moved: Record<string, { from: number; at: number }> = {}
  const note = (key: string, from: number | undefined, to: number | undefined) => {
    if (from !== undefined && to !== undefined && Math.round(from) !== Math.round(to)) moved[key] = { from, at: now }
  }
  note('context', previous.percent, usage.percent)
  for (const l of usage.limits) note(l.kind, previous.limits.find(p => p.kind === l.kind)?.percentUsed, l.percentUsed)
  if (Object.keys(moved).length === 0) return
  await update($, changesAtom, changes => ({ ...changes, ...moved }))
  animTimer?.cancel()
  animTimer = $.clock.after(ANIM_MS + 50, () => {
    animTimer = undefined
    void $.clock.now().then(at =>
      update($, changesAtom, changes => Object.fromEntries(Object.entries(changes).filter(([, c]) => at - c.at < ANIM_MS))),
    )
  })
}

async function storeUsage($: EngineInterface, reading: Reading) {
  const previous = await read($, usageAtom)
  const startedAt = 'startedAt' in reading ? Number(reading.startedAt) : (previous?.startedAt ?? 0)
  const usage = toUsage(reading, startedAt)
  await update($, usageAtom, () => usage)
  await noteChanges($, previous, usage)
  await checkAlerts($, usage)
  await noteWeek($, usage)
  await refreshStatus($)
  return usage
}

export const register: Register = (on, options) => {
  thresholds = {
    warnAt: Number(options.warnPercent ?? DEFAULT_THRESHOLDS.warnAt),
    highAt: Number(options.highPercent ?? DEFAULT_THRESHOLDS.highAt),
  }
  style = styleOf(options.style)
  motion = motionOf(options.motion)
  isTerminalStatusOn = options.terminalStatus === true
  tickTimer = undefined
  agentPoll = undefined
  sessionFile = undefined
  identity = undefined
  repoRoot = null
  pendingWrite = undefined
  keepalive = undefined
  rosterDir = undefined
  toastDir = undefined
  weekDir = undefined
  prDir = undefined
  rosterPoll = undefined
  visiblePoll = undefined
  animTimer = undefined
  asksForPermission = false
  isTerminalSession = false
  isFirstRosterRead = true
  isRepoBusy = false
  isPrBusy = false
  prBranch = null
  seenAsks = new Set()
  seenWeekMarkers = new Set()
  othersWaiting = []
  shownStatus = undefined

  on('session.start', async ($, e, next) => {
    isTerminalSession = e.surface === 'terminal'
    asksForPermission = promptsForPermission(await $.settings.read().catch(() => ({})))
    await $.command.register({
      name: 'gauges',
      description: 'Toggle the gauges pane: context, limits, cost, repo and every session',
    })
    const [model, usage] = await Promise.all([$.session.model(), $.session.usage()])
    await update($, modelAtom, () => model)
    if ((await read($, turnAtom)).isRunning) startTick($)
    await refreshAgents($)
    repoRoot = (await $.session.repo().catch(() => null))?.root ?? null
    await refreshRepo($)
    await startRoster($, e.cwd).catch(() => undefined)
    await storeUsage($, usage)
    await refreshWeek($)
    visiblePoll ??= $.clock.every(VISIBLE_EVERY_MS, () => void refreshVisible($))
    // A reload (new code, or an option changed) keeps an open pane's last tree
    // until something redraws it: ask now, so the new drawing shows at once.
    $.ui.invalidate('ui.render')
    // The terminal has a status line; the pane opens itself only where one is missing.
    if ((await $.session.surfaces()).some(s => s !== 'terminal')) void openPane($).catch(() => undefined)

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    if (e.surface !== 'terminal') void openPane($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'gauges' }, async $ => {
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane?.isShown) {
      await $.ui.close({ id: PANE })
      return { text: 'Gauges pane closed.' }
    }
    await openPane($)
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
    visiblePoll?.cancel()
    animTimer?.cancel()
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
    void refreshRepo($)
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
      void refreshRepo($)
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

    const [roster, isSessionsOpen, repo, pr, week, changes] = await Promise.all([
      read($, rosterAtom),
      read($, isSessionsOpenAtom),
      read($, repoAtom),
      read($, prAtom),
      read($, weekAtom),
      read($, changesAtom),
    ])
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
    const glyph = (status: RosterRow['status']) =>
      isTerminal
        ? { 'needs-you': '!', working: '>', idle: '-', ended: 'x', unknown: '?' }[status]
        : { 'needs-you': '◆', working: '●', idle: '○', ended: '×', unknown: '?' }[status]

    // Others waiting on the person come first, above everything.
    const waiting = roster.filter(r => r.status === 'needs-you' && r.id !== identity?.id)
    const banner =
      waiting.length === 0 ? null : (
        <Box flexDirection="column" marginBottom={1}>
          {waiting.map(r => (
            <Text key={`wait-${r.id}`} color="warning" bold wrap="truncate-end">
              {`${glyph('needs-you')} ${r.label} needs you: ${r.needs ?? 'input'}${r.since > 0 ? ` · since ${clock(r.since, clockNow)}` : ''}`}
            </Text>
          ))}
        </Box>
      )

    // Header: this session, and what its context means
    const pct = usage?.percent
    const ctxLevel = levelOf(pct, thresholds)
    const status = turn.isRunning ? (
      <Text color="claude">
        {glyph('working')} {STATUS_WORD.working} {duration(now - turn.startedAt)} · {turn.tools} tools
      </Text>
    ) : (
      <Text dimColor>
        {glyph('idle')} {STATUS_WORD.idle}
        {turn.endedAt > 0 ? ` since ${clock(turn.endedAt, now)}` : ''}
      </Text>
    )
    const current = tasks.find(t => t.status === 'in_progress')
    const activity = turn.isRunning ? (current?.activeForm ?? current?.subject ?? turn.activity) : null
    const face = cat(moodOf(ctxLevel))
    const header = (
      <Box flexDirection="row" gap={1}>
        {style === 'playful' && (
          <Box key="cat" flexDirection="column">
            <Text color={THEME[ctxLevel]}>{face[0]}</Text>
            <Text color={THEME[ctxLevel]}>{face[1]}</Text>
          </Box>
        )}
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text bold>{model ?? '…'}</Text>
            {usage !== null && usage.startedAt > 0 && <Text dimColor> · since {clock(usage.startedAt, now)}</Text>}
          </Text>
          {status}
        </Box>
      </Box>
    )
    // Plain: what the context means and what to do. Playful: Claude's mood.
    const limitLevel = Math.max(0, ...(usage?.limits ?? []).map(l => paceOf(l, clockNow, thresholds).level)) as Level
    const moodWords =
      style === 'playful'
        ? moodText({
            now: clockNow,
            ctxLevel,
            limitLevel,
            sessionMs: usage !== null && usage.startedAt > 0 ? clockNow - usage.startedAt : 0,
            idleMs: !turn.isRunning && turn.endedAt > 0 ? clockNow - turn.endedAt : 0,
            isWorking: turn.isRunning,
            turnMs: turn.isRunning ? clockNow - turn.startedAt : 0,
            othersWaiting: waiting.length,
            costUsd: usage?.costUsd,
          })
        : moodLine(pct, ctxLevel)
    const moodLevel = Math.max(ctxLevel, limitLevel) as Level
    const mood = (
      <Text color={moodLevel === 0 ? undefined : THEME[moodLevel]} dimColor={moodLevel === 0} wrap="truncate-end">
        {moodWords}
      </Text>
    )

    // Sessions: shown once there is more than this one
    const sessionRow = (row: RosterRow) => {
      const isSelf = row.id === identity?.id
      const since = row.since > 0 ? clock(row.since, clockNow) : '?'
      const state = row.isMinimal
        ? STATUS_WORD[row.status]
        : row.status === 'needs-you'
          ? `needs you: ${row.needs ?? 'input'} · since ${since}`
          : row.status === 'working'
            ? `working since ${since}${row.task === null ? '' : ` · ${row.task}`}`
            : `${STATUS_WORD[row.status]} since ${since}`
      const ctx = row.contextPct
      return (
        <Box key={`session-${row.id}`} flexDirection="column">
          <Text wrap="truncate-end">
            {style === 'playful' && <Text dimColor>{critterFor(row.id)}</Text>}
            <Text color={row.status === 'needs-you' ? 'warning' : row.status === 'working' ? 'claude' : undefined}>
              {glyph(row.status)}
            </Text>{' '}
            <Text bold={isSelf}>{row.label}</Text>
            {row.dirty !== null && row.dirty > 0 && <Text color="warning">+</Text>}
            {row.branch !== null && <Text dimColor> · {row.branch}</Text>}
            {isSelf && <Text dimColor> (this)</Text>}
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor={row.status !== 'needs-you'} color={row.status === 'needs-you' ? 'warning' : undefined}>
              {`  ${state}`}
            </Text>
            {!row.isMinimal && ctx !== null && (
              <Text>
                {'  '}
                <Text color={THEME[levelOf(ctx, thresholds)]}>{blocks(ctx, 5)}</Text>
                <Text dimColor>{` ${Math.round(ctx)}%`}</Text>
              </Text>
            )}
            {!row.isMinimal && row.costUsd !== null && <Text dimColor>{` · ${money(row.costUsd)}`}</Text>}
          </Text>
        </Box>
      )
    }
    const waitingCount = roster.filter(r => r.status === 'needs-you').length
    const sessions =
      roster.length <= 1 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Button key="sessions-toggle" plain onPress={() => update($, isSessionsOpenAtom, open => !open)}>
            {`${isSessionsOpen ? '▾' : '▸'} Sessions (${roster.length})${waitingCount > 0 ? ` · ${waitingCount} need${waitingCount === 1 ? 's' : ''} you` : ''}`}
          </Button>
          {isSessionsOpen && roster.map(sessionRow)}
        </Box>
      )

    // Context
    const ctxNumbers = usage?.tokens !== undefined ? `${kilo(usage.tokens)} / ${kilo(usage.window)}` : 'No reading yet'
    const ctxTitle = pct === undefined ? 'Context: no reading yet' : `Context ${Math.round(pct)}% used: ${ctxNumbers}`
    const context =
      Svg !== undefined ? (
        <Box flexDirection="row" alignItems="center" gap={2}>
          <Svg
            key="donut"
            source={donutSvg({ pct, level: ctxLevel, title: ctxTitle, change: changes.context, now: clockNow, motion })}
            alt={ctxTitle}
            width={64}
            height={64}
            isInteractive
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

    // Usage limits: a tank each, with pace, ETA and reset
    const tank = (l: Limit, level: Level, elapsed: number | undefined, title: string) =>
      Svg !== undefined ? (
        <Svg
          key={`tank-${l.kind}`}
          source={tankSvg({ pct: l.percentUsed, level, width: 110, title, marker: elapsed, change: changes[l.kind], now: clockNow, motion })}
          alt={title}
          width={110}
          height={10}
          isInteractive
        />
      ) : (
        <Text color={THEME[level]}>{blocks(l.percentUsed, barWidth, elapsed)}</Text>
      )
    const limits =
      usage === null || usage.limits.length === 0 ? (
        <Text dimColor>No limit readings (API billing, or none yet)</Text>
      ) : (
        <Box flexDirection="column">
          {usage.limits.map(l => {
            const pace = paceOf(l, clockNow, thresholds)
            const shown = shownProjection(pace)
            const eta = l.kind === 'five_hour' ? etaOf(l, clockNow) : null
            const resetsAt = l.resetsAt === undefined ? NaN : Date.parse(l.resetsAt)
            const title = [
              `${limitLabel(l.kind)} limit ${Math.round(l.percentUsed)}% used`,
              pace.elapsed === undefined ? null : `${Math.round(pace.elapsed * 100)}% of the window elapsed`,
              pace.projected === undefined ? null : paceText(l.kind, Math.floor(pace.projected)),
            ]
              .filter(part => part !== null)
              .join(', ')
            const when =
              eta !== null
                ? eta.kind === 'out'
                  ? `out ~${span(eta.ms)}`
                  : `resets ${span(eta.ms)}`
                : Number.isFinite(resetsAt)
                  ? `resets ${clock(resetsAt, clockNow)}`
                  : null
            return (
              <Box key={`limit-${l.kind}`} flexDirection="column">
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Text>{limitLabel(l.kind).padEnd(5)}</Text>
                  {tank(l, pace.level, pace.elapsed, title)}
                  <Text color={THEME[pace.level]}>
                    {`${Math.round(l.percentUsed)}%`.padStart(4)} {WORD[pace.level]}
                  </Text>
                </Box>
                {(shown !== null || when !== null) && (
                  <Text wrap="truncate-end">
                    {'      '}
                    {shown !== null && <Text color={THEME[pace.level]}>{paceText(l.kind, shown)}</Text>}
                    {shown !== null && when !== null && <Text dimColor> · </Text>}
                    {when !== null && <Text color={eta?.kind === 'out' ? 'error' : undefined} dimColor={eta?.kind !== 'out'}>{when}</Text>}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>
      )

    // The week, from the markers every session leaves
    const weekly = usage?.limits.find(l => l.kind === 'seven_day')
    const weekPace = weekly === undefined ? undefined : paceOf(weekly, clockNow, thresholds)
    const days = week.map(d => ({ ...d, letter: (DAYS[new Date(d.start).getDay()] ?? '?').slice(0, 1) }))
    const weekTitle = `This week: ${days.map(d => `${DAYS[new Date(d.start).getDay()]} ${d.isFuture ? '-' : `${Math.round(d.used)}%`}`).join(', ')}`
    const weekSection =
      weekly === undefined || days.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>This week</Text>
          {Svg !== undefined ? (
            <Svg key="week" source={weekSvg({ days, title: weekTitle })} alt={weekTitle} width={134} height={42} isInteractive />
          ) : (
            <Box flexDirection="column">
              <Text>{weekText(days)}</Text>
              <Text dimColor>{days.map(d => d.letter).join(' ')}</Text>
            </Box>
          )}
          {weekPace?.projected !== undefined && (
            <Text color={THEME[weekPace.level]}>{paceText('seven_day', Math.floor(weekPace.projected))}</Text>
          )}
        </Box>
      )

    // Repo and PR
    const repoLine =
      repo === null ? null : repo.guarded ? (
        <Text dimColor wrap="truncate-end">
          Repo details off: this repo sets its own git filters.
        </Text>
      ) : (
        <Text wrap="truncate-end">
          <Text bold>{repo.branch ?? 'detached'}</Text>
          <Text color={repo.changed > 0 ? 'warning' : undefined} dimColor={repo.changed === 0}>
            {repo.changed > 0 ? ` · ${repo.changed} changed` : ' · clean'}
          </Text>
          <Text dimColor>
            {repo.ahead > 0 ? ` · ahead ${repo.ahead}` : ''}
            {repo.behind > 0 ? ` · behind ${repo.behind}` : ''}
            {repo.lastCommitAt !== null ? ` · last commit ${span(clockNow - repo.lastCommitAt)} ago` : ''}
          </Text>
        </Text>
      )
    const prLine =
      pr === null ? null : (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text bold>{`PR #${pr.number}`}</Text>
            <Text dimColor>{` · ${pr.isDraft ? 'draft' : pr.state.toLowerCase()}`}</Text>
            {pr.checks.fail > 0 ? (
              <Text color="error">{` · ${pr.checks.fail} failing`}</Text>
            ) : pr.checks.pending > 0 ? (
              <Text color="warning">{` · ${pr.checks.pending} pending`}</Text>
            ) : pr.checks.pass > 0 ? (
              <Text color="success"> · checks pass</Text>
            ) : null}
            {pr.review !== null && <Text dimColor>{` · ${pr.review.toLowerCase().replace(/_/g, ' ')}`}</Text>}
          </Text>
          <Text dimColor wrap="truncate-end">{`  ${cut(pr.title, 60)}`}</Text>
        </Box>
      )
    const repoSection =
      repoLine === null ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Repo</Text>
          {repoLine}
          {prLine}
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
          {Svg !== undefined ? (
            <Svg
              key="tank-tasks"
              source={tankSvg({ pct: (done / tasks.length) * 100, level: 0, width: 200, title: `${done} of ${tasks.length} tasks done`, now: clockNow, motion })}
              alt={`${done} of ${tasks.length} tasks done`}
              width={200}
              height={10}
            />
          ) : (
            <Text color={THEME[0]}>{blocks((done / tasks.length) * 100, barWidth)}</Text>
          )}
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
        {banner}
        {header}
        {activity !== null && (
          <Text dimColor wrap="truncate-end">
            {'  '}
            {activity}
          </Text>
        )}
        {mood}
        {sessions}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Context</Text>
          {context}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Usage limits</Text>
          {limits}
        </Box>

        {weekSection}
        {repoSection}
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

// Opening the pane also brings its repo, PR and week rows up to date.
async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Gauges' })
  await refreshVisible($)
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

function taskMark(status: Task['status'], isTerminal: boolean) {
  if (isTerminal) return status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]'
  return status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'
}
