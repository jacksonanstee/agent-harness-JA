import { JUDGE_TIMEOUT_MS } from '../security/index.js';
import type { JudgeSettings } from '../security/index.js';
import { buildJudge, JUDGE_MODEL } from '../session/index.js';
import type { JudgeSessionState, JudgeSummary, QueryFn, SessionJudge } from '../session/index.js';
import { judgeCapWarning } from '../session/judged-scan.js';

// Issue #96 PR-B1, spec D2 and D7: the `run` path's judge composition and its
// two operator lines. The mid-run live lines come from the session through
// onWarning (cli.ts); only the start and summary lines are composed here.

/** D2: `{}` when the judge is off, so the deps handed to createSession carry no `judge` key (pin 3); exactly two keys when on (pin 32). */
export function runJudgeDeps(settings: JudgeSettings | null, query: QueryFn): { judge?: SessionJudge } {
  if (settings === null) return {};
  return { judge: { call: buildJudge(query, JUDGE_MODEL), maxCallsPerRun: settings.maxCallsPerRun } };
}

/** U-3: the per-call stall, stated once at run start. 60 s includes any wait for a judge slot (decision 14). */
export function judgeStartLine(settings: JudgeSettings): string {
  return (
    `[harness] judge: on (always, cap ${settings.maxCallsPerRun}): each tool result waits for one judge call, ` +
    `typically about 15 s and at most ${JUDGE_TIMEOUT_MS / 1000} s`
  );
}

/** The unjudged clause's order (spec D7). */
const UNJUDGED: readonly JudgeSessionState[] = ['timed-out', 'failed', 'oversized', 'cap-reached', 'hook-cancelled', 'stopped', 'queue-timed-out'];

/**
 * The summary line (spec D7, U-8, B-2) and, when the cap was reached, the
 * cap warning (printed with the warning prefix by the caller). The unjudged
 * clause lists only non-zero states and is omitted when all are zero; the
 * unknown-cost clause appears only when k > 0; the money format matches the
 * primary `cost=` line, which excludes the judge's spend (U-2).
 */
export function judgeSummaryLines(s: JudgeSummary): { summary: string; capWarning: string | null } {
  const unjudged = UNJUDGED.filter((state) => s.byState[state] > 0).map((state) => `${s.byState[state]} ${state}`);
  if (s.pendingAtEnd > 0) unjudged.push(`${s.pendingAtEnd} pending at end`);
  const parts = [`[harness] judge: ${s.calls}/${s.cap} call(s)`, `${s.tightened} note(s) added by the judge path`];
  if (unjudged.length > 0) parts.push(`unjudged: ${unjudged.join(', ')}`);
  const unknown = s.costUnknown > 0 ? `; ${s.costUnknown} call(s) of unknown cost` : '';
  parts.push(`cost=$${s.costUsd.toFixed(4)} (not included in cost= above${unknown})`);
  const capped = s.byState['cap-reached'];
  return { summary: parts.join(', '), capWarning: capped > 0 ? judgeCapWarning(s.cap, capped) : null };
}
