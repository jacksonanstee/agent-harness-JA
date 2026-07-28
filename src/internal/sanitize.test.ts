import { describe, expect, it } from 'vitest';

import {
  escapeJsonText,
  escapePathUnsafe,
  JSON_TEXT_UNSAFE,
  sanitizeControlChars,
  stripBidi,
  stripInvisibles,
  TERMINAL_UNSAFE,
  truncateTailWellFormed,
} from './sanitize.js';

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

describe('escapePathUnsafe (round-1 fix, issue #46 Finding 1: deletion collides two paths)', () => {
  it('leaves a plain path unchanged, with escaped: false', () => {
    expect(escapePathUnsafe('/skills/helper.md')).toEqual({
      value: '/skills/helper.md',
      escaped: false,
    });
  });

  it('escapes an invisible character instead of deleting it - the two colliding paths stay distinguishable', () => {
    // The exact PoC that reversed the original (deletion) design: a hostile
    // path and its benign twin must not read back byte-identical.
    const hostile = escapePathUnsafe('/skills/he\u200Blper.md');
    const benign = escapePathUnsafe('/skills/helper.md');
    expect(hostile.value).toBe('/skills/he\\u{200B}lper.md');
    expect(hostile.escaped).toBe(true);
    expect(hostile.value).not.toBe(benign.value);
    // The raw invisible code point itself must still be gone - only its
    // textual trace survives, not the smuggling character.
    expect(hostile.value).not.toContain('\u200B');
  });

  it('escapes a bidi override instead of merely neutralising it, and reports escaped: true', () => {
    const result = escapePathUnsafe('/skills/\u202Egm.dm');
    expect(result.value).toBe('/skills/\\u{202E}gm.dm');
    expect(result.escaped).toBe(true);
    expect(result.value).not.toContain('\u202E');
  });

  it('escapes an astral default-ignorable (tag char) as one whole code point, not two surrogate halves', () => {
    // `u` flag requirement: without it, a surrogate pair matches as two
    // independent lone-surrogate code units, each producing its own bogus
    // half-escape instead of one correct escape.
    const result = escapePathUnsafe('/skills/tag\u{E0041}.md');
    expect(result.value).toBe('/skills/tag\\u{E0041}.md');
    expect(result.escaped).toBe(true);
  });

  it('reports escaped: false for a plain backslash - doubling is not itself an "escape"', () => {
    const result = escapePathUnsafe('C:\\Users\\file.md');
    expect(result.value).toBe('C:\\\\Users\\\\file.md');
    expect(result.escaped).toBe(false);
  });

  it('doubles backslashes FIRST, so a literal backslash cannot forge an escape sequence', () => {
    // Input is the LITERAL 8-character ASCII text of the escape form
    // (backslash, u, brace, 2, 0, 0, B, brace) - not a real invisible
    // character. It must read back distinguishably from a path containing a
    // genuine invisible character.
    const forged = escapePathUnsafe('/skills/he\\u{200B}lper.md');
    const genuine = escapePathUnsafe('/skills/he\u200Blper.md');
    expect(forged.value).toBe('/skills/he\\\\u{200B}lper.md'); // doubled: forged, not real
    expect(genuine.value).toBe('/skills/he\\u{200B}lper.md'); // single: real escape
    expect(forged.value).not.toBe(genuine.value);
    expect(forged.escaped).toBe(false); // no PATH_ESCAPE_TARGETS char present, only a backslash
  });
});

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

