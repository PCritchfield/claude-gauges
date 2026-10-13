# claude-gauges

A terminal status line for [Claude Code](https://code.claude.com) that shows what the
desktop-only **gauges** pane shows: context, plan limits paced against the clock, session
cost, and every other Claude Code session you have open.

```
Opus 5.5  claude-gauges on ⎇ main ?2
[▓▓▓░░░░░░░░░] 31% · 5h 46% · 7d 22% · $3.21 · 62k/200k tokens
4 sessions · 1 working · ◆ groupyBot needs you
```

## What each line shows

**Line 1:** the model, the directory, and the git branch with staged (`+N`), modified (`~N`)
and untracked (`?N`) counts.

**Line 2:**
- The context bar and percentage. From 75% it adds a `/obsidian-summary` hint.
- **5h / 7d plan limits**, coloured by *pace* rather than raw usage:
  - projected = used % ÷ fraction of the window elapsed;
  - **amber** when projected ≥ 100%, **red** at ≥ 125% or raw ≥ 80%;
  - no projection before 10% of the window has elapsed, so only the 80% backstop applies then;
  - when a limit is amber or red, `↑N%` shows the projection.
- A `spend` limit (behind a Claude apps gateway) uses fixed 50/80 thresholds, because there's
  no window to pace against.
- The session cost and the token count.

Limits appear only on Pro and Max plans; Claude Code sends no `rate_limits` otherwise.

**Line 3:** the other live Claude Code sessions, read from the gauges mod's session files.
It appears only when another session is running, and shows:
- the number of sessions and how many are working;
- any session waiting for you, longest-waiting first. At 100+ columns it also says what that
  session needs.

Your own session is counted but never flagged as needing you: you're already looking at it.

Every line is fitted to the terminal width (`$COLUMNS`, which Claude Code sets), and long
names are cut with `…`. `NO_COLOR` is honoured.

## Install

You need `bash` (3.2 or newer, so stock macOS works) and `jq`.

```bash
git clone https://github.com/PCritchfield/claude-gauges.git ~/projects/github.com/PCritchfield/claude-gauges
```

Then point the status line at it in `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "bash ~/projects/github.com/PCritchfield/claude-gauges/statusline.sh",
  "padding": 0
}
```

## Dependency: the gauges session-file contract

Line 3 depends on the **gauges** Claude Code mod. In every session, the mod writes one file
per session to `~/.claude/gauges/sessions/<session-id>.json` (directory `0700`, files `0600`).

The record format is `SessionRecord` in the mod's `types/index.d.ts`, at version `v: 1`:

| Field | Type | Used here |
|---|---|---|
| `v` | number | `1` is read in full; a higher `v` shows label and status only |
| `id` | string | must equal the file name |
| `label` | string | shown, cut to 20 characters |
| `status` | `working` \| `needs-you` \| `idle` \| `ended` | counted; `ended` rows are dropped |
| `needs` | string \| null | shown at 100+ columns, cut to 24 characters |
| `since` | epoch ms | orders the sessions waiting on you |

Freshness is the file's mtime, not a field: a file not written in the last 2 minutes means
the session is gone. The mod rewrites its file at least every 30 seconds.

Additive changes to the record keep `v: 1`. A breaking change bumps `v`, and this script
then falls back to label and status. Without the mod installed, line 3 simply never appears.

### Session files are untrusted

Any local process could write into that directory, so the reader:
- skips symlinks, files owned by another user, files over 4 KB, files whose mtime is over
  2 minutes old (or in the future), and names that aren't `<id>.json`;
- skips a sessions directory that is itself a symlink;
- skips files that don't parse, aren't objects, have no numeric `v`, or whose `id` doesn't
  match the file name;
- reads at most 20 files;
- strips C0/C1 control characters (escape sequences included) and Unicode bidi controls from
  every string before printing.

## Tests

```bash
/bin/bash tests/run.sh
```

```bash
shellcheck statusline.sh tests/run.sh
```

The tests render against a throwaway `HOME`. They cover pacing, width fitting at 80 and 120
columns, and the hostile-file cases above. CI runs them on macOS and Linux.

`GAUGES_NOW=<epoch seconds>` pins the clock used for pacing (tests only). File freshness
always uses the real clock.

## License

MIT
