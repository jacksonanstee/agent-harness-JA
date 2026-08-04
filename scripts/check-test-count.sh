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
# This lives outside check-docs.sh deliberately: it needs node_modules and a
# test run, so it belongs in the build job, while check-docs.sh must stay
# install-free so a broken table is reported in seconds.
#
# Scope limit: this checks the COUNT, not the date beside it. Gating the date
# would fail every PR that touches a test without touching the README, which
# is friction with no defect behind it.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

README="README.md"
[ -f "$README" ] || { echo "check-test-count: no $README" >&2; exit 2; }

claimed=$(grep -oE '^\| Tests \| [0-9]+' "$README" | grep -oE '[0-9]+$')
if [ -z "$claimed" ]; then
  # Not "no claim, nothing to check": the row is part of the README's status
  # table and its absence is itself a drift worth reporting.
  echo "check-test-count: no '| Tests | N' row found in $README - if the row was removed, remove this gate in the same commit" >&2
  exit 1
fi

# --reporter=json emits one JSON document on stdout. numTotalTests counts every
# test the suite ran, which is the number the README row means.
raw=$(npx vitest run --reporter=json 2>/dev/null)
actual=$(printf '%s' "$raw" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    const start = s.indexOf("{");
    if (start < 0) { console.error("no JSON in vitest output"); process.exit(2); }
    try {
      const r = JSON.parse(s.slice(start));
      if (typeof r.numTotalTests !== "number") { console.error("no numTotalTests"); process.exit(2); }
      console.log(r.numTotalTests);
    } catch (e) { console.error("unparseable vitest JSON: " + e.message); process.exit(2); }
  });
')
status=$?
if [ $status -ne 0 ] || [ -z "$actual" ]; then
  echo "check-test-count: could not read the suite's test count from vitest" >&2
  exit 2
fi

if [ "$claimed" != "$actual" ]; then
  echo "README.md claims $claimed tests; the suite ran $actual. Re-derive the number rather than adjusting the date." >&2
  exit 1
fi

echo "check-test-count: OK ($actual)"
