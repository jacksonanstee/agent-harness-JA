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
});
