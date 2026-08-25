import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import { MIGRATIONS, runMigrations } from './migrations/index.js';
import type {
  HookEventPayload,
  RecordResult,
  SkillDropPayload,
  SkillDropReason,
  TelemetryError,
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryEventType,
  TelemetryFilter,
  TelemetryStore,
  ToolTracePayload,
  TurnCostPayload,
  TurnUsage,
} from './types.js';
import {
  SKILL_DROP_CHANNEL_MAX,
  SKILL_DROP_CHANNELS_MAX,
  HOOK_EVENT_REASON_MAX,
  SKILL_DROP_NAME_MAX,
  SKILL_DROP_PATH_DIGEST_LEN,
  SKILL_DROP_PATH_MAX,
  SKILL_DROP_RULE_ID_MAX,
  SKILL_DROP_RULE_IDS_MAX,
  TELEMETRY_ID_MAX,
} from './types.js';
import {
  escapePathUnsafe,
  PATH_ESCAPE_SEQUENCE,
  sanitizeControlChars as sanitizeText,
  truncateTailWellFormed,
  truncateWellFormed,
} from '../internal/sanitize.js';

/**
 * Exhaustive BY CONSTRUCTION. The previous
 * `as const satisfies readonly TelemetryEventType[]` checked MEMBERSHIP only:
 * widening TelemetryEventType and forgetting this array compiled clean, and
 * then EVENT_TYPE_SET rejected every write of the new type at
 * assertValidInput — which recordTelemetry downgrades to a warning, so the
 * feature would be silently dead. A missing key here is now a compile error.
 */
const EVENT_TYPE_PRESENCE: Record<TelemetryEventType, true> = {
  'turn-cost': true,
  'tool-trace': true,
  'hook-event': true,
  'skill-drop': true,
};

export const TELEMETRY_EVENT_TYPES = Object.keys(EVENT_TYPE_PRESENCE) as readonly TelemetryEventType[];
export const DEFAULT_DB_PATH = './.harness/telemetry.db';

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(TELEMETRY_EVENT_TYPES);
const HOOK_EVENT_KINDS: ReadonlySet<string> = new Set(['denied-by-hook', 'hook-error', 'hook-fired']);

/**
 * Correlation ids are an ALLOWLIST, not a denylist (issue #51). Anchored, so a
 * partial match cannot admit a longer string. The length lives in a separate
 * check rather than folded in as `{1,N}` so the bound stays one named constant
 * shared with the session layer, not a number buried in a pattern.
 *
 * Allowlisting is the whole point. A denylist of "the control and bidi
 * characters we know about" is the enumerate-a-class-one-PoC-at-a-time trap
 * ADR-0026 recorded: every round of that fix found one more code point sitting
 * in a gap. Naming what an identifier MAY contain converges immediately and
 * needs no maintenance as Unicode grows. The set is chosen to admit the id
 * schemes a library consumer plausibly already uses (UUID, ULID, prefixed and
 * namespaced ids, dotted versions) while excluding whitespace, quotes, path
 * separators and shell metacharacters, so no future reader of these columns
 * inherits a quoting problem.
 */
const CORRELATION_ID_RE = /^[A-Za-z0-9_.:-]+$/;

/**
 * DERIVED from the pattern, both halves of it. An earlier cut interpolated the
 * length but hand-typed the character class, under a comment claiming the rule
 * was "stated once so the guard and its error message cannot disagree": true
 * of the bound, false of the charset, which is the half more likely to change.
 * Widening the class for some consumer's id scheme would have left every
 * rejection message naming a rule the guard no longer enforced, with nothing to
 * catch it. Same derivation idiom as `PATH_DIGEST_RE` below and the charsets in
 * `internal/sanitize.ts`. `slice(1, -2)` drops the `^` and the trailing `+$`.
 */
const CORRELATION_ID_RULE = `must be 1-${TELEMETRY_ID_MAX} characters of ${CORRELATION_ID_RE.source.slice(1, -2)}`;

/**
 * Module-local on purpose. `assertValidCorrelationId` below is the whole
 * contract, and it is the only caller; a predicate exported beside it would be
 * a name nothing imports, and this repo's sub-barrels are where the root barrel
 * shops for things to make public (ADR-0023). Deliberately NOT the
 * `isBlockedFirstToken` shape: that predicate is exported because it has two
 * genuinely independent callers, an enforcement path and a warning path that
 * had drifted. Here the thing both layers share is the THROW, not the test.
 */
