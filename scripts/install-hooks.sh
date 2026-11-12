#!/usr/bin/env bash
# Install the embargo hooks (scripts/check-embargo.sh) into the repository's
# SHARED hooks directory, together with a copy of the check, so every worktree
# runs them whatever its branch; a relative core.hooksPath would resolve per
# worktree and skip silently where .githooks/ does not exist. Re-run after
# changing scripts/check-embargo.sh or .githooks/ (pre-commit warns when the
# installed copy differs from the checkout's script).
#
# An existing hook that is not one of ours is moved aside to <hook>.pre-embargo,
# never overwritten silently, and a core.hooksPath setting is reported before it
# is removed.
set -euo pipefail
top=$(git rev-parse --show-toplevel)
hooks=$(git rev-parse --git-common-dir)/hooks
mkdir -p "$hooks"
if old=$(git config core.hooksPath); then
  echo "install-hooks: removing core.hooksPath (was: $old); hooks there no longer run" >&2
  git config --unset core.hooksPath
fi
for h in pre-commit commit-msg pre-push; do
  dest="$hooks/$h"
  if [[ -e "$dest" ]] && ! grep -q 'check-embargo.sh' "$dest"; then
    mv "$dest" "$dest.pre-embargo"
    echo "install-hooks: existing $h moved to $dest.pre-embargo (not ours; chain it by hand if needed)" >&2
  fi
  install -m 0755 "$top/.githooks/$h" "$dest"
done
install -m 0755 "$top/scripts/check-embargo.sh" "$hooks/check-embargo.sh"
echo "install-hooks: pre-commit, commit-msg, pre-push and check-embargo.sh installed in $hooks"
