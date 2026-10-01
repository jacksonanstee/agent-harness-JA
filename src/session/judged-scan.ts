import {
  createJudgedScanner,
  JUDGE_OVERSIZED_RULE_ID,
  JUDGE_REDACTED_RULE_ID,
  JUDGE_TIMEOUT_MS,
  toInjectionJudge,
  verdictRank,
} from '../security/index.js';
import type { JudgeCall, JudgeCallResult, JudgedScanResult, ScanResult } from '../security/index.js';
import type { JudgeCallPayload } from '../telemetry/index.js';
import type { JudgeSessionState, JudgeSummary } from './types.js';
import { JUDGE_ABORT_GRACE_MS, JUDGE_DRAIN_MS, JUDGE_EARLY_STOP_AFTER, JUDGE_HOOK_TIMEOUT_S, JUDGE_MAX_CONCURRENT } from './judged-scan-constants.js';
import type { InternalSessionJudge } from './judged-scan-constants.js';
import { foldJudgeSummary } from './judged-scan-fold.js';
import type { JudgeSummaryEntry } from './judged-scan-fold.js';
import { JUDGE_HOOK_CANCELLED_WARNING, judgeCapWarning, judgeEarlyStopWarning, judgeFirstFailureWarning, judgeScanFailedWarning, judgeSlotsHeldWarning } from './judged-scan-lines.js';
import { JudgeSlots } from './judged-scan-slots.js';
import { asFloor, normaliseCallResult } from './judged-scan-validate.js';

// Issue #96 PR-B1, spec D3: everything per-run about the S-5 judge, as
// functions of an explicit context object, so session.ts only wires two call
// sites (the ~60-line target, G-6). This is session's first RUNTIME import
// from security (R2): the direction is legal (harness above security).
//
// The constants live in judged-scan-constants.ts and are re-exported at the
// end of this module, deliberately NOT on any barrel: they are fixed, not
// settings (pin 31's negative list).

type RecordOutcome = 'none' | 'called' | 'cap-reached' | 'stopped' | 'queue-timed-out';

/** One per tool result that entered the judge path (R4): what the wrapper did, and the call's result. */
interface JudgeRecord {
  outcome: RecordOutcome;
  result: JudgeCallResult | null;
  threw: boolean;
}
export type RecordSnapshot = Readonly<JudgeRecord>;

const REFUSAL: JudgeCallResult = Object.freeze({ ok: false, errorKind: 'call-failed', costUsd: null });

type LiveWarning = 'first-failure' | 'early-stop' | 'cap' | 'slots-held' | 'hook-cancelled';

/** Per-run judge state (spec D3: "let judgeReserved = 0 beside the other per-run counters"). */
export interface JudgeRunContext {
  readonly call: JudgeCall;
  readonly cap: number;
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly slots: JudgeSlots;
  readonly records: JudgeRecord[];
  readonly warnOnce: (key: LiveWarning, message: string) => void;
  /** Every time, not once: the scanner-rejection warning (step 5) is per result, like today's scanner failure. */
  readonly warn: (message: string) => void;
  reserved: number;
  stopped: boolean;
  disarmed: boolean;
  consecutiveFailures: number;
}

export interface JudgeHookState {
  readonly signal: AbortSignal | undefined;
  readonly toolUseId: string | null;
  cancelled: boolean;
}

export interface JudgedScanInput {
  tool: string;
  phase: 'post-tool' | 'post-tool-failure';
  /** The raw `runInjectionScan` result: the floor, on the RAW text (K-1, decision 11). */
  floor: unknown;
  /** The copy the judge may see: the model's copy on PostToolUse, the redacted error on the failure hook. */
  text: string;
  /** D6's one definition, measured on `text`: findings, failed closed, or truncated. */
  redacted: boolean;
}

export interface JudgedScanOutcome {
  input: JudgedScanInput;
  floor: ScanResult;
  /** The scanner's tighten-only composition (the custom hook's `scan`, spec D3). */
  scan: JudgedScanResult;
  /** The record as of the scanner's settle: a late settlement never updates the row or the summary (A-11). */
  snapshot: RecordSnapshot;
  durationMs: number;
}

export interface JudgeDecision {
  state: JudgeSessionState;
  composed: ScanResult;
  deliver: boolean;
  outcome: JudgedScanOutcome;
}

