#!/usr/bin/env bash
# Tests for statusline.sh. Needs only bash, jq and the base system tools, so it
# runs the same on macOS (bash 3.2, BSD find) and Linux (GNU find).
#
# Each test renders the status line against a throwaway HOME and asserts on the
# output. NO_COLOR=1 is set unless a test is checking colour, so any ESC byte in
# the output is a leak from untrusted data.

set -u

here=$(cd "$(dirname "$0")" && pwd)
script="$here/../statusline.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export HOME="$work/home" TMPDIR="$work/tmp"
mkdir -p "$HOME" "$TMPDIR" "$work/proj"
sessions="$HOME/.claude/gauges/sessions"

NOW=1791920400
export GAUGES_NOW=$NOW
SELF=11111111-1111-1111-1111-111111111111
FIVE_H=18000
SEVEN_D=604800

pass=0
fail=0
name=""

# The script runs under this same bash ($BASH); on macOS CI that is bash 3.2.
printf 'bash %s, %s\n' "$BASH_VERSION" "$(jq --version)"

# ---- Helpers ----------------------------------------------------------------

# The base stdin payload, with an optional jq object merged over it.
payload() {
  local o=${1:-'{}'}
  jq -cn --arg dir "$work/proj" --arg self "$SELF" --argjson now "$NOW" --argjson o "$o" '{
    session_id: $self,
    model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
    workspace: { current_dir: $dir },
    cost: { total_cost_usd: 1.2345 },
    context_window: {
      used_percentage: 42.7,
      context_window_size: 200000,
      current_usage: { input_tokens: 4000, cache_read_input_tokens: 80000, cache_creation_input_tokens: 500, output_tokens: 900 }
    },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: ($now + 9000) },
      seven_day: { used_percentage: 41.2, resets_at: ($now + 302400) }
    }
  } * $o'
}

# Renders at the given width: render COLUMNS [payload-override]
# The git cache is cleared first so no test sees another test's repo state.
render_colour() {
  rm -rf "$TMPDIR"/claude-gauges-*
  payload "${2:-}" | COLUMNS=$1 "$BASH" "$script"
}

render() { NO_COLOR=1 render_colour "$@"; }

# Writes a v1 session file: session ID LABEL STATUS [jq-override]
session() {
  local o=${4:-'{}'}
  mkdir -p "$sessions"
  jq -cn --arg id "$1" --arg label "$2" --arg status "$3" --argjson o "$o" '{
    v: 1, id: $id, label: $label, branch: null, status: $status,
    needs: (if $status == "needs-you" then "approve Bash" else null end),
    since: 1791920000000, model: "claude-opus-5-5", contextPct: 10, costUsd: 0.5,
    task: null, agents: 0, startedAt: 1791900000000
  } * $o' >"$sessions/$1.json"
}

reset_sessions() { rm -rf "$HOME/.claude"; }

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  printf 'FAIL [%s] %s\n' "$name" "$1"
  printf '%s\n' "$out" | sed 's/^/    | /'
}

has() { case "$out" in *"$1"*) ok ;; *) bad "expected: $1" ;; esac; }
lacks() { case "$out" in *"$1"*) bad "unexpected: $1" ;; *) ok ;; esac; }

lines_are() {
  local n
  n=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
  if [ "$n" -eq "$1" ]; then ok; else bad "expected $1 lines, got $n"; fi
}

# Every line fits: visible width (ANSI stripped, counted in characters) <= cols.
fits() {
  local cols=$1 line w
  while IFS= read -r line; do
    w=$(printf '%s' "$line" | sed $'s/\033\\[[0-9;]*m//g' | LC_ALL=C.UTF-8 wc -m | tr -d ' ')
    [ "$w" -le "$cols" ] || { bad "line is $w wide (> $cols): $line"; return; }
  done <<<"$out"
  ok
}

# No ESC and no C1 control (UTF-8 c2 80..c2 9f, which some terminals treat as
# escape-sequence openers) may reach NO_COLOR output.
no_escape() {
  if printf '%s' "$out" | od -An -tx1 | tr -s ' \n' '  ' | grep -Eq '(^| )(1b|c2 [89][0-9a-f])( |$)'; then
    bad "ESC or C1 byte in NO_COLOR output"
  else
    ok
  fi
}

