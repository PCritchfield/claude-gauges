import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMeasureInput } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const PANE = {
  plugin: 'gauges',
  component: 'Pane',
  requestId: 'gauges',
  props: {
    title: 'Gauges',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

function measure(contextPct: number, fiveHour: number, sevenDay: number): SessionMeasureInput {
  return {
    context: { tokens: contextPct * 2000, window: 200000, percent: contextPct },
    rateLimits: [
      { kind: 'five_hour', percentUsed: fiveHour },
      { kind: 'seven_day', percentUsed: sevenDay },
    ],
    cost: { usd: 3.42 },
    changed: ['context', 'rateLimits', 'cost'],
  }
}

// What the engine answers beneath the plugin; toasts are collected.
function engine(on: On, now?: number) {
  const toasts: string[] = []
  mock.clock(on, now === undefined ? undefined : { now })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('agent.list', () => ({ value: [] }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return toasts
}

test('the pane shows context, limits and cost on every surface', async ($, on) => {
  engine(on)
  await $.session.measure(measure(58, 41, 83))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /58%/ })).toBeDefined()
    expect(await ui.find({ text: /116k \/ 200k/ })).toBeDefined()
    expect(await ui.find({ text: /5h/ })).toBeDefined()
    expect(await ui.find({ text: /83%/ })).toBeDefined()
    expect(await ui.find({ text: /\$3\.42/ })).toBeDefined()
    // Bars are SVG on the desktop and block characters on the terminal.
    expect((await ui.findAll({ type: 'Svg' })).length).toBe(surface === 'terminal' ? 0 : 3)
    if (surface === 'terminal') expect(await ui.find({ text: /█+░+/ })).toBeDefined()
    await ui.unmount()
  }
})

test('with no readings the pane says so instead of showing zeros', async ($, on) => {
  engine(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /No reading yet/ })).toBeDefined()
    expect(await ui.find({ text: /No limit readings/ })).toBeDefined()
    expect(await ui.find({ text: /0%/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('each threshold crossing toasts once and re-arms after dropping back', async ($, on) => {
  const toasts = engine(on)

  await $.session.measure(measure(58, 41, 83))
  expect(toasts.length).toBe(2)
  expect(toasts.some(t => t.includes('Context at 58%'))).toBe(true)
  expect(toasts.some(t => t.includes('7d limit at 83%'))).toBe(true)

  await $.session.measure(measure(60, 45, 84))
  expect(toasts.length).toBe(2)

  await $.session.measure(measure(30, 45, 84))
  await $.session.measure(measure(55, 45, 84))
  expect(toasts.length).toBe(3)
})

test('thresholds come from userConfig', { options: { warnPercent: 70, highPercent: 90 } }, async ($, on) => {
  const toasts = engine(on)

  await $.session.measure(measure(58, 41, 83))
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('7d limit at 83%')
})

test('TodoWrite progress shows as a task count and expands on press', async ($, on) => {
  engine(on)
  const todos = [
    { content: 'Survey API', status: 'completed', activeForm: 'Surveying API' },
    { content: 'Write pane', status: 'in_progress', activeForm: 'Writing pane' },
    { content: 'Test it', status: 'pending', activeForm: 'Testing it' },
  ] as const
  on('tool.call', { tool: 'TodoWrite' }, () => ({
    result: { oldTodos: [], newTodos: [...todos] },
  }))
  await $.tool.call({ tool: 'TodoWrite', todos: [...todos] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Tasks 1\/3/ })).toBeDefined()
    expect(await ui.find({ text: /Test it/ })).toBeUndefined()
    await ui.press({ key: 'tasks-toggle' })
    expect(await ui.find({ text: /Test it/ })).toBeDefined()
    await ui.press({ key: 'tasks-toggle' })
    await ui.unmount()
  }
})

const NOW = Date.parse('2026-10-13T12:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

function limits(...rateLimits: SessionMeasureInput['rateLimits']): SessionMeasureInput {
  return {
    context: { tokens: 20000, window: 200000, percent: 10 },
    rateLimits,
    cost: { usd: 1 },
    changed: ['rateLimits'],
  }
}

const resetsIn = (ms: number) => new Date(NOW + ms).toISOString()

test('day 6 at 50% of the week is on pace and stays quiet', async ($, on) => {
  const toasts = engine(on, NOW)
  await $.session.measure(limits({ kind: 'seven_day', percentUsed: 50, resetsAt: resetsIn(DAY) }))
  expect(toasts.length).toBe(0)
})

test('day 1 at 30% of the week is on pace to run out and goes red', async ($, on) => {
  const toasts = engine(on, NOW)
  await $.session.measure(limits({ kind: 'seven_day', percentUsed: 30, resetsAt: resetsIn(6 * DAY) }))
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Consider pausing heavy work')
  expect(toasts[0]).toContain('on pace: 209% of weekly limit')
})

test('pace between 100% and 125% is amber', async ($, on) => {
  const toasts = engine(on, NOW)
  await $.session.measure(limits({ kind: 'five_hour', percentUsed: 60, resetsAt: resetsIn(2.25 * HOUR) }))
  expect(toasts.length).toBe(1)
  expect(toasts[0]).not.toContain('Consider pausing')
  expect(toasts[0]).toContain('on pace: 109% of')
})

test('early in a window nothing is projected; only the raw backstop applies', async ($, on) => {
  const toasts = engine(on, NOW)
  await $.session.measure(limits({ kind: 'seven_day', percentUsed: 30, resetsAt: resetsIn(6.5 * DAY) }))
  expect(toasts.length).toBe(0)
  await $.session.measure(limits({ kind: 'seven_day', percentUsed: 81, resetsAt: resetsIn(6.5 * DAY) }))
  expect(toasts.length).toBe(1)
  expect(toasts[0]).not.toContain('on pace')
})

test('a raw 80% is red even when the reset is minutes away', async ($, on) => {
  const toasts = engine(on, NOW)
  await $.session.measure(limits({ kind: 'five_hour', percentUsed: 90, resetsAt: resetsIn(HOUR / 3) }))
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Consider pausing heavy work')
})

test('a spend limit has no window and keeps the fixed thresholds', async ($, on) => {
  const toasts = engine(on, NOW)
  await $.session.measure(limits({ kind: 'spend_limit', percentUsed: 55 }))
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Spend limit at 55%')
})

test('limit rows show the projection and a time marker', async ($, on) => {
  engine(on, NOW)
  await $.session.measure(limits({ kind: 'seven_day', percentUsed: 30, resetsAt: resetsIn(6 * DAY) }))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /on pace: 209% of weekly limit/ })).toBeDefined()
    if (surface === 'terminal') expect(await ui.find({ text: /┃/ })).toBeDefined()
    await ui.unmount()
  }
})

