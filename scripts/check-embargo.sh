#!/usr/bin/env bash
# Disclosure gate for fix-first security issues. While an issue is unfixed, some
# terms (an environment variable's name, a file name, a mechanism) must not reach
# anything public. They are listed, one per line, in tasks/embargo.txt, which is
# gitignored, so the list itself is never published. Blank lines and lines
# starting with # are ignored.
#
# Matching is literal after normalising BOTH sides: ASCII lower case, backslashes
# and NUL bytes dropped, and every run of '-', '_' and whitespace folded to one
# space. So a term also matches its markdown-escaped, hyphenated, line-wrapped
# and UTF-16 spellings, and binary files are read as text.
# Encoded or paraphrased forms (base64, HTML entities, a description in other
# words) are out of reach by design: this catches accidents, not intent.
#
# The list is read from the MAIN checkout's tasks/ even in a worktree (tasks/ is
# gitignored, so a worktree has none of its own). Install the hooks with
# scripts/install-hooks.sh, which copies them and this script into the shared
# .git/hooks, so every worktree runs them whatever its branch.
#
# Usage:
#   check-embargo.sh staged              added lines and file names in the index
#   check-embargo.sh msg FILE            a commit message
#   check-embargo.sh text FILE           any text, e.g. a PR or issue body before posting
#   check-embargo.sh range REV...        messages, added lines and file names of the
#                                        commits `git log REV...` lists
#   check-embargo.sh ref NAME [SHA]      a ref name, and an annotated tag's message
#
# EXIT CODES, three states on purpose:
#   0  checked and clean; or NOT CHECKED (no list, or a list with no terms),
#      which is said on stderr every time so it cannot pass unnoticed
#   1  an embargoed term was found (reported by its line number in the list,
#      never echoed, so the report is safe to paste)
#   2  the check did not run (usage, unreadable list, git failure)
set +x
set -uo pipefail
export LC_ALL=C

die() { echo "check-embargo: $*" >&2; exit 2; }

# Lower-case ASCII, drop backslashes and NUL bytes (so UTF-16 text of ASCII terms
# still matches), fold [-_[:space:]] runs to one space.
normalise() { tr '[:upper:]' '[:lower:]' | tr -d '\\\000' | tr -s -- '-_[:space:]' '   '; }

# Keep only the added lines of a patch: '+' lines inside hunks, never the
# '+++' file header, so an added line whose content starts with '++' is kept.
added_lines() { awk '/^diff --git /{h=0} /^@@/{h=1; next} h && /^\+/{print substr($0, 2)}'; }

common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || die "not a git repository"
common_dir=$(cd "$common_dir" && pwd -P) || die "cannot resolve the git directory"
list="$(dirname "$common_dir")/tasks/embargo.txt"

if [[ ! -e "$list" ]]; then
  echo "check-embargo: NOT CHECKED, no list at $list" >&2
  exit 0
fi
[[ -f "$list" && -r "$list" ]] || die "list at $list exists but cannot be read"

DIFF_OPTS=(--text --no-textconv --no-ext-diff --no-color -U0)
mode=${1:-}
case "$mode" in
  staged)
    patch=$(git diff --cached "${DIFF_OPTS[@]}") || die "git diff --cached failed"
    names=$(git diff --cached --name-only) || die "git diff --cached --name-only failed"
    text="$(added_lines <<<"$patch")"$'\n'"$names" ;;
  msg|text)
    [[ -n "${2:-}" && -f "$2" && -r "$2" ]] || die "$mode needs a readable FILE"
    text=$(cat "$2") || die "cannot read $2" ;;
  range)
    shift
    (( $# > 0 )) || die "range needs revisions, e.g. A..B"
    msgs=$(git log --format='%B' "$@") || die "git log failed for: $*"
    patch=$(git log --format= -p --diff-merges=first-parent "${DIFF_OPTS[@]}" "$@") || die "git log -p failed"
    names=$(git log --format= --name-only --diff-merges=first-parent "$@") || die "git log --name-only failed"
    text="$msgs"$'\n'"$(added_lines <<<"$patch")"$'\n'"$names" ;;
  ref)
    [[ -n "${2:-}" ]] || die "ref needs a NAME"
    text=$2
    if [[ -n "${3:-}" && "$(git cat-file -t "$3" 2>/dev/null)" == tag ]]; then
      tag=$(git cat-file -p "$3") || die "cannot read tag object $3"
      text+=$'\n'"$tag"
    fi ;;
  *) die "usage: check-embargo.sh staged | msg FILE | text FILE | range REV... | ref NAME [SHA]" ;;
esac

norm_text=" $(normalise <<<"$text") "
found=0
terms=0
lineno=0
while IFS= read -r term || [[ -n "$term" ]]; do
  lineno=$((lineno + 1))
  (( lineno == 1 )) && term=${term#$'\xef\xbb\xbf'}
  [[ "$term" =~ ^[[:space:]]*(#|$) ]] && continue
  norm_term=$(normalise <<<"$term")
  norm_term=${norm_term# }
  norm_term=${norm_term% }
  [[ -z "$norm_term" ]] && continue
  terms=$((terms + 1))
  if [[ "$norm_text" == *"$norm_term"* ]]; then
    echo "check-embargo: embargoed term (tasks/embargo.txt line $lineno) found in $mode input" >&2
    found=1
  fi
done < "$list" || die "cannot read the list"

if (( terms == 0 )); then
  echo "check-embargo: NOT CHECKED, the list has no terms" >&2
  exit 0
fi
if (( found == 1 )); then
  echo "check-embargo: remove it, or take the line out of the list once its issue is fixed and disclosed" >&2
  exit 1
fi
echo "check-embargo: clean ($mode)"
exit 0
