#!/usr/bin/env python3
"""Measure COMMIT-SCOPED structural checks, which have a binary property to
test and therefore might succeed where the lexical checks failed.

CHECK-S1 "surviving phrase": a distinctive phrase this commit DELETED from one
file still exists verbatim elsewhere in the tree. Motivated by D08, where a
wrong claim was corrected in one file and left in three.

CHECK-S2 "intra-commit count disagreement": a counted noun ("N channels",
"N rows") appears with two different numbers across the files one commit
touches. Motivated by D12 ("four further channels" vs R-17's five).
"""
import re, subprocess, sys, collections

REPO = str(__import__('pathlib').Path(__file__).resolve().parents[2])
NUMWORD = {'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,'eight':8,'nine':9,'ten':10}


def git(*a):
    return subprocess.run(['git','-C',REPO,*a], capture_output=True, text=True).stdout


def norm(s):
    """Whitespace-collapse so a claim spanning a line wrap is still matchable.
    This is the fix for the naive line-oriented prototype, which missed D08
    precisely because the phrase spanned a ~76-column wrap."""
    return re.sub(r'\s+', ' ', re.sub(r'^[\s>*\-+|]*(//)?', ' ', s)).strip()


def removed_added(sha):
    d = git('show', sha, '--unified=0')
    rem, add = [], []
    for ln in d.splitlines():
        if ln.startswith('-') and not ln.startswith('---'): rem.append(norm(ln[1:]))
        elif ln.startswith('+') and not ln.startswith('+++'): add.append(norm(ln[1:]))
    return rem, add


def phrases(text, n=7):
    """Distinctive n-word shingles of ordinary prose."""
    words = re.findall(r"[a-z][a-z'/-]*", text.lower())
    return {' '.join(words[i:i+n]) for i in range(len(words)-n+1)}


def tree_text(sha):
    """The whole doc+source corpus at a commit, whitespace-normalised."""
    files = [f for f in git('ls-tree','-r','--name-only',sha).splitlines()
             if f.endswith(('.md','.ts')) and not f.startswith('node_modules')]
    return {f: norm(git('show', f'{sha}:{f}')) for f in files}


def check_s1(sha):
    """Fires when a phrase deleted by this commit survives elsewhere AFTER it."""
    rem, add = removed_added(sha)
    added_blob = ' '.join(add)
    after = tree_text(sha)
    survivors = []
    for line in rem:
        if len(line) < 45: continue
        for ph in phrases(line):
            if ph in added_blob:      # merely reworded in place, not a claim removal
                continue
            hits = [f for f, t in after.items() if ph in t]
            if hits:
                survivors.append((ph, hits))
                break
    return survivors


def check_s2(sha):
    """Fires when one commit's touched files disagree on a counted noun."""
    files = [f for f in git('show','--name-only','--format=', sha).splitlines()
             if f.endswith('.md')]
    counts = collections.defaultdict(set)
    for f in files:
        t = norm(git('show', f'{sha}:{f}'))
        for m in re.finditer(r'\b(\d+|' + '|'.join(NUMWORD) + r')\s+(further\s+)?([a-z]{4,})\b', t, re.I):
            n = m.group(1).lower()
            n = NUMWORD.get(n, n)
            counts[m.group(3).lower()].add((str(n), f))
    return {noun: sorted(v) for noun, v in counts.items()
            if len({n for n, _ in v}) > 1 and noun in ('channels','rows','objections','reasons','designs','defects')}


TRUE_POS = {
    '7e67413': 'D08: fixed "whole width of the home path" in the test comment, left it in 3 .md files',
    '0608a78': 'D20: left R-17 self-contradicting after editing its own (b) cell',
}
CONTROLS = ['61d6250', '48180c3', 'a1a4a73', '61fbdbf', 'ff949c8', 'db164e6', '3d4a497']

if __name__ == '__main__':
    print('=== CHECK-S1: phrase deleted here, still alive elsewhere ===')
    for sha, why in TRUE_POS.items():
        s = check_s1(sha)
        print(f'  {sha} (TRUE POSITIVE EXPECTED) -> {len(s)} hits   [{why[:60]}]')
        for ph, hits in s[:3]:
            print(f'       "{ph[:66]}"\n         survives in: {", ".join(h.split("/")[-1] for h in hits[:3])}')
    print('  --- controls (ordinary commits; every hit here is noise) ---')
    tot = 0
    for sha in CONTROLS:
        s = check_s1(sha)
        tot += len(s)
        print(f'  {sha} -> {len(s)} hits')
    print(f'  control total: {tot} hits across {len(CONTROLS)} ordinary commits')

    print('\n=== CHECK-S2: intra-commit count disagreement ===')
    for sha, why in TRUE_POS.items():
        print(f'  {sha} -> {check_s2(sha)}')
    for sha in CONTROLS[:4]:
        print(f'  {sha} (control) -> {check_s2(sha)}')
