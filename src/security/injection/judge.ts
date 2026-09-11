import { scan as defaultScan } from './scan.js';
import type { InjectionJudge, InjectionScanner, ScanResult, Verdict } from './types.js';

// S-5 judge, implemented to the ADR-0016 contract (issue #96 PR-A, ADR-0036
// D1 and D3). This file is the security layer's whole judge surface: the
// tighten-only composition over the sync heuristic, and the rich call shape
// (`JudgeCall`) that the session-layer builder produces and the eval arm
// records. It imports no SDK, no session, no cli, no eval and no router; the
// judge itself arrives as an injected async function.

export const JUDGE_MODES = ['off', 'suspicious', 'always'] as const;
export type JudgeMode = (typeof JUDGE_MODES)[number];

/** Scanner-owned ceiling on one judge call (the `ADVERSARY_TIMEOUT_MS` precedent). */
export const JUDGE_TIMEOUT_MS = 60_000;
/** Largest input the judge is ever shown, in BYTES (the `redact.ts` `MAX_INPUT` precedent). */
export const MAX_JUDGE_INPUT_BYTES = 131_072;
/** Rule ids appended when the judge tightens a verdict (ADR-0016 decision 3). */
export const JUDGE_RULE_IDS = { block: 'judge-block', ask: 'judge-ask' } as const;

/**
 * What happened to the judge on one `scanWithJudge` call. `off` and
 * `not-escalated` mean it was never consulted; `oversized` means the input
 * exceeded `MAX_JUDGE_INPUT_BYTES` so the escalation is unresolved;
 * `timed-out` and `failed` mean it was consulted and the heuristic floor
 * held; `judged` means its verdict was composed in.
 */
export type JudgeRunState = 'off' | 'not-escalated' | 'oversized' | 'judged' | 'timed-out' | 'failed';

/** A `ScanResult` plus the judge's run state. Assignable to `ScanResult`. */
export interface JudgedScanResult extends ScanResult {
  judge: JudgeRunState;
}

export type JudgeErrorKind = 'call-failed' | 'unparseable' | 'unknown-enum';

/**
 * The rich result of one judge completion: the verdict, or a closed error
 * kind, plus the cost the call incurred when the transport reported one. A
 * failed parse was still charged, so `costUsd` rides on both arms.
 */
export type JudgeCallResult =
  | { ok: true; verdict: Verdict; costUsd: number | null }
  | { ok: false; errorKind: JudgeErrorKind; costUsd: number | null };

/** One blind judge completion over untrusted text (no heuristic input). */
export type JudgeCall = (text: string) => Promise<JudgeCallResult>;

export interface JudgedScannerOptions {
  /** Default `'off'` (ADR-0016 decision 4). */
  mode?: JudgeMode;
  /** Required when `mode` is not `'off'`; the factory throws otherwise. */
  judge?: InjectionJudge;
  /** The heuristic floor. Default: the module-level `scan`. */
  scanner?: InjectionScanner;
  /** Per-call ceiling in ms. Default `JUDGE_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface JudgedScanner {
  scanWithJudge(text: string): Promise<JudgedScanResult>;
}

const RANK: Record<Verdict, 0 | 1 | 2> = { pass: 0, ask: 1, block: 2 };

export function verdictRank(v: Verdict): 0 | 1 | 2 {
  return RANK[v];
}

/** The higher-ranked of two verdicts (symmetric; `block` dominates). */
export function stricterVerdict(a: Verdict, b: Verdict): Verdict {
  return verdictRank(a) >= verdictRank(b) ? a : b;
}

function isVerdict(value: unknown): value is Verdict {
  return value === 'pass' || value === 'ask' || value === 'block';
}

/**
 * Adapts the rich call to the locked `InjectionJudge` seam. The seam's
 * `heuristic` argument is DISCARDED: the judge is blind by construction, so
 * the same text reaches the transport byte-identically whatever the floor
 * said (ADR-0036 D3). A `!ok` result becomes a rejection, which the composed
 * scanner reads as `judge: 'failed'`.
 */
export function toInjectionJudge(call: JudgeCall): InjectionJudge {
  return async (text: string): Promise<Verdict> => {
    const result = await call(text);
    if (!result.ok) throw new Error(`judge call failed: ${result.errorKind}`);
    return result.verdict;
  };
}

type JudgeOutcome = { kind: 'timed-out' } | { kind: 'failed' } | { kind: 'judged'; verdict: Verdict };

/**
 * Awaits the judge under a scanner-owned timer (the verifier.ts shape). Every
 * path resolves: the timer firing, a rejection, a synchronous throw and a
 * non-verdict value are all outcomes, never errors. Both settlement handlers
 * are attached before the timer can fire, so a late settlement after the
 * timeout is consumed and never surfaces as an unhandled rejection.
 */
function callUnderTimer(
  judge: InjectionJudge,
  text: string,
  heuristic: ScanResult,
  timeoutMs: number,
): Promise<JudgeOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timed-out' }), timeoutMs);
    const settle = (outcome: JudgeOutcome): void => {
      clearTimeout(timer);
      resolve(outcome);
    };
    let pending: Promise<Verdict>;
    try {
      pending = Promise.resolve(judge(text, heuristic));
    } catch {
      settle({ kind: 'failed' });
      return;
    }
    pending.then(
      (value) => settle(isVerdict(value) ? { kind: 'judged', verdict: value } : { kind: 'failed' }),
      () => settle({ kind: 'failed' }),
    );
  });
}

