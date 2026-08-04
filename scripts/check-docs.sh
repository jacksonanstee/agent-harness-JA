#!/usr/bin/env bash
# S2 docs done-gate: STRUCTURAL and DERIVED facts about the documentation,
# checked as commands with observable exit codes (0 = green). Companion to
# check-links.sh, which checks link targets and nothing else.
#
# WHY THIS EXISTS, and why it checks these two things and not "claims".
# Issue #61 proposed gating unsupported ABSOLUTES ("only", "never", "nowhere")
# behind a citation requirement. That proposal was measured and does not work;
# see docs/decisions/0029-docs-structure-gate.md for the numbers. What survived
# measurement is the class of docs defect with an actual BINARY property, which
# is what this file checks.
#
# Both checks were derived from real defects that shipped past a green suite:
#   - A residual-risk row was added AFTER the blank line terminating its table,
#     so it rendered as a paragraph with visible pipes. The commit's entire
#     stated purpose was to add that row. Tests, lint, typecheck and
#     check-links were all green over it.
#   - A hand-copied count in README was accurate on its own branch and stale
#     the moment a sibling branch merged beside it.
#
# Deliberate scope limits, stated because a gate that overclaims is worse than
# none (ADR-0015's rule, applied to this file):
#   - This does NOT judge prose. No truth claims, no natural language.
#   - Fence tracking is line-based: a line whose first three characters are
#     backticks toggles fence state. An INDENTED fence (inside a list item) is
#     not tracked, so a pipe-leading line inside one could be scanned as prose.
#     Accepted: the defect class this catches is column-0 structure.
#   - Only ``` fences toggle, not ~~~. A ~~~ block containing pipe-leading
#     lines would be scanned as prose. The test suite pins this limit.
#   - Derived counts are re-derived from the FILESYSTEM only. The test count is
#     checked by check-test-count.sh, which needs the suite to have run.
#
# Usage: check-docs.sh [ROOT]   (ROOT defaults to the repo root; the argument
# exists so the test suite can point it at fixture trees.)
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || { echo "check-docs: cannot enter '$ROOT'" >&2; exit 2; }

# Failures are collected in a temp file, not a variable: every loop below runs
# in a pipeline subshell, where a counter would be silently discarded. This is
# the same construction (and the same reason) as check-links.sh.
FAILURES=$(mktemp) || exit 2
trap 'rm -f "$FAILURES"' EXIT

note() {
  # Doc content is attacker-influenced under the cloned-repo threat model
  # (security-model §2) and this string reaches CI logs, so strip C0/C1
  # controls and bidi overrides first — Trojan-Source class, the same
  # treatment check-links.sh gives link targets.
  printf '%s\n' "$1" \
    | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' \
    | LC_ALL=C sed $'s/\xe2\x80[\xaa-\xae]//g; s/\xe2\x81[\xa6-\xa9]//g' \
    >> "$FAILURES"
}

markdown_files() {
  # Tracked files only: an untracked scratch file is not part of the docs.
  # Falls back to find when there is no git dir, so fixture trees work.
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git ls-files '*.md'
  else
    find . -name '*.md' -type f | sed 's|^\./||'
  fi
}

# ---------------------------------------------------------------------------
# CHECK 1 — table structure.
#
# A GFM table is a header row, a delimiter row, then body rows, with no blank
# line inside it. A blank line ENDS the table, so a pipe-leading line after one
# is a paragraph that happens to contain pipes. It renders as literal text, and
# in a diff it looks exactly like a row.
#
# Rule: every maximal run of consecutive pipe-leading lines outside a fence
# must have a delimiter row as its SECOND line.
# ---------------------------------------------------------------------------
check_tables() {
  local file
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    awk -v F="$file" '
      function flush(   ) {
        if (n > 0) {
          # A delimiter row is pipes, spaces, colons and hyphens only, and must
          # carry at least one hyphen, so "| |" does not qualify as one.
          if (n < 2 || second !~ /^\|[ :|-]+$/ || second !~ /-/)
            printf "%s:%d: table row is not inside a table (no delimiter row on the line below the header) - a blank line above ends the table, so this renders as a paragraph\n", F, start
        }
        n = 0; second = ""
      }
      # substr, not a regex, so an info string (```ts) still toggles.
      substr($0, 1, 3) == "```" { flush(); infence = !infence; next }
      infence { next }
      /^\|/ {
        if (n == 0) start = FNR
        n++
        if (n == 2) second = $0
        next
      }
      { flush() }
      END { flush() }
    ' "$file"
  done < <(markdown_files) | while IFS= read -r problem; do note "$problem"; done
}

