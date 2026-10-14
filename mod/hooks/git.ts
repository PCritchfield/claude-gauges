// The repo and PR rows. A session's folder may be any cloned or extracted
// tree, so its git config is untrusted: every git call is hardened, git status
// is skipped outright when the repo configures its own clean or process filter
// (which status could run), and everything read back is parsed strictly and
// sanitised. Pure: register.tsx runs these argv with $.process.run.
import { cut, MAX_FILE_BYTES, sanitize } from './roster'

export const GIT_TIMEOUT_MS = 3000
export const GH_TIMEOUT_MS = 8000

/** Set over the host's environment for every git call. */
export const GIT_ENV: Readonly<Record<string, string>> = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
/** Set over the host's environment for every gh call. */
export const GH_ENV: Readonly<Record<string, string>> = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_SPINNER_DISABLED: '1',
  NO_COLOR: '1',
}

// -c is command-line scope, which the repo's own config cannot override. Hooks
// and fsmonitor would run commands; a planted bare-repo layout could carry its
// own config; the untracked cache would write.
const HARDENING = [
  '--no-optional-locks',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'safe.bareRepository=explicit',
]

export function gitArgv(root: string, ...args: string[]): string[] {
  return ['git', ...HARDENING, '-C', root, ...args]
}

/** Lists configured clean and process filters with the scope that set each. */
export const FILTER_CHECK = ['config', '--show-scope', '--get-regexp', '^filter\\..*\\.(clean|process)$']
export const STATUS = ['status', '--porcelain=v2', '--branch', '--ignore-submodules=all', '--untracked-files=normal']
export const LAST_COMMIT = ['log', '-1', '--format=%ct', '--no-show-signature']
export const REMOTE = ['config', '--get', 'remote.origin.url']

const TRUSTED_SCOPES = new Set(['global', 'system'])

/** True when any clean or process filter comes from anywhere but the person's own global or system config. */
export function hasRepoFilter(stdout: string): boolean {
  return stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .some(line => !TRUSTED_SCOPES.has(line.split('\t', 1)[0] ?? ''))
}

export type Status = { branch: string | null; ahead: number; behind: number; changed: number }

const HEADER = /^# branch\.(oid|head|upstream|ab) (.+)$/
const AB = /^\+(\d{1,9}) -(\d{1,9})$/
const ENTRY = /^[12u?!] /

/** `git status --porcelain=v2 --branch`; null on any line it does not expect. */
export function parseStatus(stdout: string): Status | null {
  const status: Status = { branch: null, ahead: 0, behind: 0, changed: 0 }
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    if (line.startsWith('# stash ')) continue
    const header = HEADER.exec(line)
    if (header !== null) {
      const [, key, value = ''] = header
      if (key === 'head') status.branch = value === '(detached)' ? null : value
      if (key === 'ab') {
        const ab = AB.exec(value)
        if (ab === null) return null
        status.ahead = Number(ab[1])
        status.behind = Number(ab[2])
      }
      continue
    }
    if (!ENTRY.test(line)) return null
    if (!line.startsWith('! ')) status.changed++
  }
  return status
}

const CONTROL = /[\p{Cc}\p{Cf}]/gu

/** A branch name for display: control and format characters (bidi, zero-width) gone, 48 at most. */
export function cleanBranch(raw: string): string {
  return cut(sanitize(raw).replace(CONTROL, ''), 48)
}

const OWNER = '[A-Za-z0-9][A-Za-z0-9-]{0,38}'
const NAME = '[A-Za-z0-9._-]{1,100}?'
const GITHUB_REMOTE = new RegExp(
  `^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)(${OWNER})/(${NAME})(?:\\.git)?/?$`,
)
const REPO = new RegExp(`^${OWNER}/[A-Za-z0-9._-]{1,100}$`)
// No leading '-', so gh never reads the branch as an option.
const BRANCH_ARG = /^[A-Za-z0-9_][A-Za-z0-9._/@+=()-]{0,199}$/

