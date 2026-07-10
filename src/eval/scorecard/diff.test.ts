import { describe, expect, it } from 'vitest';

import { diffRows } from './diff.js';

interface Row { id: string; pass: boolean; failureKind: string | null; verdict?: string }
const row = (id: string, over: Partial<Row> = {}): Row => ({ id, pass: true, failureKind: null, ...over });

describe('diffRows', () => {
  it('reports identical for equal sets regardless of order', () => {
    const d = diffRows([row('a'), row('b')], [row('b'), row('a')]);
    expect(d).toEqual({ identical: true, added: [], removed: [], changed: [] });
  });

  it('reports added and removed by id', () => {
    const d = diffRows([row('a')], [row('b')]);
    expect(d.identical).toBe(false);
    expect(d.removed.map((r) => r.id)).toEqual(['a']);
    expect(d.added.map((r) => r.id)).toEqual(['b']);
  });

  it('detects an extension-field-only change (design SK2: block→ask leaves core identical)', () => {
    const d = diffRows([row('a', { verdict: 'block' })], [row('a', { verdict: 'ask' })]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]?.fields).toEqual(['verdict']);
  });

  it('detects a field present on one side only', () => {
    const d = diffRows([row('a')], [row('a', { verdict: 'ask' })]);
    expect(d.changed[0]?.fields).toEqual(['verdict']);
  });

  it('pairs by id even with __proto__ as an id (Map pairing, design CG3)', () => {
    const d = diffRows([row('__proto__')], [row('__proto__')]);
    expect(d.identical).toBe(true);
  });

  it('handles empty row sets', () => {
    expect(diffRows([], []).identical).toBe(true);
  });
});