// A clean repo on main with a GitHub remote, answering the mod's hardened git calls.
function git(argv: readonly string[]): { exitCode: number; stdout: string } {
  const args = argv.slice(argv.indexOf('-C') + 2)
  if (args[0] === 'config' && args[1] === '--show-scope') return { exitCode: 1, stdout: '' }
  if (args[0] === 'status') return { exitCode: 0, stdout: '# branch.oid abc\n# branch.head main\n# branch.ab +0 -0\n' }
  if (args[0] === 'log') return { exitCode: 0, stdout: '1791900000\n' }
  if (args[0] === 'config') return { exitCode: 0, stdout: 'git@github.com:acme/groupyBot.git\n' }
  return { exitCode: 1, stdout: '' }
}

// session.start needs the engine's answers for everything it reads; opens are counted.
type Host = {
  opens: string[]
  toasts: string[]
  markers: Set<string>
  writes: { path: string; text: string }[]
  runs: string[][]
  clock: ReturnType<typeof mock.clock>
}

function startEngine(on: On, surfaces: readonly ('terminal' | 'desktop')[], home = '/Users/test'): Host {
  const host: Host = { opens: [], toasts: [], markers: new Set(), writes: [], runs: [], clock: mock.clock(on, { now: Date.parse('2026-10-13T12:00:00Z') }) }
  const opens = host.opens
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('agent.list', () => ({ value: [] }))
  on('ui.toast', (_$, e) => {
    host.toasts.push(e.text)
    return { value: undefined }
  })
  mock.env(on, { HOME: home })
  on('session.id', () => ({ value: 'abc-123' }))
  on('session.repo', () => ({ value: { root: '/code/groupyBot', name: 'groupyBot', remote: null, internal: false } }))
  on('process.run', (_$, e) => {
    host.runs.push([...e.argv])
    const { exitCode, stdout } = e.argv[0] === 'git' ? git(e.argv) : { exitCode: 0, stdout: '' }
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', (_$, e) => {
    if (e.path.includes('/gauges/sessions/')) host.writes.push({ path: e.path, text: e.text })
    else host.markers.add(e.path)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: host.markers.has(e.path) }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.open', (_$, e) => {
    opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.end', () => ({ sessionId: 'abc-123' }))
  on('turn.start', () => ({ turnId: 't1' }))
  return host
}

const lastRecord = (host: Host) => JSON.parse(host.writes[host.writes.length - 1]?.text ?? 'null')

test('a terminal session does not open the pane by itself', async ($, on) => {
  const { opens } = startEngine(on, ['terminal'])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(opens.length).toBe(0)
})

test('a desktop session opens the pane when the app attaches', async ($, on) => {
  const { opens } = startEngine(on, [])
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  expect(opens.length).toBe(0)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(opens).toEqual(['gauges'])
})

test('a reload inside a desktop session reopens the pane', async ($, on) => {
  const { opens } = startEngine(on, ['desktop'])
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  expect(opens).toEqual(['gauges'])
})

const SESSION_FILE = '/Users/test/.claude/gauges/sessions/abc-123.json'

test('session start writes a private v1 record for this session', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  await $.session.start({ cwd: '/code/groupyBot/src', surface: null, isInteractive: false })
  expect(host.writes[0]?.path).toBe(SESSION_FILE)
  expect(lastRecord(host)).toMatchObject({ v: 1, id: 'abc-123', label: 'groupyBot', branch: 'main', status: 'idle', needs: null })
  expect(host.runs).toContainEqual(['chmod', '600', SESSION_FILE])
  const g = '/Users/test/.claude/gauges'
  const dirs = [`${g}/sessions`, `${g}/toasts`, `${g}/week`, `${g}/pr`]
  expect(host.runs).toContainEqual(['mkdir', '-p', '-m', '700', ...dirs])
  expect(host.runs).toContainEqual(['chmod', '700', g, ...dirs])
})

