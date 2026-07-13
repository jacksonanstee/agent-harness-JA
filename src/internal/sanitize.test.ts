import { describe, expect, it } from 'vitest';

import { sanitizeControlChars, stripBidi, stripInvisibles } from './sanitize.js';

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
