#!/usr/bin/env python3
"""Measure candidate docs-claims gates against a hand-labelled defect corpus.

Recall  = fraction of KNOWN defects the check fires on.
Fire rate on negatives = fraction of ordinary shipped docs prose it also fires on.
A check is only useful if recall is high AND the negative fire rate is low
enough that the output is readable.
"""
import json, re, subprocess, pathlib, sys

REPO = pathlib.Path(__file__).resolve().parents[2]
CORPUS = json.load(open(pathlib.Path(__file__).parent / 'docs-defect-corpus.json'))['defects']

# --- issue #61's proposed quantifier list, verbatim from the issue body ---
QUANT = r'\b(only|never|nowhere|anywhere|all three|independent|every)\b'
# A wider list, to test whether #61's rule fails because the list is too short.
QUANT_WIDE = r'\b(only|never|nowhere|anywhere|every|all|none|always|any|no other|whole|entire|cannot|must)\b'
# What #61 counts as a citation on the same or adjacent line.
CITE = r'(`[^`]+`|\b\w+\.(ts|md|json):\d+|\bverified\b)'
SUPERLATIVE = r'\b(the only|the reason|nowhere|no other|the single)\b'
NUMBER = r'\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|zero)\b'


def check_quant_as_specified(text, has_cite):
    """#61 as written: an absolute quantifier with no citation on the line."""
    return bool(re.search(QUANT, text, re.I)) and not has_cite


def check_quant_only(text, has_cite):
    """The quantifier list alone, ignoring the citation escape hatch."""
    return bool(re.search(QUANT, text, re.I))


def check_quant_wide(text, has_cite):
    return bool(re.search(QUANT_WIDE, text, re.I))


def check_superlative(text, has_cite):
    return bool(re.search(SUPERLATIVE, text, re.I))


def check_number_uncited(text, has_cite):
    """A bare number in prose with no citation on the line."""
    return bool(re.search(NUMBER, text, re.I)) and not has_cite


CHECKS = [
    ('#61 as specified (quantifier AND no citation)', check_quant_as_specified),
    ('quantifier list only (no citation escape)', check_quant_only),
    ('wider quantifier list', check_quant_wide),
    ('superlative / uniqueness phrase', check_superlative),
    ('uncited number in prose', check_number_uncited),
]


def negatives():
    """Ordinary shipped docs prose: the best available proxy for 'correct'.

    CAVEAT, stated because it bounds every number below: these lines are only
    presumed correct. This repo has found defects in shipped prose repeatedly,
    so some negatives are certainly mislabelled, which makes the measured
    negative fire rate an UNDER-estimate of noise, not an over-estimate.
    """
    out = []
    for p in sorted((REPO / 'docs').rglob('*.md')):
        for ln in p.read_text(encoding='utf-8').splitlines():
            s = ln.strip()
            if len(s) < 40 or s.startswith(('#', '```', '|---', '- **Status')):
                continue
            out.append(s)
    return out


def main():
    neg = negatives()
    print(f"corpus: {len(CORPUS)} labelled defects | negatives: {len(neg)} shipped docs lines\n")
    w = 46
    print(f"{'check':<{w}} {'recall':>14}  {'fires on negatives':>20}")
    print('-' * (w + 38))
    for name, fn in CHECKS:
        hits = [d for d in CORPUS if fn(d['clause'], d['line_has_citation'])]
        nhits = [s for s in neg if fn(s, bool(re.search(CITE, s)))]
        r = len(hits) / len(CORPUS)
        f = len(nhits) / len(neg)
        print(f"{name:<{w}} {len(hits):>3}/{len(CORPUS)} ({r:4.0%})  {len(nhits):>5}/{len(neg)} ({f:4.0%})")

    print("\nper-defect detail for #61 as specified:")
    for d in CORPUS:
        fired = check_quant_as_specified(d['clause'], d['line_has_citation'])
        print(f"  {'FIRES' if fired else '     '}  {d['id']}  {d['class']}")

    caught = {d['id'] for d in CORPUS if check_quant_as_specified(d['clause'], d['line_has_citation'])}
    print(f"\n#61 as specified catches {len(caught)}/{len(CORPUS)}: {sorted(caught) or 'NONE'}")

    classes = {}
    for d in CORPUS:
        classes.setdefault(d['class'], 0)
        classes[d['class']] += 1
    print(f"\ndefect classes present ({len(classes)} distinct over {len(CORPUS)} defects):")
    for c, n in sorted(classes.items(), key=lambda kv: -kv[1]):
        print(f"  {n}x  {c}")


if __name__ == '__main__':
    main()
