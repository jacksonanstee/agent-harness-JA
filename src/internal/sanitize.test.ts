import { describe, expect, it } from 'vitest';

import { sanitizeControlChars } from './sanitize.js';

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
