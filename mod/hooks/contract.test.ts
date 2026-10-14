// The shared contract: the same cases run in tests/run.sh against statusline.sh.
import { expect, test } from 'claude-code/testing'

import vectors from './contract-vectors'
import { HIGH_AT, MIN_ELAPSED, PACE_HIGH, PACE_WARN, paceOf, shownProjection, WARN_AT } from './pace'
import { MAX_ROWS, parseRecord, ROSTER_VERSION, sanitize, STALE_MS } from './roster'

const NOW = 1_791_920_400_000
const expand = (text: string) => text.replace('PAD4096', 'x'.repeat(4096))

test('constants match the shared contract', () => {
  expect({
    WARN_AT,
    HIGH_AT,
    PACE_WARN,
    PACE_HIGH,
    MIN_ELAPSED,
    ROSTER_VERSION,
    STALE_SECS: STALE_MS / 1000,
    MAX_FILES: MAX_ROWS,
  }).toEqual(vectors.constants)
})

// Each case carries its name, so a failure says which one.
test('every pace vector', () => {
  for (const v of vectors.pace) {
    const resetsAt = v.secondsLeft === null ? undefined : new Date(NOW + v.secondsLeft * 1000).toISOString()
    const pace = paceOf({ kind: v.kind, percentUsed: v.pct, resetsAt }, NOW)
    expect({ name: v.name, level: pace.level, shownProjection: shownProjection(pace) }).toEqual({
      name: v.name,
      level: v.level,
      shownProjection: v.shownProjection,
    })
  }
})

test('every sanitize vector', () => {
  for (const v of vectors.sanitize) expect({ name: v.name, out: sanitize(v.in) }).toEqual({ name: v.name, out: v.out })
})

test('every record vector', () => {
  for (const v of vectors.records) {
    const row = parseRecord(expand(v.text), v.file)
    if (v.expect === null) expect({ name: v.name, row }).toEqual({ name: v.name, row: null })
    else expect({ name: v.name, ...row }).toMatchObject({ name: v.name, ...v.expect })
  }
})