function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= TELEMETRY_ID_MAX && CORRELATION_ID_RE.test(value);
}

/**
 * Throwing form, exported so the session layer raises the SAME error for the
 * SAME rule. An earlier cut of this change shared only the predicate and let
 * each layer word its own message, which meant two descriptions of one rule
 * free to drift apart, which is the thing the predicate was shared to prevent,
 * one level up. Rendering the rejected value is the fiddly part (escape it, never
 * invoke its `toString`), and it should exist once.
 */
export function assertValidCorrelationId(value: unknown, field: string): string {
  if (!isValidCorrelationId(value)) {
    throw new TypeError(`${field} ${CORRELATION_ID_RULE}, got ${describeId(value)}`);
  }
  return value;
}

/**
 * Renders a rejected id for an error message. Escaped, not raw: the whole
 * reason this id was refused is that it carries characters that misbehave in a
 * terminal, and a direct library consumer printing `error.message` would
 * otherwise be handed the exact bytes the guard just refused to store.
 * `recordTelemetry` sanitises on its own path, but a thrown TypeError belongs
 * to whoever catches it.
 *
 * A NON-STRING id is reported by TYPE and never rendered, which is the case an
 * earlier draft of this function got wrong: it fell through to `String(value)`,
 * and `String` invokes the value's own `toString`, which on a hostile object is
 * attacker-authored text spliced into the message with no escaping at all. That
 * would have moved the problem into the error path rather than closing it,
 * while the paragraph above claimed otherwise. There is nothing legitimate to
 * render for a non-string anyway: the caller's mistake is the type, not the
 * characters, so the type is the whole diagnosis.
 */
function describeId(value: unknown): string {
  if (typeof value !== 'string') return `a non-string value of type ${typeof value}`;
  return escapePathUnsafe(truncateWellFormed(value, TELEMETRY_ID_MAX)).value;
}


const INSERT_SQL = `
INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
VALUES (@id, @type, @sessionId, @turnId, @ts, @payload);
`;

interface OpenTelemetryDatabaseOptions {
  path?: string;
}

/**
 * Opens (creating if needed) the shared harness DB and brings its schema up to
 * date via the migration runner. Caller owns the connection lifecycle.
 */
export function openTelemetryDatabase(opts: OpenTelemetryDatabaseOptions = {}): Database.Database {
  const path = opts.path ?? DEFAULT_DB_PATH;
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);
  return db;
}