export function ownerRepo(url: string): string | null {
  const m = GITHUB_REMOTE.exec(url.trim())
  return m === null ? null : `${m[1]}/${m[2]}`
}

/** `gh pr view <branch> -R <owner/repo>`, or null when either is not of safe shape. */
export function prArgv(branch: string, repo: string): string[] | null {
  if (!BRANCH_ARG.test(branch) || !REPO.test(repo)) return null
  return ['gh', 'pr', 'view', branch, '-R', repo, '--json', 'number,state,isDraft,title,reviewDecision,statusCheckRollup']
}

export type PrInfo = {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  title: string
  review: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  checks: { pass: number; fail: number; pending: number }
}

const STATES = new Set(['OPEN', 'MERGED', 'CLOSED'])
const REVIEWS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'])
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Reads gh's JSON, or a cached copy of what this returned, field by field. */
function toPr(value: unknown): PrInfo | null {
  const r = record(value)
  if (r === null) return null
  const { number, state, isDraft, title } = r
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null
  if (typeof state !== 'string' || !STATES.has(state) || typeof isDraft !== 'boolean' || typeof title !== 'string') return null
  const reviewRaw = r.reviewDecision ?? r.review
  const review = typeof reviewRaw === 'string' && REVIEWS.has(reviewRaw) ? (reviewRaw as PrInfo['review']) : null
  let checks = { pass: 0, fail: 0, pending: 0 }
  const cached = record(r.checks)
  if (cached !== null) {
    const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1000 ? v : null)
    const [pass, fail, pending] = [n(cached.pass), n(cached.fail), n(cached.pending)]
    if (pass === null || fail === null || pending === null) return null
    checks = { pass, fail, pending }
  } else if (Array.isArray(r.statusCheckRollup)) {
    for (const item of r.statusCheckRollup.slice(0, 500)) {
      const c = record(item)
      if (c === null) continue
      if (c.__typename === 'StatusContext') {
        if (c.state === 'SUCCESS') checks.pass++
        else if (c.state === 'PENDING' || c.state === 'EXPECTED') checks.pending++
        else checks.fail++
      } else if (c.status !== 'COMPLETED') checks.pending++
      else if (typeof c.conclusion === 'string' && PASSED.has(c.conclusion)) checks.pass++
      else checks.fail++
    }
  }
  return { number, state: state as PrInfo['state'], isDraft, title: cut(sanitize(title).trim(), 60), review, checks }
}

export function parsePr(stdout: string): PrInfo | null {
  try {
    return toPr(JSON.parse(stdout))
  } catch {
    return null
  }
}

/**
 * One file per repo and branch in ~/.claude/gauges/pr, shared by every
 * session, so N panes on one branch make one gh call a minute, not N.
 * `pr` null means no PR for the branch (or none readable).
 */
export type PrCache = { v: 1; repo: string; branch: string; fetchedAt: number; failures: number; pr: PrInfo | null }

export const PR_FRESH_MS = 60_000
const MAX_BACKOFF_STEPS = 4

/** Whether the cache is old enough to ask gh again: a minute, doubling per failure up to 16. */
export function prDue(cache: PrCache | null, now: number): boolean {
  if (cache === null) return true
  return now - cache.fetchedAt >= PR_FRESH_MS * 2 ** Math.min(cache.failures, MAX_BACKOFF_STEPS)
}

/** Reads a cache file back (any local process could have written it). */
export function parsePrCache(text: string, repo: string, branch: string): PrCache | null {
  if (text.length > MAX_FILE_BYTES) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const r = record(raw)
  if (r === null || r.v !== 1 || r.repo !== repo || r.branch !== branch) return null
  const { fetchedAt, failures } = r
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return null
  if (typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0 || failures > 99) return null
  const pr = r.pr === null ? null : toPr(r.pr)
  if (r.pr !== null && pr === null) return null
  return { v: 1, repo, branch, fetchedAt, failures, pr }
}
