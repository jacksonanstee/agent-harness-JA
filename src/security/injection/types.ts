export type Verdict = 'pass' | 'block' | 'ask';

export type Confidence = 'high' | 'medium';

export type RuleFamily =
  | 'direct-instruction'
  | 'role-impersonation'
  | 'hidden-unicode'
  | 'encoded-blob'
  | 'exfil';

export interface InjectionRule {
  /** kebab-case, unique across the table. */
  id: string;
  family: RuleFamily;
  /** high → block; medium → ask (or judge escalation once S-5 lands). */
  confidence: Confidence;
  /**
   * MUST be linear-time: no nested quantifiers, no backreferences, no
   * lookbehind, bounded repetition over broad classes. Enforced by the ReDoS
   * guard test in rules.test.ts.
   */
  pattern: RegExp;
  description: string;
}

export interface ScanResult {
  verdict: Verdict;
  rule_ids: string[];
  excerpts: string[];
  /**
   * True when only medium-confidence rules fired (verdict 'ask') — the
   * escalation trigger for the S-5 LLM-judge stage (ADR-0005 `judge:
   * suspicious`).
   */
  suspicious: boolean;
}

/** Reserved for per-call options (e.g. rule suppression); empty in S-1. */
export type ScanOptions = Record<string, never>;

/**
 * S-5 seam (ADR-0012): an injected async judge that re-evaluates suspicious
 * text. Typed now so the S-5 wrapper is additive; unused in S-1.
 */
export type InjectionJudge = (text: string, heuristic: ScanResult) => Promise<Verdict>;

export interface ScannerOptions {
  rules?: readonly InjectionRule[];
  /** Cap on reported excerpts/rule ids. Default 10. */
  maxExcerpts?: number;
  /** Cap on each excerpt's length. Default 120. */
  maxExcerptLength?: number;
  /** S-5 seam — accepted but unused in S-1 (heuristic-only). */
  judge?: InjectionJudge;
}

export interface InjectionScanner {
  scan(text: string, opts?: ScanOptions): ScanResult;
}
