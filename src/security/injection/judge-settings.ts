import { unknownKeyMessage, unknownKeys } from '../../internal/settings.js';

/**
 * The session judge's settings (issue #96 PR-B1, spec D1). Read from the USER
 * layer only (`~/.harness/settings.json`, decision 2); the project layer's
 * `judge` key is never parsed (decision 9), only detected by `hasJudgeKey`.
 * `mode` is typed `'always'` because the session offers only `off | always`
 * (decision 3; `suspicious` measured no added detection, ADR-0036 D7): the
 * difference from the scanner's three `JUDGE_MODES` is visible in the types (U-5).
 */
export interface JudgeSettings {
  mode: 'always';
  maxCallsPerRun: number;
}

/** Same fail-loud contract as PermissionSettingsError and SandboxSettingsError (ADR-0034, A-8). */
export class JudgeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeSettingsError';
  }
}

/** A typo guard, not a budget (spec D1). The money ceiling is below. */
export const MAX_JUDGE_CALLS_PER_RUN = 1000;

const JUDGE_KEYS: readonly string[] = ['mode', 'maxCallsPerRun'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_JUDGE_CALLS_PER_RUN;
}

/**
 * Validates the `judge` key of a USER settings document. Absent or `off` is
 * null (judge off). One grammar for the block whatever the mode (K-7): an
 * unknown key or a malformed `maxCallsPerRun` fails under `off` too. Messages
 * name the key path and the expected type or range and never echo a value
 * (G-3); an unknown key's name is bounded by `unknownKeyMessage` (boundEcho).
 */
export function parseJudgeSettings(doc: unknown): JudgeSettings | null {
  if (!isRecord(doc)) throw new JudgeSettingsError('settings root must be a JSON object');
  const judge = doc['judge'];
  if (judge === undefined) return null;
  if (!isRecord(judge)) throw new JudgeSettingsError('judge must be an object');
  const [unknown] = unknownKeys(judge, JUDGE_KEYS);
  if (unknown !== undefined) throw new JudgeSettingsError(unknownKeyMessage('judge', unknown, JUDGE_KEYS));
  const mode = judge['mode'];
  const cap = judge['maxCallsPerRun'];
  if (mode === 'suspicious') {
    throw new JudgeSettingsError(
      'judge.mode "suspicious" is not available in a session: it measured no added detection (ADR-0036 D7); use "always" or "off"',
    );
  }
  if (mode !== 'always' && mode !== 'off') throw new JudgeSettingsError('judge.mode must be "always" or "off"');
  if (cap === undefined) {
    if (mode === 'off') return null;
    throw new JudgeSettingsError(
      `judge.maxCallsPerRun is required when judge.mode is "always" (an integer from 1 to ${MAX_JUDGE_CALLS_PER_RUN}; see README Settings)`,
    );
  }
  if (!isCap(cap)) {
    throw new JudgeSettingsError(`judge.maxCallsPerRun must be an integer from 1 to ${MAX_JUDGE_CALLS_PER_RUN}`);
  }
  return mode === 'off' ? null : { mode: 'always', maxCallsPerRun: cap };
}

/**
 * True when a settings document carries an OWN `judge` key, whatever its
 * value: the project layer's only judge behaviour is one warning (spec D1).
 */
export function hasJudgeKey(doc: unknown): boolean {
  return isRecord(doc) && Object.prototype.hasOwnProperty.call(doc, 'judge');
}

// ----- The money ceiling (spec D1, threat model T-4, N-4). The cap bounds the
// NUMBER of calls, not dollars per call: ADR-0036 D7's USD 0.0033 per haiku
// call is the TYPICAL figure on short corpus strings, while a session input
// can reach MAX_JUDGE_INPUT_BYTES and the reply has no length bound
// (decision 16). The ceiling is the cost of one call at the input cap, from
// the inputs below; pin 33 re-derives it and checks README's figure. The
// D8 re-measure does not exercise realistic input sizes (ADR-0037).

/** The date the prices below were read (claude-api skill model table, cached 2026-09-25). */
export const JUDGE_PRICE_READ_ON = '2026-10-01';
/** claude-haiku-4-5 list price, USD per million input tokens. */
export const JUDGE_INPUT_USD_PER_MTOK = 1;
/** claude-haiku-4-5 list price, USD per million output tokens. */
export const JUDGE_OUTPUT_USD_PER_MTOK = 5;
/** Byte-level tokenisation never spends fewer than one byte per token, so one byte per token is the worst case. */
export const JUDGE_BYTES_PER_TOKEN_FLOOR = 1;
/** An allowance for the system prompt, the boundary markers and the CLI's framing around the untrusted block. */
export const JUDGE_PROMPT_OVERHEAD_TOKENS = 2_048;
/** A stated ALLOWANCE, not a bound: the judge's reply length is unbounded (decision 16). */
export const JUDGE_REPLY_ALLOWANCE_TOKENS = 4_096;
/**
 * USD for one judge call at the 128 KiB input cap, from the inputs above:
 * (131,072 / 1 + 2,048) x 1 + 4,096 x 5 = 153,600 micro-USD. A literal, so a
 * changed input without this constant fails pin 33. Root-public (R3-2).
 */
export const JUDGE_WORST_CASE_USD_PER_CALL = 0.1536;
