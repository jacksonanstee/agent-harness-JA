import { JUDGE_ERROR_KINDS, JUDGE_TIMEOUT_MS, MAX_JUDGE_CALLS_PER_RUN } from '../security/index.js';
import type { JudgeCallResult, JudgeErrorKind, ScanResult, Verdict } from '../security/index.js';
import { JUDGE_HOOK_TIMEOUT_S } from './judged-scan-constants.js';
import type { InternalSessionJudge } from './judged-scan-constants.js';
import type { SessionDeps } from './types.js';

// Issue #96 PR-B1: construction-time validation of `deps.judge`, and the
// narrowing of caller-supplied values (a judge result, a heuristic floor)
// before they enter the judge path.

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Construction-time validation (spec D3, K-1, A-4, A-10): library misuse fails at `createSession`, not mid-run. */
export function validateSessionJudge(deps: SessionDeps): void {
  const judge = deps.judge as InternalSessionJudge | undefined;
  if (judge === undefined) return;
  const call: unknown = typeof judge === 'object' && judge !== null ? judge.call : undefined;
  if (typeof call !== 'function') {
    throw new TypeError('createSession: deps.judge.call must be a function (build one with buildJudge(query, JUDGE_MODEL))');
  }
  const cap: unknown = judge.maxCallsPerRun;
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > MAX_JUDGE_CALLS_PER_RUN) {
    throw new TypeError(`createSession: deps.judge.maxCallsPerRun must be an integer from 1 to ${MAX_JUDGE_CALLS_PER_RUN}`);
  }
  if (typeof deps.scanInjection !== 'function') {
    throw new TypeError("createSession: deps.judge needs deps.scanInjection (the judge only tightens the heuristic's verdict)");
  }
  if (typeof deps.redactSecrets !== 'function') {
    throw new TypeError("createSession: deps.judge needs deps.redactSecrets (the judge's tool-output input is redacted first)");
  }
  for (const key of ['__smokeTimeoutMs', '__smokeHookTimeoutS'] as const) {
    if (judge[key] !== undefined && !isPositiveInteger(judge[key])) {
      throw new TypeError(`createSession: deps.judge.${key} must be a positive integer`);
    }
  }
  const timerMs = judge.__smokeTimeoutMs ?? JUDGE_TIMEOUT_MS;
  const hookS = judge.__smokeHookTimeoutS ?? JUDGE_HOOK_TIMEOUT_S;
  if (!(hookS * 1000 > timerMs)) {
    throw new TypeError(`createSession: the judge hook timeout (${hookS} s) must exceed the judge timer (${timerMs} ms)`);
  }
}

const isVerdict = (value: unknown): value is Verdict => value === 'pass' || value === 'ask' || value === 'block';
const isErrorKind = (value: unknown): value is JudgeErrorKind =>
  typeof value === 'string' && (JUDGE_ERROR_KINDS as readonly string[]).includes(value);

/**
 * Narrows a caller-supplied `JudgeCall` result on EVERY arm (lesson
 * 2026-09-15) so a forged value can never dead-letter the `judge-call` row:
 * a cost that is not a finite non-negative number reads null, an errorKind
 * outside the closed union reads `call-failed`, anything else reads
 * `call-failed`. Property reads may throw on a hostile object; the caller
 * (the recording wrapper) catches that as a thrown call.
 */
export function normaliseCallResult(raw: unknown): JudgeCallResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, errorKind: 'call-failed', costUsd: null };
  const r = raw as { ok?: unknown; verdict?: unknown; errorKind?: unknown; costUsd?: unknown };
  const costUsd = typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd >= 0 ? r.costUsd : null;
  if (r.ok === true && isVerdict(r.verdict)) return { ok: true, verdict: r.verdict, costUsd };
  if (r.ok === true) return { ok: false, errorKind: 'call-failed', costUsd: null };
  return { ok: false, errorKind: isErrorKind(r.errorKind) ? r.errorKind : 'call-failed', costUsd };
}

/**
 * The heuristic floor as the judged path reads it: a well-formed `ScanResult`
 * copied into fresh arrays, or null. `scanInjection` is caller-supplied code
 * (lesson 2026-07-28): a malformed or absent result never enters the judge
 * path (Review Focus 2); the hook then behaves exactly as with no judge.
 */
export function asFloor(raw: unknown): ScanResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { verdict?: unknown; rule_ids?: unknown; excerpts?: unknown; suspicious?: unknown };
  if (!isVerdict(r.verdict) || !Array.isArray(r.rule_ids) || !Array.isArray(r.excerpts)) return null;
  return { verdict: r.verdict, rule_ids: [...(r.rule_ids as string[])], excerpts: [...(r.excerpts as string[])], suspicious: r.suspicious === true };
}
