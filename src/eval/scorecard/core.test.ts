import { describe, expect, it } from 'vitest';
import { computeByFailureKind } from './core.js';

describe('computeByFailureKind', () => {
  const KINDS = ['a', 'b'] as const;
  it('counts each kind and ignores nulls', () => {
    const rows = [
      { id: '1', pass: false, failureKind: 'a' as const },
      { id: '2', pass: false, failureKind: 'a' as const },
      { id: '3', pass: true, failureKind: null },
    ];
    expect(computeByFailureKind(rows, KINDS)).toEqual({ a: 2, b: 0 });
  });
  it('is defensive against an out-of-tuple kind — no NaN, known kinds still counted', () => {
    const rows = [
      { id: '1', pass: false, failureKind: 'a' as const },
      // 'c' is NOT in KINDS — a producer/tuple drift. Must not corrupt the record.
      { id: '2', pass: false, failureKind: 'c' as unknown as 'a' },
      { id: '3', pass: false, failureKind: 'b' as const },
    ];
    const out = computeByFailureKind(rows, KINDS);
    expect(out).toEqual({ a: 1, b: 1 });
    expect(Number.isNaN(out.a)).toBe(false);
    expect(Number.isNaN(out.b)).toBe(false);
    expect('c' in out).toBe(false);
  });
});