# No bidi or invisible formatting character may reach the output.
no_bidi() {
  if printf '%s' "$out" | od -An -tx1 | tr -s ' \n' '  ' | grep -Eq 'e2 80 (8[b-f]|a[89a-e])|e2 81 (a[0-49])|d8 9c|ef bb bf'; then
    bad "bidi or invisible formatting character in output"
  else
    ok
  fi
}

# ---- Existing segments --------------------------------------------------------

name="base, no session files"
reset_sessions
out=$(render 120)
lines_are 2
has "Opus 5.5"
has "proj"
has "42%"
has "84k/200k tokens"
has "\$1.23"
has "5h 24%"
has "7d 41%"
no_escape

name="git branch and changes"
git -C "$work/proj" init -q -b feature/gauges
printf 'x\n' >"$work/proj/a.txt"
out=$(render 120)
has "on ⎇ feature/gauges"
has "?1"
rm -rf "$work/proj/.git" "$work/proj/a.txt"

name="context hint at 75%"
out=$(render 120 '{"context_window":{"used_percentage":80}}')
has "80%"
has "/obsidian-summary"

name="context hint is configurable"
out=$(payload '{"context_window":{"used_percentage":80}}' | GAUGES_CONTEXT_HINT=/compact COLUMNS=120 NO_COLOR=1 "$BASH" "$script")
has "80% /compact"
lacks "/obsidian-summary"
out=$(payload '{"context_window":{"used_percentage":80}}' | GAUGES_CONTEXT_HINT='' COLUMNS=120 NO_COLOR=1 "$BASH" "$script")
has "80% · "
lacks "/obsidian-summary"

name="early session: null context fields"
out=$(render 80 '{"context_window":{"used_percentage":null,"current_usage":null}}')
has "0%"
lacks "tokens"

name="no rate_limits (API key)"
out=$(payload | jq -c 'del(.rate_limits)' | COLUMNS=80 NO_COLOR=1 "$BASH" "$script")
lacks "5h"
lacks "7d"
has "\$1.23"

name="not JSON on stdin"
out=$(printf 'garbage' | COLUMNS=80 NO_COLOR=1 "$BASH" "$script")
code=$?
if [ "$code" -eq 0 ]; then ok; else bad "exit $code"; fi
has "0%"

name="COLUMNS unset defaults to 80"
out=$(payload | env -u COLUMNS NO_COLOR=1 "$BASH" "$script")
fits 80

# ---- Limits: pace -------------------------------------------------------------

# five_hour at pct P with fraction E of the window elapsed.
five_at() {
  local pct=$1 elapsed=$2
  printf '{"rate_limits":{"five_hour":{"used_percentage":%s,"resets_at":%s}}}' \
    "$pct" "$(awk -v n="$NOW" -v w="$FIVE_H" -v e="$elapsed" 'BEGIN { printf "%d", n + w * (1 - e) }')"
}

RED=$'\033[38;5;196m'
AMBER=$'\033[38;5;202m'
SAFE=$'\033[38;5;70m'

name="pace: on track"
out=$(render_colour 120 "$(five_at 20 0.5)")
has "${SAFE}5h 20%"
lacks "↑"

name="pace: amber at projected >= 100"
out=$(render_colour 120 "$(five_at 55 0.5)")
has "${AMBER}5h 55% ↑110%"

name="pace: red at projected >= 125"
out=$(render_colour 120 "$(five_at 25 0.2)")
has "${RED}5h 25% ↑125%"

name="pace: no projection before 10% elapsed"
out=$(render_colour 120 "$(five_at 30 0.05)")
has "${SAFE}5h 30%"
lacks "↑"

name="pace: raw backstop at 80 is red"
out=$(render_colour 120 "$(five_at 85 0.95)")
has "${RED}5h 85%"

name="pace: backstop applies before 10% elapsed too"
out=$(render_colour 120 "$(five_at 81 0.05)")
has "${RED}5h 81%"

