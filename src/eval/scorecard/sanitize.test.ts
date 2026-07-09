import { describe, expect, it } from 'vitest';
import { cleanForScorecard, MAX_REASON_LENGTH } from './sanitize.js';

describe('cleanForScorecard', () => {
  it('passes plain text through', () => {
    expect(cleanForScorecard('oracle expected pong')).toBe('oracle expected pong');
  });

  it('applies the injected redactor before anything else', () => {
    const redactSecrets = (t: string) => ({
      redacted: t.replace('sk-secret', '[REDACTED:test]'),
      findings: [],
    });
    expect(cleanForScorecard('leaked sk-secret here', redactSecrets)).toBe(
      'leaked [REDACTED:test] here',
    );
  });

  it('fails closed to the sentinel when the redactor throws', () => {
    const redactSecrets = () => {
      throw new Error('boom');
    };
    expect(cleanForScorecard('anything', redactSecrets)).toBe('[REDACTION FAILED]');
  });

  it('strips control characters and bidi overrides (Trojan Source)', () => {
    const dirty = 'ok\x1b[31m‮evil⁦x⁩';
    const clean = cleanForScorecard(dirty);
    expect(clean).not.toMatch(/[\x00-\x1F‪-‮⁦-⁩]/);
  });

  it('truncates to MAX_REASON_LENGTH with an ellipsis', () => {
    const long = 'a'.repeat(MAX_REASON_LENGTH + 100);
    const clean = cleanForScorecard(long);
    expect(clean.length).toBe(MAX_REASON_LENGTH + 1); // 500 chars + ellipsis
    expect(clean.endsWith('…')).toBe(true);
  });

  it('does not bisect a surrogate pair at the truncation boundary', () => {
    // 499 'a' + 2 emojis (4 code units) = 503 total.
    // When truncated at 500, without protection would bisect the first emoji.
    const long = 'a'.repeat(499) + '😀😀';
    const clean = cleanForScorecard(long);
    // Spreading a string iterates by code point, so a lone surrogate left
    // behind by a bisected pair surfaces as its own single-char element in
    // the D800-DFFF range.
    const hasLoneSurrogate = [...clean].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0xd800 && code <= 0xdfff;
    });
    expect(hasLoneSurrogate).toBe(false);
    expect(clean.endsWith('…')).toBe(true);
  });

  it('returns a string exactly at MAX_REASON_LENGTH untouched', () => {
    const exact = 'a'.repeat(MAX_REASON_LENGTH);
    const clean = cleanForScorecard(exact);
    expect(clean).toBe(exact);
    expect(clean.endsWith('…')).toBe(false);
  });
});
