import { describe, expect, it } from 'vitest';

import { redact } from './redact.js';
import { SECRET_CORPUS } from './secret-corpus.js';

const malicious = SECRET_CORPUS.filter((c) => c.expect !== 'benign');
const benign = SECRET_CORPUS.filter((c) => c.expect === 'benign');

describe('secret corpus', () => {
  it('has unique ids and a meaningful spread', () => {
    const ids = SECRET_CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(malicious.length).toBeGreaterThanOrEqual(20);
    expect(benign.length).toBeGreaterThanOrEqual(10);
  });

  it.each(malicious)('redacts case $id with the expected rule', (c) => {
    const result = redact(c.text);
    expect(result.findings.map((f) => f.rule_id)).toContain(c.expect);
    // The literal secret bytes must be gone from the redacted output.
    expect(result.redacted).toContain(`[REDACTED:${c.expect}]`);
  });

  it.each(benign)('does not fire on benign case $id', (c) => {
    expect(redact(c.text).findings).toEqual([]);
  });

  it('redacts ≥20 distinct secrets across the corpus (S-2 checkpoint)', () => {
    const redactedIds = new Set(
      malicious.flatMap((c) => redact(c.text).findings.map((f) => f.rule_id)),
    );
    expect(redactedIds.size).toBeGreaterThanOrEqual(20);
  });

  it('never leaves a benign false-positive redaction', () => {
    const falsePositives = benign.filter((c) => redact(c.text).findings.length > 0);
    expect(falsePositives.map((c) => c.id)).toEqual([]);
  });
});
