import { describe, expect, it } from 'vitest';

import { formatUsd } from './money.js';

// The one USD formatter behind every cost cell, summary line and progress
// figure (issue #143). The output is byte-pinned: golden and redteam
// scorecards, the judge summary and the CLI result line all render through it.
describe('formatUsd', () => {
  it('renders zero with four decimals', () => {
    expect(formatUsd(0)).toBe('$0.0000');
  });

  it('rounds to four decimals using toFixed semantics', () => {
    expect(formatUsd(0.00005)).toBe('$0.0001');
    expect(formatUsd(0.00004)).toBe('$0.0000');
    expect(formatUsd(0.12345)).toBe('$0.1235');
    expect(formatUsd(1)).toBe('$1.0000');
  });

  it('pads short values and keeps large values unrounded to the dollar', () => {
    expect(formatUsd(0.5)).toBe('$0.5000');
    expect(formatUsd(1234567.891)).toBe('$1234567.8910');
    expect(formatUsd(1e6)).toBe('$1000000.0000');
  });

  it('prefixes a negative value after the dollar sign, as the inlined copies did', () => {
    expect(formatUsd(-0.5)).toBe('$-0.5000');
  });
});
