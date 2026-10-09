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
 * Rule ids that attribute a TIGHTENING that was not a judgement (issue #96
 * PR-B1, spec D3 steps 3a and 3b; issue #152, spec D3), declared BESIDE
 * `JUDGE_RULE_IDS` and deliberately not inside it, so PR-A's measured
 * scanner and its public tuple keep their shape. Three ids. `judge-oversized`:
 * an oversized input under `always` composes as at least `ask` (decision 8).
 * `judge-redacted`: on the failure hook, a redacted judge input composes as
 * at least `ask` (decision 15). `judge-refused`: the provider refused to
 * judge the text, so `scanWithJudge` composes it as at least `ask` (#152, a
 * refusal is a distinct outcome, never a judgement). Each id is added only
 * when its rule caused the tightening (ADR-0016 decision 3, G-9).
 */
export const JUDGE_OVERSIZED_RULE_ID = 'judge-oversized';
export const JUDGE_REDACTED_RULE_ID = 'judge-redacted';
export const JUDGE_REFUSED_RULE_ID = 'judge-refused';

/**
 * What happened to the judge on one `scanWithJudge` call. `off` and
 * `not-escalated` mean it was never consulted; `oversized` means the input
 * exceeded `MAX_JUDGE_INPUT_BYTES` so the escalation is unresolved;
 * `timed-out` and `failed` mean it was consulted and the heuristic floor
 * held; `refused` means it was consulted and the provider refused to judge
 * the text, so the result is composed as at least `ask` with `judge-refused`
 * and the escalation is unresolved (issue #152); `judged` means its verdict
 * was composed in.
 */
export type JudgeRunState = 'off' | 'not-escalated' | 'oversized' | 'judged' | 'timed-out' | 'failed' | 'refused';

/** A `ScanResult` plus the judge's run state. Assignable to `ScanResult`. */
export interface JudgedScanResult extends ScanResult {
  judge: JudgeRunState;
}

/** The closed error kinds a `JudgeCall` may report. The eval arm narrows a
 *  recorded kind against this list before it becomes a row status, exactly
 *  as the `ok` arm's verdict is narrowed by `isVerdict`. `refused` (issue
 *  #152) is the one kind that is not a failure: the provider answered by
 *  refusing, so it is composed as at least `ask`, counts as answered and
 *  never toward an early stop. */
export const JUDGE_ERROR_KINDS = ['call-failed', 'unparseable', 'unknown-enum', 'refused'] as const;
export type JudgeErrorKind = (typeof JUDGE_ERROR_KINDS)[number];

/**
 * The one definition of ANSWERED (issue #152 review M1): the endpoint replied
 * with a verdict or with a refusal. Every consumer that resets an early stop,
 * counts a denominator or reads a call as complete derives from here, so
 * "answered" is never spelled by hand twice.
 */
export function isAnsweredResult(result: JudgeCallResult): boolean {
  return result.ok || result.errorKind === 'refused';
}

/**
 * The rich result of one judge completion: the verdict, or a closed error
 * kind, plus the cost the call incurred when the transport reported one. A
 * failed parse was still charged, so `costUsd` rides on both arms. The `!ok`
 * arm carries `'refused'` with the charged cost when the provider refused
 * (issue #152, spec D1): same shape, one more kind.
 */
export type JudgeCallResult =
  | { ok: true; verdict: Verdict; costUsd: number | null }
  | { ok: false; errorKind: JudgeErrorKind; costUsd: number | null };

/**
 * One blind judge completion over untrusted text (no heuristic input). The
 * optional `signal` (issue #96 PR-B1, spec D4) asks the transport to stop the
 * call; `buildJudge` links it to the SDK's `abortController`. A call that
 * ignores it is abandoned, not stopped.
 */
export type JudgeCall = (text: string, signal?: AbortSignal) => Promise<JudgeCallResult>;

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
  /** `signal` (optional, spec D4): when it aborts, the call is aborted and the scan settles `failed` on the floor. */
  scanWithJudge(text: string, signal?: AbortSignal): Promise<JudgedScanResult>;
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
 * The module-private brand a provider refusal carries across the locked
 * `InjectionJudge` seam (issue #152, spec D2). A symbol, checked by the
 * predicate below and never by message text or `name`, so no caller-supplied
 * judge can forge a refusal by throwing an `Error` that SAYS refused: that
 * still reads `failed`. The signal never leaves `callUnderTimer`.
 */
const REFUSED_BRAND: unique symbol = Symbol('agent-harness-ja.judge.refused');

class RefusedSignal extends Error {
  readonly [REFUSED_BRAND] = true as const;
  constructor() {
    super('judge call refused by the provider');
    this.name = 'RefusedSignal';
  }
}

function isRefusedSignal(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { [REFUSED_BRAND]?: unknown })[REFUSED_BRAND] === true;
}

/**
 * Adapts the rich call to the locked `InjectionJudge` seam. The seam's
 * `heuristic` argument is DISCARDED: the judge is blind by construction, so
 * the same text reaches the transport byte-identically whatever the floor
 * said (ADR-0036 D3). A `!ok` result becomes a rejection, which the composed
 * scanner reads as `judge: 'failed'`, except `errorKind: 'refused'` (issue
 * #152, spec D2), which rejects with the module-private branded signal and
 * reads `judge: 'refused'`. A caller who writes a raw `InjectionJudge` cannot
 * signal a refusal; one who builds a `JudgeCall` gets it through here.
 */
export function toInjectionJudge(call: JudgeCall): InjectionJudge {
  return async (text: string, _heuristic: ScanResult, signal?: AbortSignal): Promise<Verdict> => {
    const result = await call(text, signal);
    if (!result.ok) {
      if (result.errorKind === 'refused') throw new RefusedSignal();
      throw new Error(`judge call failed: ${result.errorKind}`);
    }
    return result.verdict;
  };
}

/**
 * The floor as the judge sees it: a copy with fresh arrays. The composition
 * reads `heuristic` AFTER the call, so a judge that mutates its argument
 * (library misuse; the shipped adapter discards the argument) cannot reach
 * the object the tighten-only rule is applied to.
 */
function floorCopy(heuristic: ScanResult): ScanResult {
  return { ...heuristic, rule_ids: [...heuristic.rule_ids], excerpts: [...heuristic.excerpts] };
}

type JudgeOutcome = { kind: 'timed-out' } | { kind: 'failed' } | { kind: 'refused' } | { kind: 'judged'; verdict: Verdict };

/**
 * Awaits the judge under a scanner-owned timer (the verifier.ts shape). Every
 * path resolves: the timer firing, a rejection, a synchronous throw and a
 * non-verdict value are all outcomes, never errors. A rejection or a
 * synchronous throw of the branded refusal signal is `refused` (issue #152,
 * spec D2); every other rejection, throw, abort and resolved non-verdict is
 * `failed`, and a branded signal arriving after the timer fired is consumed
 * by the `settled` guard like any late settlement. Both settlement handlers
 * are attached before the timer can fire, so a late settlement after the
 * timeout is consumed and never surfaces as an unhandled rejection.
 * One AbortController per call (issue #96 PR-B1, spec D4): the timer aborts
 * it, so the transport can stop a call the scanner has given up on. An
 * external signal is linked with `AbortSignal.any`, so no listener is ever
 * added to it by hand (Gm1#2); the one listener here sits on the per-call
 * combined signal and is removed when the call settles.
 */
function callUnderTimer(
  judge: InjectionJudge,
  text: string,
  heuristic: ScanResult,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<JudgeOutcome> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const signal = external === undefined ? controller.signal : AbortSignal.any([external, controller.signal]);
    // A holder, not `let timer`: `prefer-const` (plan review P-8), and a `const`
    // declared after the pre-aborted check would hit the temporal dead zone,
    // because that path calls `settle` before the timer exists.
    const timers: { id?: ReturnType<typeof setTimeout> } = {};
    let settled = false;
    const onAbort = (): void => settle({ kind: 'failed' });
    function settle(outcome: JudgeOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timers.id);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    }
    if (signal.aborted) {
      settle({ kind: 'failed' });
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    timers.id = setTimeout(() => {
      // Settle BEFORE aborting, or the abort would reach `onAbort` and read
      // as an external cancellation.
      settle({ kind: 'timed-out' });
      controller.abort();
    }, timeoutMs);
    const onRejected = (error: unknown): void => settle(isRefusedSignal(error) ? { kind: 'refused' } : { kind: 'failed' });
    let pending: Promise<Verdict>;
    try {
      pending = Promise.resolve(judge(text, floorCopy(heuristic), signal));
    } catch (error: unknown) {
      onRejected(error);
      return;
    }
    pending.then((value) => settle(isVerdict(value) ? { kind: 'judged', verdict: value } : { kind: 'failed' }), onRejected);
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
 * Composes a provider refusal onto the heuristic floor (issue #152, spec D3):
 * tighten to at least `ask`, append `JUDGE_REFUSED_RULE_ID` only when that
 * raised the verdict (ADR-0016 decision 3, G-9), fresh arrays, and
 * `suspicious` as the floor set it, because the escalation is UNRESOLVED (the
 * `oversized` precedent), unlike `judged` where it is false. No verdict is
 * carried: a refusal is the provider declining, not a judgement (ADR-0038 D2
 * as amended by #152).
 */
function composeRefused(heuristic: ScanResult): JudgedScanResult {
  const composed = stricterVerdict(heuristic.verdict, 'ask');
  const tightened = verdictRank(composed) > verdictRank(heuristic.verdict);
  return {
    verdict: composed,
    rule_ids: tightened ? [...heuristic.rule_ids, JUDGE_REFUSED_RULE_ID] : [...heuristic.rule_ids],
    excerpts: [...heuristic.excerpts],
    suspicious: heuristic.suspicious,
    judge: 'refused',
  };
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

  async function scanWithJudge(text: string, signal?: AbortSignal): Promise<JudgedScanResult> {
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
    const outcome = await callUnderTimer(judge, text, heuristic, timeoutMs, signal);
    if (outcome.kind === 'judged') return compose(heuristic, outcome.verdict);
    if (outcome.kind === 'refused') return composeRefused(heuristic);
    return { ...heuristic, judge: outcome.kind };
  }

  return { scanWithJudge };
}