test('changes are coalesced into one write after the delay', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  const before = host.writes.length
  await $.session.measure(measure(42, 10, 10))
  await $.session.measure(measure(43, 10, 10))
  expect(host.writes.length).toBe(before)
  await host.clock.advance(2000)
  expect(host.writes.length).toBe(before + 1)
  expect(lastRecord(host).contextPct).toBe(43)
})

test('a running turn is written as working, and session end as ended', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await host.clock.advance(2000)
  expect(lastRecord(host).status).toBe('working')
  await $.session.end({ reason: 'other', sessionId: 'abc-123', resume: { id: 'abc-123' } })
  expect(lastRecord(host).status).toBe('ended')
})

test('no roster file is written when HOME is not an absolute path', async ($, on) => {
  const host = startEngine(on, ['desktop'], 'relative/home')
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  expect(host.writes.length).toBe(0)
})

// A sessions folder as the reader sees it: files by name, each with text and age.
function rosterFolder(on: On, host: Host, files: Record<string, { text: string; ageMs?: number; isLink?: boolean }>) {
  on('fs.list', () => ({
    value: Object.entries(files).map(([name, f]) => ({
      name,
      kind: 'file' as const,
      size: f.text.length,
      mtimeMs: host.clock.now() - (f.ageMs ?? 1000),
      isLink: f.isLink ?? false,
    })),
  }))
  on('fs.read', (_$, e) => {
    const name = e.path.slice(e.path.lastIndexOf('/') + 1)
    const file = files[name]
    return file === undefined ? { deny: 'ENOENT' } : { value: file.text }
  })
}

const peer = (id: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, id, label: id, branch: null, status: 'idle', needs: null, since: Date.parse('2026-10-13T11:00:00Z'), model: 'm', contextPct: 20, costUsd: 0.5, task: null, agents: 0, startedAt: 0, ...over })

