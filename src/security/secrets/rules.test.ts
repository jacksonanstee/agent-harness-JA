import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SECRET_RULES } from './rules.js';
import { createSecretRedactor } from './redact.js';

// Positive = realistic fake secret (never a real credential); negative =
// near-miss that must NOT fire (wrong length/prefix/charset, low entropy).
const CASES: { id: string; positive: string; negative: string }[] = [
  {
    id: 'aws-access-key-id',
    positive: 'AKIA' + 'IOSFODNN7EXAMPLE',
    negative: 'AKIA_SHORT and akiaiosfodnn7example lowercase',
  },
  {
    id: 'aws-secret-access-key',
    positive: 'aws_sec' + 'ret_access_key = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYabcd"',
    negative: 'aws_sec' + 'ret_access_key = "short"',
  },
  {
    id: 'github-pat',
    positive: 'ghp_' + 'a1B2c3D4e5f6G7h8i9J0k1L2m3N4o5P6q7R8',
    negative: 'ghp_tooshort and ghp_' + 'x'.repeat(50),
  },
  {
    id: 'github-fine-grained-pat',
    positive: `github${'_pat_'}${'A1b2C3d4E5'.repeat(8)}A1`,
    negative: 'github_pat_short',
  },
  {
    id: 'github-oauth',
    positive: 'gho_' + 'a1B2c3D4e5f6G7h8i9J0k1L2m3N4o5P6q7R8',
    negative: 'gho_short',
  },
  {
    id: 'github-app-token',
    positive: 'ghs_' + 'a1B2c3D4e5f6G7h8i9J0k1L2m3N4o5P6q7R8',
    negative: 'ghx_1234567890abcdefghijklmnopqrstuvwx',
  },
  {
    id: 'gitlab-pat',
    positive: 'glpat-' + 'ABCDEF1234567890abcd',
    negative: 'glpat-short',
  },
  {
    id: 'slack-token',
    positive: 'xoxb-' + '1234567890-abcdefghijklmnop',
    negative: 'xoxz-1234567890-nope',
  },
  {
    id: 'slack-webhook',
    positive: 'https://hooks.sla' + 'ck.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
    negative: 'https://hooks.sla' + 'ck.com/services/short',
  },
  {
    id: 'stripe-secret-key',
    positive: 'sk_live_' + '1234567890abcdefghijklmn',
    negative: 'sk_live_short',
  },
  {
    id: 'stripe-test-key',
    positive: 'sk_test_' + '1234567890abcdefghijklmn',
    negative: 'sk_test_short',
  },
  {
    id: 'google-api-key',
    positive: 'AIza' + 'SyA1234567890abcdefghijklmnopqrstuv',
    negative: 'AIzaShort',
  },
  {
    id: 'gcp-service-account',
    positive: '"private_key_id": "0123456789abcdef0123456789abcdef01234567"',
    negative: '"private_key_id": "short"',
  },
  {
    id: 'openai-api-key',
    positive: `sk-proj-${'a'.repeat(24)}T3BlbkFJ${'b'.repeat(24)}`,
    negative: 'sk-proj-short',
  },
  {
    id: 'openai-legacy-key',
    positive: `sk-${'A1b2c3D4e5'.repeat(4)}F6g7h8I9`,
    negative: 'sk-short',
  },
  {
    id: 'anthropic-api-key',
    positive: `sk-ant-api03-${'A1b2c3D4e5'.repeat(9)}AA`,
    negative: 'sk-ant-short',
  },
  {
    id: 'npm-access-token',
    positive: 'npm_' + 'a1B2c3D4e5f6G7h8i9J0k1L2m3N4o5P6q7R8',
    negative: 'npm_short',
  },
  {
    id: 'pypi-upload-token',
    positive: `pypi-AgEIcHlwaS5vcmc${'a'.repeat(60)}`,
    negative: 'pypi-short',
  },
  {
    id: 'sendgrid-api-key',
    positive: `SG.${'A1b2c3d4e5F6g7h8i9j0k1'}.${'A1b2c3d4e5F6g7h8i9j0k1L2m3n4o5P6q7r8s9t0u1v'}`,
    negative: 'SG.short.short',
  },
  {
    id: 'twilio-api-key',
    positive: 'SK' + '0123456789abcdef0123456789abcdef',
    negative: 'SK0123 and SKshortnothex',
  },
  {
    id: 'mailgun-api-key',
    positive: 'key-' + '0123456789abcdef0123456789abcdef',
    negative: 'key-short',
  },
  {
    id: 'jwt',
    positive: `eyJ${'A1b2c3d4e5'.repeat(2)}.eyJ${'A1b2c3d4e5'.repeat(2)}.${'sig'.repeat(6)}`,
    negative: 'eyJshort.and',
  },
  {
    id: 'private-key-block',
    positive: '-----BEGIN RSA PRIVATE ' + 'KEY-----\nMIIABC123\n-----END RSA PRIVATE ' + 'KEY-----',
    negative: 'a normal --- separator line ---',
  },
  {
    id: 'basic-auth-in-url',
    positive: 'https:' + '//admin:s3cr3tP4ss@internal.example.com/path',
    negative: 'https://example.com/no-creds',
  },
  {
    id: 'generic-keyword-secret',
    positive: 'api' + '_key = "aB3xK9pL2mQ7zW1nR5tY8vC4"',
    negative: 'api' + '_key = "changeme"',
  },
];

