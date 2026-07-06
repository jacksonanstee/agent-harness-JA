export type SecretPrecision = 'high' | 'heuristic';

export interface SecretRule {
  /** kebab-case, unique; becomes the `[REDACTED:<id>]` marker. */
  id: string;
  /**
   * `high` = structural token (fixed prefix + charset/length), near-zero false
   * positives. `heuristic` = keyword/shape match that also requires the
   * `entropy` gate to fire, since the pattern alone over-matches.
   */
  precision: SecretPrecision;
  /**
   * MUST be linear-time: single-level bounded quantifiers, no backreferences,
   * no lookbehind. Enforced by the ReDoS guard in rules.test.ts.
   */
  pattern: RegExp;
  /**
   * Minimum Shannon entropy (bits/char) the matched token must have for the
   * rule to fire. Set on `heuristic` rules; omitted on `high` rules.
   */
  entropy?: number;
  description: string;
}

/**
 * A redaction hit. Deliberately carries NO content — not the secret, not a
 * masked preview, not prefix/suffix chars (any preview leaks bytes of the
 * secret into logs/telemetry, defeating the point). Only the rule id and the
 * span offsets into the ORIGINAL text; the surrounding text in any sink is
 * already redacted, so offsets are safe.
 */
export interface SecretFinding {
  rule_id: string;
  start: number;
  end: number;
  length: number;
}

export interface RedactResult {
  redacted: string;
  findings: SecretFinding[];
}

export interface RedactorOptions {
  rules?: readonly SecretRule[];
  /** Cap on the findings array (redaction itself is never capped). Default 50. */
  maxFindings?: number;
}

export interface SecretRedactor {
  redact(text: string): RedactResult;
}