name="seven_day uses its own window"
out=$(render_colour 120 "{\"rate_limits\":{\"seven_day\":{\"used_percentage\":60,\"resets_at\":$((NOW + SEVEN_D / 2))}}}")
has "${AMBER}7d 60% ↑120%"

name="spend_limit falls back to fixed 50/80"
out=$(render_colour 120 "{\"rate_limits\":{\"spend_limit\":{\"used_percentage\":62.8,\"resets_at\":$((NOW + 999999))}}}")
has "${AMBER}spend 63%"

# ---- Roster -------------------------------------------------------------------

A=aaaaaaaa-0000-0000-0000-000000000001
B=bbbbbbbb-0000-0000-0000-000000000002
C=cccccccc-0000-0000-0000-000000000003

name="roster: only this session -> no roster line"
reset_sessions
session "$SELF" "claude-gauges" working
out=$(render 80)
lines_are 2

name="roster: example line"
session "$A" "groupyBot" needs-you
session "$B" "api" idle
out=$(render 80)
lines_are 3
has "3 sessions · 1 working · ◆ groupyBot needs you"
fits 80

name="roster: wide shows what is needed"
out=$(render 120)
has "◆ groupyBot needs you (approve Bash)"
fits 120

name="roster: this session needing you is not flagged"
session "$SELF" "claude-gauges" needs-you
session "$A" "groupyBot" working
out=$(render 80)
lacks "needs you"
has "3 sessions · 1 working"

name="roster: ended rows dropped"
session "$B" "api" ended
out=$(render 80)
has "2 sessions"

name="roster: longest-waiting first, then +N more"
reset_sessions
session "$SELF" "me" working
session "$A" "alpha" needs-you '{"since":1791920300000}'
session "$B" "bravo" needs-you '{"since":1791920100000}'
session "$C" "charlie" needs-you '{"since":1791920200000}'
out=$(render 80)
has "◆ bravo needs you · +2 more"
fits 80
out=$(render 120)
has "◆ bravo needs you (approve Bash) · ◆ charlie needs you (approve Bash) · +1 more"
fits 120

name="roster: long labels are cut"
reset_sessions
session "$SELF" "me" working
session "$A" "an-extraordinarily-long-repository-name-indeed" needs-you
out=$(render 80)
has "◆ an-extraordinarily-… needs you"
fits 80

# ---- Roster: untrusted files ----------------------------------------------------

name="untrusted: stale file ignored"
reset_sessions
session "$SELF" "me" working
session "$A" "stale" needs-you
touch -t 202001010000 "$sessions/$A.json"
out=$(render 80)
lines_are 2

name="untrusted: symlink ignored"
reset_sessions
session "$SELF" "me" working
session "$A" "real" working
mv "$sessions/$A.json" "$work/elsewhere.json"
ln -s "$work/elsewhere.json" "$sessions/$A.json"
out=$(render 80)
lines_are 2

name="untrusted: file over 4 KB ignored"
reset_sessions
session "$SELF" "me" working
session "$A" "big" needs-you "{\"task\":\"$(printf '%5000s' '' | tr ' ' x)\"}"
out=$(render 80)
lines_are 2

name="untrusted: bad JSON skipped, others kept"
reset_sessions
session "$SELF" "me" working
printf '{"v":1,"id":' >"$sessions/$A.json"
session "$B" "good" needs-you
out=$(render 80)
has "2 sessions · 1 working · ◆ good needs you"

name="untrusted: id must match the file name"
reset_sessions
session "$SELF" "me" working
session "$A" "liar" needs-you "{\"id\":\"$B\"}"
out=$(render 80)
lines_are 2

name="untrusted: odd file names ignored"
reset_sessions
session "$SELF" "me" working
session "$A" "x" needs-you
mv "$sessions/$A.json" "$sessions/has space.json"
out=$(render 80)
lines_are 2

name="untrusted: unknown status counts but is not flagged"
reset_sessions
session "$SELF" "me" working
session "$A" "weird" "exploding"
out=$(render 80)
has "2 sessions"
lacks "needs you"