/**
 * The recording wrapper (spec D3 step 1, R4, R6, decision 14). Everything
 * before the first `await` is SYNCHRONOUS, so the stop check, the cap check
 * and the reservation cannot interleave between concurrent hooks (K-4). A
 * refusal is `call-failed` to the scanner; the session reads the RECORD, not
 * the scanner's state, to say `cap-reached`, `stopped` or `queue-timed-out`.
 */
function recording(ctx: JudgeRunContext, record: JudgeRecord): JudgeCall {
  return async (text, signal) => {
    if (ctx.stopped) {
      record.outcome = 'stopped';
      return REFUSAL;
    }
    if (ctx.reserved >= ctx.cap) {
      record.outcome = 'cap-reached';
      return REFUSAL;
    }
    ctx.reserved += 1;
    record.outcome = 'called';
    const admitted = await ctx.slots.acquire(signal, () => {
      // The abort LISTENER, synchronously (A-11): never behind an await, so
      // runJudgedScan can never read the scanner's `timed-out` first.
      record.outcome = 'queue-timed-out';
      ctx.reserved -= 1;
      if (ctx.slots.allHeldFor(ctx.now(), ctx.timeoutMs + JUDGE_ABORT_GRACE_MS)) {
        ctx.warnOnce('slots-held', judgeSlotsHeldWarning(Math.round((ctx.timeoutMs + JUDGE_ABORT_GRACE_MS) / 1000)));
      }
    });
    if (!admitted) return REFUSAL;
    if (signal?.aborted === true) {
      record.outcome = 'queue-timed-out';
      ctx.reserved -= 1;
      ctx.slots.release();
      return REFUSAL;
    }
    if (ctx.stopped) {
      record.outcome = 'stopped';
      ctx.reserved -= 1;
      ctx.slots.release();
      return REFUSAL;
    }
    const holder = ctx.slots.hold(ctx.now());
    try {
      record.result = normaliseCallResult(await ctx.call(text, signal));
    } catch {
      record.threw = true;
      record.result = null;
    } finally {
      // Decision 17: R6 counts at CALL SETTLE, here, BEFORE the permit is
      // released, so a freed permit can never admit a queued call ahead of the
      // count (spec R6's bound, pin 28).
      countAtSettle(ctx, record, isAborted(signal));
      ctx.slots.release(holder);
    }
    return record.result ?? REFUSAL;
  };
}

/**
 * The judged scan for one tool result (spec D3 steps 0-2 and 5). Null means
 * the result did not enter the judge path (its floor is absent or
 * malformed). Never rejects: every failure lands on the heuristic floor.
 */
export async function runJudgedScan(
  ctx: JudgeRunContext,
  hook: JudgeHookState,
  input: JudgedScanInput,
): Promise<JudgedScanOutcome | null> {
  const floor = asFloor(input.floor);
  if (floor === null) return null;
  const start = ctx.now();
  const record: JudgeRecord = { outcome: 'none', result: null, threw: false };
  ctx.records.push(record);
  const finish = (scan: JudgedScanResult): JudgedScanOutcome => ({
    input,
    floor,
    scan,
    snapshot: { ...record },
    durationMs: Math.max(0, Math.round(ctx.now() - start)),
  });
  // Step 0 (K-5): a hook the CLI has already abandoned reserves and spawns nothing.
  if (hook.cancelled || hook.signal?.aborted === true) return finish({ ...floor, judge: 'not-escalated' });
  try {
    const scanner = createJudgedScanner({
      mode: 'always',
      judge: toInjectionJudge(recording(ctx, record)),
      scanner: { scan: () => floor },
      timeoutMs: ctx.timeoutMs,
    });
    return finish(await scanner.scanWithJudge(input.text, hook.signal));
  } catch (error: unknown) {
    // Step 5: the scanner rejects only for a non-string text; warn and floor, as today (ADR-0026 D7).
    ctx.warn(judgeScanFailedWarning(error));
    return finish({ ...floor, judge: 'failed' });
  }
}

function tightenToAsk(result: ScanResult, ruleId: string): ScanResult {
  if (verdictRank(result.verdict) >= verdictRank('ask')) return result;
  return { ...result, verdict: 'ask', rule_ids: [...result.rule_ids, ruleId] };
}

/**
 * Spec D3 steps 3, 3a, 3b and the step 6 cancellation check: the session
 * state (the record wins over the scanner's `timed-out` for a queued call),
 * the composed verdict, and whether a notice is delivered.
 */
