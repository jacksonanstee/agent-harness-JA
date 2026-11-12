#!/usr/bin/env bash
# Install the embargo hooks (scripts/check-embargo.sh) into the repository's
# SHARED hooks directory, together with a copy of the check, so every worktree
# runs them whatever its branch; a relative core.hooksPath would resolve per
# worktree and skip silently where .githooks/ does not exist. Re-run after
# changing scripts/check-embargo.sh or .githooks/.
set -euo pipefail
top=$(git rev-parse --show-toplevel)
hooks=$(git rev-parse --git-common-dir)/hooks
mkdir -p "$hooks"
git config --unset core.hooksPath 2>/dev/null || true
for h in pre-commit commit-msg pre-push; do
  install -m 0755 "$top/.githooks/$h" "$hooks/$h"
done
install -m 0755 "$top/scripts/check-embargo.sh" "$hooks/check-embargo.sh"
echo "install-hooks: pre-commit, commit-msg, pre-push and check-embargo.sh installed in $hooks"
