import { describe, expect, it } from 'vitest';

import { sanitizeControlChars, stripBidi, stripInvisibles, truncateTailWellFormed } from './sanitize.js';

describe('sanitizeControlChars', () => {
  it('strips C0 controls, C1 controls, DEL, and Unicode line separators', () => {
    expect(sanitizeControlChars('a\x1b[31mb')).toBe('a [31mb');
    expect(sanitizeControlChars('x\x00y\x07z')).toBe('x y z');
    expect(sanitizeControlChars('del\x7fc1\x9b')).toBe('del c1 ');
    expect(sanitizeControlChars('ls\u2028ps\u2029end')).toBe('ls ps end');
    expect(sanitizeControlChars('line1\nline2\ttab')).toBe('line1 line2 tab');
  });

  it('leaves printable text untouched', () => {
    expect(sanitizeControlChars('plain text — ünïcode ok')).toBe('plain text — ünïcode ok');
  });
});

describe('stripBidi (issue #24: hoisted to the zero-dep leaf)', () => {
  it('replaces bidi overrides, isolates, marks, and ALM with spaces', () => {
    expect(stripBidi('legit‮gnp.exe')).toBe('legit gnp.exe'); // RLO — Trojan-Source
    expect(stripBidi('a‪‫‬‭b')).toBe('a    b'); // LRE/RLE/PDF/LRO
    expect(stripBidi('x⁦⁧⁨⁩y')).toBe('x    y'); // isolates
    expect(stripBidi('m‎e‏f؜g')).toBe('m e f g'); // LRM/RLM/ALM
  });

  it('leaves genuine RTL letters intact (multilingual descriptions stay legal)', () => {
    expect(stripBidi('שלום مرحبا hello')).toBe('שלום مرحبا hello');
  });
});

describe('stripInvisibles (prompt-sink hardening, review MEDIUM on issue #24 fix)', () => {
  it('removes zero-width chars, tag chars, and variation selectors', () => {
    // ZWSP/ZWNJ/ZWJ/WJ/BOM/SHY interleaved between letters
    expect(stripInvisibles('a\u200Bb\u200Cc\u200Dd\u2060e\uFEFFf\u00ADg')).toBe('abcdefg');
    expect(stripInvisibles('hi\u{E0041}\u{E0042}dden')).toBe('hidden'); // tag chars
    expect(stripInvisibles('sel\uFE0F\u{E0100}ector')).toBe('selector'); // variation selectors
  });

  it('preserves NFD combining marks — accented text must not be mangled', () => {
    expect(stripInvisibles('cafe\u0301')).toBe('cafe\u0301');
  });
});

// The project deliberately does NOT use String.prototype.isWellFormed here:
// commit c9d3d61 reverted the project-wide `lib: ES2024` bump that it needs,
// because `lib` is a PROJECT-WIDE capability grant and widening it silently
// permits every other ES2024 API to compile, including ones absent from the
// Node 20 floor `engines` promises. Same pattern as
// src/eval/scorecard/sanitize.test.ts: spreading a string iterates by code
// point, so a lone surrogate left by a bisected pair surfaces as its own
// single-char element in the D800-DFFF range.
function hasLoneSurrogate(text: string): boolean {
  return [...text].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0xd800 && code <= 0xdfff;
  });
}

describe('truncateTailWellFormed', () => {
  it('returns the input unchanged when it is within the bound', () => {
    expect(truncateTailWellFormed('/skills/a.md', 64)).toBe('/skills/a.md');
  });

  it('keeps the TAIL, which is the disambiguating end of a path', () => {
    // 28 units; slice(16) is 'fix/skill.md'.
    expect(truncateTailWellFormed('/a/very/long/prefix/skill.md', 12)).toBe('…fix/skill.md');
  });

  it('drops a leading LOW surrogate whose high half was cut', () => {
    // 'abc' + U+1F600 (😀, two units) + 'def' = 8 units.
    // max 4 starts the slice at index 4, which is the LOW surrogate.
    const out = truncateTailWellFormed('abc\u{1F600}def', 4);
    expect(out).toBe('…def');
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('keeps a whole surrogate pair when the boundary does not split it', () => {
    // max 5 starts at index 3, the HIGH surrogate — the pair is intact.
    const out = truncateTailWellFormed('abc\u{1F600}def', 5);
    expect(out).toBe('…\u{1F600}def');
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});