name="untrusted: escape and bidi characters stripped"
reset_sessions
session "$SELF" "me" working
session "$A" "x" needs-you "$(jq -cn '{label: "ev\u001b[2J\u001b]0;pwn\u0007il‮gnp", needs: "ok\u001b[31m"}')"
out=$(render 120)
no_escape
lacks $'‮'
lacks $'\a'
has "ev[2J]0;pwnilgnp needs you (ok[31m)"

name="untrusted: higher v shows label and status only"
reset_sessions
session "$SELF" "me" working
session "$A" "future" needs-you '{"v":2,"needs":"secret plans"}'
out=$(render 120)
has "◆ future needs you"
lacks "secret plans"

name="untrusted: missing v ignored"
reset_sessions
session "$SELF" "me" working
session "$A" "nov" needs-you '{"v":null}'
out=$(render 80)
lines_are 2

name="untrusted: sessions dir is a symlink"
reset_sessions
mkdir -p "$work/real-sessions" "$HOME/.claude/gauges"
ln -s "$work/real-sessions" "$sessions"
session "$A" "via-link" needs-you
out=$(render 80)
lines_are 2

# ---- Width ----------------------------------------------------------------------

name="width: everything at once fits 80 and 120"
reset_sessions
git -C "$work/proj" init -q -b feature/an-unreasonably-long-branch-name-for-testing-widths
printf 'x\n' >"$work/proj/a.txt"
session "$SELF" "me" working
session "$A" "groupyBot-with-a-long-name" needs-you
session "$B" "api" working
big="{\"cost\":{\"total_cost_usd\":1234.56},\"context_window\":{\"used_percentage\":91},\"rate_limits\":{\"five_hour\":{\"used_percentage\":99,\"resets_at\":$((NOW + 100))},\"seven_day\":{\"used_percentage\":99,\"resets_at\":$((NOW + 100))},\"spend_limit\":{\"used_percentage\":99,\"resets_at\":$((NOW + 100))}}}"
for cols in 80 120; do
  out=$(render "$cols" "$big")
  fits "$cols"
  lines_are 3
  has "⎇ feature/an-unreasonably"
done
rm -rf "$work/proj/.git" "$work/proj/a.txt"

# ---- Security: git in an untrusted directory -------------------------------------

name="security: repo config core.fsmonitor is not run"
reset_sessions
git -C "$work/proj" init -q -b main
printf 'x\n' >"$work/proj/a.txt"
git -C "$work/proj" add a.txt
git -C "$work/proj" config core.fsmonitor "touch '$work/PWNED'; false"
out=$(render 120)
has "on ⎇ main"
if [ -e "$work/PWNED" ]; then bad "core.fsmonitor ran"; else ok; fi
rm -rf "$work/proj/.git" "$work/proj/a.txt" "$work/PWNED"

name="security: embedded bare repository is not used"
mkdir -p "$work/proj/evil/objects" "$work/proj/evil/refs"
printf 'ref: refs/heads/main\n' >"$work/proj/evil/HEAD"
printf '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ..\n\tfsmonitor = touch %s; false\n' "'$work/PWNED'" >"$work/proj/evil/config"
out=$(payload "{\"workspace\":{\"current_dir\":\"$work/proj/evil\"}}" | COLUMNS=120 NO_COLOR=1 "$BASH" "$script")
has "(no git)"
if [ -e "$work/PWNED" ]; then bad "embedded bare repo fsmonitor ran"; else ok; fi
rm -rf "$work/proj/evil" "$work/PWNED"

name="security: hostile branch name is sanitised"
git -C "$work/proj" init -q -b main
git -C "$work/proj" symbolic-ref HEAD "refs/heads/x$(printf '\302\2332J')y$(printf '\342\200\256')z"
out=$(render 120)
no_escape
no_bidi
has "⎇ x2Jyz"
rm -rf "$work/proj/.git"

# ---- Security: the sessions directory and its files --------------------------------

name="untrusted: group-writable sessions dir ignored"
reset_sessions
session "$SELF" "me" working
session "$A" "loose" needs-you
chmod 0777 "$sessions"
out=$(render 80)
lines_are 2
chmod 0700 "$sessions"

name="untrusted: future mtime ignored"
reset_sessions
session "$SELF" "me" working
session "$A" "future" needs-you
touch -t 203001010000 "$sessions/$A.json"
out=$(render 80)
lines_are 2

name="untrusted: newline in a file name cannot reach another path"
reset_sessions
session "$SELF" "me" working
session "$A" "x" working
mv "$sessions/$A.json" "$sessions/x
planted.json"
jq -cn '{v: 1, id: "planted", label: "planted", status: "needs-you", since: 0}' >"$work/proj/planted.json"
out=$(cd "$work/proj" && payload | COLUMNS=80 NO_COLOR=1 "$BASH" "$script")
lacks "planted"
rm -f "$work/proj/planted.json"

name="untrusted: stale files do not crowd out a live session"
reset_sessions
session "$SELF" "me" working
for i in $(seq 10 34); do
  id="eeeeeeee-0000-0000-0000-0000000000$i"
  session "$id" "old$i" needs-you
  touch -t 202001010000 "$sessions/$id.json"
done
session "$A" "fresh" needs-you
out=$(render 80)
has "2 sessions · 1 working · ◆ fresh needs you"

name="untrusted: wider character set stripped"
reset_sessions
session "$SELF" "me" working
session "$A" "a" needs-you "$(jq -cn '{label: "a\u061cb\u200bc\u2028d\u2060e\ufeffg"}')"
out=$(render 80)
no_bidi
has "◆ abcdeg needs you"

name="roster: newer v sorts with since 0"
reset_sessions
session "$SELF" "me" working
session "$A" "alpha" needs-you '{"since":1}'
session "$B" "bravo" needs-you '{"v":2,"since":999999999999999}'
out=$(render 80)
has "◆ bravo needs you · +1 more"

# ---- Display details ----------------------------------------------------------------

name="roster: one other session and no own file says 1 session"
reset_sessions
session "$A" "solo" idle
out=$(render 80)
has "1 session"
lacks "1 sessions"

name="roster: long needs text is cut"
reset_sessions
session "$SELF" "me" working
session "$A" "a" needs-you '{"needs":"approve a very long tool name indeed"}'
out=$(render 120)
has "(approve a very long too…)"

name="tokens under 1000 are shown raw"
reset_sessions
out=$(render 80 '{"context_window":{"current_usage":{"input_tokens":500,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}')
has "500/200k tokens"

name="COLUMNS not a number defaults to 80; tiny COLUMNS floors at 20"
out=$(payload | COLUMNS=wide NO_COLOR=1 "$BASH" "$script")
fits 80
out=$(payload | COLUMNS=5 NO_COLOR=1 "$BASH" "$script")
fits 20

# ---- Pace boundaries ------------------------------------------------------------------

name="pace: projected exactly 100 is amber"
out=$(render_colour 120 "$(five_at 50 0.5)")
has "${AMBER}5h 50% ↑100%"

name="pace: raw exactly 80 is red"
out=$(render_colour 120 "$(five_at 80 0.9)")
has "${RED}5h 80%"

name="pace: 10% elapsed boundary matches the mod (no projection)"
out=$(render_colour 120 "$(five_at 15 0.1)")
has "${SAFE}5h 15%"

name="pace: reset time in the past clamps to a full window"
out=$(render_colour 120 "{\"rate_limits\":{\"five_hour\":{\"used_percentage\":50,\"resets_at\":$((NOW - 60))}}}")
has "${SAFE}5h 50%"

name="pace: no reset time falls back to fixed 50/80"
out=$(render_colour 120 '{"rate_limits":{"five_hour":{"used_percentage":55,"resets_at":null}}}')
has "${AMBER}5h 55%"
lacks "↑"

name="pace: seven_day backstop"
out=$(render_colour 120 "{\"rate_limits\":{\"seven_day\":{\"used_percentage\":81,\"resets_at\":$((NOW + 600000))}}}")
has "${RED}7d 81%"

name="pace: non-numeric percentage hides the limit"
out=$(render 120 '{"rate_limits":{"five_hour":{"used_percentage":"lots","resets_at":0}}}')
lacks "5h"

# ---- Summary --------------------------------------------------------------------

printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
