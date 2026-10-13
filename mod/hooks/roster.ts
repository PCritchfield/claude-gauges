// Pure helpers for the cross-session roster: no `$` here, so they unit-test
// directly. Everything that touches the host lives in register.tsx.
import type { Needs, RosterRow, SessionRecord, SessionStatus, Task, Turn, Usage } from '../types'

export const ROSTER_VERSION = 1
export const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/

const MAX_LABEL = 40
const MAX_TASK = 80

export type Identity = { id: string; label: string; branch: string | null }

export type Snapshot = {
  usage: Usage | null
  model: string | null
  turn: Turn
  tasks: Task[]
  agents: number
  needs: Needs | null
}

export function labelFor(cwd: string, repoRoot: string | null): string {
  if (cwd.includes('/scratch-workspaces/')) return 'No folder'
  const path = (repoRoot ?? cwd).replace(/\/+$/, '')
  return cut(path.slice(path.lastIndexOf('/') + 1) || path, MAX_LABEL)
}

export function statusOf(snapshot: Snapshot, isEnded: boolean): { status: SessionStatus; since: number } {
  const { needs, turn, usage } = snapshot
  if (isEnded) return { status: 'ended', since: turn.endedAt }
  if (needs !== null) return { status: 'needs-you', since: needs.since }
  if (turn.isRunning) return { status: 'working', since: turn.startedAt }
  return { status: 'idle', since: turn.endedAt > 0 ? turn.endedAt : (usage?.startedAt ?? 0) }
}

export function buildRecord(identity: Identity, snapshot: Snapshot, isEnded = false): SessionRecord {
  const { status, since } = statusOf(snapshot, isEnded)
  const current = snapshot.tasks.find(t => t.status === 'in_progress')
  const task = current === undefined ? null : cut(current.activeForm ?? current.subject, MAX_TASK)
  return {
    v: ROSTER_VERSION,
    id: identity.id,
    label: identity.label,
    branch: identity.branch,
    status,
    needs: status === 'needs-you' ? (snapshot.needs?.what ?? null) : null,
    since,
    model: snapshot.model,
    contextPct: snapshot.usage?.percent ?? null,
    costUsd: snapshot.usage?.costUsd ?? null,
    task,
    agents: snapshot.agents,
    startedAt: snapshot.usage?.startedAt ?? 0,
  }
}

export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// ---- Reading rows back. Every file is untrusted: any local process could have
// written it, so each field is type-checked, cut to length and stripped of
// control and bidi characters before it reaches a drawing.

export const MAX_FILE_BYTES = 4096
export const STALE_MS = 2 * 60_000
export const MAX_ROWS = 20

const ROW_FILE = /^([A-Za-z0-9-]{1,64})\.json$/
const UNSAFE = /[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g
const STATUSES = new Set(['working', 'needs-you', 'idle', 'ended'])

/** The session id a row file belongs to, or null for any other name. */
export function rowFileId(name: string): string | null {
  return ROW_FILE.exec(name)?.[1] ?? null
}

/** Parses one file's text; null when it is not a usable row for `fileId`. */
export function parseRecord(text: string, fileId: string): RosterRow | null {
  if (text.length > MAX_FILE_BYTES) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.id !== fileId || typeof r.v !== 'number') return null
  const status = typeof r.status === 'string' && STATUSES.has(r.status) ? (r.status as SessionStatus) : 'unknown'
  const label = str(r.label, MAX_LABEL) ?? fileId.slice(0, 8)
  const isMinimal = r.v > ROSTER_VERSION
  if (isMinimal) {
    return { id: fileId, label, branch: null, status, needs: null, since: 0, model: null, contextPct: null, costUsd: null, task: null, agents: 0, isMinimal }
  }
  return {
    id: fileId,
    label,
    branch: str(r.branch, 60),
    status,
    needs: status === 'needs-you' ? str(r.needs, 40) : null,
    since: num(r.since, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    model: str(r.model, 40),
    contextPct: num(r.contextPct, 0, 100),
    costUsd: num(r.costUsd, 0, 1_000_000),
    task: str(r.task, MAX_TASK),
    agents: Math.round(num(r.agents, 0, 99) ?? 0),
    isMinimal,
  }
}

const RANK: Record<RosterRow['status'], number> = { 'needs-you': 0, working: 1, idle: 2, unknown: 3, ended: 4 }

/** Needs-you first (longest waiting first), then working, then idle (most recent first). */
export function sortRows(rows: RosterRow[]): RosterRow[] {
  return [...rows].sort((a, b) => {
    const byRank = RANK[a.status] - RANK[b.status]
    if (byRank !== 0) return byRank
    return a.status === 'idle' ? b.since - a.since : a.since - b.since
  })
}

export function sanitize(text: string): string {
  return text.replace(UNSAFE, '')
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = sanitize(value).trim()
  return clean === '' ? null : cut(clean, max)
}

function num(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null
}

// ---- Needs-you.

/** Tools that always wait on the person, and what the row says about them. */
export const PERSON_TOOLS: Readonly<Record<string, string>> = {
  AskUserQuestion: 'answer a question',
  ExitPlanMode: 'approve a plan',
}

const NON_PROMPTING = new Set(['auto', 'bypassPermissions', 'dontAsk'])

/**
 * Whether an `ask` verdict means a dialog for the person. Mods cannot read the
 * live permission mode, so the configured default stands in; auto mode's
 * classifier settles most asks itself, and flagging them would cry wolf.
 */
export function promptsForPermission(settings: Readonly<Record<string, unknown>>): boolean {
  const permissions = settings.permissions
  const mode =
    typeof permissions === 'object' && permissions !== null ? (permissions as Record<string, unknown>).defaultMode : undefined
  return !(typeof mode === 'string' && NON_PROMPTING.has(mode))
}

/** The terminal's exceptions-only line: other sessions waiting, limits off pace. */
export function statusLine(othersWaiting: RosterRow[], limitWarnings: string[]): string | undefined {
  const parts: string[] = []
  if (othersWaiting.length === 1) {
    const [row] = othersWaiting
    parts.push(`◆ ${row?.label} needs you: ${row?.needs ?? 'input'}`)
  } else if (othersWaiting.length > 1) {
    parts.push(`◆ ${othersWaiting.length} sessions need you: ${othersWaiting.map(r => r.label).join(', ')}`)
  }
  parts.push(...limitWarnings)
  return parts.length === 0 ? undefined : parts.join('  ·  ')
}

// ---- Toast markers: one file per toasted event, so N sessions show it once.

/** A marker file name for an event: only safe characters, bounded length. */
export function markerName(...parts: (string | number)[]): string {
  return parts
    .map(part => String(part).replace(/[^A-Za-z0-9_-]/g, '_'))
    .join('-')
    .slice(0, 120)
}

// ---- Housekeeping: rows and markers untouched for a day go.

export const PRUNE_AFTER_MINUTES = 24 * 60
const PRUNABLE = /^\/(?:[^/\0]+\/)*\.claude\/gauges\/(sessions|toasts)$/

/**
 * The `find` that deletes stale files in one of the mod's own folders, or null
 * when `dir` is anything else: it must be absolute, end in
 * /.claude/gauges/sessions or /.claude/gauges/toasts, and hold no `..`.
 * One level deep, plain files only; no shell runs it.
 */
export function pruneArgv(dir: string): string[] | null {
  if (!PRUNABLE.test(dir) || dir.split('/').includes('..')) return null
  return ['find', dir, '-maxdepth', '1', '-type', 'f', '-mmin', `+${PRUNE_AFTER_MINUTES}`, '-delete']
}
