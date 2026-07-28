export type TelemetryEventType = 'turn-cost' | 'tool-trace' | 'hook-event' | 'skill-drop';

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

export interface TurnCostPayload {
  model: string;
  ruleId: string;
  costUsd: number | null;
  numTurns: number | null;
  usage: TurnUsage | null;
  /** SDK-reported session id when one arrived; telemetry keys on the harness id. */
  sdkSessionId: string | null;
  /** SDK result subtype ('success', 'error_max_turns', …) or null on stream error. */
  resultSubtype: string | null;
  /**
   * Refusal fields (ADR-0025). OPTIONAL, not because a writer may omit them —
   * the session layer always supplies all three — but because
   * `isTurnCostPayload` also validates on the READ path and throws on a
   * mismatch. Required fields here would make every turn-cost row written
   * before ADR-0025 unreadable, including `telemetry export` over an existing
   * database. See store.test.ts 'still reads a turn-cost row written before the
   * refusal fields existed'.
   */
  stopReason?: string | null;
  /**
   * Which channel detected a refusal, or null if none did. This is the ONLY
   * field that is non-null whenever a refusal was detected: the SDK documents
   * `api_refusal_category` as null "when neither source carried a category
   * (normal, not an error)", and a no-fallback banner can arrive on a result
   * whose `stop_reason` is not 'refusal'. Without this field such a row is
   * indistinguishable from a clean success, which is the exact defect ADR-0025
   * exists to remove.
   */
  refusalSource?: string | null;
  refusalCategory?: string | null;
  /** Non-null means the answering model was NOT `model` above (a fallback swap). */
  refusalFallbackModel?: string | null;
}

/**
 * No success/failure flag: the SDK's PostToolUse input does not surface tool
 * outcome, and a hardcoded value would assert something false into a
 * persisted, exported surface. Add one only when it can be derived truthfully.
 */
export interface ToolTracePayload {
  tool: string;
  phase: 'post-tool';
  resultSummary: string | null;
}

/**
 * Structural mirror of hooks' HookEventRecord kinds. Deliberately NOT imported
 * from src/hooks — telemetry and hooks are peer leaf modules; the adapter that
 * maps one to the other lives in the composition root (cli.ts).
 */
export type HookEventKind = 'denied-by-hook' | 'hook-error' | 'hook-fired';

export interface HookEventPayload {
  kind: HookEventKind;
  event: string;
  tool?: string;
  reason?: string;
  handlerIndex?: number;
  handlersFired?: number;
}

/**
 * Structural mirror of session's SkillDropReason. Deliberately NOT imported
 * from src/session — telemetry is a leaf below harness (layering.test.ts), the
 * same rule that makes HookEventKind a structural mirror of hooks' kinds.
 */
export type SkillDropReason = 'injection-block' | 'prompt-budget';

/**
 * These are the VALIDATION bound: `isSkillDropPayload` (src/telemetry/store.ts)
 * rejects any field longer (or, for the two `*_MAX` array caps, larger) than
 * its limit. They are shared by the CAPTURE site (session) and the READ-path
 * validator and must be the same constants, not two sets of literals:
 * assertValidInput runs BEFORE sanitizePayload on the write path, so a
 * capture site that capped differently would trip the store's own validator
 * and silently lose rows.
 *
 * `name` and `path` specifically must be bounded through `boundSkillDropName`
 * / `boundSkillDropPath` (src/telemetry/store.ts, re-exported from
 * src/telemetry/index.ts) rather than truncated manually — do not call
 * `truncateWellFormed`/`truncateTailWellFormed` directly against
 * SKILL_DROP_NAME_MAX/SKILL_DROP_PATH_MAX. The reason is the ⚠️ below; the
 * four array caps (CHANNELS/CHANNEL/RULE_IDS/RULE_ID) are plain count/length
 * limits with no truncation semantics, so no equivalent helper exists or is
 * needed for them — a caller enforces those simply by not exceeding them.
 *
 * ⚠️ SKILL_DROP_NAME_MAX/SKILL_DROP_PATH_MAX ARE TOTAL STORED LENGTH,
 * INCLUDING THE ELLIPSIS — this is why the two helpers exist rather than
 * "just pass the cap to the truncator." Truncators bound the CONTENT at `max`
 * and then append (or prepend) a U+2026, so a truncated value is `max + 1`
 * units — pinned behaviour, asserted at src/eval/scorecard/sanitize.test.ts.
 * `boundSkillDropName`/`boundSkillDropPath` own the resulting `CAP - 1`
 * arithmetic (and, for `path`, the truncated-flag derivation) so no caller
 * re-derives it by hand: getting that arithmetic backwards makes every
 * truncated row fail isSkillDropPayload, throw in assertValidInput, and get
 * downgraded to a warning by recordTelemetry — i.e. the pathological long
 * attacker-controlled paths, the rows most worth having, are exactly the ones
 * silently lost.
 */
