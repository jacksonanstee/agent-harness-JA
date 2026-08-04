#!/usr/bin/env bash
# S2 docs done-gate: STRUCTURAL and DERIVED facts about the documentation,
# checked as commands with observable exit codes. Companion to check-links.sh,
# which checks link targets and nothing else.
#
# EXIT CODES ARE PART OF THE CONTRACT, and the reason is a review finding
# against this file's first cut. `set -u` makes bash exit 1 on an unbound
# variable, which was the SAME code this gate used for "I found problems", so
# five of its own tests passed against a build of the script that executed no
# checks at all. Now:
#   0  every check ran and found nothing
#   1  every check ran and found problems (each one printed)
#   2  the gate did not complete — crash, bad root, unreadable tree
# The EXIT trap below enforces this: a non-zero exit before `checks_completed`
# is set becomes 2, so exit 1 means a finding and cannot mean a crash.
#
# WHY THIS EXISTS, and why it checks structure and not "claims". Issue #61
# proposed gating unsupported ABSOLUTES behind a citation requirement. That was
# measured twice and does not work; docs/decisions/0029-docs-structure-gate.md
# carries the numbers. What survived measurement is the class of docs defect
# with an actual binary property, which is this file.
#
# Both checks come from defects that shipped past a fully green suite: a
# residual-risk row added after the blank line that terminates its table (so it
# rendered as a paragraph), and a hand-copied count that went stale when a
# sibling branch merged beside the one that measured it.
#
# Deliberate scope limits, stated because a gate that overclaims is worse than
# none (ADR-0015's rule, applied to this file):
#   - This does NOT judge prose. No truth claims, no natural language.
#   - Fences are tracked CommonMark-style: an opener is up to 3 spaces then a
#     run of 3+ backticks or tildes, and only a run of the SAME character at
#     least as long closes it. Deeper indentation inside list items is not
#     modelled.
#   - A table row inside a blockquote (`> | a |`) is not seen. Blockquoted
#     tables do not appear in this repo and the marker would need its own
#     stripping pass.
#
# Usage: check-docs.sh [ROOT]   (ROOT defaults to the repo root; the argument
# exists so the test suite can point it at fixture trees.)
set -uo pipefail

checks_completed=""
finish() {
  local status=$?
  if [ -z "$checks_completed" ] && [ "$status" -ne 0 ]; then
    echo "check-docs: did not complete (exit $status before the checks finished)" >&2
    rm -f "${FAILURES:-}"
    exit 2
  fi
  rm -f "${FAILURES:-}"
  exit "$status"
}
trap finish EXIT

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || { echo "check-docs: cannot enter '$ROOT'" >&2; exit 2; }

# Failures are collected in a temp file, not a variable: the loops below run in
# pipeline subshells where a counter would be silently discarded. Same
# construction, and same reason, as check-links.sh.
FAILURES=$(mktemp) || exit 2

# TEST-ONLY SEAM, and it exists because round-2 review mutated `trap finish
# EXIT` to a no-op and the entire suite stayed green: the fix for the
# exit-code collision was itself bound by nothing. The one test named for the
# property used a non-existent root, which hits the explicit `exit 2` on the
# cd above and passes identically against the pre-fix script. A crash has to
# be REACHABLE for the trap to be testable at all. Same reasoning as the
# injectable `generateNonce` in src/session/session.ts.
if [ -n "${CHECK_DOCS_SELFTEST_CRASH:-}" ]; then
  printf '%s' "$__check_docs_deliberately_unset_variable"
fi

note() {
  # Doc content is attacker-influenced under the cloned-repo threat model
  # (security-model §2) and this reaches CI logs, so strip C0/C1 controls and
  # bidi overrides first — Trojan-Source class, the treatment check-links.sh
  # gives link targets.
  printf '%s\n' "$1" \
    | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' \
    | LC_ALL=C sed $'s/\xe2\x80[\xaa-\xae]//g; s/\xe2\x81[\xa6-\xa9]//g' \
    >> "$FAILURES"
}