describe('DEFAULT_SECRET_RULES — per-rule positives/negatives', () => {
  it.each(CASES)('rule $id redacts its positive sample', ({ id, positive }) => {
    const findings = createSecretRedactor().redact(positive).findings;
    expect(findings.map((f) => f.rule_id)).toContain(id);
  });

  it.each(CASES)('rule $id stays quiet on its negative sample', ({ id, negative }) => {
    const findings = createSecretRedactor().redact(negative).findings;
    expect(findings.map((f) => f.rule_id)).not.toContain(id);
  });

  it('redacts an oversized private-key body in full (no tail leak past the cap)', () => {
    const body = 'A'.repeat(9600); // > the old 8192 lazy cap
    const key = `-----BEGIN RSA PRIVATE${''} KEY-----\n${body}\n-----END RSA PRIVATE${''} KEY-----`;
    const result = createSecretRedactor().redact(`prefix ${key} suffix`);
    expect(result.findings.map((f) => f.rule_id)).toContain('private-key-block');
    expect(result.redacted).not.toContain(body);
    expect(result.redacted).toBe('prefix [REDACTED:private-key-block] suffix');
  });

  it('redacts an unterminated private-key block to end-of-input', () => {
    const key = `-----BEGIN OPENSSH PRIVATE${''} KEY-----\n${'b3Blbn'.repeat(500)}`;
    const result = createSecretRedactor().redact(key);
    expect(result.findings.map((f) => f.rule_id)).toContain('private-key-block');
    expect(result.redacted).toBe('[REDACTED:private-key-block]');
  });

  it('every rule has at most one capture group (gatedToken invariant)', () => {
    for (const rule of DEFAULT_SECRET_RULES) {
      const groups = new RegExp(`${rule.pattern.source}|`).exec('')!.length - 1;
      expect(groups).toBeLessThanOrEqual(1);
    }
  });

  it('covers ≥20 distinct patterns (S-2 requirement)', () => {
    expect(DEFAULT_SECRET_RULES.length).toBeGreaterThanOrEqual(20);
  });

  it('every table case references a real rule id', () => {
    const known = new Set<string>(DEFAULT_SECRET_RULES.map((r) => r.id));
    for (const c of CASES) expect(known.has(c.id)).toBe(true);
  });
});

describe('rule table hygiene', () => {
  it('ids are unique and kebab-case', () => {
    const ids = DEFAULT_SECRET_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('heuristic rules carry an entropy gate; high rules do not require one', () => {
    for (const r of DEFAULT_SECRET_RULES) {
      expect(['high', 'heuristic']).toContain(r.precision);
      if (r.precision === 'heuristic') expect(typeof r.entropy).toBe('number');
      expect(r.description.length).toBeGreaterThan(0);
    }
  });
});

describe('ReDoS guard — every rule is linear-time on pathological input', () => {
  const PATHOLOGICAL = [
    'sk-'.repeat(50_000),
    'eyJ'.repeat(50_000),
    `-----BEGIN RSA PRIVATE${''} KEY-----\n${'A'.repeat(200_000)}`, // unterminated block
    'A'.repeat(200_000),
    `${'aws_sec' + 'ret_access_key='.repeat(1)}${'a'.repeat(200_000)}`,
    // The true worst case for the private-key lazy body: many BEGIN headers
    // with no END, well past redact()'s MAX_INPUT cap (differential-review
    // finding). The input cap must keep this bounded.
    ('-----BEGIN RSA PRIVATE ' + 'KEY-----\n').repeat(40_000), // ~1.3 MB
    // Stresses the widened \s{0,20} delimiter budget: keyword + over-budget
    // padding with no delimiter, repeated, forcing a bounded fail at every
    // occurrence (2026-07-15 audit remediation).
    ('aws_sec' + 'ret_access_key' + ' '.repeat(25)).repeat(5_000),
    ('to' + 'ken' + '\t'.repeat(25)).repeat(10_000),
  ];

  it.each(DEFAULT_SECRET_RULES.map((r) => r.id))(
    'rule %s completes quickly on adversarial input',
    (id) => {
      const redactor = createSecretRedactor({
        rules: DEFAULT_SECRET_RULES.filter((r) => r.id === id),
      });
      for (const input of PATHOLOGICAL) {
        const start = performance.now();
        redactor.redact(input);
        // Generous bound: this catches CATASTROPHIC backtracking (orders of
        // magnitude worse — seconds/timeout), not a tight per-ms budget that
        // flakes on a slower CI runner. Linear-time rules finish well within.
        expect(performance.now() - start).toBeLessThan(1000);
      }
    },
  );
});
