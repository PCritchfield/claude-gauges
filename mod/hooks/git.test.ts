import { expect, test } from 'claude-code/testing'

import {
  cleanBranch,
  gitArgv,
  GIT_ENV,
  hasRepoFilter,
  ownerRepo,
  parsePr,
  parsePrCache,
  parseStatus,
  prArgv,
  prDue,
} from './git'
import type { PrCache } from './git'

// ---- Angua's exploit cases ----------------------------------------------------

test('a repo-local clean or process filter is detected (filter.x.clean = touch /tmp/pwned)', () => {
  // `git config --show-scope --get-regexp` output, as real git prints it.
  expect(hasRepoFilter('local\tfilter.x.clean touch /tmp/pwned\n')).toBe(true)
  expect(hasRepoFilter('worktree\tfilter.x.process evil\n')).toBe(true)
  expect(hasRepoFilter('global\tfilter.lfs.clean git-lfs clean -- %f\nlocal\tfilter.x.clean touch /tmp/pwned\n')).toBe(true)
  // A scope git adds later is not trusted either.
  expect(hasRepoFilter('submodule\tfilter.x.clean evil\n')).toBe(true)
  // The person's own filters (git-lfs) are theirs.
  expect(hasRepoFilter('global\tfilter.lfs.clean git-lfs clean -- %f\nsystem\tfilter.lfs.process git-lfs filter-process\n')).toBe(false)
  expect(hasRepoFilter('')).toBe(false)
})

test('a U+202E branch name renders stripped', () => {
  expect(cleanBranch('feat/‮txt.exe')).toBe('feat/txt.exe')
  expect(cleanBranch('a​b⁦c\u0007d\u001b[2Je')).toBe('abcd[2Je')
  expect(cleanBranch('x'.repeat(100)).length).toBe(48)
})

// ---- git ------------------------------------------------------------------------

test('every git call carries the hardening, and the env turns prompts and locks off', () => {
  const argv = gitArgv('/repo', 'status')
  expect(argv.slice(0, 2)).toEqual(['git', '--no-optional-locks'])
  for (const c of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.untrackedCache=false', 'safe.bareRepository=explicit']) {
    expect(argv[argv.indexOf(c) - 1]).toBe('-c')
  }
  expect(argv.slice(-3)).toEqual(['-C', '/repo', 'status'])
  expect(GIT_ENV).toMatchObject({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' })
})

test('porcelain v2 is parsed strictly', () => {
  const out = [
    '# branch.oid 1234567890abcdef1234567890abcdef12345678',
    '# branch.head feat/x',
    '# branch.upstream origin/feat/x',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 abc abc src/a.ts',
    '? new.txt',
    '',
  ].join('\n')
  expect(parseStatus(out)).toEqual({ branch: 'feat/x', ahead: 2, behind: 1, changed: 2 })
  expect(parseStatus('# branch.oid (initial)\n# branch.head (detached)\n')).toEqual({ branch: null, ahead: 0, behind: 0, changed: 0 })
  expect(parseStatus('# branch.head main\nsurprise line\n')).toBeNull()
  expect(parseStatus('# branch.ab +x -1\n')).toBeNull()
})

test('owner/repo comes only from github remotes of safe shape', () => {
  expect(ownerRepo('git@github.com:PCritchfield/claude-gauges.git')).toBe('PCritchfield/claude-gauges')
  expect(ownerRepo('https://github.com/PCritchfield/claude-gauges')).toBe('PCritchfield/claude-gauges')
  expect(ownerRepo('ssh://git@github.com/a-b/c.d_e.git\n')).toBe('a-b/c.d_e')
  expect(ownerRepo('https://evil.example/github.com/a/b')).toBeNull()
  expect(ownerRepo('git@github.com:a/b;rm -rf /')).toBeNull()
  expect(ownerRepo('git@github.com:-a/b')).toBeNull()
})

// ---- gh -------------------------------------------------------------------------

test('gh pr view names the branch and -R repo, and refuses option-like or odd names', () => {
  expect(prArgv('feat/x', 'a/b')).toEqual([
    'gh', 'pr', 'view', 'feat/x', '-R', 'a/b', '--json', 'number,state,isDraft,title,reviewDecision,statusCheckRollup',
  ])
  expect(prArgv('--web', 'a/b')).toBeNull()
  expect(prArgv('-R', 'a/b')).toBeNull()
  expect(prArgv('feat‮x', 'a/b')).toBeNull()
  expect(prArgv('ok', 'a/b c')).toBeNull()
})

test('a PR answer is read field by field, its title sanitised', () => {
  const json = JSON.stringify({
    number: 6,
    state: 'OPEN',
    isDraft: true,
    title: 'feat: v3‮ \u001b[31mred',
    reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'StatusContext', state: 'PENDING' },
      { __typename: 'StatusContext', state: 'SUCCESS' },
    ],
  })
  expect(parsePr(json)).toEqual({
    number: 6,
    state: 'OPEN',
    isDraft: true,
    title: 'feat: v3 [31mred',
    review: 'REVIEW_REQUIRED',
    checks: { pass: 2, fail: 1, pending: 2 },
  })
  expect(parsePr('{"number":"6"}')).toBeNull()
  expect(parsePr('not json')).toBeNull()
})

test('the shared PR cache is trusted only for its own repo and branch, and backs off on failure', () => {
  const cache: PrCache = { v: 1, repo: 'a/b', branch: 'main', fetchedAt: 1000, failures: 0, pr: null }
  expect(parsePrCache(JSON.stringify(cache), 'a/b', 'main')).toEqual(cache)
  expect(parsePrCache(JSON.stringify(cache), 'a/b', 'other')).toBeNull()
  expect(parsePrCache(JSON.stringify({ ...cache, pr: { number: 'x' } }), 'a/b', 'main')).toBeNull()
  expect(prDue(null, 0)).toBe(true)
  expect(prDue(cache, 1000 + 59_000)).toBe(false)
  expect(prDue(cache, 1000 + 61_000)).toBe(true)
  expect(prDue({ ...cache, failures: 2 }, 1000 + 61_000)).toBe(false)
  expect(prDue({ ...cache, failures: 2 }, 1000 + 241_000)).toBe(true)
  expect(prDue({ ...cache, failures: 50 }, 1000 + 16 * 60_000)).toBe(true)
})
