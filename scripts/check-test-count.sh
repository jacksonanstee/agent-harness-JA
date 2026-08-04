#!/usr/bin/env bash
# S2 done-gate, second half: the one derived constant in the docs that cannot
# be re-derived from the filesystem, because it is a property of the SUITE.
#
# README carries "| Tests | N at the <date> snapshot |". That number drifted on
# 2026-08-04: it was accurate on its own branch and stale the moment a sibling
# branch merged beside it, because each branch had measured itself alone. A
# dated snapshot makes a stale number defensible in prose, which is exactly why
# it needs a command rather than a convention.
#
# EXIT CODES, and the middle one is a review finding against the first cut,
# which captured vitest's stdout and never looked at its status:
#   0  README's count matches the suite
#   1  README's count is stale — a real drift, fix the README
#   2  the measurement is not trustworthy (suite red, vitest missing, output
#      unparseable, README row absent)
# The distinction matters because of how the first cut failed. With a test file
# that would not COLLECT, sixteen tests vanished and the gate reported
# "README claims 1135; the suite ran 1119. Re-derive the number" — instructing
# the developer to write the broken number into the README and hide the real
# failure. A red suite is never a docs drift.
#
# This lives outside check-docs.sh deliberately: it needs node_modules and a
# test run, so it belongs in the build job, while check-docs.sh stays
# install-free so a broken table is reported in seconds.
#
# Scope limit: this checks the COUNT, not the date beside it. Gating the date
# would fail every PR that touches a test without touching the README, which is
# friction with no defect behind it.
#
# Usage: check-test-count.sh [ROOT]   (ROOT exists so the suite can point it at
# a fixture; it defaults to the repo root.)
set -uo pipefail

# The same EXIT-trap contract check-docs.sh carries, and it is here because
# round-3 review found this file declaring the identical 0/1/2 contract in its
# header while implementing none of it. Under `set -u` an unbound variable
# exits 1, and the only exit 1 below means "README's count is stale" - so a
# typo in a future message string would tell a developer to write a wrong
# number into the README, which is precisely the defect this script exists to
# prevent, one level up.
checks_completed=""
finish() {
  local status=$?
  if [ -z "$checks_completed" ] && [ "$status" -ne 0 ] && [ "$status" -ne 2 ]; then
    echo "check-test-count: did not complete (exit $status before the comparison)" >&2
    exit 2
  fi
  exit "$status"
}
trap finish EXIT

# Test-only seam, same role as check-docs.sh's: a crash has to be REACHABLE for
# the trap to be bound by anything (round-2 lesson, applied here from the
# start rather than after review).
if [ -n "${CHECK_TEST_COUNT_SELFTEST_CRASH:-}" ]; then
  printf '%s' "$__check_test_count_deliberately_unset_variable"
fi

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || { echo "check-test-count: cannot enter '$ROOT'" >&2; exit 2; }

README="README.md"
[ -f "$README" ] || { echo "check-test-count: no $README in '$ROOT'" >&2; exit 2; }

# Whitespace-tolerant: a markdown formatter (Prettier, VS Code) pads table
# columns to align them, and the previous fixed-single-space pattern then found
# nothing and reported the row as MISSING - loud, but with the wrong diagnosis
# (round-3 review).
claimed=$(grep -oE '^\|[[:space:]]*Tests[[:space:]]*\|[[:space:]]*[0-9]+' "$README" | grep -oE '[0-9]+$')
if [ "$(printf '%s' "$claimed" | grep -c .)" -gt 1 ]; then
  echo "check-test-count: $README has more than one '| Tests | N' row; refusing to guess which one is the claim" >&2
  exit 2
fi
if [ -z "$claimed" ]; then
  # Not "no claim, nothing to check": the row is part of the README's status
  # table and its absence is itself a drift worth reporting.
  echo "check-test-count: no '| Tests | N' row found in $README - if the row was removed, remove this gate in the same commit" >&2
  exit 2
fi

# --reporter=json emits one JSON document on stdout. Status is captured
# separately: a red suite must not be read as a docs drift.
raw=$(npx vitest run --reporter=json 2>/dev/null)
vitest_status=$?

parsed=$(printf '%s' "$raw" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    const start = s.indexOf("{");
    if (start < 0) { console.error("no JSON in vitest output"); process.exit(2); }
    try {
      const r = JSON.parse(s.slice(start));
      if (typeof r.numTotalTests !== "number") { console.error("no numTotalTests"); process.exit(2); }
      const failedTests = r.numFailedTests ?? 0;
      const failedSuites = r.numFailedTestSuites ?? 0;
      console.log(`${r.numTotalTests} ${failedTests} ${failedSuites}`);
    } catch (e) { console.error("unparseable vitest JSON: " + e.message); process.exit(2); }
  });
')
parse_status=$?
# The two conditions coincide today (node emits nothing on its failure paths),
# so neither can be isolated by a fixture. Both are kept because they answer
# different questions and a future parser change could separate them; noted
# rather than silently carried as though one were tested (round-2 review).
if [ "$parse_status" -ne 0 ] || [ -z "$parsed" ]; then
  echo "check-test-count: could not read the suite's test count from vitest" >&2
  exit 2
fi

actual=$(printf '%s' "$parsed" | cut -d' ' -f1)
failed_tests=$(printf '%s' "$parsed" | cut -d' ' -f2)
failed_suites=$(printf '%s' "$parsed" | cut -d' ' -f3)

# A red suite (or one that failed to collect) makes the count meaningless: the
# number it reports is smaller than the truth for a reason that has nothing to
# do with the README. Report the real problem instead of the derived one.
if [ "$vitest_status" -ne 0 ] || [ "$failed_tests" -ne 0 ] || [ "$failed_suites" -ne 0 ]; then
  echo "check-test-count: the suite is not green ($failed_tests failed test(s), $failed_suites failed suite(s), vitest exit $vitest_status) - the count is not measurable and README is not the problem" >&2
  exit 2
fi

checks_completed=1
if [ "$claimed" != "$actual" ]; then
  echo "README.md claims $claimed tests; the suite ran $actual. Re-derive the number rather than adjusting the date." >&2
  exit 1
fi

echo "check-test-count: OK ($actual)"