export function decideJudgedResult(hook: JudgeHookState, outcome: JudgedScanOutcome | null): JudgeDecision | null {
  if (outcome === null) return null;
  const { snapshot, input, scan } = outcome;
  let state: JudgeSessionState;
  if (hook.cancelled) state = 'hook-cancelled';
  else if (snapshot.outcome === 'queue-timed-out' || snapshot.outcome === 'stopped' || snapshot.outcome === 'cap-reached') {
    state = snapshot.outcome;
  } else state = scan.judge === 'off' ? 'not-escalated' : scan.judge;
  let composed: ScanResult = { verdict: scan.verdict, rule_ids: [...scan.rule_ids], excerpts: [...scan.excerpts], suspicious: scan.suspicious };
  if (state === 'oversized') composed = tightenToAsk(composed, JUDGE_OVERSIZED_RULE_ID);
  if (input.phase === 'post-tool-failure' && input.redacted && state !== 'hook-cancelled') {
    composed = tightenToAsk(composed, JUDGE_REDACTED_RULE_ID);
  }
  return { state, composed, deliver: !hook.cancelled && composed.verdict !== 'pass', outcome };
}

/**
 * Read through a function so TypeScript's narrowing from the wrapper's
 * earlier `if (signal?.aborted === true) return` does not survive the
 * `await` into the `finally` (TS2367; plan review R2-1).
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * R6 at call settle (decision 17), classified from the wrapper's own
 * knowledge: the call's signal aborted -> timed-out (counts); threw, or
 * `ok: false` with `call-failed` -> failed (counts); `unparseable` or
 * `unknown-enum` -> neutral; `ok: true` -> judged (resets and disarms for the
 * run). A call that never settles is never counted (D7's slots-held line
 * covers it); a later `hook-cancelled` state does not undo the count. The
 * classification does not distinguish the timer's abort from the hook's
 * cancellation; the shipped transport resolves `call-failed` on abort, so
 * the count is the same either way (Spec issues item 9a). It also emits the
 * first-failure live line (spec D7, R2-2). A queued call that never spawned
 * (`queue-timed-out`) never reaches here, so it is neutral (decision 14).
 */
export function countAtSettle(ctx: JudgeRunContext, record: RecordSnapshot, signalAborted: boolean): void {
  const r = record.result;
  const infrastructure = signalAborted || record.threw || (r !== null && !r.ok && r.errorKind === 'call-failed');
  if (!infrastructure) {
    if (r !== null && r.ok) {
      ctx.consecutiveFailures = 0;
      ctx.disarmed = true;
    }
    return;
  }
  // The first-failure live line comes from the SAME classification as the
  // counter (spec D7 as amended for plan review R2-2): one source, so the
  // early-stop line can never arrive without it, cancelled hooks included.
  ctx.warnOnce('first-failure', judgeFirstFailureWarning(signalAborted ? 'timed out' : 'failed'));
  if (ctx.disarmed) return;
  ctx.consecutiveFailures += 1;
  if (ctx.consecutiveFailures >= JUDGE_EARLY_STOP_AFTER && !ctx.stopped) {
    ctx.stopped = true;
    ctx.warnOnce('early-stop', judgeEarlyStopWarning());
  }
}

export interface JudgeRunOptions {
  judge: InternalSessionJudge;
  now: () => number;
  warn: (message: string) => void;
  writeRow: (payload: JudgeCallPayload) => void;
}

export interface JudgeHook {
  readonly state: JudgeHookState;
  scan(input: JudgedScanInput): Promise<JudgedScanOutcome | null>;
  decide(outcome: JudgedScanOutcome | null): JudgeDecision | null;
  record(decision: JudgeDecision | null): void;
  track<T>(work: Promise<T>): Promise<T>;
  dispose(): void;
}

export interface JudgeRun {
  readonly hookTimeoutS: number;
  readonly context: JudgeRunContext;
  enter(signal: AbortSignal | undefined, toolUseId: string | null): JudgeHook;
  hookWasCancelled(toolUseId: string | null): boolean;
  drain(): Promise<JudgeSummary>;
}