describe('escapeJsonText', () => {
  // Non-global probes. Both exported regexes carry `g`, and `.test` on a global
  // regex advances lastIndex, so reusing them inside these loops would skip
  // matches and read green vacuously.
  const target = new RegExp(JSON_TEXT_UNSAFE.source, 'u');
  const terminal = new RegExp(TERMINAL_UNSAFE.source, 'u');

  const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase()}`;

  it('round-trips every character it escapes, and leaves no raw one behind', () => {
    // Property-based, mirroring session.test.ts's invisible-code-point sweep:
    // the charset is a Unicode property, so the test asserts the whole class
    // rather than the handful of code points a proof-of-concept happened to use.
    const leaked: string[] = [];
    const broke: string[] = [];
    let swept = 0;
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const char = String.fromCodePoint(cp);
      if (!target.test(char)) continue;
      swept += 1;
      const value = `a${char}b`;
      const line = escapeJsonText(JSON.stringify({ v: value }));
      if (target.test(line)) leaked.push(hex(cp));
      if ((JSON.parse(line) as { v: string }).v !== value) broke.push(hex(cp));
    }
    // Anchor: without it a charset that matches nothing sweeps zero code points
    // and both arrays read green. 4,242 members on Node 25.8.1 (ICU 78.2,
    // Unicode 17.0); the bound is loose because an ICU upgrade may add more.
    expect(swept).toBeGreaterThan(4000);
    expect(leaked, 'code points still raw in the escaped JSON').toEqual([]);
    expect(broke, 'code points whose value changed under JSON.parse').toEqual([]);
  });

  it('escapes a strict superset of TERMINAL_UNSAFE, so the terminal pass is redundant on the export path', () => {
    // This is what lets runTelemetryExport drop sanitizeForTerminal from the
    // stdout branch instead of keeping it as a second pass. If anyone replaces
    // the derivation with a hand-typed literal, this is the ratchet that fires.
    const uncovered: string[] = [];
    let swept = 0;
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const char = String.fromCodePoint(cp);
      if (!terminal.test(char)) continue;
      swept += 1;
      if (!target.test(char)) uncovered.push(hex(cp));
    }
    // Literal-derived and so ICU-independent: 9 + 21 + 33 + 2.
    expect(swept).toBe(65);
    expect(uncovered, 'TERMINAL_UNSAFE code points the JSON escaper misses').toEqual([]);
  });

  it('covers every bidi control the internal sanitizer names', () => {
    // The pin against re-adding a hand-typed bidi list: src/internal/
    // sanitize.ts's BIDI_CONTROLS is wholly inside the property already.
    const bidi = new RegExp('[\\u202a-\\u202e\\u2066-\\u2069\\u200e\\u200f\\u061c]', 'u');
    const uncovered: string[] = [];
    let swept = 0;
    for (let cp = 0; cp <= 0xffff; cp += 1) {
      const char = String.fromCodePoint(cp);
      if (!bidi.test(char)) continue;
      swept += 1;
      if (!target.test(char)) uncovered.push(hex(cp));
    }
    expect(swept).toBe(12);
    expect(uncovered, 'bidi controls the JSON escaper misses').toEqual([]);
  });

  it('emits a surrogate PAIR for an astral target', () => {
    const languageTag = String.fromCodePoint(0xe0001);
    const line = escapeJsonText(JSON.stringify({ a: languageTag }));
    // Four hex digits per UTF-16 code unit. A code-point-wise escaper would
    // emit one five-digit escape here, which JSON.parse reads as U+E000
    // followed by a literal '1'.
    expect(line).toBe('{"a":"\\uDB40\\uDC01"}');
    expect((JSON.parse(line) as { a: string }).a).toBe(languageTag);
  });

  it('leaves the JSONL record separators and non-target astral text alone', () => {
    const zwsp = '\u200B';
    const rocket = String.fromCodePoint(0x1f680);
    const body = `${JSON.stringify({ a: rocket })}\n${JSON.stringify({ b: `x${zwsp}` })}\n`;
    const out = escapeJsonText(body);
    // Two records plus the trailing empty segment from the final delimiter.
    expect(out.split('\n')).toHaveLength(3);
    expect(out.includes(rocket)).toBe(true);
    expect(out.includes(zwsp)).toBe(false);
    expect(JSON.parse(out.split('\n')[1] ?? '')).toEqual({ b: `x${zwsp}` });
  });

  it('cannot be defeated by a backslash preceding a target, or by a forged escape in the data', () => {
    const zwsp = '\u200B';
    const rlo = '\u202E';
    const cases: readonly string[] = [
      `\\${zwsp}`, // one literal backslash then a target
      `\\\\${rlo}`, // two literal backslashes then a target
      '\\u200B', // forgery: literal text that only LOOKS like an escape
      `x${zwsp}\\`, // target then a trailing literal backslash
      `${rlo}\\n`, // target then the literal two-character text \n
      String.fromCharCode(0xd800), // lone high surrogate
      String.fromCharCode(0xdc00), // lone low surrogate
    ];
    for (const value of cases) {
      const label = JSON.stringify(value);
      const line = escapeJsonText(JSON.stringify({ v: value }));
      expect(JSON.parse(line), label).toEqual({ v: value });
      expect(target.test(line), label).toBe(false);
    }
  });
});
