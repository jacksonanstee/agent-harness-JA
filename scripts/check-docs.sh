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
# FILE SCOPE, and it is WIDER than check-links.sh's. That script scans README,
# docs/ and process/; this one scans every tracked markdown file, fixtures and
# agent-authored reports included. There is no exemption mechanism. The known
# consequence: a deliberately malformed .md fixture (an unclosed fence, say, to
# pin ADR-0028's accepted residual) would fail every build, and the only
# remedies would be deleting it or editing this script. If that day comes, add
# an explicit ignore list here rather than weakening a check.
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
# EXTENDING THIS GATE, because four of its failure modes are SILENT and it
# cannot warn you about them itself:
#   - A FOURTH spelling of the ADR count (e.g. "the thirtieth ADR", "0001
#     through 0030") is not detected. The `claims -eq 0` backstop only fires
#     when NO claim is recognised, so a new spelling alongside the existing
#     three drifts unchecked. Add a recogniser next to the other three.
#   - Another hand-copied derived constant. README's "Three essays" is one
#     today: `docs/blog/` holds exactly 3 files and nothing re-derives it.
#   - Moving docs/decisions/ or renaming README (now reported, not silent).
#   - Tables the scanner cannot see; see the blind-spot list in ADR-0029.
#
# Usage: check-docs.sh [ROOT]   (ROOT defaults to the repo root; the argument
# exists so the test suite can point it at fixture trees.)
set -uo pipefail

checks_completed=""
finish() {
  local status=$?
  if [ -z "$checks_completed" ] && [ "$status" -ne 0 ]; then
    echo "check-docs: did not complete (exit $status before the checks finished)" >&2
    rm -f "${FAILURES:-}" "${FILE_LIST:-}"
    exit 2
  fi
  rm -f "${FAILURES:-}" "${FILE_LIST:-}"
  exit "$status"
}
trap finish EXIT

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || { echo "check-docs: cannot enter '$ROOT'" >&2; exit 2; }

# Failures are collected in a temp file, not a variable: the loops below run in
# pipeline subshells where a counter would be silently discarded. Same
# construction, and same reason, as check-links.sh.
FAILURES=$(mktemp) || exit 2
FILE_LIST=$(mktemp) || exit 2

# TEST-ONLY SEAM, and it exists because round-2 review mutated `trap finish
# EXIT` to a no-op and the entire suite stayed green: the fix for the
# exit-code collision was itself bound by nothing. The one test named for the
# property used a non-existent root, which hits the explicit `exit 2` on the
# cd above and passes identically against the pre-fix script. A crash has to
# be REACHABLE for the trap to be testable at all.
#
# ⚠️ THIS IS FAULT INJECTION, NOT DEPENDENCY INJECTION. An earlier comment
# cited `generateNonce` in src/session/session.ts as the precedent; round-3
# review showed the analogy fails on every load-bearing axis (that injects a
# COLLABORATOR through a typed public field which production uses and which is
# validated; this injects a FAULT through ambient environment, has no
# production consumer and validates nothing). The honest name for it is fault
# injection. It fails safe — the crash lands on the trap and exits 2, so an
# environment that sets it by accident blocks the build rather than passing
# it — and it is not referenced by any workflow or npm script.
if [ -n "${CHECK_DOCS_SELFTEST_CRASH:-}" ]; then
  printf '%s' "$__check_docs_deliberately_unset_variable"
fi

# Every emitted line starts with a FIXED LITERAL, and that is a security
# control rather than cosmetics. GitHub Actions parses a step's output line as
# a WORKFLOW COMMAND when the line begins with `::`, and colons are not
# control characters, are not stripped below, and do not trigger git's path
# quoting. A tracked file at the repo root named
# `::error title=X::y.md` therefore used to produce a finding line beginning
# `::error title=X::`, giving a PR author a spoofed annotation in the Checks
# UI and, via `::add-mask::`, the ability to blank out later log lines. The
# prefix makes attacker-influenced text unable to be first on the line
# (round-3 security review, empirically confirmed).
FINDING_PREFIX='check-docs:'

note() {
  # Doc content and FILENAMES are attacker-influenced under the cloned-repo
  # threat model (security-model §2) and reach CI logs, so C0, C1, DEL and the
  # bidi overrides/isolates come out first. C1 is two UTF-8 bytes (0xC2
  # 0x80-0x9F), which no `tr` byte range can express, so it needs the sed pass
  # — the previous version's comment claimed C1 and stripped only C0.
  #
  # ⚠️ THE PIPELINE'S STATUS IS CHECKED. Every finding in this gate funnels
  # through this one function, and its `tr | sed` status was previously
  # discarded: a failing sed dropped the finding, and if it was the only one
  # the gate printed OK and exited 0. That is the same fail-open round 2 fixed
  # for awk, sitting at the choke point every finding passes through.
  local clean
  clean=$(printf '%s\n' "$1" \
    | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' \
    | LC_ALL=C sed $'s/\xc2[\x80-\x9f]//g; s/\xe2\x80[\xaa-\xae]//g; s/\xe2\x81[\xa6-\xa9]//g') || {
    echo "$FINDING_PREFIX the log sanitiser failed; refusing to report findings it could not clean" >&2
    exit 2
  }
  printf '%s %s\n' "$FINDING_PREFIX" "$clean" >> "$FAILURES" || {
    echo "$FINDING_PREFIX could not write to the findings file" >&2
    exit 2
  }
}

