export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
  costUsd?: number
  startedAt: number
}

export type Turn = {
  isRunning: boolean
  startedAt: number
  endedAt: number
  tools: number
  activity: string | null
  costAtStart?: number
  lastCostUsd?: number
}

export type Task = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

/**
 * What this session needs from the person, and since when (epoch ms).
 * `what` names the kind of ask only ("approve Bash"), never its input.
 */
export type Needs = { what: string; since: number; callId?: string }

export type SessionStatus = 'working' | 'needs-you' | 'idle' | 'ended'

/**
 * One session's row in ~/.claude/gauges/sessions/<id>.json: the contract other
 * readers (the status line, later) rely on. Additive changes keep `v: 1`; a
 * breaking change bumps it, and a reader shows only label and status for a
 * version it does not know. Freshness is the file's mtime, not a field.
 */
export type SessionRecord = {
  v: number
  id: string
  label: string
  branch: string | null
  status: SessionStatus
  /** Set while status is needs-you: "approve Bash", "answer a question". */
  needs: string | null
  /** When the current status began, epoch ms. */
  since: number
  model: string | null
  contextPct: number | null
  costUsd: number | null
  /** The in-progress task's subject or active form. */
  task: string | null
  agents: number
  startedAt: number
}

/**
 * A row as a pane draws it: a SessionRecord read back from disk, sanitised.
 * `isMinimal` marks a record of a newer version: only label and status shown.
 */
export type RosterRow = {
  id: string
  label: string
  branch: string | null
  status: SessionStatus | 'unknown'
  needs: string | null
  since: number
  model: string | null
  contextPct: number | null
  costUsd: number | null
  task: string | null
  agents: number
  isMinimal: boolean
}

declare module 'claude-code' {
  interface PluginState {
    gauges: {
      usage: Usage | null
      model: string | null
      turn: Turn
      tick: number
      tasks: Task[]
      isTasksOpen: boolean
      agentsRunning: number
      alerts: Record<string, number>
      needs: Needs | null
      roster: RosterRow[]
      isSessionsOpen: boolean
    }
  }
}
