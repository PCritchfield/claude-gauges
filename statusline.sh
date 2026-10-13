#!/usr/bin/env bash
# =============================================================================
# claude-gauges status line
#
# Line 1: model, directory, git branch and changes
# Line 2: context bar, 5h/7d/spend limits coloured by pace, session cost, tokens
# Line 3: the other live Claude Code sessions, from the gauges mod's session
#         files (only when there are others)
#
# Reads Claude Code's status line JSON on stdin. Fits every line to $COLUMNS.
# Honours NO_COLOR. Always exits 0: a failing status line just goes blank.
#
# Session files: ~/.claude/gauges/sessions/<id>.json, written by the gauges mod
# (contract: SessionRecord, v 1). Any local process could write one, so each is
# treated as untrusted: symlinks, other owners, a loosely-permissioned directory,
# files over 4 KB, stale or future files, odd names, bad JSON and ids that do
# not match the file name are all skipped.
#
# Every string that reaches the terminal (session fields, model, directory, git
# branch) is stripped of control, bidi and invisible formatting characters.
# git runs with the repository's fsmonitor disabled and implicit bare
# repositories refused, so a cloned repo cannot run code through this script.
# =============================================================================

# Character counts and cuts below must be in characters, not bytes, which
# needs a UTF-8 locale. C.UTF-8 is on current macOS and Linux; else en_US.
export LC_ALL=C.UTF-8
probe='◆'
[ "${#probe}" -eq 1 ] || export LC_ALL=en_US.UTF-8

# uint NAME DEFAULT: sets NAME to DEFAULT unless it holds a non-negative integer.
uint() { case "${!1}" in '' | *[!0-9]*) printf -v "$1" '%s' "$2" ;; esac; }

real_now=$(date +%s)
now=${GAUGES_NOW:-$real_now}
uint now "$real_now"

COLS=${COLUMNS:-80}
uint COLS 80
[ "$COLS" -lt 20 ] && COLS=20
WIDE=0
[ "$COLS" -ge 100 ] && WIDE=1

US=$'\037' # field separator: a control character, so sanitised text never holds one

# Stripped from every untrusted string: C0, DEL, C1 (escape-sequence openers),
# the bidi controls (U+061C, U+200E-F, U+202A-E, U+2066-9), and the invisible
# formatting characters (U+200B-D, U+2028-9, U+2060-4, U+FEFF, tags).
# A superset of the mod's UNSAFE class in hooks/roster.ts.
UNSAFE='[\x{0}-\x{1f}\x{7f}-\x{9f}\x{61c}\x{200b}-\x{200f}\x{2028}-\x{202e}\x{2060}-\x{2064}\x{2066}-\x{2069}\x{feff}\x{e0000}-\x{e007f}]'

# Pace thresholds, named as in the mod's hooks/register.tsx. WARN_AT/HIGH_AT
# are the mod's warnPercent/highPercent defaults; its user options do not
# reach this script.
WARN_AT=50
HIGH_AT=80
PACE_WARN=100
PACE_HIGH=125
MIN_ELAPSED=0.1

# -----------------------------------------------------------------------------
# Colours
# -----------------------------------------------------------------------------
if [ -n "${NO_COLOR:-}" ]; then
  RESET='' BOLD='' DIM='' GOLD='' COPPER='' COBBLE='' RIVER='' FLAME='' DANGER='' GREEN='' LILAC=''
else
  RESET=$'\033[0m'
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  GOLD=$'\033[38;5;220m'
  COPPER=$'\033[38;5;172m'
  COBBLE=$'\033[38;5;240m'
  RIVER=$'\033[38;5;31m'
  FLAME=$'\033[38;5;202m'
  DANGER=$'\033[38;5;196m'
  GREEN=$'\033[38;5;70m'
  LILAC=$'\033[38;5;183m'
fi

# -----------------------------------------------------------------------------
# Line builder: segments are added left to right until the line is full.
#   seg TEXT COLOUR [SEPARATOR] [CUTTABLE]
# A cuttable segment that does not fit is shortened with "…"; any other
# segment that does not fit ends the line.
# -----------------------------------------------------------------------------
line_start() {
  L=""
  W=0
  FULL=0
}