markdown_files() {
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git ls-files '*.md' || { echo "check-docs: git ls-files failed" >&2; kill -TERM $$; }
  else
    find . -name '*.md' -type f | sed 's|^\./||'
  fi
}

# ---------------------------------------------------------------------------
# CHECK 1 and 2 — table structure and fence closure, one pass per file.
#
# A GFM table is a header row, a delimiter row, then body rows, with no blank
# line inside it. A blank line ENDS the table, so a pipe-leading line after one
# is a paragraph that happens to contain pipes. It renders as literal text, and
# in a diff it looks exactly like a row.
#
# An unclosed fence swallows the rest of the rendered document. Tracked by
# marker rather than by counting lines: a 4-backtick block containing a
# 3-backtick example is balanced, and line-parity called it broken.
# ---------------------------------------------------------------------------
check_structure() {
  local file out status
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    # ⚠️ awk's status is CAPTURED, not piped away. Round-2 review: awk ran on
    # the left of a pipeline whose status nothing inspected, so a missing awk
    # or one unreadable .md skipped the file and the gate printed "OK", exit 0.
    # That is the same defect as the exit-code collision, in the direction CI
    # acts on. A scanner that could not read a file has NOT checked it, which
    # is the didn't-run state, so it exits 2 rather than being filed as a
    # finding or ignored.
    out=$(awk -v F="$file" '
      function flush() {
        if (n > 0) {
          if (second !~ /^ ? ? ?\|[ :|-]+$/ || second !~ /-/)
            printf "%s:%d: table row is not inside a table (no delimiter row under the header) - a blank line above ends the table, so this renders as a paragraph\n", F, start
        }
        n = 0; second = ""
      }
      {
        line = $0
        sub(/\r$/, "", line)
      }
      match(line, /^ ? ? ?(```+|~~~+)/) {
        marker = line
        sub(/^ ? ? ?/, "", marker)
        ch = substr(marker, 1, 1)
        len = 0
        while (substr(marker, len + 1, 1) == ch) len++
        rest = substr(marker, len + 1)
        if (!infence) {
          flush()
          infence = 1; fch = ch; flen = len
          next
        }
        if (ch == fch && len >= flen && rest ~ /^[ \t]*$/) { infence = 0; next }
        next
      }
      infence { next }
      line ~ /^ ? ? ?\|/ {
        if (n == 0) start = FNR
        n++
        if (n == 2) second = line
        next
      }
      { flush() }
      END {
        flush()
        if (infence)
          printf "%s: a code fence opened and never closed - everything after it renders inside the block\n", F
      }
    ' "$file" 2>&1)
    status=$?
    if [ "$status" -ne 0 ]; then
      echo "check-docs: could not scan '$file' (scanner exit $status): $out" >&2
      echo "check-docs: the file was NOT checked, so this run proves nothing" >&2
      exit 2
    fi
    [ -n "$out" ] || continue
    while IFS= read -r problem; do
      [ -n "$problem" ] && note "$problem"
    done <<EOF
$out
EOF
  done < <(markdown_files)
}

# ---------------------------------------------------------------------------
# CHECK 3 — derived constants re-derived.
#
# Any hand-copied computed value gets a check that re-derives it and fails on
# drift. The ADR count appears in README in THREE spellings (a range, a bare
# numeral, a spelled-out word) and all three are checked: the first cut checked
# two, and the uncovered one is exactly where the drift was found.
# ---------------------------------------------------------------------------
# README with fenced blocks removed. check_structure is fence-aware and this
# was not, so a `29 ADRs` inside a shell example was read as a live claim
# (round-2 review). Same fence grammar, deliberately: two spellings of "is this
# inside a fence" would drift apart.
readme_prose() {
  awk '
    {
      line = $0
      sub(/\r$/, "", line)
    }
    match(line, /^ ? ? ?(```+|~~~+)/) {
      marker = line
      sub(/^ ? ? ?/, "", marker)
      ch = substr(marker, 1, 1)
      len = 0
      while (substr(marker, len + 1, 1) == ch) len++
      rest = substr(marker, len + 1)
      if (!infence) { infence = 1; fch = ch; flen = len; next }
      if (ch == fch && len >= flen && rest ~ /^[ \t]*$/) { infence = 0; next }
      next
    }
    infence { next }
    { print line }
  ' README.md
}

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

  local claims=0 line n word expected lower

  # Every ADR claim is matched on a line that MENTIONS ADRs. Scoping to the
  # line is what stops an unrelated "under thirty days" elsewhere in README
  # being read as the ADR count (review finding against the first cut, which
  # took the first match in the whole file).
  while IFS= read -r line; do
    # (a) the range, e.g. 0001-0029 or 0001–0029.
    for n in $(printf '%s' "$line" | grep -oE '0001[^0-9]{1,3}0[0-9]{3}' | grep -oE '0[0-9]{3}$'); do
      claims=$((claims + 1))
      [ "$n" = "$padded" ] || note "README.md: claims ADR range ending $n but docs/decisions holds 0001-$padded"
    done
    # (b) the bare numeral, e.g. "29 ADRs".
    for n in $(printf '%s' "$line" | grep -oE '\b[0-9]+ ADRs?\b' | grep -oE '^[0-9]+'); do
      claims=$((claims + 1))
      [ "$n" = "$actual" ] || note "README.md: claims '$n ADRs' but docs/decisions holds $actual"
    done
    # (c) the spelled-out count, e.g. "Twenty-nine ADRs".
    for word in $(printf '%s' "$line" | grep -oiE '\b(twenty|thirty)(-(one|two|three|four|five|six|seven|eight|nine))? ADRs?\b' | sed 's/ ADRs*$//'); do
      claims=$((claims + 1))
      expected=$(awk -v n="$actual" 'BEGIN {
        split("one two three four five six seven eight nine", o, " ");
        tens = int(n / 10) * 10; unit = n % 10;
        name = (tens == 20) ? "twenty" : (tens == 30) ? "thirty" : "";
        if (name == "") { print ""; exit }
        print (unit == 0) ? name : name "-" o[unit];
      }')
      lower=$(printf '%s' "$word" | tr 'A-Z' 'a-z')
      if [ -z "$expected" ]; then
        note "check-docs: README spells an ADR count ('$word') that this gate cannot re-derive for $actual ADRs - extend the mapping rather than dropping the check"
      elif [ "$lower" != "$expected" ]; then
        note "README.md: spells the ADR count '$word' but docs/decisions holds $actual ($expected)"
      fi
    done
  done < <(readme_prose | grep -iE 'ADRs?\b|0001[^0-9]')

  # A README that talks about ADRs but carries no claim this gate recognises is
  # REPORTED, never passed over. A silent skip is the proxy-check pattern
  # DEC-0016 bans: it goes quiet exactly when someone rewords the claim, which
  # is when the coverage is lost.
  if [ "$claims" -eq 0 ] && grep -qiE '\bADRs?\b' README.md; then
    note "check-docs: README mentions ADRs but carries no count this gate recognises (a range like 0001-$padded, '$actual ADRs', or the spelled-out form) - reword it into one of those or this check is silently covering nothing"
  fi
}

check_structure
check_adr_counts

# `checks_completed` is set INSIDE each branch, after the reporting work, not
# before it: a crash in cat/wc/printf would otherwise exit 1 and be read as a
# finding. Narrow window, but the header claims exit 1 cannot mean a crash and
# that claim should be true rather than nearly true (round-2 review).
if [ -s "$FAILURES" ]; then
  cat "$FAILURES" >&2
  printf 'check-docs: FAILED (%d problem(s))\n' "$(wc -l < "$FAILURES" | tr -d ' ')" >&2
  checks_completed=1
  exit 1
fi
checks_completed=1
echo "check-docs: OK"
