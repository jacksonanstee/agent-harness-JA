#!/usr/bin/env bash
# S1 docs done-gate: every relative markdown link in README/docs/process must
# resolve to a real file or directory. Observable exit code (0 = green), no
# eyeballing. Deliberate scope limits:
#   - External URLs are NOT fetched (network cost + flake in CI).
#   - Anchors are NOT validated (GitHub slug rules — colon stripping etc. —
#     produced a false positive in the first audit; a naive matcher is worse
#     than none).
#   - Targets containing a literal ')' or space are unsupported (extraction
#     stops at either); none exist in this repo, and a titled link
#     [x](./p.md "title") extracts correctly as ./p.md.
#   - Root-absolute targets (](/docs/x.md)) are unsupported — everything here
#     resolves relative to the containing file; use relative links.
#
# NOTE: failures are collected in a temp file, not a variable — the
# extraction loop runs in a pipeline subshell, so a counter would be lost.
# NOTE: link targets are attacker-influenced content (cloned-repo threat
# model), so extracted strings are stripped of C0/C1 controls, ESC, and
# UTF-8 bidi overrides before echoing into CI logs (Trojan-Source class).
set -uo pipefail

# Strip terminal-spoofing bytes: C0 controls (keep \t), DEL, C1 range as
# UTF-8 (C2 80–C2 9F), and bidi overrides U+202A–E / U+2066–69.
sanitize() {
  LC_ALL=C sed -E $'s/[\x01-\x08\x0b-\x1f\x7f]//g; s/\xc2[\x80-\x9f]//g; s/\xe2\x80[\xaa-\xae]//g; s/\xe2\x81[\xa6-\xa9]//g'
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fails="$(mktemp)"
trap 'rm -f "$fails"' EXIT

find "$repo_root/README.md" "$repo_root/docs" "$repo_root/process" \
  -type f -name '*.md' 2>/dev/null | sort | while IFS= read -r md; do
  rel="${md#"$repo_root"/}"
  # Extract every markdown link target: [text](target ...) — stop at the
  # first ')' or space so a "title" clause never bleeds into the target.
  grep -oE '\]\([^) ]+' "$md" | sed -E 's/^\]\(//' | while IFS= read -r url; do
    [[ -z "$url" ]] && continue
    [[ "$url" =~ ^https?:// ]] && continue     # external: out of scope
    [[ "$url" =~ ^mailto: ]] && continue
    [[ "$url" =~ ^# ]] && continue             # same-file anchor: out of scope
    target="${url%%#*}"                        # strip anchor from relative link
    [[ -z "$target" ]] && continue
    resolved="$(dirname "$md")/$target"
    if [[ ! -e "$resolved" ]]; then
      printf 'BROKEN: %s -> %s\n' "$rel" "$url" | sanitize | tee -a "$fails"
    fi
  done
done

if [[ -s "$fails" ]]; then
  echo "link-check: FAIL ($(wc -l < "$fails" | tr -d ' ') broken)" >&2
  exit 1
fi
echo "link-check: OK"