seg() {
  local text=$1 colour=$2 sep=${3- · } cut=${4:-0} room
  [ "$FULL" -eq 1 ] && return
  [ "$W" -eq 0 ] && sep=""
  room=$((COLS - W - ${#sep}))
  if [ "${#text}" -gt "$room" ]; then
    if [ "$cut" -eq 1 ] && [ "$room" -ge 4 ]; then
      text="${text:0:$((room - 1))}…"
    else
      FULL=1
      return
    fi
  fi
  L="$L$sep$colour$text$RESET"
  W=$((W + ${#sep} + ${#text}))
}

# -----------------------------------------------------------------------------
# Stdin: one jq pass. Limits get their pace level here, ported from the mod's
# paceOf: projected = pct ÷ fraction of window elapsed; amber at >= PACE_WARN,
# red at >= PACE_HIGH or raw >= HIGH_AT; no projection before MIN_ELAPSED of the
# window; a window with no reset time (spend_limit) uses fixed WARN_AT/HIGH_AT.
# Each limit comes out as "pct:level:projected" (projected only when it is at
# least PACE_WARN). Percentages are rounded for display, as the mod does.
# -----------------------------------------------------------------------------
fields=$(jq -r --argjson now "$now" --arg unsafe "$UNSAFE" --arg us "$US" \
  --argjson warn_at "$WARN_AT" --argjson high_at "$HIGH_AT" \
  --argjson pace_warn "$PACE_WARN" --argjson pace_high "$PACE_HIGH" --argjson min_elapsed "$MIN_ELAPSED" '
  def clean: if type == "string" then gsub($unsafe; "") else "" end;
  def num: if type == "number" then . else null end;
  def lim($w):
    if type == "object" and (.used_percentage | type) == "number" then
      .used_percentage as $p
      | (if $w > 0 and (.resets_at | type) == "number"
         then [1, ([0, 1 - ((.resets_at - $now) / $w)] | max)] | min
         else null end) as $e
      | (if $e != null and $e >= $min_elapsed then $p / $e else null end) as $proj
      | (if $e == null then (if $p >= $high_at then 2 elif $p >= $warn_at then 1 else 0 end)
         elif $p >= $high_at or ($proj != null and $proj >= $pace_high) then 2
         elif $proj != null and $proj >= $pace_warn then 1
         else 0 end) as $level
      | "\($p | round):\($level):\(if $proj != null and $proj >= $pace_warn then ($proj | floor) else "" end)"
    else "" end;
  (.context_window | if type == "object" then . else {} end) as $cw
  | ($cw.current_usage | if type == "object" then . else null end) as $u
  | [ (.model.display_name | clean | if . == "" then "Unknown" else . end),
      ((.workspace.current_dir // .cwd) | clean),
      (.session_id | clean),
      (($cw.used_percentage | num) // 0 | floor | if . < 0 then 0 elif . > 100 then 100 else . end),
      (if $u then ([$u.input_tokens, $u.cache_read_input_tokens, $u.cache_creation_input_tokens] | map(num // 0) | add | floor) else 0 end),
      (($cw.context_window_size | num) // 0 | floor),
      (if (.cost.total_cost_usd | num) != null then (.cost.total_cost_usd * 100 | round) else "" end),
      (.rate_limits.five_hour | lim(18000)),
      (.rate_limits.seven_day | lim(604800)),
      (.rate_limits.spend_limit | lim(0))
    ] | map(tostring) | join($us)
' 2>/dev/null)

IFS=$US read -r MODEL DIR SESSION PCT TOKENS CTX_SIZE COST_CENTS LIM_5H LIM_7D LIM_SPEND <<<"$fields"
MODEL=${MODEL:-Unknown}
uint PCT 0
uint TOKENS 0
uint CTX_SIZE 0
case "$COST_CENTS" in *[!0-9]*) COST_CENTS="" ;; esac
case "$SESSION" in *[!A-Za-z0-9-]*) SESSION="" ;; esac

# -----------------------------------------------------------------------------
# Git status, cached per session for a few seconds to avoid lag
# -----------------------------------------------------------------------------
GIT_MAX_AGE=5

# The working directory may be any cloned or extracted tree, so its git config
# is untrusted. core.fsmonitor would run a command on every index read;
# safe.bareRepository=explicit refuses a bare-repo layout planted inside a
# checkout (whose config could set fsmonitor); diff.external and textconv
# drivers are turned off on the diffs. -c is protected scope, so the repo
# cannot override these. --no-optional-locks keeps this read-only, so it never
# fights the user's own git for index.lock. Needs git 2.38+ for
# safe.bareRepository; older git ignores it.
gitx() {
  git --no-optional-locks -c core.fsmonitor=false -c safe.bareRepository=explicit \
    -c core.untrackedCache=false -C "$DIR" "$@" 2>/dev/null
}

git_status() {
  if [ -n "$DIR" ] && gitx rev-parse --git-dir >/dev/null; then
    local branch staged modified untracked
    branch=$(gitx branch --show-current)
    [ -z "$branch" ] && branch="(detached)"
    # $(( )) drops the padding BSD wc puts around its count.
    staged=$(($(gitx diff --no-ext-diff --no-textconv --cached --numstat | wc -l)))
    modified=$(($(gitx diff --no-ext-diff --no-textconv --numstat | wc -l)))
    untracked=$(($(gitx ls-files --others --exclude-standard | wc -l)))
    printf '1%s%s%s%s%s%s%s%s' "$US" "$branch" "$US" "$staged" "$US" "$modified" "$US" "$untracked"
  else
    printf '0%s%s0%s0%s0' "$US" "$US" "$US" "$US"
  fi
}

cache_dir="${TMPDIR:-/tmp}"
cache_dir="${cache_dir%/}/claude-gauges-$UID"
[ -e "$cache_dir" ] || mkdir -m 700 "$cache_dir" 2>/dev/null
git_line=""
cache_file=""
if [ -d "$cache_dir" ] && [ ! -L "$cache_dir" ] && [ -O "$cache_dir" ]; then
  cache_file="$cache_dir/git-${SESSION:-default}"
  if [ -f "$cache_file" ] && [ ! -L "$cache_file" ]; then
    IFS=$US read -r c_time c_dir c_rest <"$cache_file"
    uint c_time 0
    if [ "$c_dir" = "$DIR" ] && [ $((real_now - c_time)) -le "$GIT_MAX_AGE" ]; then
      git_line=$c_rest
    fi
  fi
fi
if [ -z "$git_line" ]; then
  git_line=$(git_status)
  if [ -n "$cache_file" ]; then
    # Re-assert the mode in case the directory pre-existed with looser bits.
    chmod 700 "$cache_dir" 2>/dev/null
    tmp="$cache_file.$$.$RANDOM"
    printf '%s%s%s%s%s\n' "$real_now" "$US" "$DIR" "$US" "$git_line" >"$tmp" 2>/dev/null &&
      mv -f "$tmp" "$cache_file" 2>/dev/null
  fi
fi
IFS=$US read -r IN_REPO BRANCH STAGED MODIFIED UNTRACKED <<<"$git_line"
uint STAGED 0
uint MODIFIED 0
uint UNTRACKED 0

# Branch names may hold any byte >= 0x80, including C1 escape openers and bidi
# controls, and a clone's branch name is the remote's choice. Sanitised here,
# at display, so a tampered cache file is covered too. Plain names skip jq.
case "$BRANCH" in
  *[![:alnum:]._/+@=\(\)-]*)
    BRANCH=$(printf '%s' "$BRANCH" | jq -Rr --arg unsafe "$UNSAFE" 'gsub($unsafe; "")' 2>/dev/null)
    ;;
esac

# -----------------------------------------------------------------------------
# Line 1: model, directory, git
# -----------------------------------------------------------------------------
case "$MODEL" in
  *opus* | *Opus*) MODEL_COLOR=$GOLD ;;
  *sonnet* | *Sonnet*) MODEL_COLOR=$LILAC ;;
  *haiku* | *Haiku*) MODEL_COLOR=$COPPER ;;
  *) MODEL_COLOR=$COBBLE ;;
esac

DIRNAME="${DIR##*/}"
[ -z "$DIRNAME" ] && DIRNAME="$DIR"

line_start
seg "$MODEL" "$BOLD$MODEL_COLOR" "" 1
[ -n "$DIRNAME" ] && seg "$DIRNAME" "$COBBLE" "  " 1
if [ "$IN_REPO" = "1" ]; then
  seg "on" "$DIM" " "
  seg "⎇ $BRANCH" "$RIVER" " " 1
  [ "$STAGED" -gt 0 ] && seg "+${STAGED}staged" "$GREEN" " "
  [ "$MODIFIED" -gt 0 ] && seg "~${MODIFIED}" "$FLAME" " "
  [ "$UNTRACKED" -gt 0 ] && seg "?${UNTRACKED}" "$COBBLE" " "
  [ "$STAGED$MODIFIED$UNTRACKED" = "000" ] && seg "(clean)" "$DIM" " "
else
  seg "(no git)" "$DIM" " "
fi
LINE1=$L

# -----------------------------------------------------------------------------
# Line 2: context, limits, cost, tokens
# -----------------------------------------------------------------------------
BAR_WIDTH=12
FILLED=$((PCT * BAR_WIDTH / 100))
EMPTY=$((BAR_WIDTH - FILLED))
BAR=""
for ((j = 0; j < FILLED; j++)); do BAR="${BAR}▓"; done
for ((j = 0; j < EMPTY; j++)); do BAR="${BAR}░"; done

if [ "$PCT" -ge 90 ]; then
  BAR_COLOR=$DANGER
elif [ "$PCT" -ge 75 ]; then
  BAR_COLOR=$FLAME
elif [ "$PCT" -ge 50 ]; then
  BAR_COLOR=$GOLD
else
  BAR_COLOR=$GREEN
fi

CTX_HINT=""
if [ "$PCT" -ge 100 ]; then
  CTX_HINT="compaction imminent"
elif [ "$PCT" -ge 75 ]; then
  CTX_HINT="/obsidian-summary"
fi

# limit NAME "pct:level:projected"
limit() {
  local name=$1 pct level proj colour text
  [ -z "$2" ] && return
  IFS=: read -r pct level proj <<<"$2"
  case "$pct" in '' | *[!0-9]*) return ;; esac
  case "$level" in
    2) colour=$DANGER ;;
    1) colour=$FLAME ;;
    *) colour=$GREEN ;;
  esac
  text="$name $pct%"
  case "$proj" in '' | *[!0-9]*) ;; *) text="$text ↑$proj%" ;; esac
  seg "$text" "$colour"
}

line_start
seg "[$BAR]" "$BAR_COLOR" ""
seg "$PCT%" "$BOLD" " "
[ -n "$CTX_HINT" ] && seg "$CTX_HINT" "$DIM" " "
limit "5h" "$LIM_5H"
limit "7d" "$LIM_7D"
limit "spend" "$LIM_SPEND"
if [ -n "$COST_CENTS" ]; then
  printf -v cents '%02d' $((COST_CENTS % 100))
  seg "\$$((COST_CENTS / 100)).$cents" "$GOLD"
fi
if [ "$TOKENS" -gt 0 ]; then
  tokens=$TOKENS
  [ "$TOKENS" -ge 1000 ] && tokens="$((TOKENS / 1000))k"
  [ "$CTX_SIZE" -gt 0 ] && tokens="$tokens/$((CTX_SIZE / 1000))k"
  seg "$tokens tokens" "$DIM"
fi
LINE2=$L

# -----------------------------------------------------------------------------
# Line 3: the roster of other sessions
# -----------------------------------------------------------------------------
STALE_SECS=120  # the mod rewrites its file at least every 30 s
FUTURE_SECS=60  # tolerated clock skew for an mtime ahead of now
MAX_SCAN=200    # most candidate files looked at
MAX_FILES=20    # most fresh files read, as in the mod
ROSTER_VERSION=1
NAME_RE='^[A-Za-z0-9-]{1,64}\.json$'

roster() {
  case "${HOME:-}" in /*) ;; *) return ;; esac
  local dir="$HOME/.claude/gauges/sessions"
  [ -d "$dir" ] && [ ! -L "$dir" ] && [ -O "$dir" ] || return

  # One find. It prints the directory itself if group or other can write to it
  # (then nothing in it is trusted), and otherwise the candidate files. -mmin -3
  # is only a coarse pre-filter (BSD rounds minutes up, GNU does not), so stale
  # files never crowd out live ones; the exact cutoff is applied below.
  local found path base n=0 paths=()
  found=$(find "$dir" -maxdepth 1 \
    \( -type d -name "${dir##*/}" \( -perm -020 -o -perm -002 \) -print \) -o \
    \( -type f -name '*.json' -user "$UID" -size -4097c -mmin -3 -print \) 2>/dev/null)
  while IFS= read -r path; do
    [ "$path" = "$dir" ] && return
    base=${path##*/}
    # A newline in a file name splits it across two lines; requiring exactly
    # "$dir/<id>.json" drops both halves.
    [ "$path" = "$dir/$base" ] && [[ $base =~ $NAME_RE ]] || continue
    paths[n]=$path
    n=$((n + 1))
    [ "$n" -ge "$MAX_SCAN" ] && break
  done <<<"$found"
  [ "$n" -eq 0 ] && return

  # Freshness is the file's mtime. One stat call, printing each mtime with its
  # path so a file vanishing in between cannot shift the pairing. On BSD the
  # system stat is named outright: GNU coreutils first on PATH reads -f
  # differently.
  local stat_out
  case "$OSTYPE" in
    darwin* | *bsd*) stat_out=$(/usr/bin/stat -f '%m %N' -- "${paths[@]}" 2>/dev/null) ;;
    *) stat_out=$(stat -c '%Y %n' -- "${paths[@]}" 2>/dev/null) ;;
  esac

  local k=0 mtime args=()
  while read -r mtime path; do
    case "$mtime" in '' | *[!0-9]*) continue ;; esac
    [ $((real_now - mtime)) -lt "$STALE_SECS" ] || continue
    [ $((mtime - real_now)) -lt "$FUTURE_SECS" ] || continue
    base=${path##*/}
    [ "$path" = "$dir/$base" ] && [[ $base =~ $NAME_RE ]] || continue
    args+=(--rawfile "f$k" "$path" --arg "i$k" "${base%.json}")
    k=$((k + 1))
    [ "$k" -ge "$MAX_FILES" ] && break
  done <<<"$stat_out"
  [ "$k" -eq 0 ] && return

  # First line: total, working, others, needs-you others.
  # Then one line per other session that needs you: label, what (v1 only).
  # A record of a newer version shows label and status only, sorted as since 0.
  jq -rn "${args[@]}" --argjson n "$k" --argjson version "$ROSTER_VERSION" \
    --arg self "$SESSION" --arg unsafe "$UNSAFE" --arg us "$US" '
    def text($max):
      if type == "string" then
        gsub($unsafe; "") | sub("^\\s+"; "") | sub("\\s+$"; "")
        | if . == "" then null elif length > $max then .[0:$max - 1] + "…" else . end
      else null end;
    [ range(0; $n) as $j
      | $ARGS.named["i\($j)"] as $id
      | ($ARGS.named["f\($j)"] | if length <= 4096 then (try fromjson catch null) else null end) as $r
      | select(($r | type) == "object" and $r.id == $id and ($r.v | type) == "number")
      | ($r.v > $version) as $minimal
      | { id: $id,
          label: (($r.label | text(20)) // $id[0:8]),
          status: (if $r.status | IN("working", "needs-you", "idle", "ended") then $r.status else "unknown" end),
          needs: (if $minimal then null else ($r.needs | text(24)) end),
          since: (if $minimal then 0 else ($r.since | if type == "number" then . else 0 end) end) }
      | select(.status != "ended") ] as $live
    | ($live | map(select(.id != $self))) as $others
    | ($others | map(select(.status == "needs-you")) | sort_by(.since)) as $waiting
    | ([$live, ($live | map(select(.status == "working"))), $others, $waiting] | map(length | tostring) | join($us)),
      ($waiting[] | "\(.label)\($us)\(.needs // "")")
  ' 2>/dev/null
}

LINE3=""
roster_out=$(roster)
if [ -n "$roster_out" ]; then
  # Header line first, then one line per waiting session.
  {
    IFS=$US read -r R_TOTAL R_WORKING R_OTHERS R_WAITING
    uint R_TOTAL 0
    uint R_WORKING 0
    uint R_OTHERS 0
    uint R_WAITING 0
    if [ "$R_OTHERS" -gt 0 ]; then
      line_start
      sessions="sessions"
      [ "$R_TOTAL" -eq 1 ] && sessions="session"
      seg "$R_TOTAL $sessions" "$COBBLE"
      [ "$R_WORKING" -gt 0 ] && seg "$R_WORKING working" "$GREEN"
      shown=0
      max_shown=$((WIDE + 1))
      while IFS=$US read -r label what; do
        [ -z "$label" ] && continue
        [ "$shown" -ge "$max_shown" ] && break
        text="◆ $label needs you"
        [ "$WIDE" -eq 1 ] && [ -n "$what" ] && text="$text ($what)"
        seg "$text" "$BOLD$FLAME"
        shown=$((shown + 1))
      done
      [ "$R_WAITING" -gt "$shown" ] && seg "+$((R_WAITING - shown)) more" "$FLAME"
      LINE3=$L
    fi
  } <<<"$roster_out"
fi

printf '%s\n%s\n' "$LINE1" "$LINE2"
[ -n "$LINE3" ] && printf '%s\n' "$LINE3"
exit 0