test('the Sessions section lists live peers, needs-you first, on both surfaces', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  rosterFolder(on, host, {
    'abc-123.json': { text: peer('abc-123', { label: 'this-one' }) },
    'groupy.json': { text: peer('groupy', { label: 'groupyBot', status: 'needs-you', needs: 'answer a question' }) },
    'swim.json': { text: peer('swim', { label: 'Learning-to-Swim', status: 'working', task: 'Writing tests' }) },
    'stale.json': { text: peer('stale', { label: 'ghost' }), ageMs: 3 * 60_000 },
    'linked.json': { text: peer('linked', { label: 'planted' }), isLink: true },
    'done.json': { text: peer('done', { label: 'finished', status: 'ended' }) },
  })
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Sessions \(3\) · 1 needs you/ })).toBeDefined()
    expect(await ui.find({ text: /needs you: answer a question/ })).toBeDefined()
    expect(await ui.find({ text: /working since .* · Writing tests/ })).toBeDefined()
    expect(await ui.find({ text: /\(this\)/ })).toBeDefined()
    for (const hidden of [/ghost/, /planted/, /finished/]) expect(await ui.find({ text: hidden })).toBeUndefined()
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(texts.indexOf('groupyBot')).toBeLessThan(texts.indexOf('Learning-to-Swim'))
    await ui.press({ key: 'sessions-toggle' })
    expect(await ui.find({ text: /Learning-to-Swim/ })).toBeUndefined()
    await ui.press({ key: 'sessions-toggle' })
    await ui.unmount()
  }
})

test('a row caught mid-write keeps its last good version', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  const files: Record<string, { text: string }> = {
    'abc-123.json': { text: peer('abc-123', { label: 'this-one' }) },
    'swim.json': { text: peer('swim', { label: 'Learning-to-Swim' }) },
  }
  rosterFolder(on, host, files)
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  files['swim.json'] = { text: '{"v":1,"id":"sw' }
  await host.clock.advance(5000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Learning-to-Swim/ })).toBeDefined()
  await ui.unmount()
})

// ---- Step 3: needs-you

function withMode(on: On, defaultMode: string) {
  on('settings.read', () => ({ value: { permissions: { defaultMode } } }))
}

test('a question marks this session as needing you until it is answered', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  let during: unknown
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    during = lastRecord(host)
    return { result: { questions: [], answers: {} } as never }
  })
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'q1', questions: [] } as never)
  expect(during).toMatchObject({ status: 'needs-you', needs: 'answer a question' })
  expect(lastRecord(host)).toMatchObject({ status: 'idle', needs: null })
})

for (const outcome of ['approved', 'denied'] as const) {
  test(`a permission prompt marks needs-you in a prompting mode and clears when ${outcome}`, async ($, on) => {
    const host = startEngine(on, ['desktop'])
    withMode(on, 'default')
    on('tool.check', () => ({ decision: 'ask' }))
    on('tool.call', { tool: 'Bash' }, () =>
      outcome === 'approved'
        ? { result: { stdout: '', stderr: '', interrupted: false } as never }
        : { result: 'denied' as never, isError: true },
    )
    await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
    // The engine checks a call before it runs: an ask here is the dialog going up.
    await $.tool.check({ tool: 'Bash', input: { command: 'touch /tmp/x' }, tool_use_id: 'tu1' } as never)
    expect(lastRecord(host)).toMatchObject({ status: 'needs-you', needs: 'approve Bash' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'touch /tmp/x' } as never)
    expect(lastRecord(host)).toMatchObject({ needs: null })
  })
}

test('in auto mode an ask is left to the classifier and never flagged', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  withMode(on, 'auto')
  on('tool.check', () => ({ decision: 'ask' }))
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' } as never)
  expect(lastRecord(host)).toMatchObject({ needs: null })
})

test('another session starting to wait toasts once, not for asks already open', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  const toasts = host.toasts
  const files: Record<string, { text: string }> = {
    'old.json': { text: peer('old', { label: 'oldAsk', status: 'needs-you', needs: 'answer a question', since: 1 }) },
  }
  rosterFolder(on, host, files)
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  expect(toasts.filter(t => t.includes('needs you')).length).toBe(0)

  files['swim.json'] = { text: peer('swim', { label: 'Learning-to-Swim', status: 'needs-you', needs: 'approve Bash', since: 2 }) }
  await host.clock.advance(5000)
  await host.clock.advance(5000)
  expect(toasts.filter(t => t.includes('needs you'))).toEqual(['◆ Learning-to-Swim needs you: approve Bash'])
})

