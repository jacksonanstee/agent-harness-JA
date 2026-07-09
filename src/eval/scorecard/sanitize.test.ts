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
});
