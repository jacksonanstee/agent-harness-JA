import type { JudgeSessionState, SessionJudge } from './types.js';

// Issue #96 PR-B1: the judge path's fixed per-run constants, the session-state
// tuple and the smoke script's internal seam type.
//
// The constants below are module exports for the tests, deliberately NOT on
// any barrel: they are fixed, not settings (pin 31's negative list).

/** The tool matchers' timeout when a judge is on (spec D5; K-9: the CLI binary carries a 600 s literal, `bp=600000`, unverified for SDK callback hooks until D9). */
export const JUDGE_HOOK_TIMEOUT_S = 600;
/** Live judge calls per run (decision 12; one child measured about 343 MB RSS during the spec's review: the design spec's figure, not re-measured). */
export const JUDGE_MAX_CONCURRENT = 4;
/** Consecutive infrastructure failures, nothing judged, before the judge stops for the run (R6). */
export const JUDGE_EARLY_STOP_AFTER = 3;
/** Bound on awaiting still-running judged hooks at the end of `run()` (spec D3 step 7). */
export const JUDGE_DRAIN_MS = 10_000;
/** The SDK's stdin-close, SIGTERM, SIGKILL ladder (about 7 s) plus D9's 2 s margin (T-3). */
export const JUDGE_ABORT_GRACE_MS = 10_000;

const JUDGE_SESSION_STATE_PRESENCE: Record<JudgeSessionState, true> = {
  'not-escalated': true,
  oversized: true,
  judged: true,
  'timed-out': true,
  failed: true,
  'cap-reached': true,
  'hook-cancelled': true,
  stopped: true,
  'queue-timed-out': true,
};
/** Every `JudgeSessionState`, derived from an exhaustive record (lesson 2026-07-28). On the root barrel. */
export const JUDGE_SESSION_STATES = Object.keys(JUDGE_SESSION_STATE_PRESENCE) as readonly JudgeSessionState[];

/**
 * The smoke script's seams (architect A-3), validated in `validateSessionJudge`.
 * NOT on any barrel and not on the public `SessionJudge`, but that is not
 * enforcement (B-4): a typed variable or a JS caller can set them. Internal
 * by documentation; named in ADR-0037.
 */
export type InternalSessionJudge = SessionJudge & { __smokeTimeoutMs?: number; __smokeHookTimeoutS?: number };
