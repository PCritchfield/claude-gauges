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
# treated as untrusted: symlinks, other owners, files over 4 KB, stale files,
# odd names, bad JSON and ids that do not match the file name are all skipped,
# and every string is stripped of control and bidi characters before printing.
# =============================================================================

# Character counts and cuts below must be in characters, not bytes.
export LC_ALL=C.UTF-8

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

# Matches the mod's UNSAFE class: C0, DEL, C1, and the bidi controls.
UNSAFE='[\x{0}-\x{1f}\x{7f}-\x{9f}\x{200e}\x{200f}\x{202a}-\x{202e}\x{2066}-\x{2069}]'

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
# paceOf: projected = pct ÷ fraction of window elapsed; amber at >= 100, red at
# >= 125 or raw >= 80; no projection before 10% of the window has elapsed; a
# window with no reset time (spend_limit) uses fixed 50/80.
# Each limit comes out as "pct:level:projected" (projected only when >= 100).
# -----------------------------------------------------------------------------
fields=$(jq -r --argjson now "$now" --arg unsafe "$UNSAFE" --arg us "$US" '
  def clean: if type == "string" then gsub($unsafe; "") else "" end;
  def num: if type == "number" then . else null end;
  def lim($w):
    if type == "object" and (.used_percentage | type) == "number" then
      .used_percentage as $p
      | (if $w > 0 and (.resets_at | type) == "number"
         then [1, ([0, 1 - ((.resets_at - $now) / $w)] | max)] | min
         else null end) as $e
      | (if $e != null and $e >= 0.1 then $p / $e else null end) as $proj
      | (if $e == null then (if $p >= 80 then 2 elif $p >= 50 then 1 else 0 end)
         elif $p >= 80 or ($proj != null and $proj >= 125) then 2
         elif $proj != null and $proj >= 100 then 1
         else 0 end) as $level
      | "\($p | floor):\($level):\(if $proj != null and $proj >= 100 then ($proj | floor) else "" end)"
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

git_status() {
  if [ -n "$DIR" ] && git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
    local branch staged modified untracked
    branch=$(git -C "$DIR" branch --show-current 2>/dev/null)
    [ -z "$branch" ] && branch="(detached)"
    # $(( )) drops the padding BSD wc puts around its count.
    staged=$(($(git -C "$DIR" diff --cached --numstat 2>/dev/null | wc -l)))
    modified=$(($(git -C "$DIR" diff --numstat 2>/dev/null | wc -l)))
    untracked=$(($(git -C "$DIR" ls-files --others --exclude-standard 2>/dev/null | wc -l)))
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
    printf '%s%s%s%s%s\n' "$real_now" "$US" "$DIR" "$US" "$git_line" >"$cache_file.$$" 2>/dev/null &&
      mv -f "$cache_file.$$" "$cache_file" 2>/dev/null
  fi
fi
IFS=$US read -r IN_REPO BRANCH STAGED MODIFIED UNTRACKED <<<"$git_line"
uint STAGED 0
uint MODIFIED 0
uint UNTRACKED 0

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
  tokens="$((TOKENS / 1000))k"
  [ "$CTX_SIZE" -gt 0 ] && tokens="$tokens/$((CTX_SIZE / 1000))k"
  seg "$tokens tokens" "$DIM"
fi
LINE2=$L

# -----------------------------------------------------------------------------
# Line 3: the roster of other sessions
# -----------------------------------------------------------------------------
STALE_SECS=120
MAX_FILES=20
NAME_RE='^[A-Za-z0-9-]{1,64}\.json$'

roster() {
  case "${HOME:-}" in /*) ;; *) return ;; esac
  local dir="$HOME/.claude/gauges/sessions"
  [ -d "$dir" ] && [ ! -L "$dir" ] || return

  local found path base n=0 paths=() ids=()
  found=$(find "$dir" -maxdepth 1 -type f -name '*.json' -user "$UID" -size -4097c 2>/dev/null)
  while IFS= read -r path; do
    base=${path##*/}
    [[ $base =~ $NAME_RE ]] || continue
    paths[n]=$path
    ids[n]=${base%.json}
    n=$((n + 1))
    [ "$n" -ge "$MAX_FILES" ] && break
  done <<<"$found"
  [ "$n" -eq 0 ] && return

  # Freshness is the file's mtime. One stat call for all of them.
  local mtimes
  case "$OSTYPE" in
    darwin* | *bsd*) mtimes=$(stat -f '%m' -- "${paths[@]}" 2>/dev/null) ;;
    *) mtimes=$(stat -c '%Y' -- "${paths[@]}" 2>/dev/null) ;;
  esac

  local i=0 k=0 mtime args=() filter=""
  while IFS= read -r mtime; do
    path=${paths[i]}
    base=${ids[i]}
    i=$((i + 1))
    case "$mtime" in '' | *[!0-9]*) continue ;; esac
    [ $((real_now - mtime)) -lt "$STALE_SECS" ] || continue
    [ $((mtime - real_now)) -lt 60 ] || continue
    args+=(--rawfile "f$k" "$path" --arg "i$k" "$base")
    filter="$filter{t:\$f$k,i:\$i$k},"
    k=$((k + 1))
  done <<<"$mtimes"
  [ "$k" -eq 0 ] && return

  # First line: total, working, others, needs-you others.
  # Then one line per other session that needs you: label, what (v1 only).
  jq -rn "${args[@]}" --arg self "$SESSION" --arg unsafe "$UNSAFE" --arg us "$US" "
    def text(\$n):
      if type == \"string\" then
        gsub(\$unsafe; \"\") | sub(\"^\\\\s+\"; \"\") | sub(\"\\\\s+\$\"; \"\")
        | if . == \"\" then null elif length > \$n then .[0:\$n - 1] + \"…\" else . end
      else null end;
    [ [${filter%,}][]
      | .i as \$id
      | (.t | if length <= 4096 then (try fromjson catch null) else null end) as \$r
      | select((\$r | type) == \"object\" and \$r.id == \$id and (\$r.v | type) == \"number\")
      | (\$r.v > 1) as \$minimal
      | { id: \$id,
          label: ((\$r.label | text(20)) // \$id[0:8]),
          status: (if \$r.status | IN(\"working\", \"needs-you\", \"idle\", \"ended\") then \$r.status else \"unknown\" end),
          needs: (if \$minimal then null else (\$r.needs | text(24)) end),
          since: (\$r.since | if type == \"number\" then . else 0 end) }
      | select(.status != \"ended\") ] as \$live
    | (\$live | map(select(.id != \$self))) as \$others
    | (\$others | map(select(.status == \"needs-you\")) | sort_by(.since)) as \$waiting
    | ([\$live, (\$live | map(select(.status == \"working\"))), \$others, \$waiting] | map(length | tostring) | join(\$us)),
      (\$waiting[] | \"\(.label)\(\$us)\(.needs // \"\")\")
  " 2>/dev/null
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
      seg "$R_TOTAL sessions" "$COBBLE"
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
