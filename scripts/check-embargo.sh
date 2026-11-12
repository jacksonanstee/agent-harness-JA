#!/usr/bin/env bash
# Disclosure gate for fix-first security issues. While an issue is unfixed, some
# terms (an environment variable's name, a file name, a mechanism) must not reach
# anything public. They are listed, one per line, in tasks/embargo.txt, which is
# gitignored, so the list itself is never published. Blank lines and lines
# starting with # are ignored; matching is case-insensitive and literal.
#
# The list is read from the MAIN checkout's tasks/ even when this runs in a
# worktree (tasks/ is gitignored, so a worktree has none of its own).
#
# Usage:
#   check-embargo.sh staged          added lines in the index (pre-commit)
#   check-embargo.sh msg FILE        a commit message (commit-msg)
#   check-embargo.sh range A..B      messages and added lines of commits (pre-push)
#   check-embargo.sh text FILE       any text, e.g. a PR or issue body before posting
#
# EXIT CODES, three states on purpose:
#   0  checked and clean, or NO LIST (said out loud: nothing was checked)
#   1  an embargoed term was found (reported by its line number in the list,
#      never echoed, so the report itself is safe to paste)
#   2  usage or git error: the check did not run
set -uo pipefail

common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo "check-embargo: not a git repository" >&2; exit 2; }
list="$(dirname "$common_dir")/tasks/embargo.txt"

if [[ ! -f "$list" ]]; then
  echo "check-embargo: no list at $list, nothing checked"
  exit 0
fi

mode=${1:-}
case "$mode" in
  staged) text=$(git diff --cached -U0 --no-color | grep '^+' | grep -v '^+++') || true ;;
  msg|text)
    [[ -n "${2:-}" && -f "$2" ]] || { echo "check-embargo: $mode needs a readable FILE" >&2; exit 2; }
    text=$(cat "$2") ;;
  range)
    [[ -n "${2:-}" ]] || { echo "check-embargo: range needs A..B" >&2; exit 2; }
    text=$(git log -p --no-color --format='%B' "$2" 2>&1) || { echo "check-embargo: git log failed for $2" >&2; exit 2; } ;;
  *) echo "usage: check-embargo.sh staged | msg FILE | range A..B | text FILE" >&2; exit 2 ;;
esac

found=0
lineno=0
while IFS= read -r term || [[ -n "$term" ]]; do
  lineno=$((lineno + 1))
  term=${term%$'\r'}
  [[ -z "${term// /}" || "$term" == \#* ]] && continue
  if grep -qiF -- "$term" <<<"$text"; then
    echo "check-embargo: embargoed term (tasks/embargo.txt line $lineno) found in $mode input" >&2
    found=1
  fi
done < "$list"

if [[ $found -eq 1 ]]; then
  echo "check-embargo: remove it, or take the line out of the list once its issue is fixed and disclosed" >&2
  exit 1
fi
echo "check-embargo: clean ($mode)"
exit 0
