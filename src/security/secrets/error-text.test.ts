import { describe, expect, it } from 'vitest';

import { redactErrorText } from './error-text.js';
import { redact } from './index.js';

// Issue #251, security review of 20/11/2026. An error's message can carry the tail of the bundled
// CLI's stderr, which is whatever the CLI wrote. The redactor matches a secret as one unbroken run,
// so anything invisible inside it has to go BEFORE the redactor looks, not after.

const KEY = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';
const SK = 'sk-ant-' + 'api03-' + 'A'.repeat(95);
const text = (input: string): string => redactErrorText(input, redact).redacted;

describe('redactErrorText', () => {
  it('redacts a plain secret, as the redactor does', () => {
    expect(text(`exited 9. stderr: credential ${KEY} rejected`)).toBe('exited 9. stderr: credential [REDACTED:aws-access-key-id] rejected');
  });

  it.each([
    ['a zero-width space (U+200B)', '​'],
    ['a soft hyphen (U+00AD)', '­'],
    ['a zero-width joiner (U+200D)', '‍'],
    ['a word joiner (U+2060)', '⁠'],
    ['a left-to-right mark (U+200E)', '‎'],
    ['an ANSI colour reset', '\u001b[0m'],
    ['an ANSI cursor move', '\u001b[12;40H'],
    ['a bare escape', '\u001b'],
    ['a NUL', '\u0000'],
    ['a backspace', '\b'],
    ['a carriage return', '\r'],
  ])('redacts a key split by %s', (_name, splitter) => {
    for (const secret of [KEY, SK]) {
      const out = text(`x. stderr: credential ${secret.slice(0, 8)}${splitter}${secret.slice(8)} rejected`);
      expect(out).toContain('[REDACTED:');
      expect(out).not.toContain(secret);
      expect(out).not.toContain(secret.slice(8));
      expect(out).not.toContain(secret.slice(0, 8));
    }
  });

  it('keeps line breaks and tabs: they are what makes a tail readable, and no rule matches across them', () => {
    expect(text('exited 2. stderr: first\n\tsecond')).toBe('exited 2. stderr: first\n\tsecond');
  });

  it('a private key whose BEGIN line was cut off is redacted up to its END line', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nVJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvuNMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLOyS56YyCFGeJZ';
    const out = text(`x. stderr: ${body}\n-----END PRIVATE KEY-----\nafter the key`);
    expect(out).toContain('[REDACTED:private-key-block]');
    expect(out).not.toContain('VJTUt9Us8cKjMzEf');
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7');
    expect(out).toContain('after the key');
    expect(out.startsWith('x. stderr: ')).toBe(true);
  });

  it('a whole private key is redacted as before, and text with no END line is not treated as key body', () => {
    const whole = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----';
    expect(text(`x. stderr: ${whole}`)).toBe('x. stderr: [REDACTED:private-key-block]');
    const hash = 'commit 9fA3cD27bE41f0aa9fA3cD27bE41f0aa9fA3cD27bE41f0aa failed';
    expect(text(hash)).toBe(hash);
  });

  it('only a PRIVATE KEY end line starts the key reading: text before the end of a certificate is left alone', () => {
    const input = 'request failed\nError\ncommit 9fA3bC1dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d\nsee cert:\n-----END CERTIFICATE-----\nretry';
    expect(text(input)).toBe(input);
    const pub = 'key MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2Mo\n-----END PUBLIC KEY-----';
    expect(text(pub)).toBe(pub);
  });

  it.each(['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK'])('an END %s line does start it', (kind) => {
    const out = text(`x. stderr: MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END ${kind}-----`);
    expect(out).toContain('[REDACTED:private-key-block]');
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7');
  });

  it('reports the findings of the redactor it was given, and lets that redactor throw', () => {
    expect(redactErrorText(`a ${KEY}`, redact).findings.length).toBeGreaterThan(0);
    // The same when a headless private key was redacted as well: the redactor's findings are passed on.
    const both = redactErrorText(`a ${KEY}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----`, redact);
    expect(both.redacted).toContain('[REDACTED:private-key-block]');
    expect(both.findings.length).toBeGreaterThan(0);
    expect(() =>
      redactErrorText('x', () => {
        throw new Error('redactor broke');
      }),
    ).toThrow('redactor broke');
  });
});
