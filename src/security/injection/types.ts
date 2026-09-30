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
   * suspicious`). After `scanWithJudge` (`createJudgedScanner`, ADR-0036),
   * `false` means the judge ran and the escalation is resolved; `true` means
   * it did not run (see the result's `judge` field for why).
   */
  suspicious: boolean;
}

/**
 * S-5 seam (ADR-0012): an injected async judge that re-evaluates suspicious
 * text. Consumed by `createJudgedScanner` (ADR-0036); the sync `scan()`
 * never calls it. `toInjectionJudge` builds one from a `JudgeCall`.
 */
export type InjectionJudge = (text: string, heuristic: ScanResult) => Promise<Verdict>;

export interface ScannerOptions {
  rules?: readonly InjectionRule[];
  /** Cap on reported excerpts/rule ids. Default 10. */
  maxExcerpts?: number;
  /** Cap on each excerpt's length. Default 120. */
  maxExcerptLength?: number;
  /**
   * S-5 seam, ignored by the SYNC scanner (the heuristic stage never
   * consults a judge); pass the judge to `createJudgedScanner`
   * instead, whose async `scanWithJudge` composes it onto the heuristic
   * verdict, tighten-only (ADR-0016, ADR-0036).
   */
  judge?: InjectionJudge;
}

export interface InjectionScanner {
  scan(text: string): ScanResult;
}
