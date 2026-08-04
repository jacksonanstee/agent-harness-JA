"""The measurement that decided ADR-0029, committed so it can be re-run.

Round-3 review: the ADR gave the anchor, the window and the outcomes but not
the command, so its figures were unfalsifiable from the repo — in an ADR whose
headline lesson is that a sliding window silently changed its own numbers.

Run:  python3 process/experiments/2026-08-04-superlative-variant-measurement.py [ANCHOR]

ANCHOR defaults to 9334f18, the merge-base ADR-0029 states. Pass a different
ref and the figures WILL differ, because the window is `git log -40` and slides
with HEAD; that is the point of pinning the anchor.

Expected at 9334f18 (all scopes, docs+process+README):
    40 commits, 15,233 added markdown lines
    full            97 lines fired, 24/40 commits blocked
    drop "the reason"   87,  24/40
    nowhere|no other    16,   9/40
    nowhere only        13,   8/40
Expected at 9334f18, docs/ + README only: 4,693 lines, 21/40 and 5/40.
"""

import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

VARIANTS = {
    'full (measured 7.8:1)': r'\b(the only|the reason|nowhere|no other|the single)\b',
    'drop "the reason"': r'\b(the only|nowhere|no other|the single)\b',
    'only "nowhere|no other"': r'\b(nowhere|no other)\b',
    'only "nowhere"': r'\bnowhere\b',
}

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=REPO).stdout

ANCHOR = sys.argv[1] if len(sys.argv) > 1 else '9334f18'
commits = [c for c in sh('git', 'log', '--format=%H', '-40', ANCHOR, '--',
                         'docs/', 'README.md', 'process/').split('\n') if c]

per_commit_lines = []
for c in commits:
    out = sh('git', 'diff', '--unified=0', f'{c}^', c, '--', '*.md')
    path, added = None, []
    for line in out.split('\n'):
        if line.startswith('+++ b/'):
            path = line[6:]
        elif line.startswith('+') and not line.startswith('+++'):
            added.append((path, line[1:]))
    per_commit_lines.append((c[:7], added))

total = sum(len(a) for _, a in per_commit_lines)
print(f'{len(commits)} docs commits, {total} added markdown lines\n')
print(f'{"variant":<26} {"lines fired":>12} {"% lines":>9} {"COMMITS BLOCKED":>17}')
for name, pat in VARIANTS.items():
    rx = re.compile(pat, re.I)
    fired = blocked = 0
    for _, added in per_commit_lines:
        hits = sum(1 for _, t in added if rx.search(t))
        fired += hits
        if hits:
            blocked += 1
    print(f'{name:<26} {fired:>12} {100*fired/total:>8.2f}% {blocked:>10}/{len(commits)}')