# Markdown files, NUL-separated.
#
# NUL rather than newlines, and `-c core.quotePath=off`, because `git ls-files`
# C-quotes any path with unusual bytes by default: a file named `café.md`
# arrived as the literal text `"caf\303\251.md"`, which awk then could not
# open, so the gate exited 2 and blocked every PR (round-3 review). NUL also
# makes a newline in a filename harmless.
#
# The previous version signalled git failure with `kill -TERM $$` from inside a
# process-substitution subshell. That did NOT produce the documented exit 2: it
# died with 143 (128+SIGTERM), skipped the trap's cleanup, and reached Node as
# `status: null, signal: SIGTERM`. Enumeration now happens once, up front, with
# its status inspected like any other command.
list_markdown_files() {
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git -c core.quotePath=off ls-files -z '*.md'
  else
    # node_modules is pruned: run outside a git tree after an install (a source
    # tarball, a Docker context without .git) this otherwise scanned thousands
    # of dependency READMEs.
    find . -name node_modules -prune -o -name '*.md' -type f -print0
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
  while IFS= read -r -d '' file; do
    # `find` yields ./path and `git ls-files` yields path. Normalised so the two
    # enumeration branches produce identical findings — and because the round-3
    # test for the `::` log-injection fix passed vacuously without it: the ./
    # prefix meant no line ever began with the attacker's filename, so the test
    # could not tell whether the FINDING_PREFIX was doing anything.
    file=${file#./}
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
      # Routed through note()'s sanitiser rather than echoed raw: this path
      # previously emitted the filename verbatim, and a bidi override in a
      # filename reached the CI log intact on the non-git branch (round-3).
      note "could not scan '$file' (scanner exit $status): $out"
      note "that file was NOT checked, so this run proves nothing"
      cat "$FAILURES" >&2
      exit 2
    fi
    [ -n "$out" ] || continue
    while IFS= read -r problem; do
      [ -n "$problem" ] && note "$problem"
    done <<EOF
$out
EOF
  done < "$FILE_LIST"
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
# Wrapper whose ONLY job is to make the fence-stripper's failure loud. Its awk
# had no status check, which is the identical shape as the round-2 awk finding
# in check_structure, left unfixed in the sibling function added by that very
# fix. If it fails the claim loop reads nothing and every count silently stops
# being compared.
readme_prose_or_die() {
  local out
  out=$(readme_prose) || {
    echo "$FINDING_PREFIX could not read README.md for ADR claims - not checked, so this run proves nothing" >&2
    exit 2
  }
  printf '%s\n' "$out"
}

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
  # ⚠️ THESE WERE SILENT RETURNS, which is the proxy-check pattern this same
  # function names and bans 50 lines below. Move docs/decisions/ in a reorg, or
  # rename README, and the whole derived-constant class went green forever with
  # no message. The sibling script already took the opposite view on the
  # identical condition (check-test-count.sh exits 2 on a missing README);
  # round-3 review found the two disagreeing inside one commit.
  #
  # A fixture tree that legitimately has neither is a tree where this check does
  # not apply; one that has README but no docs/decisions is a repo that moved
  # its ADRs, which is exactly the case worth shouting about.
  if [ ! -f README.md ] && [ ! -d docs/decisions ]; then
    return 0
  fi
  if [ ! -d docs/decisions ]; then
    note "docs/decisions/ is missing but README.md exists - the ADR counts are no longer being re-derived from anything"
    return 0
  fi
  if [ ! -f README.md ]; then
    note "README.md is missing but docs/decisions/ exists - nothing is asserting an ADR count to check"
    return 0
  fi

  local actual highest padded
  actual=$(find docs/decisions -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-*.md' | wc -l | tr -d ' ') || {
    note "could not enumerate docs/decisions - the ADR count was not re-derived"
    return 0
  }
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
  done < <(readme_prose_or_die | grep -iE 'ADRs?\b|0001[^0-9]')

  # A README that talks about ADRs but carries no claim this gate recognises is
  # REPORTED, never passed over. A silent skip is the proxy-check pattern
  # DEC-0016 bans: it goes quiet exactly when someone rewords the claim, which
  # is when the coverage is lost.
  # Reads the fence-stripped README, not the raw file: the raw grep undid the
  # round-2 fence fix six lines after it was applied, so an ADR mention that
  # existed only inside a fenced example produced a false failure (round-3).
  if [ "$claims" -eq 0 ] && readme_prose_or_die | grep -qiE '\bADRs?\b'; then
    note "check-docs: README mentions ADRs but carries no count this gate recognises (a range like 0001-$padded, '$actual ADRs', or the spelled-out form) - reword it into one of those or this check is silently covering nothing"
  fi
}

if ! list_markdown_files > "$FILE_LIST"; then
  echo "$FINDING_PREFIX could not enumerate markdown files - the tree was not scanned, so this run proves nothing" >&2
  exit 2
fi

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