interface EventRow {
  id: string;
  type: string;
  session_id: string;
  turn_id: string;
  ts: number;
  payload: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Absent is allowed (older rows); present-but-wrong-typed is not. */
function isOptionalStringOrNull(value: unknown): value is string | null | undefined {
  return value === undefined || isStringOrNull(value);
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isTurnUsage(value: unknown): value is TurnUsage {
  return (
    isObject(value) &&
    typeof value.inputTokens === 'number' &&
    Number.isFinite(value.inputTokens) &&
    typeof value.outputTokens === 'number' &&
    Number.isFinite(value.outputTokens) &&
    isFiniteOrNull(value.cacheCreationInputTokens) &&
    isFiniteOrNull(value.cacheReadInputTokens)
  );
}

function isTurnCostPayload(value: unknown): value is TurnCostPayload {
  return (
    isObject(value) &&
    typeof value.model === 'string' &&
    typeof value.ruleId === 'string' &&
    isFiniteOrNull(value.costUsd) &&
    isFiniteOrNull(value.numTurns) &&
    (value.usage === null || isTurnUsage(value.usage)) &&
    isStringOrNull(value.sdkSessionId) &&
    isStringOrNull(value.resultSubtype) &&
    // Optional so rows written before ADR-0025 still validate on read; a
    // PRESENT field of the wrong type is still a hard failure.
    isOptionalStringOrNull(value.stopReason) &&
    isOptionalStringOrNull(value.refusalSource) &&
    isOptionalStringOrNull(value.refusalCategory) &&
    isOptionalStringOrNull(value.refusalFallbackModel)
  );
}

function isToolTracePayload(value: unknown): value is ToolTracePayload {
  return (
    isObject(value) &&
    typeof value.tool === 'string' &&
    value.phase === 'post-tool' &&
    isStringOrNull(value.resultSummary)
  );
}

function isHookEventPayload(value: unknown): value is HookEventPayload {
  return (
    isObject(value) &&
    typeof value.kind === 'string' &&
    HOOK_EVENT_KINDS.has(value.kind) &&
    typeof value.event === 'string' &&
    (value.tool === undefined || typeof value.tool === 'string') &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    // Number.isInteger, not `typeof === 'number'`: the same write-passes/
    // read-fails asymmetry as the sparse-array class above — `typeof NaN` and
    // `typeof Infinity` are both 'number', so both used to pass here, then
    // JSON.stringify writes NaN/Infinity as `null`, and the read-back's
    // re-validation (this same function) rejects the `null`. The transaction
    // now makes that fail-safe (nothing commits) rather than fail-open, but
    // it was still a silently lost event with a misleading error, so this
    // closes it at the same pre-write gate as the array fix.
    (value.handlerIndex === undefined || Number.isInteger(value.handlerIndex)) &&
    (value.handlersFired === undefined || Number.isInteger(value.handlersFired))
  );
}

/**
 * Exhaustive BY CONSTRUCTION, same shape as EVENT_TYPE_PRESENCE above and for
 * the same reason: a hand-copied `Set(['injection-block', 'prompt-budget'])`
 * is a MEMBERSHIP check, not a completeness check. This is the exact bug this
 * task fixed for TELEMETRY_EVENT_TYPES, one file down — a set built from a
 * literal list compiles clean when SkillDropReason grows a third member and
 * nobody updates the literal, and the new reason is silently dead-lettered by
 * assertValidInput. A missing key here is now a compile error.
 */
const SKILL_DROP_REASON_PRESENCE: Record<SkillDropReason, true> = {
  'injection-block': true,
  'prompt-budget': true,
};

// Mirrors TELEMETRY_EVENT_TYPES/EVENT_TYPE_SET above: an exported array for
// callers/tests that need the exact member list (round-2 review Finding 3 —
// the sibling ratchet had a runtime "covers every member" test and this one
// didn't), plus an internal Set for the O(1) membership check below.
export const SKILL_DROP_REASONS = Object.keys(SKILL_DROP_REASON_PRESENCE) as readonly SkillDropReason[];
const SKILL_DROP_REASON_SET: ReadonlySet<string> = new Set(SKILL_DROP_REASONS);

/**
 * First array-bearing payload in this store: elements are validated, not just
 * the container, because a direct writer need not have gone through session.ts.
 *
 * Indexed loop, NOT `.every`: `Array.prototype.every` (and `.map`, in
 * sanitizePayload's skill-drop branch) SKIP holes — they walk HasProperty, not
 * indices — so a sparse array (e.g. `ruleIds[2] = 'x'` with no index 0 or 1
 * set) passes this check and passes the `.map` in sanitizePayload unchanged.
 * `JSON.stringify` does NOT skip holes: it materialises each one as `null`.
 * That row then INSERTs successfully, and only fails re-validation on the
 * read-back inside record() (rowToEvent's structural check), by which point
 * the write already happened — see the transaction wrapping the insert and
 * read-back in createTelemetryStore. Reading `value[i]` on a hole returns
 * `undefined`, which fails `typeof item !== 'string'` here, so this indexed
 * loop rejects the sparse array BEFORE either the write or the `.map`.
 */
function isBoundedStringArray(value: unknown, maxItems: number, maxLen: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  for (let i = 0; i < value.length; i += 1) {
    const item: unknown = value[i];
    if (typeof item !== 'string' || item.length > maxLen) return false;
  }
  return true;
}

/**
 * Bakes the CAP-1 truncator arithmetic (see types.ts's SKILL_DROP_*_MAX doc
 * comment) into one place so no caller re-derives it. Task 5's capture site
 * needs this arithmetic in two independent spots — the truncation call and
 * the separate `pathTruncated` derivation, since neither truncator reports
 * whether it fired — and a hand-copied `CAP - 1` in each is a silent-inversion
 * risk: get the sign wrong and every oversized attacker-controlled path (the
 * rows most worth having) fails isSkillDropPayload and vanishes as a warning.
 *
 * The input here has ALREADY been through `escapePathUnsafe` (session.ts
 * write site; since ADR-0031 the escape runs on the ROOT-RELATIVE form —
 * relativise, then escape, then bound; round-1 fix issue #46 Finding 1) —
 * escape THEN truncate, not the other order, so the cap bounds what is
 * actually stored rather than a pre-image that can grow past it during
 * escaping. That ordering creates a
 * hazard `truncateTailWellFormed` alone does not guard: a raw tail-cut can
 * land INSIDE one of `escapePathUnsafe`'s own tokens (`\\` or `\u{HEX}`,
 * `PATH_ESCAPE_SEQUENCE`), keeping a fragment like `00B}rest.md` that reads as
 * ordinary text containing digits and a brace, not as a truncated escape.
 * Guarded by nudging the cut FORWARD — dropping the whole partial token
 * rather than keeping a fragment of it — which only ever trims MORE, never
 * less, so the result never exceeds the cap this function exists to enforce.
 */
export function boundSkillDropPath(
  path: string,
  digestPreImage: string,
): { value: string; truncated: boolean; digest?: string } {
  const cap = SKILL_DROP_PATH_MAX - 1;
  const truncated = path.length > cap;
  // No digest when nothing was discarded: a complete stored value is its own
  // identity WITHIN its root — since ADR-0031 the value is root-relative, so
  // two sub-cap rows under different roots can store identically with no
  // digest to separate them, an accepted cost recorded there (rows carry
  // sessionId). The key is omitted rather than set to undefined so a consumer
  // can use presence as the signal (issue #50).
  if (!truncated) return { value: path, truncated };
  const naiveFrom = path.length - cap;
  let effectiveMax = cap;
  PATH_ESCAPE_SEQUENCE.lastIndex = 0;
  for (let m = PATH_ESCAPE_SEQUENCE.exec(path); m !== null; m = PATH_ESCAPE_SEQUENCE.exec(path)) {
    const start = m.index;
    const end = start + m[0].length;
    if (naiveFrom > start && naiveFrom < end) {
      effectiveMax = path.length - end;
      break;
    }
    if (start >= naiveFrom) break; // tokens run in order; nothing earlier remains
  }
  return {
    value: truncateTailWellFormed(path, effectiveMax),
    truncated,
    // Over the FULL pre-image, never the truncated result: digesting the
    // result would collide exactly as the stored value does, which is the
    // whole bug (issue #50). Computed here so it cannot disagree with
    // `truncated`.
    //
    // `digestPreImage` is REQUIRED, with no default back to `path`. Review
    // asked for that: a default silently digests the escaped path whenever a
    // caller forgets the argument, which is precisely the bug #54 fixes,
    // reintroduced with no compiler signal. There is exactly one production
    // caller and it always knows the raw path, so the parameter costs nothing
    // and forces every future call site into an explicit, reviewable choice.
    // The session layer passes the RAW path (issue #54): `path` here has been
    // through
    // `escapePathUnsafe`, whose target set derives from the
    // Unicode-version-dependent `\p{Default_Ignorable_Code_Point}`, so
    // digesting it would silently re-key every stored digest on an ICU upgrade
    // or a charset widening. The raw pre-image is stable forever, and it is
    // what an operator can reproduce with `sha256sum` against a candidate file.
    digest: skillDropPathDigest(digestPreImage),
  };
}

/**
 * SHA-256 over the full pre-image it is given, first SKILL_DROP_PATH_DIGEST_LEN hex
 * characters. Lowercase because `digest('hex')` is, and the validator pins it.
 */
function skillDropPathDigest(fullPath: string): string {
  return createHash('sha256').update(fullPath, 'utf8').digest('hex').slice(0, SKILL_DROP_PATH_DIGEST_LEN);
}

/**
 * `name` has no truncated-flag counterpart (see SkillDropPayload.pathTruncated's
 * doc comment for why `path` needs one and `name` deliberately doesn't).
 */
export function boundSkillDropName(name: string): string {
  return truncateWellFormed(name, SKILL_DROP_NAME_MAX - 1);
}

/**
 * Write-side bound for `HookEventPayload.reason` (issue #75). Truncation
 * only: redaction is the CAPTURE seam's job (it holds the redactor; telemetry
 * is a leaf and imports no security module), and it must run BEFORE this cut
 * so a secret straddling the boundary becomes a marker, not a fragment.
 * Surrogate-safe like its siblings. Lives here rather than in the capture
 * seam so the module that owns the payload shape owns its cap, and so any
 * future writer of hook-event rows (there is one in src/session/session.ts,
 * writing the runtime's own `fire failed:` message) can reuse it without an
 * upward import.
 */
export function boundHookEventReason(reason: string): string {
  return truncateWellFormed(reason, HOOK_EVENT_REASON_MAX - 1);
}

/** Anchored and length-pinned: a partial match would admit a longer string. */
const PATH_DIGEST_RE = new RegExp(`^[0-9a-f]{${SKILL_DROP_PATH_DIGEST_LEN}}$`);

function isOptionalPathDigest(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && PATH_DIGEST_RE.test(value));
}

function isSkillDropPayload(value: unknown): value is SkillDropPayload {
  return (
    isObject(value) &&
    typeof value.name === 'string' &&
    value.name.length <= SKILL_DROP_NAME_MAX &&
    // path/pathForm coherence (issue #59 round 2, ADR-0031 decision 6).
    // Three admissible shapes and only three: a legacy row (string path, no
    // pathForm — rows predating the field must still read, the pathDigest
    // optionality lesson re-applied), a root-relative row (string path,
    // pathForm 'root-relative'), and a suppressed row (null path, pathForm
    // 'suppressed'). A null path WITHOUT the declared suppressed form is
    // malformed, not legacy, and an unknown pathForm value is rejected the
    // same way a malformed digest is: an unusable signal a consumer would
    // trust is worse than none.
    // The suppressed arm carries the FULL coherence the review demanded of
    // it (issue-#55 style): a suppressed row stores nothing, so it can
    // neither claim truncation nor carry a digest — a digest would attach
    // the row's designated home-prefix carrier to a row whose whole point is
    // refusing to identify the path. Same honest-but-buggy-direct-writer
    // class as the digest-implies-truncated coupling below.
    ((typeof value.path === 'string' &&
      value.path.length <= SKILL_DROP_PATH_MAX &&
      (value.pathForm === undefined || value.pathForm === 'root-relative')) ||
      (value.path === null &&
        value.pathForm === 'suppressed' &&
        value.pathTruncated === false &&
        // DELIBERATELY REDUNDANT with the digest-implies-truncated coupling
        // below (pathTruncated === false on this arm already makes a digest
        // unreachable), so removing this conjunct alone reddens nothing — it
        // stays because the suppressed arm should state its FULL contract
        // locally rather than lean on a conjunct thirty lines away (verify
        // pass, 2026-08-07: recorded as unpinnable-by-design, not missed).
        value.pathDigest === undefined)) &&
    typeof value.pathTruncated === 'boolean' &&
    typeof value.pathHasEscapes === 'boolean' &&
    // OPTIONAL: absent is valid, because rows predating the field must still
    // read — see SkillDropPayload.pathDigest for why requiring it would deny
    // the whole trail. Present-but-malformed is NOT valid: an unusable
    // disambiguator is worse than none, since a consumer would trust it.
    isOptionalPathDigest(value.pathDigest) &&
    // COUPLING, enforced here for the first time (issue #55). A digest is
    // emitted ONLY on truncated rows, so presence is itself the signal that
    // something was discarded — which is what ADR-0011 decision 16,
    // `SkillDropPayload` in types.ts and the README operator note all tell a
    // consumer to key on. The shape check above never looked at
    // `pathTruncated`, so that documented coupling was enforced by nothing.
    // Because isPayloadForType serves record() AND rowToEvent, this conjunct
    // closes both gates at once — they were never asymmetric.
    //
    // WHAT IT BUYS, stated precisely because the first draft of this comment
    // overstated it: COHERENCE between two fields, not the truth of either. A
    // writer that sets `pathTruncated: true` beside a well-formed digest on a
    // short, complete path is still admitted. So this defends against an
    // honest-but-buggy direct writer and against record()/rowToEvent drift —
    // NOT against a forger, who simply lies in two fields instead of one.
    //
    // ONE DIRECTION ONLY, and the asymmetry is load-bearing. `digest present
    // => pathTruncated` is safe to enforce because rows predating the field
    // carry no digest and so are untouched by it. The CONVERSE, `pathTruncated
    // => digest present`, would fail the TRUNCATED pre-field rows, which are
    // digest-less by construction (not every pre-field row — an untruncated
    // one satisfies it), and rowToEvent throws rather than skipping, so
    // query() would deny the ENTIRE trail by exactly the route the optionality
    // bullet measured. Do not "complete" this into a biconditional.
    (value.pathDigest === undefined || value.pathTruncated === true) &&
    typeof value.reason === 'string' &&
    SKILL_DROP_REASON_SET.has(value.reason) &&
    isBoundedStringArray(value.channels, SKILL_DROP_CHANNELS_MAX, SKILL_DROP_CHANNEL_MAX) &&
    isBoundedStringArray(value.ruleIds, SKILL_DROP_RULE_IDS_MAX, SKILL_DROP_RULE_ID_MAX)
  );
}

function isPayloadForType(type: TelemetryEventType, payload: unknown): boolean {
  switch (type) {
    case 'turn-cost':
      return isTurnCostPayload(payload);
    case 'tool-trace':
      return isToolTracePayload(payload);
    case 'hook-event':
      return isHookEventPayload(payload);
    case 'skill-drop':
      return isSkillDropPayload(payload);
    default: {
      // `payload` is unknown here, so the old unguarded fall-through gave NO
      // compile-time protection: a fifth type would have been validated
      // against the hook-event shape. Exhaustiveness is on the DISCRIMINANT,
      // which does type-check — a new type without a case fails to compile.
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

/**
 * Preserves absence: an omitted optional field stays omitted once serialized
 * (JSON.stringify drops undefined), so an old-shape write stays old-shape.
 */
function sanitizeOptional(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  return sanitizeText(value);
}

/**
 * Sanitizes the attacker-influenceable string fields of a validated payload.
 * Returns a new object (immutability: callers' inputs are never mutated).
 */
function sanitizePayload(event: TelemetryEventInput): TelemetryEventInput['payload'] {
  if (event.type === 'turn-cost') {
    const p = event.payload;
    return {
      ...p,
      model: sanitizeText(p.model),
      ruleId: sanitizeText(p.ruleId),
      sdkSessionId: p.sdkSessionId === null ? null : sanitizeText(p.sdkSessionId),
      resultSubtype: p.resultSubtype === null ? null : sanitizeText(p.resultSubtype),
      // Sanitized again here rather than trusting the caller: this store is a
      // public factory, so a direct writer need not have gone through session.ts.
      stopReason: sanitizeOptional(p.stopReason),
      refusalSource: sanitizeOptional(p.refusalSource),
      refusalCategory: sanitizeOptional(p.refusalCategory),
      refusalFallbackModel: sanitizeOptional(p.refusalFallbackModel),
    };
  }
  if (event.type === 'tool-trace') {
    const p = event.payload;
    return {
      ...p,
      tool: sanitizeText(p.tool),
      resultSummary: p.resultSummary === null ? null : sanitizeText(p.resultSummary),
    };
  }
  if (event.type === 'skill-drop') {
    const p = event.payload;
    // sanitizeText is a 1:1 space substitution, so lengths are preserved and
    // the caps validated above still hold after sanitization.
    // Branched rather than a ternary override so each union arm keeps its
    // own path/pathForm pairing under the spread (a suppressed row's path is
    // null and must stay null — ADR-0031; pathForm rides through the spread
    // untouched, a closed union the validator enforced).
    if (p.path === null) {
      return {
        ...p,
        name: sanitizeText(p.name),
        channels: p.channels.map(sanitizeText),
        ruleIds: p.ruleIds.map(sanitizeText),
      };
    }
    return {
      ...p,
      name: sanitizeText(p.name),
      path: sanitizeText(p.path),
      channels: p.channels.map(sanitizeText),
      ruleIds: p.ruleIds.map(sanitizeText),
    };
  }
  const p = event.payload;
  return {
    ...p,
    event: sanitizeText(p.event),
    ...(p.tool !== undefined ? { tool: sanitizeText(p.tool) } : {}),
    ...(p.reason !== undefined ? { reason: sanitizeText(p.reason) } : {}),
  };
}

function assertValidInput(event: TelemetryEventInput): void {
  if (typeof event !== 'object' || event === null) {
    throw new TypeError(`event must be an object, got ${String(event)}`);
  }
  if (!EVENT_TYPE_SET.has(event.type)) {
    throw new TypeError(
      `event.type must be one of ${TELEMETRY_EVENT_TYPES.join('|')}, got ${String(event.type)}`,
    );
  }
  assertValidCorrelationId(event.sessionId, 'event.sessionId');
  assertValidCorrelationId(event.turnId, 'event.turnId');
  if (event.ts !== undefined && (!Number.isFinite(event.ts) || event.ts < 0)) {
    throw new TypeError(`event.ts must be a non-negative finite number when provided, got ${String(event.ts)}`);
  }
  if (!isPayloadForType(event.type, event.payload)) {
    throw new TypeError(`event.payload is not a valid ${event.type} payload`);
  }
}

function assertValidFilter(filter: TelemetryFilter): void {
  if (typeof filter !== 'object' || filter === null) {
    throw new TypeError(`filter must be an object, got ${String(filter)}`);
  }
  if (filter.type !== undefined && !EVENT_TYPE_SET.has(filter.type)) {
    throw new TypeError(
      `filter.type must be one of ${TELEMETRY_EVENT_TYPES.join('|')}, got ${String(filter.type)}`,
    );
  }
  if (filter.sessionId !== undefined && typeof filter.sessionId !== 'string') {
    throw new TypeError(`filter.sessionId must be a string when provided, got ${String(filter.sessionId)}`);
  }
  if (filter.turnId !== undefined && typeof filter.turnId !== 'string') {
    throw new TypeError(`filter.turnId must be a string when provided, got ${String(filter.turnId)}`);
  }
  if (filter.since !== undefined && !Number.isFinite(filter.since)) {
    throw new TypeError(`filter.since must be a finite number when provided, got ${String(filter.since)}`);
  }
  if (filter.until !== undefined && !Number.isFinite(filter.until)) {
    throw new TypeError(`filter.until must be a finite number when provided, got ${String(filter.until)}`);
  }
  if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 0)) {
    throw new TypeError(`filter.limit must be a non-negative integer, got ${String(filter.limit)}`);
  }
  if (filter.order !== undefined && filter.order !== 'asc' && filter.order !== 'desc') {
    throw new TypeError(`filter.order must be 'asc' or 'desc', got ${String(filter.order)}`);
  }
}

function rowToEvent(row: unknown): TelemetryEvent {
  const r = row as EventRow;
  // Total structural validation (memory rowToEntry precedent — never trust a
  // shared DB file blindly): a relaxed migration or another writer could
  // produce a malformed row; fail loud rather than emit a mistyped event.
  if (
    typeof r.id !== 'string' ||
    !EVENT_TYPE_SET.has(r.type) ||
    typeof r.session_id !== 'string' ||
    typeof r.turn_id !== 'string' ||
    typeof r.ts !== 'number' ||
    typeof r.payload !== 'string'
  ) {
    throw new Error('telemetry_events row failed structural validation');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    throw new Error('telemetry_events row failed structural validation: payload is not JSON');
  }
  const type = r.type as TelemetryEventType;
  if (!isPayloadForType(type, payload)) {
    throw new Error(`telemetry_events row failed structural validation: payload mismatches type '${type}'`);
  }
  return {
    id: r.id,
    type,
    sessionId: r.session_id,
    turnId: r.turn_id,
    ts: r.ts,
    payload,
  } as TelemetryEvent;
}

function telemetryError(cause: unknown): TelemetryError {
  const code = isObject(cause) && typeof cause.code === 'string' ? cause.code : '';
  const kind: TelemetryError['kind'] = code.startsWith('SQLITE_CONSTRAINT') ? 'constraint' : 'db';
  const message = cause instanceof Error ? cause.message : String(cause);
  return { kind, message };
}

function buildQuery(filter: TelemetryFilter): { sql: string; params: Record<string, unknown> } {
  const clauses: string[] = ['1 = 1'];
  const params: Record<string, unknown> = {};
  if (filter.sessionId !== undefined) {
    clauses.push('session_id = @sessionId');
    params.sessionId = filter.sessionId;
  }
  if (filter.turnId !== undefined) {
    clauses.push('turn_id = @turnId');
    params.turnId = filter.turnId;
  }
  if (filter.type !== undefined) {
    clauses.push('type = @type');
    params.type = filter.type;
  }
  if (filter.since !== undefined) {
    clauses.push('ts >= @since');
    params.since = filter.since;
  }
  if (filter.until !== undefined) {
    clauses.push('ts < @until');
    params.until = filter.until;
  }
  // Default asc: telemetry reads are trace reconstructions, oldest first.
  // rowid tiebreak gives same-ms events a total, deterministic order.
  const direction = filter.order === 'desc' ? 'DESC' : 'ASC';
  let sql = `SELECT * FROM telemetry_events WHERE ${clauses.join(' AND ')} ORDER BY ts ${direction}, rowid ${direction}`;
  if (filter.limit !== undefined) {
    sql += ' LIMIT @limit';
    params.limit = filter.limit;
  }
  return { sql: `${sql};`, params };
}

/**
 * Telemetry store over an injected better-sqlite3 connection (ADR-0011;
 * substrate per ADR-0004). Runs migrations on construction so an arbitrary
 * injected connection is self-sufficient, mirroring memory's ensureSchema
 * contract. Caller owns the connection lifecycle.
 */
export function createTelemetryStore(db: Database.Database): TelemetryStore {
  runMigrations(db, MIGRATIONS);
  const insert = db.prepare(INSERT_SQL);
  const selectById = db.prepare('SELECT * FROM telemetry_events WHERE id = @id;');

  /**
   * Insert and read-back as ONE transaction, defined once and reused (per
   * better-sqlite3's guidance) rather than wrapped fresh on every call.
   *
   * rowToEvent's read-back re-validation can throw on a row that passed
   * isPayloadForType in memory but serializes differently — the sparse-array
   * case above is the one this task found and closed pre-write, but that fix
   * is per-field; this closes the CLASS for every field, present and future.
   * Before this wrapped the two statements, that throw happened AFTER
   * insert.run had already committed (better-sqlite3 auto-commits a bare
   * statement outside an explicit transaction), so record() returned
   * `ok: false` while the bad row stayed in the table — and recordTelemetry
   * downgrades `ok: false` to one stderr warning, so the corrupted row (and,
   * via store.query()'s unconditional rowToEvent map, every OTHER row too,
   * since one throwing row fails the whole query) went undetected until an
   * operator ran `telemetry export` weeks later. Wrapping means `ok: false`
   * now always means "nothing was written."
   *
   * COST, named rather than left implicit: every write now pays one extra
   * SELECT, a `JSON.parse`, and a full structural re-validation
   * (`isPayloadForType` again, via `rowToEvent`) beyond the INSERT itself,
   * plus the transaction's own BEGIN/COMMIT (or ROLLBACK) overhead. Accepted
   * trade: this defends against the row and its in-memory source diverging at
   * the DB layer — another writer, a trigger, a relaxed migration — not
   * against the write-path validator (`assertValidInput`), which already ran
   * before `insertAndReadBack` is ever called. That divergence class has now
   * bitten this file twice (the sparse-array case above, then a NaN
   * handlerIndex in isHookEventPayload) in two review rounds, which is why
   * the cost is paid unconditionally rather than only for skill-drop.
   */
  const insertAndReadBack = db.transaction(
    (row: {
      id: string;
      type: TelemetryEventInput['type'];
      sessionId: string;
      turnId: string;
      ts: number;
      payload: string;
    }): TelemetryEvent => {
      insert.run(row);
      const stored = selectById.get({ id: row.id });
      return rowToEvent(stored);
    },
  );

  function record(event: TelemetryEventInput): RecordResult {
    assertValidInput(event);
    const row = {
      id: crypto.randomUUID(),
      type: event.type,
      sessionId: event.sessionId,
      turnId: event.turnId,
      ts: event.ts ?? Date.now(),
      payload: JSON.stringify(sanitizePayload(event)),
    };
    try {
      const value = insertAndReadBack(row);
      return { ok: true, value };
    } catch (cause: unknown) {
      return { ok: false, error: telemetryError(cause) };
    }
  }

  function query(filter: TelemetryFilter = {}): TelemetryEvent[] {
    assertValidFilter(filter);
    const built = buildQuery(filter);
    return db.prepare(built.sql).all(built.params).map(rowToEvent);
  }

  return { record, query };
}