/** One per `run()` (R1: the cap cannot live in anything the composition root builds once). */
export function createJudgeRun(opts: JudgeRunOptions): JudgeRun {
  const warned = new Set<LiveWarning>();
  const ctx: JudgeRunContext = {
    call: opts.judge.call,
    cap: opts.judge.maxCallsPerRun,
    timeoutMs: opts.judge.__smokeTimeoutMs ?? JUDGE_TIMEOUT_MS,
    now: opts.now,
    slots: new JudgeSlots(JUDGE_MAX_CONCURRENT),
    records: [],
    warnOnce: (key, message) => {
      if (warned.has(key)) return;
      warned.add(key);
      opts.warn(message);
    },
    warn: opts.warn,
    reserved: 0,
    stopped: false,
    disarmed: false,
    consecutiveFailures: 0,
  };
  const entries: JudgeSummaryEntry[] = [];
  const cancelledHooks = new Set<string>();
  const inFlight = new Set<Promise<unknown>>();
  let capReached = 0;

  function record(hook: JudgeHookState, decision: JudgeDecision): void {
    const { state, composed, deliver, outcome } = decision;
    const { snapshot, floor, input } = outcome;
    const called = snapshot.outcome === 'called';
    const costUsd = called ? (snapshot.result?.costUsd ?? null) : null;
    opts.writeRow({
      tool: input.tool,
      tool_use_id: hook.toolUseId,
      phase: input.phase,
      state,
      heuristic: floor.verdict,
      judge: snapshot.result?.ok === true ? snapshot.result.verdict : null,
      composed: composed.verdict,
      errorKind: state === 'failed' && snapshot.result !== null && !snapshot.result.ok ? snapshot.result.errorKind : null,
      redacted: input.redacted,
      costUsd,
      durationMs: outcome.durationMs,
    });
    entries.push({ state, called, costUsd, delivered: deliver, tightened: deliver && verdictRank(composed.verdict) > verdictRank(floor.verdict) });
    // R6's counter and the first-failure line both moved to call settle
    // (countAtSettle; decision 17, plan review R2-2).
    if (state === 'cap-reached') {
      capReached += 1;
      ctx.warnOnce('cap', judgeCapWarning(ctx.cap, capReached));
    }
    if (state === 'hook-cancelled') ctx.warnOnce('hook-cancelled', JUDGE_HOOK_CANCELLED_WARNING);
  }

  function enter(signal: AbortSignal | undefined, toolUseId: string | null): JudgeHook {
    const state: JudgeHookState = { signal, toolUseId, cancelled: false };
    // Spec D3 step 6 (B-5): a per-CALL flag decides the state (tool_use_id
    // can be null); the per-run set serves only the U-4 LEAKED join and
    // keeps its entry for the rest of the run.
    const onAbort = (): void => {
      state.cancelled = true;
      if (toolUseId !== null) cancelledHooks.add(toolUseId);
    };
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    return {
      state,
      scan: (input) => runJudgedScan(ctx, state, input),
      decide: (outcome) => decideJudgedResult(state, outcome),
      record: (decision) => {
        if (decision !== null) record(state, decision);
      },
      track: <T>(work: Promise<T>): Promise<T> => {
        inFlight.add(work);
        const done = (): void => {
          inFlight.delete(work);
        };
        work.then(done, done);
        return work;
      },
      dispose: () => signal?.removeEventListener('abort', onAbort),
    };
  }

  async function drain(): Promise<JudgeSummary> {
    if (inFlight.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, JUDGE_DRAIN_MS);
      });
      await Promise.race([Promise.allSettled([...inFlight]), bound]);
      clearTimeout(timer);
    }
    const calls = ctx.records.filter((r) => r.outcome === 'called').length;
    return foldJudgeSummary(ctx.cap, calls, entries, inFlight.size);
  }

  return {
    hookTimeoutS: opts.judge.__smokeHookTimeoutS ?? JUDGE_HOOK_TIMEOUT_S,
    context: ctx,
    enter,
    hookWasCancelled: (toolUseId) => toolUseId !== null && cancelledHooks.has(toolUseId),
    drain,
  };
}

export * from './judged-scan-constants.js';
export { JudgeSlots } from './judged-scan-slots.js';
export * from './judged-scan-lines.js';
export { asFloor, normaliseCallResult, validateSessionJudge } from './judged-scan-validate.js';
export { foldJudgeSummary } from './judged-scan-fold.js';
export type { JudgeSummaryEntry } from './judged-scan-fold.js';
