import { describeError } from './describe-error.js';
import { JUDGE_EARLY_STOP_AFTER, JUDGE_MAX_CONCURRENT } from './judged-scan-constants.js';

// Issue #96 PR-B1: the judge path's live-line texts (spec D7; U-1, U-3, U-4;
// decision 16), plus the refused line (`judgeRefusedWarning`, issue #152
// D10). The session's `warn` carries them; the CLI prefixes `warning: `.
// One source per text.

export const JUDGE_HOOK_CANCELLED_WARNING =
  "a tool result reached the model WITHOUT the harness's note or secret redaction, because its hook ran past the SDK's hook timeout.";

export function judgeFirstFailureWarning(kind: 'failed' | 'timed out'): string {
  return (
    `a judge call ${kind}; that result used the heuristic only. If this repeats, check ANTHROPIC_API_KEY and the network ` +
    `(a tool result's content can also slow the judge), or set judge.mode to "off" in ~/.harness/settings.json.`
  );
}

export function judgeEarlyStopWarning(): string {
  return (
    `the judge failed ${JUDGE_EARLY_STOP_AFTER} times in a row with nothing judged, so it is off for the rest of this run; ` +
    `results use the heuristic only. Check ANTHROPIC_API_KEY and the network; if they are fine, a tool result's content may have slowed the judge.`
  );
}

export function judgeCapWarning(cap: number, unjudged: number): string {
  return (
    `the judge call cap (${cap}) was reached; ${unjudged} tool result(s) ran on the heuristic only. ` +
    'Raise judge.maxCallsPerRun in ~/.harness/settings.json to judge more.'
  );
}

export function judgeSlotsHeldWarning(seconds: number): string {
  return (
    `all ${JUDGE_MAX_CONCURRENT} judge slots are held by calls that have not finished ${seconds} s after starting, ` +
    "so later tool results are going unjudged. A custom QueryFn must honour abortController; the shipped CLI's does."
  );
}

/**
 * Issue #152 D10: once per run, on the first `refused` result the session
 * records. No tool name: the row carries it, and the first refusal's tool
 * would be arbitrary for a once-per-run line.
 */
export function judgeRefusedWarning(): string {
  return (
    'the provider refused to judge a tool result (its usage-policy filter), so that result is annotated ask (rule id judge-refused) and was not judged. ' +
    'The judge stays on; refusals never count toward its early stop, and the summary line and the judge-call rows count them.'
  );
}

/** Spec D3 step 5: a judged-scanner rejection is reported like today's scanner failure (ADR-0026 D7), same prefix, same renderer. */
export function judgeScanFailedWarning(error: unknown): string {
  return `injection scan failed: ${describeError(error)}`;
}

/** U-4: the existing LEAKED warning, naming the hook timeout as the cause instead of the redactor. */
export function judgeLeakedByHookTimeoutWarning(tool: string): string {
  return `the ${tool} output rewrite LEAKED: its hook ran past the SDK's hook timeout, so the harness's redaction never reached the model (#84, #96)`;
}