/**
 * Composes the judge's verdict onto the heuristic floor: stricter-of, and an
 * attribution id only when the judge CAUSED the tightening (ADR-0016
 * decision 3). Fresh arrays on the tightened result; the floor is never
 * mutated.
 */
function compose(heuristic: ScanResult, judged: Verdict): JudgedScanResult {
  const composed = stricterVerdict(heuristic.verdict, judged);
  if (verdictRank(composed) > verdictRank(heuristic.verdict)) {
    // `composed` outranks the floor, so it cannot be `pass`.
    const attribution = JUDGE_RULE_IDS[composed as Exclude<Verdict, 'pass'>];
    return {
      verdict: composed,
      rule_ids: [...heuristic.rule_ids, attribution],
      excerpts: [...heuristic.excerpts],
      suspicious: false,
      judge: 'judged',
    };
  }
  // The judge agreed or answered looser: the floor holds, escalation is no
  // longer warranted, and nothing is attributed because nothing was caused.
  return { ...heuristic, suspicious: false, judge: 'judged' };
}

/**
 * The additive async wrapper ADR-0016 names `scanWithJudge`. It can only
 * TIGHTEN the heuristic verdict; a heuristic `block` is final and the judge
 * is never consulted on it; every judge failure fails closed to the floor.
 * Off by default. Rejects only where `scan()` throws (non-string input), so
 * the sync and async surfaces fail the same way on the same input.
 */
export function createJudgedScanner(opts: JudgedScannerOptions = {}): JudgedScanner {
  const mode: JudgeMode = opts.mode ?? 'off';
  const judge = opts.judge;
  if (mode !== 'off' && judge === undefined) {
    throw new Error(`createJudgedScanner: mode '${mode}' requires a judge`);
  }
  const scanner: InjectionScanner = opts.scanner ?? { scan: defaultScan };
  const timeoutMs = opts.timeoutMs ?? JUDGE_TIMEOUT_MS;

  async function scanWithJudge(text: string): Promise<JudgedScanResult> {
    const heuristic = scanner.scan(text);
    if (mode === 'off' || judge === undefined) return { ...heuristic, judge: 'off' };
    if (heuristic.verdict === 'block') return { ...heuristic, judge: 'not-escalated' };
    // `suspicious` escalates on the FLAG, not on `verdict === 'ask'`: the
    // scanner may be arbitrary caller code (ADR-0016 decision 4).
    const escalate = mode === 'always' || heuristic.suspicious === true;
    if (!escalate) return { ...heuristic, judge: 'not-escalated' };
    if (Buffer.byteLength(text, 'utf8') > MAX_JUDGE_INPUT_BYTES) {
      // Never judge a prefix: a cut can hide the payload, and `suspicious:
      // false` would then claim an adjudication that never saw it.
      return { ...heuristic, judge: 'oversized' };
    }
    const outcome = await callUnderTimer(judge, text, heuristic, timeoutMs);
    if (outcome.kind === 'judged') return compose(heuristic, outcome.verdict);
    return { ...heuristic, judge: outcome.kind };
  }

  return { scanWithJudge };
}
