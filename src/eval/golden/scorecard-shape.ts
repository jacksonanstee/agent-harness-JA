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
  /**
   * Refusal detection channel (ADR-0025). Present because a refusal that was
   * retried on a fallback model reports `resultSubtype: 'success'` with a real
   * answer, so without this a refused turn recorded `pass` here and named the
   * ROUTED model in meta.models: the same defect ADR-0025 removes, at a third
   * durable sink. Null when no refusal was detected.
   */
  refusalSource: string | null;
  /** Non-null means a model other than meta.models answered this task. */
  refusalFallbackModel: string | null;
}

export type GoldenRow = ScorecardRowCore<GoldenFailureKind> & {
  /** Redacted, sanitized, truncated before storage — never raw model output. */
  reason: string | null;
  volatile: RowVolatile;
};

/**
 * The `meta.taskDir` pair (issues #62 and #64, ADR-0030).
 *
 * `taskDir` is populated only when the task directory is at or under the
 * working directory the run was invoked from. It is then that directory
 * relative to that cwd, and on the machine that produced the scorecard,
 * resolving the stored value against the invoking working directory returns
 * the original path. That working directory is deliberately NOT recorded,
 * because recording it would re-introduce the disclosure this field exists
 * to avoid.
 *
 * ANY other invocation stores null. The relative form for such a directory
 * walks up through `..` and can spell out intervening absolute segments
 * (the home directory, a client's name) in a file whose purpose is to be
 * shared; even the bounded sibling shape (`../tasks`) reveals the
 * directory's own name. Suppression only ever REMOVES information: null
 * cannot be resolved by accident, where a degraded value (say, a bare
 * basename) shape-matches a resolvable path and silently resolves WRONG.
 * The Windows cross-drive case, where `relative()` has no relative form and
 * returns an absolute path, suppresses too (reasoned, not executed; there
 * is no Windows CI).
 *
 * `taskDirForm` is the in-row signal ADR-0027 decision 3 requires of a
 * transform that may not apply: the "boolean paired with an identifier for
 * the transform that ran", encoded as a two-value union because there is
 * exactly one transform to name. The discriminated union makes the invalid
 * pairings (a string with 'suppressed', a null with 'relative')
 * unrepresentable at construction rather than merely documented; field-level
 * mutation of an existing value is not barred (no `readonly`, per house
 * style), which holds because the runner's meta literal is the only
 * production construction site and nothing mutates it. Two
 * independently-settable fields whose relationship lived in prose already
 * cost this codebase a review round once (`pathTruncated`/`pathDigest`,
 * ADR-0011).
 *
 * `taskDir` keeps its name through the type change. ADR-0011 item 16
 * requires a NEW FIELD NAME when the READ path is intolerant; a golden
 * scorecard has no read path at all — re-verified for this change: nothing
 * in src/, scripts/ or examples/ parses one back. Pre-#64 scorecards are
 * distinguishable by the absence of `taskDirForm`.
 */
export type TaskDirMeta =
  | { taskDir: string; taskDirForm: 'relative' }
  | { taskDir: null; taskDirForm: 'suppressed' };

/** Volatile — informational, never baseline-diffed. */
export type GoldenMeta = {
  /** ISO-8601, from the injected clock. */
  createdAt: string;
  harnessVersion: string;
  /** Distinct router model choices observed across rows that ran, sorted. */
  models: string[];
} & TaskDirMeta;

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
