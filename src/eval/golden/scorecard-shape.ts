/**
 * Golden-runner scorecard shape (ADR-0017 H1). Composes the producer-agnostic
 * core (`src/eval/scorecard/core.ts`) with golden's own failure-kind tuple and
 * volatile/cost fields. The DETERMINISTIC partition — rows sorted by id, each
 * {id, pass, failureKind, reason} — is the only part a future baseline diff
 * (E-3) may compare. `reason` is only safely diffable for producers whose
 * reasons are themselves deterministic (the red-team arm); golden-runner
 * reasons derive from live model/SDK output, so a golden baseline diff must
 * compare {id, pass, failureKind} only. Everything under `volatile` and `meta`
 * is informational and never diffed: golden scorecards come from live model
 * runs and are not re-derivable byte-for-byte.
 */

import type {
  ScorecardEnvelope,
  ScorecardRowCore,
  ScorecardTotalsCore,
} from '../scorecard/index.js';
import type { ChallengeFinding } from '../verifier/types.js';

export const GOLDEN_FAILURE_KINDS = [
  'task-parse',
  'oracle-load',
  'session-error',
  'oracle-error',
  'oracle-fail',
] as const;

export type GoldenFailureKind = (typeof GOLDEN_FAILURE_KINDS)[number];

/** Volatile partition — informational, never baseline-diffed. */
export interface RowVolatile {
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  resultSubtype: string | null;
}

export type GoldenRow = ScorecardRowCore<GoldenFailureKind> & {
  /** Redacted, sanitized, truncated before storage — never raw model output. */
  reason: string | null;
  volatile: RowVolatile;
};

/** Volatile — informational, never baseline-diffed. */
export interface GoldenMeta {
  /** ISO-8601, from the injected clock. */
  createdAt: string;
  harnessVersion: string;
  /** Resolved absolute task directory the run scored. */
  taskDir: string;
  /** Distinct router model choices observed across rows that ran, sorted. */
  models: string[];
}

export type GoldenTotals = ScorecardTotalsCore<GoldenFailureKind> & {
  /** passed / total; total >= 1 is guaranteed (zero tasks is a run-level error). */
  passRate: number;
  /** Sum of known per-row costs; pair with unpricedTasks — never a silently understated sum. */
  totalCostUsd: number;
  /** Rows whose costUsd is null (didn't run, or SDK reported no cost). */
  unpricedTasks: number;
};

/** E-4 report-only section. Volatile like everything golden — never diffed. */
export interface VerificationSection {
  adversaryModelId: string;
  /** One per oracle-pass row (incl. 'no-output' rows), ordered by taskId. */
  findings: ChallengeFinding[];
  totals: { agreed: number; challenged: number; verifierErrors: number; noOutput: number };
  totalCostUsd: number;
  unpricedChallenges: number;
}

// The shared envelope is closed and shared with redteam; it is never widened
// (spec §Scorecard shape, forbidden implementation):
export type GoldenScorecard = ScorecardEnvelope<GoldenMeta, GoldenRow, GoldenTotals> & {
  verification?: VerificationSection;
};
