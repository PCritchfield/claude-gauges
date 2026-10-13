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

**Line 1:** the model, the directory, and the git branch with staged (`+Nstaged`), modified
(`~N`) and untracked (`?N`) counts. It shows `(clean)` when there are none, and `(no git)`
outside a repository.

**Line 2:**
- The context bar and percentage. From 75% it adds a `/obsidian-summary` hint (the author's
  session-summary skill; the command won't exist for you unless you have the same skill), and at
  100% `compaction imminent`.
- **5h / 7d plan limits**, coloured by *pace* rather than raw usage:
  - projected = used % ÷ fraction of the window elapsed;
  - **amber** when projected ≥ 100%, **red** at ≥ 125% or raw ≥ 80%;
  - no projection before 10% of the window has elapsed, so only the 80% backstop applies then;
  - when the projection is at least 100%, `↑N%` shows it. A limit that is red only because of
    the 80% backstop shows no arrow.
- A `spend` limit (behind a Claude apps gateway) uses fixed 50/80 thresholds, because there's
  no window to pace against.
- The session cost and the token count (raw below 1,000, else `Nk`).

Limits appear only on Pro and Max plans; Claude Code sends no `rate_limits` otherwise.

**Line 3:** the other live Claude Code sessions, read from the gauges mod's session files.
It appears only when another session is running, and shows:
- the number of sessions and how many are working;
- any session waiting for you, longest-waiting first: one at a time below 100 columns, two at
  100+ (where it also says what that session needs), then `+N more`.

A session with a status this script doesn't recognise is counted but never flagged.

Your own session is counted but never flagged as needing you: you're already looking at it.

Every line is fitted to the terminal width: `$COLUMNS`, which Claude Code sets for status line
commands (80 if it is missing or not a number, never below 20). Long names are cut with `…`.
Width is counted in characters, so double-width characters (CJK) can still overflow. `NO_COLOR`
(any non-empty value) turns colour off.

## Install

You need `bash` 3.2 or newer (so stock macOS works), `jq` 1.6 or newer, and a UTF-8 locale
(`C.UTF-8` or `en_US.UTF-8`). `git` is optional; 2.38 or newer is needed for the bare-repository
guard below.

```bash
git clone https://github.com/PCritchfield/claude-gauges.git ~/projects/github.com/PCritchfield/claude-gauges
```

Check it runs (expect two lines, the first starting with `Test`):

```bash
echo '{"model":{"display_name":"Test"}}' | bash ~/projects/github.com/PCritchfield/claude-gauges/statusline.sh
```

Then set `statusLine` in `~/.claude/settings.json`. Merge this key into the existing object; it
replaces any `statusLine` you already have:

```json
"statusLine": {
  "type": "command",
  "command": "bash ~/projects/github.com/PCritchfield/claude-gauges/statusline.sh",
  "padding": 0
}
```

The status line updates on Claude Code's next refresh. To roll back, restore your previous
`statusLine` value, or delete the key.

## Dependency: the gauges session-file contract

Line 3 depends on the **gauges** Claude Code mod (the author's; not yet published, it lives at
`~/.claude/mods/gauges`). In every session, the mod writes one file per session to
`~/.claude/gauges/sessions/<session-id>.json` (directory `0700`, files `0600`). While a session
runs, `ls ~/.claude/gauges/sessions/` lists its file.

The record format is `SessionRecord` in the mod's `types/index.d.ts`, which is the source of
truth. This table is derived from it and lists only what this script reads, at version `v: 1`:

| Field | Type | Used here |
|---|---|---|
| `v` | number | `1` is read in full; a higher `v` shows label and status only |
| `id` | string | must equal the file name |
| `label` | string | shown, cut to 20 characters |
| `status` | `working` \| `needs-you` \| `idle` \| `ended` | counted; `ended` rows are dropped |
| `needs` | string \| null | shown at 100+ columns, cut to 24 characters |
| `since` | epoch ms | orders the sessions waiting on you (treated as 0 when `v` is newer) |

Freshness is the file's mtime, not a field: a file not written in the last 2 minutes means
the session is gone. The mod rewrites its file at least every 30 seconds; that keepalive must
stay well under the 2-minute cutoff.

Additive changes to the record keep `v: 1`. A breaking change bumps `v`, and this script
then falls back to label and status. Without the mod installed, line 3 simply never appears.

### Session files are untrusted

Any local process could write into that directory, so the reader:
- skips symlinks, files owned by another user, files over 4 KB, files whose mtime is over
  2 minutes old or more than 60 seconds in the future, and names that aren't `<id>.json`;
- ignores the whole directory if it is a symlink, isn't yours, or is group- or other-writable;
- skips files that don't parse, aren't objects, have no numeric `v`, or whose `id` doesn't
  match the file name;
- reads at most 20 fresh files;
- strips C0/C1 control characters (escape sequences included), Unicode bidi controls and
  invisible formatting characters from every string before printing. This is a superset of the
  mod's own `UNSAFE` class.

A file swapped between the checks and the read is a remaining race, but only a process running
as you can do that, and it could already do anything you can.

### git runs in untrusted directories

The working directory can be any cloned or extracted tree, and its `.git/config` is untrusted.
Every git call runs with `core.fsmonitor` disabled (a repo could otherwise run a command on every
status refresh), with implicit bare repositories refused (`safe.bareRepository=explicit`, git
2.38+), with external diff and textconv drivers off, and without taking optional locks. Branch
names are sanitised like session strings. A fully attacker-written `.git/config` could still
reach a `filter.*.clean` driver while git checks file contents; every shell prompt that shows
git status shares that limit.

The git result is cached for 5 seconds per session in `$TMPDIR/claude-gauges-$UID/` (mode
`0700`), so a branch switch can take that long to show.

## Tests

```bash
/bin/bash tests/run.sh
```

```bash
shellcheck statusline.sh tests/run.sh
```

The tests render against a throwaway `HOME`. They cover pacing and its boundaries, width
fitting, the hostile-file cases above (except files owned by another user, which needs root to
set up), a planted `core.fsmonitor`, an embedded bare repository, and a hostile branch name. CI
runs them on macOS (bash 3.2, BSD tools) and Linux.

`GAUGES_NOW=<epoch seconds>` pins the clock used for pacing (tests only). File freshness
always uses the real clock.

## License

MIT