test('with terminalStatus on, a terminal session shows waiting sessions on its status line', { options: { terminalStatus: true } }, async ($, on) => {
  const host = startEngine(on, ['terminal'])
  const lines: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  const files: Record<string, { text: string }> = {}
  rosterFolder(on, host, files)
  await $.session.start({ cwd: '/code/groupyBot', surface: 'terminal', isInteractive: true })
  expect(lines.length).toBe(0)

  files['swim.json'] = { text: peer('swim', { label: 'Learning-to-Swim', status: 'needs-you', needs: 'approve Bash' }) }
  await host.clock.advance(5000)
  expect(lines[lines.length - 1]).toBe('◆ Learning-to-Swim needs you: approve Bash')

  files['swim.json'] = { text: peer('swim', { label: 'Learning-to-Swim', status: 'idle' }) }
  await host.clock.advance(5000)
  expect(lines[lines.length - 1]).toBe(undefined)
})

// ---- Step 4: one toast per event across sessions

const TOASTS = '/Users/test/.claude/gauges/toasts'

test('a limit toast already claimed by another session is not shown again', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  rosterFolder(on, host, {})
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  const reset = new Date(NOW + 6 * DAY).toISOString()
  host.markers.add(`${TOASTS}/limit-seven_day-${reset.replace(/[^A-Za-z0-9_-]/g, '_')}-2`)
  await $.session.measure(limits({ kind: 'seven_day', percentUsed: 30, resetsAt: reset }))
  expect(host.toasts.filter(t => t.includes('7d limit'))).toEqual([])
})

test('the first session to see a limit crossing claims and shows it', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  rosterFolder(on, host, {})
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  await $.session.measure(limits({ kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 6 * DAY).toISOString() }))
  expect(host.toasts.filter(t => t.includes('7d limit')).length).toBe(1)
  expect([...host.markers].some(m => m.startsWith(`${TOASTS}/limit-seven_day-`))).toBe(true)
})

test('context toasts stay per session and take no marker', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  rosterFolder(on, host, {})
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  await $.session.measure(measure(60, 1, 1))
  expect(host.toasts.filter(t => t.includes('Context at 60%')).length).toBe(1)
  expect([...host.markers].some(m => m.includes('context'))).toBe(false)
})

test('a needs-you toast claimed by another session stays quiet here', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  const files: Record<string, { text: string }> = {}
  rosterFolder(on, host, files)
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  host.markers.add(`${TOASTS}/ask-swim-2`)
  files['swim.json'] = { text: peer('swim', { label: 'Learning-to-Swim', status: 'needs-you', needs: 'approve Bash', since: 2 }) }
  await host.clock.advance(5000)
  expect(host.toasts.filter(t => t.includes('needs you'))).toEqual([])
})

// ---- Step 5: housekeeping

test('session start prunes the gauges folders only: a day for rows, markers and PR caches, 8 days for the week', async ($, on) => {
  const host = startEngine(on, ['desktop'])
  rosterFolder(on, host, {})
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  const finds = host.runs.filter(argv => argv[0] === 'find')
  const G = '/Users/test/.claude/gauges'
  expect(finds.map(argv => [argv[1], argv[7]])).toEqual([
    [`${G}/sessions`, '+1440'],
    [`${G}/toasts`, '+1440'],
    [`${G}/week`, '+11520'],
    [`${G}/pr`, '+1440'],
  ])
  for (const argv of finds) expect(argv.slice(2, 6)).toEqual(['-maxdepth', '1', '-type', 'f'])
})

test('no pruning happens when HOME is unusable', async ($, on) => {
  const host = startEngine(on, ['desktop'], '')
  await $.session.start({ cwd: '/code/groupyBot', surface: null, isInteractive: false })
  expect(host.runs.filter(argv => argv[0] === 'find')).toEqual([])
})

// ---- v3 -------------------------------------------------------------------------

const G = '/Users/test/.claude/gauges'

