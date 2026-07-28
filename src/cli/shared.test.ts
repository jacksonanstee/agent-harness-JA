import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { escapeJsonText, JSON_TEXT_UNSAFE, readPackageVersion, TERMINAL_UNSAFE } from './shared.js';

describe('readPackageVersion', () => {
  it('pins to the version in the repo package.json (catches ../package.json depth mistakes)', () => {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version: string };
    expect(readPackageVersion()).toBe(parsed.version);
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
