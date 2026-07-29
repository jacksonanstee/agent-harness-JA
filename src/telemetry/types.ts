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
 * SKILL_DROP_NAME_MAX/SKILL_DROP_PATH_MAX. The reason is the ⚠️ below.
 *
 * The four array caps have no helper, but they are NOT uniform, and the
 * difference is what the shipped capture site actually does:
 *   - CHANNELS_MAX / CHANNEL_MAX are pure limits. `channels` is harness-
 *     authored from a closed union, so the capture site passes it through
 *     whole — neither sliced nor element-truncated. Both are guarded from the
 *     session side, the only side that lints: cardinality by the drift guards,
 *     element length by session.test.ts's `every channel name fits` test.
 *   - RULE_IDS_MAX / RULE_ID_MAX DO carry truncation semantics at the capture
 *     site, because rule ids come from a caller-supplied `scanInjection` and
 *     are bounded by nothing. The array is sliced to RULE_IDS_MAX and each
 *     element truncated to RULE_ID_MAX **- 1**, per the ⚠️ below.
 * Do not "simplify" that to `truncateWellFormed(id, SKILL_DROP_RULE_ID_MAX)`:
 * the truncators append an ellipsis ON TOP of `max`, so that yields RULE_ID_MAX
 * + 1 units, fails isSkillDropPayload, throws in assertValidInput, and
 * recordTelemetry downgrades it to one stderr warning — the row is lost.
 *
 * `SKILL_DROP_CHANNELS_MAX` is not a free-standing budget: it is the
 * CARDINALITY of the `SkillDropChannel` union (src/session/types.ts), because
 * `DroppedSkill.channels` can name at most every channel once. Nothing here
 * derives it — layering forbids telemetry importing session — so it is
 * hand-copied by necessity and guarded from the other side instead, by the
 * drift test in src/session/session.test.ts. Grow the union without bumping
 * this and the widest drops fail `isSkillDropPayload`, get downgraded to a
 * warning by `recordTelemetry`, and vanish.
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
/**
 * Length of `SkillDropPayload.pathDigest`, in lowercase hex characters (issue
 * #50). Each hex character carries 4 bits, so the value below is a 128-bit
 * digest.
 *
 * The width is set by the THREAT, not by taste. This field exists to survive a
 * DELIBERATE attacker: they author the skill pack, so they choose both paths,
 * and forcing two audit rows to collide defeats the field's only purpose. That
 * rules out a non-cryptographic hash (FNV-class collisions are constructible by
 * hand) — but it equally rules out a short truncation of a good one, because a
 * 64-bit digest has a birthday bound near 2^32 hashes, minutes of commodity GPU
 * time and well inside an attacker's budget. At 128 bits the bound is 2^64,
 * which is not reachable.
 *
 * NEITHER DIRECTION IS A FREE EDIT, and the guards live elsewhere, so they are
 * named here the way `SKILL_DROP_CHANNELS_MAX` names its drift test above.
 * Narrowing restores the forceable collision and is refused by the ratchet in
 * `src/telemetry/store.test.ts`. Widening is a BREAKING READ CHANGE rather than
 * an improvement: the validator's pattern is anchored at exactly this width and
 * `query()` throws on the first row that fails it, so old rows would deny the
 * whole trail. Raise the width by adding a NEW FIELD, not by editing this
 * number. ADR-0011 decision 16 carries the full argument.
 */
export const SKILL_DROP_PATH_DIGEST_LEN = 32;
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
  /**
   * ALREADY ESCAPED (not merely cleaned) by the capture site, mirroring
   * session.ts's `DroppedSkill.path` / `escapePathUnsafe` (src/internal/
   * sanitize.ts) one layer down: deleting an invisible character here would
   * be lossy in exactly the way `pathTruncated` below exists to prevent for
   * truncation — a hostile `/skills/he<U+200B>lper.md` must not read back
   * byte-identical to a benign `/skills/helper.md` (round-1 fix, issue #46
   * Finding 1). `isSkillDropPayload` (store.ts) validates shape, not
   * content, so a direct writer that skips escaping is not rejected here —
   * same trust boundary as every other string field on this payload.
   */
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
  /**
   * OUT-OF-BAND marker mirroring `pathTruncated`, for the same reason: `path`
   * above went through `escapePathUnsafe` at capture, and whether it needed
   * to (i.e. whether the raw path carried a control/bidi/invisible
   * character) is itself a signal worth keeping structural rather than
   * requiring a consumer to re-derive it by scanning for `\u{` substrings —
   * which a legitimately named file could also contain (see
   * `escapePathUnsafe`'s anti-forgery doc comment).
   *
   * Being a property of the PRE-IMAGE, it deliberately survives truncation:
   * `boundSkillDropPath` drops a cut-straddling token whole, so a stored
   * `path` may contain no escape token at all while this flag is correctly
   * true. That is not a desync — re-deriving from the stored string is the
   * bug. Backslash-doubling alone never sets it (it neutralises nothing);
   * see DroppedSkill.pathHasEscapes for the full contract.
   */
  pathHasEscapes: boolean;
  /**
   * SHA-256 of the FULL escaped path, first `SKILL_DROP_PATH_DIGEST_LEN` hex
   * characters. Present only when `pathTruncated` is true, because a complete
   * path is already its own identity (issue #50).
   *
   * WHY IT EXISTS: tail truncation keeps the filename and discards everything
   * before it, so two paths differing only BEFORE the cut store byte-
   * identically — and `path` exists precisely to disambiguate skills whose
   * names collide. `pathTruncated` tells an operator the path was cut; it does
   * not tell them a DISTINGUISHING character was lost. An attacker authoring a
   * cloned repo controls directory depth and naming, so the offset is
   * engineerable.
   *
   * ⚠️ OPTIONAL ON PURPOSE, and it must stay that way. Rows written before
   * this field existed carry no `pathDigest`. Requiring it would fail
   * `isSkillDropPayload` on READ, and `rowToEvent` throws rather than skipping
   * the row, so `query()` would throw on every call and deny the ENTIRE trail
   * — every unrelated event included — for anyone who had already run the
   * shipping build. Verified empirically before choosing optional: removing
   * one required field from one stored row made `telemetry export` exit 1 with
   * zero rows out of twenty-five.
   *
   * It also cannot be backfilled by a migration, because the digest is taken
   * over the full escaped path and that is exactly what truncation discarded.
   *
   * Derive it from `boundSkillDropPath`, which returns it from the SAME call
   * that truncates, so the digest and `pathTruncated` cannot disagree. Do not
   * compute it from the STORED path: that collides exactly as the stored value
   * does, which is the bug this field exists to fix.
   */
  pathDigest?: string;
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
