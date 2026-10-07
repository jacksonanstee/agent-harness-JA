import { JUDGE_SESSION_STATES } from './judged-scan-constants.js';
import type { JudgeSessionState, JudgeSummary } from './types.js';

// Issue #96 PR-B1: the fold of one run's judge-path entries into
// `SessionResult.judge` (spec D7, K-6).

/** One settled judge-path result, as the summary folds it. */
export interface JudgeSummaryEntry {
  state: JudgeSessionState;
  called: boolean;
  costUsd: number | null;
  delivered: boolean;
  tightened: boolean;
}

/** `SessionResult.judge` (spec D7, K-6). `calls` counts reserved slots; `costUnknown` is reserved slots with no known cost. */
export function foldJudgeSummary(
  cap: number,
  calls: number,
  entries: readonly JudgeSummaryEntry[],
  pendingAtEnd: number,
): JudgeSummary {
  const byState = Object.fromEntries(JUDGE_SESSION_STATES.map((s) => [s, 0])) as Record<JudgeSessionState, number>;
  let annotated = 0;
  let tightened = 0;
  let costUsd = 0;
  let known = 0;
  for (const e of entries) {
    byState[e.state] += 1;
    if (e.delivered) annotated += 1;
    if (e.tightened) tightened += 1;
    if (e.called && e.costUsd !== null) {
      costUsd += e.costUsd;
      known += 1;
    }
  }
  return { cap, calls, byState, annotated, tightened, costUsd, costUnknown: calls - known, pendingAtEnd };
}