// The host's answers beneath the plugin for git, gh, the pane's visibility and
// the files the plugin writes and reads back, all recorded.
function v3Host(
  on: On,
  o: {
    git?: (args: readonly string[]) => { exitCode: number; stdout: string }
    gh?: () => { exitCode: number; stdout: string; stderr?: string }
    isVisible?: boolean
    surfaces?: readonly ('terminal' | 'desktop')[]
  } = {},
) {
  const h = {
    runs: [] as { argv: string[]; env?: Record<string, string> }[],
    files: new Map<string, string>(),
    toasts: [] as string[],
    clock: mock.clock(on, { now: NOW }),
  }
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('agent.list', () => ({ value: [] }))
  on('ui.toast', (_$, e) => {
    h.toasts.push(e.text)
    return { value: undefined }
  })
  mock.env(on, { HOME: '/Users/test' })
  on('session.id', () => ({ value: 'abc-123' }))
  on('session.repo', () => ({ value: { root: '/code/groupyBot', name: 'groupyBot', remote: null, internal: false } }))
  on('process.run', (_$, e) => {
    h.runs.push({ argv: [...e.argv], env: e.init?.env === undefined ? undefined : { ...e.init.env } })
    const answer: { exitCode: number; stdout: string; stderr?: string } =
      e.argv[0] === 'git'
        ? o.git !== undefined
          ? o.git(e.argv.slice(e.argv.indexOf('-C') + 2))
          : git(e.argv)
        : e.argv[0] === 'gh'
          ? (o.gh?.() ?? { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "main"' })
          : { exitCode: 0, stdout: '' }
    const stderr = answer.stderr ?? ''
    return { value: { exitCode: answer.exitCode, stdout: answer.stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', (_$, e) => {
    h.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: h.files.has(e.path) }))
  on('fs.read', (_$, e) => (h.files.has(e.path) ? { value: h.files.get(e.path) ?? '' } : { deny: 'ENOENT' }))
  on('fs.list', (_$, e) => ({
    value: [...h.files.keys()]
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 10, mtimeMs: h.clock.now(), isLink: false })),
  }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.surfaces', () => ({ value: o.surfaces ?? ['desktop'] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({
    value: o.isVisible === false ? [] : [{ id: 'gauges', title: 'Gauges', isShown: true, isFocused: false, isPlaced: true }],
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', () => ({ turnId: 't1' }))
  return h
}

const gitCalls = (h: { runs: { argv: string[]; env?: Record<string, string> }[] }) => h.runs.filter(r => r.argv[0] === 'git')
const sub = (argv: string[]) => argv.slice(argv.indexOf('-C') + 2)
const START = { cwd: '/code/groupyBot', surface: null, isInteractive: false } as const

test("Angua: a repo-local clean filter (filter.x.clean = touch /tmp/pwned) means git status never runs", async ($, on) => {
  const h = v3Host(on, {
    git: args =>
      args[0] === 'config' && args[1] === '--show-scope'
        ? { exitCode: 0, stdout: 'local\tfilter.x.clean touch /tmp/pwned\n' }
        : git(['-C', '/r', ...args]),
  })
  await $.session.start(START)
  await h.clock.advance(15_000)
  expect(gitCalls(h).map(r => sub(r.argv)[0])).toEqual(gitCalls(h).map(() => 'config'))
  expect(gitCalls(h).some(r => sub(r.argv)[0] === 'status' || sub(r.argv)[0] === 'log')).toBe(false)
  expect(h.runs.some(r => r.argv[0] === 'gh')).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Repo details off: this repo sets its own git filters/ })).toBeDefined()
  await ui.unmount()
})

test('Angua: a U+202E branch name renders stripped, in the pane and in the session file', async ($, on) => {
  const h = v3Host(on, {
    git: args =>
      args[0] === 'status'
        ? { exitCode: 0, stdout: '# branch.oid abc\n# branch.head feat/‮txt.exe\n' }
        : git(['-C', '/r', ...args]),
  })
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /feat\/txt\.exe/ })).toBeDefined()
    expect(await ui.find({ text: /‮/ })).toBeUndefined()
    await ui.unmount()
  }
  expect(JSON.parse(h.files.get(`${G}/sessions/abc-123.json`) ?? '{}').branch).toBe('feat/txt.exe')
  // A name gh could read as an option, or one with format characters, is never passed to it.
  expect(h.runs.some(r => r.argv[0] === 'gh')).toBe(false)
})