# ---------------------------------------------------------------------------
# CHECK 2 — fence balance.
#
# An unclosed fence swallows every later section of the rendered document. It
# is the documentation-side instance of the failure ADR-0028 accepts for skill
# bodies, and unlike that one it costs nothing to check here.
# ---------------------------------------------------------------------------
check_fences() {
  local file count
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    count=$(grep -c '^```' "$file" 2>/dev/null)
    [ -n "$count" ] || count=0
    if [ $((count % 2)) -ne 0 ]; then
      note "$file: $count column-0 code fences - an odd count means one is never closed, which swallows the rest of the document"
    fi
  done < <(markdown_files)
}

# ---------------------------------------------------------------------------
# CHECK 3 — derived constants re-derived.
#
# Any hand-copied computed value gets a check that re-derives it and fails on
# drift. The ADR count and range are asserted in README prose and in its status
# table; both come from the filesystem, so both are re-derived here.
# ---------------------------------------------------------------------------
check_adr_counts() {
  [ -d docs/decisions ] || return 0
  [ -f README.md ] || return 0

  local actual highest padded
  actual=$(find docs/decisions -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-*.md' | wc -l | tr -d ' ')
  highest=$(find docs/decisions -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-*.md' \
    | sed 's|.*/||; s|-.*||' | sort -n | tail -1)
  [ -n "$highest" ] || return 0
  padded=$(printf '%04d' "$((10#$highest))")

  # Contiguity underwrites every count claim below, so it is checked, not
  # assumed: N files numbered 0001..N, no gaps, no duplicates.
  if [ "$actual" -ne "$((10#$highest))" ]; then
    note "docs/decisions: $actual ADR files but the highest number is $padded - the numbering has a gap or a duplicate, so every count claim about it is ambiguous"
    return 0
  fi

  # The range claim, wherever it appears. This repo uses both an en dash and a
  # hyphen in these, so both are matched.
  local r
  for r in $(grep -oE '0001[^0-9]0[0-9]{3}' README.md | sort -u); do
    case "$r" in
      *"$padded") ;;
      *) note "README.md: claims ADR range '$r' but docs/decisions holds 0001-$padded" ;;
    esac
  done

  # The NUMERIC count ("28 ADRs"), which the README header carries separately
  # from the spelled-out one below. Found by this gate missing it on its own
  # first run: adding ADR-0029 left "28 ADRs" stale in the header while the
  # range and spelled-out claims were both caught. Two spellings of one fact
  # need two checks, or the uncovered one is where the drift lives.
  local n
  for n in $(grep -oE '\b[0-9]+ ADRs\b' README.md | grep -oE '^[0-9]+' | sort -u); do
    if [ "$n" != "$actual" ]; then
      note "README.md: claims '$n ADRs' but docs/decisions holds $actual"
    fi
  done

  # The spelled-out count ("Twenty-eight ADRs"). An unmapped number is
  # REPORTED, never skipped: a silent skip is the proxy-check pattern DEC-0016
  # bans, and it would go quiet exactly when the count grows past the mapping.
  local word expected
  word=$(grep -oiE '\b(twenty|thirty)(-(one|two|three|four|five|six|seven|eight|nine))?\b' README.md | head -1)
  [ -n "$word" ] || return 0
  expected=$(awk -v n="$actual" 'BEGIN {
    split("one two three four five six seven eight nine", o, " ");
    tens = int(n / 10) * 10; unit = n % 10;
    name = (tens == 20) ? "twenty" : (tens == 30) ? "thirty" : "";
    if (name == "") { print ""; exit }
    print (unit == 0) ? name : name "-" o[unit];
  }')
  if [ -z "$expected" ]; then
    note "check-docs: README spells an ADR count ('$word') that this gate cannot re-derive for $actual ADRs - extend the mapping rather than dropping the check"
  elif [ "$(printf '%s' "$word" | tr 'A-Z' 'a-z')" != "$expected" ]; then
    note "README.md: spells the ADR count '$word' but docs/decisions holds $actual ($expected)"
  fi
}

check_tables
check_fences
check_adr_counts

if [ -s "$FAILURES" ]; then
  cat "$FAILURES" >&2
  printf 'check-docs: FAILED (%d problem(s))\n' "$(wc -l < "$FAILURES" | tr -d ' ')" >&2
  exit 1
fi
echo "check-docs: OK"
