# claude-gauges

Two ways to see what [Claude Code](https://code.claude.com) is doing across every session you
have open: context, plan limits paced against the clock, cost, and who is waiting on you.

- **[The gauges mod](#the-gauges-mod)** (`mod/`): a live pane, drawn in the desktop app, VS
  Code or a terminal, and the data layer the status line reads.
- **The status line** (`statusline.sh`): the same at a glance in the terminal.

Each works alone; together, the mod writes one small file per session and the status line
reads them all.

## The status line

```
Opus 5.5  claude-gauges on ⎇ main ?2
[▓▓▓░░░░░░░░░] 31% · 5h 46% · 7d 22% · $3.21 · 62k/200k tokens
4 sessions · 1 working · ◆ groupyBot needs you
```

### What each line shows

**Line 1:** the model, the directory, and the git branch with staged (`+Nstaged`), modified
(`~N`) and untracked (`?N`) counts. It shows `(clean)` when there are none, and `(no git)`
outside a repository.

**Line 2:**
- The context bar and percentage. From 75% it adds a hint, and at 100% `compaction imminent`.
  The hint is `$GAUGES_CONTEXT_HINT`; set it to the command you use to save or compact a session
  (`/compact`, say), or to an empty string for no hint. When it is unset the hint is
  `/obsidian-summary`, the author's session-summary skill, which won't exist for you unless you
  have the same skill.
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

### Install the status line

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

To set the context hint, add it to the `env` object in the same file, e.g.
`"env": { "GAUGES_CONTEXT_HINT": "/compact" }`.

The status line updates on Claude Code's next refresh. To roll back, restore your previous
`statusLine` value, or delete the key.

### Dependency: the gauges session-file contract

Line 3 depends on the **gauges** mod in `mod/` (see [below](#the-gauges-mod)). In every session, the mod writes one file per session to
`~/.claude/gauges/sessions/<session-id>.json` (directory `0700`, files `0600`). While a session
runs, `ls ~/.claude/gauges/sessions/` lists its file.

The record format is `SessionRecord` in `mod/types/index.d.ts`, which is the source of
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

#### Session files are untrusted

Any local process could write into that directory, so the reader:
- skips symlinks, files owned by another user, files over 4 KB, files whose mtime is over
  2 minutes old or more than 60 seconds in the future, and names that aren't `<id>.json`;
- ignores the whole directory if it is a symlink, isn't yours, or is group- or other-writable;
- skips files that don't parse, aren't objects, have no numeric `v`, or whose `id` doesn't
  match the file name;
- reads at most 20 fresh files;
- strips C0/C1 control characters (escape sequences included), Unicode bidi controls and
  invisible formatting characters from every string before printing. This is the same class
  as the mod's `UNSAFE`; both are pinned by the shared vectors in
  `mod/hooks/contract-vectors.ts`.

A file swapped between the checks and the read is a remaining race, but only a process running
as you can do that, and it could already do anything you can.

#### git runs in untrusted directories

The working directory can be any cloned or extracted tree, and its `.git/config` is untrusted.
Every git call runs with `core.fsmonitor` disabled (a repo could otherwise run a command on every
status refresh), with implicit bare repositories refused (`safe.bareRepository=explicit`, git
2.38+), with external diff and textconv drivers off, and without taking optional locks. Branch
names are sanitised like session strings. A fully attacker-written `.git/config` could still
reach a `filter.*.clean` driver while git checks file contents; every shell prompt that shows
git status shares that limit.

The git result is cached for 5 seconds per session in `$TMPDIR/claude-gauges-$UID/` (mode
`0700`), so a branch switch can take that long to show.

## The gauges mod

A Claude Code mod (a hooks plugin) that opens a **Gauges** pane:

- **Waiting on you** first: any other session that needs an answer or an approval.
- **This session:** the model, working or idle, and a one-line read of the context with what
  to do about it ("Context 82%: save what matters, then /compact."), or in the playful style,
  Claude's mood.
- **Sessions:** once more than one is open, every local session with a status word, a small
  context bar, cost, and `+` when its repo has changes.
- **Context** and the **usage limits** as tanks, the limits coloured by pace (the same rule as the status
  line), "on pace: 118% of weekly limit", and for the 5-hour window when it runs out at this
  rate ("out ~25m") or resets ("resets 2h18m").
- **This week:** how much of the weekly limit each day used.
- **Repo:** branch, changed files, ahead/behind, last commit age; and the branch's **PR** with
  its checks and review state (needs the `gh` CLI, signed in).
- Tasks, cost, and running subagents.

It opens by itself in the desktop app and VS Code; `/gauges` toggles it anywhere. Gauges
animate briefly when a value moves, never in a loop; they follow the OS reduced-motion
setting, and `motion: off` stops animation outright. Colour is never the only signal: every
gauge has a word or a number beside it, and each drawing's alt text carries its numbers.

### Install the mod

At the prompt of a Claude Code terminal session:

```
/plugin install gauges --marketplace PCritchfield/claude-gauges
```

Answer `y` to add the marketplace, pick a scope (user is the usual one), then set the options.

### Options

| Option | Values | Default | What it does |
|---|---|---|---|
| `style` | `plain`, `playful` | `plain` | `plain` gives a dry line on what the context means and what to do. `playful` gives Claude a mood instead ("Claude thinks it’s past your bedtime.", "Claude is bored and quietly drafting plans for global domination."), picked from the time, session length, idle time, context, limits, cost and who is waiting on you; plus an ASCII cat whose face follows context, and a critter per session. Decoration only: status is always a word and a colour. |
| `motion` | `system`, `off` | `system` | `system` animates on change unless the OS asks for reduced motion; `off` never animates. |
| `terminalStatus` | on/off | off | Shows sessions waiting on you and off-pace limits in the terminal's status area. Leave it off when `statusline.sh` owns the terminal, or both say it. |
| `warnPercent` | number | 50 | Context turns amber and toasts once. |
| `highPercent` | number | 80 | Context turns red, and any limit at this raw percentage is red. |

### What it writes

Everything lives under `~/.claude/gauges/` (directory `0700`, files `0600`):

| Folder | What | Pruned after |
|---|---|---|
| `sessions/` | one record per session (the contract above) | 1 day |
| `toasts/` | empty markers, so N sessions show a toast once | 1 day |
| `week/` | empty `<reset>-<pct>` markers, the week's bars | 8 days |
| `pr/` | the PR row's cache, shared by every session on a branch | 1 day |

It never writes prompt text or tool input to disk. Every file read back is treated as
untrusted: size-capped, type-checked, and stripped of control, bidi and invisible characters.

### git and gh in untrusted repositories

The repo row reads whatever folder the session runs in, so the mod treats its git config as
hostile:
- every git call runs with hooks, `core.fsmonitor` and the untracked cache off, implicit bare
  repositories refused, no optional locks, no terminal prompt, and a 3-second timeout;
- before `git status`, it lists clean and process filters with their scope, and if any comes from
  the repository rather than your global or system config, it leaves the repo row off ("Repo
  details off: this repo sets its own git filters");
- branch names are stripped of control and format characters (bidi included) and cut to 48;
- `gh pr view <branch> -R <owner/repo>` runs only for a GitHub remote and a branch name of safe
  shape, with prompts off; its errors are never shown;
- git and gh run only while the pane is on screen (git also once at the start and end of each
  turn, for the session's changed-file count), one call at a time, and gh at most once a minute
  per branch across all sessions, backing off to 16 minutes after failures.

### Developing the mod

```bash
claude plugin validate .
```

```bash
claude plugin validate mod
```

```bash
claude plugin test mod
```

Type-checking needs the types the engine writes into `mod/.claude-plugin/types/` when it loads
the mod (kept out of git). Load it once (for example with `claude --plugin-dir mod`), then:

```bash
npx -p typescript@5.6.3 tsc -p mod
```

CI runs validate and the tests on a pinned Claude Code; tsc runs locally. Load a development
copy with `--plugin-dir` in one session rather than pointing `CLAUDE_CODE_PLUGIN_DIRS` at a
working tree: every session watching that folder hot-reloads half-written code.

## Tests

```bash
/bin/bash tests/run.sh
```

```bash
claude plugin test mod
```

```bash
shellcheck statusline.sh tests/run.sh
```

The tests render against a throwaway `HOME`. They cover pacing and its boundaries, width
fitting, the hostile-file cases above (except files owned by another user, which needs root to
set up), a planted `core.fsmonitor`, an embedded bare repository, and a hostile branch name. CI
runs them on macOS (bash 3.2, BSD tools) and Linux.

Pacing, the sanitiser and the record rules are shared: `mod/hooks/contract-vectors.ts` holds the
cases (its body is plain JSON), and both suites run every one.

`GAUGES_NOW=<epoch seconds>` pins the clock used for pacing (tests only). File freshness
always uses the real clock.

## License

MIT