test('every git call is hardened, with prompts and optional locks off and a 3 s timeout', async ($, on) => {
  const h = v3Host(on)
  await $.session.start(START)
  expect(gitCalls(h).length).toBeGreaterThan(0)
  for (const r of gitCalls(h)) {
    expect(r.argv.slice(0, 2)).toEqual(['git', '--no-optional-locks'])
    expect(r.argv).toContain('core.hooksPath=/dev/null')
    expect(r.argv).toContain('core.fsmonitor=false')
    expect(r.env).toMatchObject({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' })
  }
  const status = gitCalls(h).find(r => sub(r.argv)[0] === 'status')
  expect(status?.argv).toContain('--ignore-submodules=all')
  expect(gitCalls(h).find(r => sub(r.argv)[0] === 'log')?.argv).toContain('--no-show-signature')
})

const PR_JSON = JSON.stringify({
  number: 6,
  state: 'OPEN',
  isDraft: false,
  title: 'feat: gauges v3',
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
})

test('the PR row: gh pr view <branch> -R <owner/repo>, cached for every session, a minute at a time', async ($, on) => {
  const h = v3Host(on, { gh: () => ({ exitCode: 0, stdout: PR_JSON }) })
  await $.session.start(START)
  await h.clock.advance(15_000)
  const gh = () => h.runs.filter(r => r.argv[0] === 'gh')
  expect(gh().map(r => r.argv.slice(0, 6))).toEqual([['gh', 'pr', 'view', 'main', '-R', 'acme/groupyBot']])
  expect(gh()[0]?.env).toMatchObject({ GH_PROMPT_DISABLED: '1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /PR #6/ })).toBeDefined()
  expect(await ui.find({ text: /1 failing/ })).toBeDefined()
  await ui.unmount()
  expect([...h.files.keys()].some(p => p.startsWith(`${G}/pr/acme_groupyBot-`))).toBe(true)
  await h.clock.advance(30_000)
  expect(gh().length).toBe(1)
  await h.clock.advance(45_000)
  expect(gh().length).toBe(2)
})

test('nothing polls git or gh while the pane is hidden', async ($, on) => {
  const h = v3Host(on, { isVisible: false, gh: () => ({ exitCode: 0, stdout: PR_JSON }) })
  await $.session.start(START)
  const before = gitCalls(h).length
  await h.clock.advance(5 * 60_000)
  expect(gitCalls(h).length).toBe(before)
  expect(h.runs.some(r => r.argv[0] === 'gh')).toBe(false)
})

test('a failing gh backs off, and its stderr is never shown', async ($, on) => {
  const h = v3Host(on, { gh: () => ({ exitCode: 4, stdout: '', stderr: 'SECRET token expired' }) })
  await $.session.start(START)
  const gh = () => h.runs.filter(r => r.argv[0] === 'gh').length
  await h.clock.advance(15_000)
  expect(gh()).toBe(1)
  // One failure: the next ask waits two minutes, not one.
  await h.clock.advance(75_000)
  expect(gh()).toBe(1)
  await h.clock.advance(60_000)
  expect(gh()).toBe(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /SECRET/ })).toBeUndefined()
  expect(await ui.find({ text: /PR #/ })).toBeUndefined()
  await ui.unmount()
})

test('the weekly limit leaves a whole-percent marker, and the week shows on both surfaces', async ($, on) => {
  const h = v3Host(on)
  await $.session.start(START)
  const resetsAt = new Date(NOW + 2 * DAY).toISOString()
  await $.session.measure(limits({ kind: 'seven_day', percentUsed: 41.7, resetsAt }))
  expect(h.files.has(`${G}/week/${Date.parse(resetsAt) / 1000}-41`)).toBe(true)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /This week/ })).toBeDefined()
    expect(await ui.find({ text: /on pace: 58% of weekly limit/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the 5h row says when it runs out at this rate', async ($, on) => {
  const h = v3Host(on)
  await $.session.start(START)
  // 1h into the window at 80%: the rest goes in 15 minutes.
  await $.session.measure(limits({ kind: 'five_hour', percentUsed: 80, resetsAt: new Date(NOW + 4 * HOUR).toISOString() }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /out ~15m/ })).toBeDefined()
  await ui.unmount()
  void h
})

test('a gauge animates once on a change, and is drawn still after', async ($, on) => {
  const h = v3Host(on)
  await $.session.start(START)
  await $.session.measure(measure(20, 10, 10))
  await $.session.measure(measure(40, 10, 10))
  const donut = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const svgs = await ui.findAll({ type: 'Svg' })
    await ui.unmount()
    return String(svgs.find(e => String(e.props.alt).startsWith('Context'))?.props.source ?? '')
  }
  expect(await donut()).toContain('@keyframes')
  expect(await donut()).toContain('prefers-reduced-motion: no-preference')
  await h.clock.advance(1000)
  expect(await donut()).not.toContain('@keyframes')
})

test('motion off never animates', { options: { motion: 'off' } }, async ($, on) => {
  v3Host(on)
  await $.session.start(START)
  await $.session.measure(measure(20, 10, 10))
  await $.session.measure(measure(40, 10, 10))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svgs = await ui.findAll({ type: 'Svg' })
  const donut = svgs.find(e => String(e.props.alt).startsWith('Context'))
  expect(String(donut?.props.source)).toContain('<rect')
  expect(String(donut?.props.source)).not.toContain('@keyframes')
  await ui.unmount()
})

test('plain style has no cat or critters; playful adds them, and the cat follows context', async ($, on) => {
  v3Host(on)
  await $.session.start(START)
  await $.session.measure(measure(85, 10, 10))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /\/\\_\/\\/ })).toBeUndefined()
  expect(await ui.find({ text: /Context 85%: save what matters, then \/compact\./ })).toBeDefined()
  await ui.unmount()
})

