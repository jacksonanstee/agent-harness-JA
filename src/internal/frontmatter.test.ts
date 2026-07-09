import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import {
  hasUnsafeFenceLanguage,
  MAX_FILE_BYTES,
  SAFE_MATTER_OPTIONS,
} from './frontmatter.js';

describe('hasUnsafeFenceLanguage', () => {
  it('accepts a plain --- fence', () => {
    expect(hasUnsafeFenceLanguage('---\nname: x\n---\nbody')).toBe(false);
  });

  it('accepts yaml/yml fence languages case-insensitively', () => {
    expect(hasUnsafeFenceLanguage('---yaml\nname: x\n---\n')).toBe(false);
    expect(hasUnsafeFenceLanguage('---YML\nname: x\n---\n')).toBe(false);
  });

  it('rejects a js fence (the gray-matter eval RCE vector)', () => {
    expect(hasUnsafeFenceLanguage('---js\n({run: eval("1")})\n---\n')).toBe(true);
  });

  it('rejects unknown fence languages', () => {
    expect(hasUnsafeFenceLanguage('---coffee\nx\n---\n')).toBe(true);
  });

  it('handles a BOM before the fence', () => {
    expect(hasUnsafeFenceLanguage('﻿---js\nx\n---\n')).toBe(true);
  });

  it('does not hang on a long dash run (ReDoS guard)', () => {
    const start = Date.now();
    hasUnsafeFenceLanguage('-'.repeat(1_000_000));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('SAFE_MATTER_OPTIONS', () => {
  it('neutralizes the javascript engine even without the fence guard', () => {
    expect(() => matter('---js\n({x: 1})\n---\n', SAFE_MATTER_OPTIONS)).toThrow(
      /non-YAML frontmatter engine is disabled/,
    );
  });
});

describe('MAX_FILE_BYTES', () => {
  it('is the shared 1MB resource-exhaustion cap', () => {
    expect(MAX_FILE_BYTES).toBe(1_000_000);
  });
});