export const SKILL_DROP_NAME_MAX = 200;
export const SKILL_DROP_PATH_MAX = 1024;
export const SKILL_DROP_CHANNELS_MAX = 3;
export const SKILL_DROP_CHANNEL_MAX = 64;
export const SKILL_DROP_RULE_IDS_MAX = 32;
export const SKILL_DROP_RULE_ID_MAX = 64;

/**
 * `path` is bounded TAIL-first (see truncateTailWellFormed): skill names are
 * not unique and only the path disambiguates, and a path's distinguishing part
 * is its filename. `ruleIds` is bounded in BOTH count and element length
 * because `SessionDeps.scanInjection` is caller-supplied code, not the shipped
 * rule table — the rule-table bound described in scan.ts does not apply here.
 */
export interface SkillDropPayload {
  name: string;
  path: string;
  /**
   * OUT-OF-BAND truncation marker for `path`. The in-band ellipsis cannot be
   * trusted: U+2026 is a legal filename character and skill paths are
   * attacker-authored (a malicious cloned repo is in scope per the security
   * model), so a file literally named '…foo.md' is byte-identical to a
   * genuinely truncated path. That lets an attacker forge "the real path is
   * longer" and send an analyst to the wrong file, or collide a short path
   * with a truncated long one — defeating the single job `path` exists for.
   *
   * `name` deliberately does NOT get an equivalent flag: it is a display
   * label, is not unique, and is not the disambiguator. Scope choice, not
   * oversight.
   */
  pathTruncated: boolean;
  reason: SkillDropReason;
  /** Scanned channels that blocked the skill; empty for 'prompt-budget'. */
  channels: string[];
  ruleIds: string[];
}

interface TelemetryEventBase {
  id: string;
  /** Harness-generated session id — stable across hook/session/tool events. */
  sessionId: string;
  /** Turn-scoped correlation id; with sessionId reconstructs a full trace. */
  turnId: string;
  /** epoch ms */
  ts: number;
}

export type TelemetryEvent =
  | (TelemetryEventBase & { type: 'turn-cost'; payload: TurnCostPayload })
  | (TelemetryEventBase & { type: 'tool-trace'; payload: ToolTracePayload })
  | (TelemetryEventBase & { type: 'hook-event'; payload: HookEventPayload })
  | (TelemetryEventBase & { type: 'skill-drop'; payload: SkillDropPayload });

interface TelemetryInputBase {
  sessionId: string;
  turnId: string;
  /** epoch ms; the store stamps Date.now() when omitted. */
  ts?: number;
}

/** What callers pass to `record`. The store fills `id` (and `ts` if omitted). */
export type TelemetryEventInput =
  | (TelemetryInputBase & { type: 'turn-cost'; payload: TurnCostPayload })
  | (TelemetryInputBase & { type: 'tool-trace'; payload: ToolTracePayload })
  | (TelemetryInputBase & { type: 'hook-event'; payload: HookEventPayload })
  | (TelemetryInputBase & { type: 'skill-drop'; payload: SkillDropPayload });

export interface TelemetryFilter {
  sessionId?: string;
  turnId?: string;
  type?: TelemetryEventType;
  /** epoch ms, inclusive. */
  since?: number;
  /** epoch ms, exclusive. */
  until?: number;
  /** Non-negative integer cap on the number of rows returned. */
  limit?: number;
  /** Order by `ts` (rowid tiebreak); default 'asc' — trace order. */
  order?: 'asc' | 'desc';
}

export type TelemetryErrorKind = 'constraint' | 'db';

export interface TelemetryError {
  kind: TelemetryErrorKind;
  message: string;
}

export type RecordResult =
  | { ok: true; value: TelemetryEvent }
  | { ok: false; error: TelemetryError };

export interface TelemetryStore {
  record(event: TelemetryEventInput): RecordResult;
  query(filter?: TelemetryFilter): TelemetryEvent[];
}