test('playful: the cat sweats at high context', { options: { style: 'playful' } }, async ($, on) => {
  v3Host(on)
  await $.session.start(START)
  await $.session.measure(measure(85, 10, 10))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /\( O\.O;\)/ })).toBeDefined()
  expect(await ui.find({ text: /Claude’s head is full/ })).toBeDefined()
  expect(await ui.find({ text: /Context 85%: save what matters/ })).toBeUndefined()
  await ui.unmount()
})

test('playful: an idle pane is redrawn now and then, so the mood can move on', { options: { style: 'playful' } }, async ($, on) => {
  const h = v3Host(on)
  let redraws = 0
  on('ui.invalidate', () => {
    redraws++
    return { value: undefined }
  })
  await $.session.start(START)
  const before = redraws
  await h.clock.advance(60_000)
  expect(redraws).toBeGreaterThan(before)
})

test('with only this session, the Sessions section stays hidden', async ($, on) => {
  const h = v3Host(on)
  await $.session.start(START)
  expect(h.files.has(`${G}/sessions/abc-123.json`)).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Sessions \(/ })).toBeUndefined()
  await ui.unmount()
})

test('terminalStatus off (the default) leaves the terminal to statusline.sh', async ($, on) => {
  const host = startEngine(on, ['terminal'])
  const lines: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  const files: Record<string, { text: string }> = {}
  rosterFolder(on, host, files)
  await $.session.start({ cwd: '/code/groupyBot', surface: 'terminal', isInteractive: true })
  files['swim.json'] = { text: peer('swim', { label: 'Learning-to-Swim', status: 'needs-you', needs: 'approve Bash' }) }
  await host.clock.advance(5000)
  expect(lines).toEqual([])
})

test('toasts carry no Discworld and no tool names beyond /compact', async ($, on) => {
  const h = v3Host(on)
  await $.session.start(START)
  await $.session.measure(measure(55, 10, 10))
  await $.session.measure(measure(90, 10, 10))
  expect(h.toasts.length).toBe(2)
  for (const t of h.toasts) expect(t).not.toMatch(/obsidian|lid|luggage|narrative|suitcase|wizard/i)
})

test('a reload (session.start again) redraws an open pane, so new code or options show at once', async ($, on) => {
  v3Host(on)
  const asked: string[] = []
  on('ui.invalidate', (_$, e) => {
    asked.push(String(e.event))
    return { value: undefined }
  })
  await $.session.start(START)
  expect(asked).toContain('ui.render')
})

test('the pane draws images, never interactive frames, which reload (and flicker) on every redraw', async ($, on) => {
  v3Host(on)
  await $.session.start(START)
  await $.session.measure(measure(20, 10, 10))
  await $.session.measure(measure(40, 30, 10))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs.length).toBeGreaterThan(0)
  for (const svg of svgs) expect(svg.props.isInteractive).toBeUndefined()
  await ui.unmount()
})

for (const [style, line, toast] of [
  ['sassy', /My head is stuffed/, /^Oh good\. Context at 85%/],
  ['discworld', /thaums are piling up/, /^THE LID OPENS: Context at 85%/],
] as const) {
  test(`${style}: its own mood and toast voice, the cat too`, { options: { style } }, async ($, on) => {
    const h = v3Host(on)
    await $.session.start(START)
    await $.session.measure(measure(85, 10, 10))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ text: line })).toBeDefined()
    expect(await ui.find({ text: /\( O\.O;\)/ })).toBeDefined()
    await ui.unmount()
    expect(h.toasts.some(t => toast.test(t))).toBe(true)
  })
}
