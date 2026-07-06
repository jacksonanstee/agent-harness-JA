import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { createSecretRedactor, redact } from './redact.js';
import type { SecretRule } from './types.js';

const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const GHP = 'ghp_' + 'a1B2c3D4e5f6G7h8i9J0k1L2m3N4o5P6q7R8';

describe('redact — format and findings', () => {
  it('replaces a secret with [REDACTED:<rule_id>] and reports the finding', () => {
    const result = redact(`key is ${AWS} ok`);
    expect(result.redacted).toBe('key is [REDACTED:aws-access-key-id] ok');
    expect(result.findings).toEqual([
      { rule_id: 'aws-access-key-id', start: 7, end: 7 + AWS.length, length: AWS.length },
    ]);
  });

  it('redacts every occurrence of a repeated secret', () => {
    const result = redact(`${AWS} then ${AWS}`);
    expect(result.redacted).toBe('[REDACTED:aws-access-key-id] then [REDACTED:aws-access-key-id]');
    expect(result.findings).toHaveLength(2);
  });

  it('redacts multiple distinct secrets in one pass', () => {
    const result = redact(`aws=${AWS} gh=${GHP}`);
    expect(result.redacted).toBe('aws=[REDACTED:aws-access-key-id] gh=[REDACTED:github-pat]');
    expect(result.findings.map((f) => f.rule_id)).toEqual(['aws-access-key-id', 'github-pat']);
  });

  it('finding offsets index the original text', () => {
    const text = `prefix ${AWS} suffix`;
    const f = redact(text).findings[0];
    if (f === undefined) throw new Error('no finding');
    expect(text.slice(f.start, f.end)).toBe(AWS);
  });

  it('returns pass-through text and no findings on benign input', () => {
    const result = redact('just some ordinary log output, nothing secret here');
    expect(result.findings).toEqual([]);
    expect(result.redacted).toBe('just some ordinary log output, nothing secret here');
  });

  it('throws TypeError on non-string input', () => {
    expect(() => redact(null as unknown as string)).toThrow(TypeError);
    expect(() => redact(42 as unknown as string)).toThrow(TypeError);
  });
});

describe('redact — overlap resolution', () => {
  it('the longer span wins when two rules overlap at the same start', () => {
    // A private-key block whose body contains a JWT-shaped line: the block
    // (longer) must win, not the inner JWT.
    const jwtLine = `eyJ${'A1b2c3d4e5'.repeat(2)}.eyJ${'A1b2c3d4e5'.repeat(2)}.${'sig'.repeat(6)}`;
    const block = `-----BEGIN RSA PRIVATE${''} KEY-----\n${jwtLine}\n-----END RSA PRIVATE${''} KEY-----`;
    const result = redact(block);
    expect(result.redacted).toBe('[REDACTED:private-key-block]');
    expect(result.findings.map((f) => f.rule_id)).toEqual(['private-key-block']);
  });

  it('produces non-overlapping, ascending findings', () => {
    const result = redact(`${AWS} mid ${GHP}`);
    const fs = result.findings;
    for (let i = 1; i < fs.length; i += 1) {
      expect(fs[i]!.start).toBeGreaterThanOrEqual(fs[i - 1]!.end);
    }
  });
});

describe('redact — safety properties', () => {
  it('findings never carry any substring of the secret (leak-safe)', () => {
    const secrets = [AWS, GHP, 'sk_live_' + '1234567890abcdefghijklmn'];
    const text = secrets.join(' and ');
    const findingsJson = JSON.stringify(redact(text).findings);
    for (const secret of secrets) {
      for (let i = 0; i + 8 <= secret.length; i += 1) {
        expect(findingsJson).not.toContain(secret.slice(i, i + 8));
      }
    }
  });

  it('is idempotent — redacting the output finds nothing new', () => {
    const once = redact(`aws=${AWS} gh=${GHP}`).redacted;
    const twice = redact(once);
    expect(twice.findings).toEqual([]);
    expect(twice.redacted).toBe(once);
  });

  it('is deterministic', () => {
    const text = `a=${AWS} b=${GHP}`;
    expect(redact(text)).toEqual(redact(text));
  });
});

describe('redact — options', () => {
  it('uses an injected rule table', () => {
    const rule: SecretRule = {
      id: 'custom-token',
      precision: 'high',
      pattern: /\bTOK-[0-9]{6}\b/,
      description: 'custom',
    };
    const result = createSecretRedactor({ rules: [rule] }).redact('id TOK-123456 end');
    expect(result.redacted).toBe('id [REDACTED:custom-token] end');
    expect(redact('id TOK-123456 end').findings).toEqual([]); // default table doesn't know it
  });

  it('caps the findings array but never leaves a secret unredacted', () => {
    const many = Array.from({ length: 5 }, () => AWS).join(' ');
    const result = createSecretRedactor({ maxFindings: 2 }).redact(many);
    expect(result.findings).toHaveLength(2);
    expect(result.redacted).not.toContain('AKIA'); // all 5 still redacted
  });

  it('caps oversized input: drops the tail with a marker, never emits it raw', () => {
    const secret = 'AKIA' + 'IOSFODNN7EXAMPLE';
    // A secret well past the 128 KiB scan cap must not appear in the output.
    const text = `head ${secret} ${'x'.repeat(200_000)} tail ${secret}`;
    const result = redact(text);
    expect(result.redacted).toContain('[REDACTED:aws-access-key-id]'); // head secret redacted
    expect(result.redacted).toContain('[REDACTED:oversized-input]');
    expect(result.redacted).not.toContain('tail'); // tail (with its secret) dropped, not emitted raw
    expect(result.redacted).not.toContain('AKIA' + 'IOSFODNN7EXAMPLE'); // no raw secret survives
  });

  it('stays fast on many unterminated private-key headers past the cap', () => {
    const huge = ('-----BEGIN RSA PRIVATE ' + 'KEY-----\n').repeat(40_000); // ~1.3 MB
    const start = performance.now();
    redact(huge);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('entropy gate: low-entropy keyword assignment does not fire', () => {
    expect(redact('pass' + 'word = "aaaaaaaaaaaaaaaa"').findings).toEqual([]);
    expect(redact('pass' + 'word = "aB3xK9pL2mQ7zW1nR5tY"').findings.length).toBeGreaterThan(0);
  });

  it('isolates a throwing rule and still applies the others', () => {
    const bad: SecretRule = {
      id: 'bad-rule',
      precision: 'high',
      pattern: {
        [Symbol.matchAll]: () => {
          throw new Error('boom');
        },
        source: 'x',
        flags: '',
      } as unknown as RegExp,
      description: 'throws',
    };
    const good: SecretRule = {
      id: 'good-rule',
      precision: 'high',
      pattern: /\bMARK\b/,
      description: 'ok',
    };
    const result = createSecretRedactor({ rules: [bad, good] }).redact('a MARK b');
    expect(result.findings.map((f) => f.rule_id)).toEqual(['good-rule']);
  });
});
