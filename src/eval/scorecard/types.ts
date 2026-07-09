/**
 * Scorecard schema (spec 2026-07-08 E-1, ADR-0017). The DETERMINISTIC
 * partition — rows sorted by id, each {id, pass, failureKind, reason} — is
 * the only part a future baseline diff (E-3) may compare. `reason` is only
 * safely diffable for producers whose reasons are themselves deterministic
 * (the red-team arm); golden-runner reasons derive from live model/SDK
 * output, so a golden baseline diff must compare {id, pass, failureKind}
 * only. Everything under `volatile` and `meta` is informational and never
 * diffed: golden scorecards come from live model runs and are not
 * re-derivable byte-for-byte.
 */

export const FAILURE_KINDS = [
  'task-parse',
  'oracle-load',
  'session-error',
  'oracle-error',
  'oracle-fail',
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Volatile partition — informational, never baseline-diffed. */
export interface RowVolatile {
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  resultSubtype: string | null;
}

export interface ScorecardRow {
  id: string;
  pass: boolean;
  failureKind: FailureKind | null;
  /** Redacted, sanitized, truncated before storage — never raw model output. */
  reason: string | null;
  volatile: RowVolatile;
}

/** Volatile — informational, never baseline-diffed. */
export interface ScorecardMeta {
  /** ISO-8601, from the injected clock. */
  createdAt: string;
  harnessVersion: string;
  /** Resolved absolute task directory the run scored. */
  taskDir: string;
  /** Distinct router model choices observed across rows that ran, sorted. */
  models: string[];
}

export interface ScorecardTotals {
  tasks: number;
  passed: number;
  failed: number;
  byFailureKind: Record<FailureKind, number>;
  /** passed / tasks; tasks >= 1 is guaranteed (zero tasks is a run-level error). */
  passRate: number;
  /** Sum of known per-row costs; pair with unpricedTasks — never a silently understated sum. */
  totalCostUsd: number;
  /** Rows whose costUsd is null (didn't run, or SDK reported no cost). */
  unpricedTasks: number;
}

export interface Scorecard {
  schemaVersion: 1;
  meta: ScorecardMeta;
  /** Sorted by id (the deterministic partition's order contract). */
  rows: ScorecardRow[];
  totals: ScorecardTotals;
}
