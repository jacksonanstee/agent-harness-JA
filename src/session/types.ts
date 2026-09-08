import type { ModelChoice, TaskDescriptor } from '../router/index.js';
import type { FireResult, HookEvent, HookPayloadMap, HookRuntime } from '../hooks/index.js';
import type { MemoryStore } from '../memory/index.js';
import type { LoadResult, SkillError } from '../skills/index.js';
import type { TelemetryStore } from '../telemetry/index.js';
import type { RedactResult, ScanResult } from '../security/index.js';

/**
 * Minimal structural view of the Claude Agent SDK surface the session uses.
 * The SDK's own types are not imported here so tests can inject plain fakes
 * and the harness only depends on the fields it actually reads.
 */

export interface SdkTextBlock {
  type: 'text';
  text: string;
}

export interface SdkSystemMessage {
  type: 'system';
  subtype: string;
  session_id?: string;
}

export interface SdkAssistantMessage {
  type: 'assistant';
  message: { content: unknown[] };
}

export interface SdkUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface SdkResultMessage {
  type: 'result';
  subtype: string;
  result?: string;
  session_id: string;
  /** Declared optional (unlike the SDK) so drift yields null, not undefined-typed-as-number. */
  num_turns?: number;
  total_cost_usd?: number;
  usage?: SdkUsage;
  /**
   * Why the model stopped. The SDK declares this on BOTH result variants
   * (success and error) as an open `string | null`; declared optional here so
   * drift yields null rather than undefined-typed-as-string. `'refusal'` is the
   * value this harness branches on (ADR-0025).
   */
  stop_reason?: string | null;
}

/**
 * The SDK's two refusal banners (ADR-0025). `model_refusal_no_fallback` ends the
 * turn as an error; `model_refusal_fallback` means the turn was retried on
 * `fallback_model` and the swap was made persistent for the session, so the
 * answering model is NOT the one the router chose.
 *
 * Both are documented by the SDK as absent from older CLIs, which is why
 * `SdkResultMessage.stop_reason` is read as a second, independent channel.
 * `api_refusal_explanation` and the banners' required `content` field are
 * deliberately not modelled: both are model-authored prose (the SDK calls the
 * explanation unstable, display-only) and capturing either would open a new
 * untrusted channel into two retained sinks. ADR-0025 decision 2.
 *
 * `original_model` is declared but deliberately unread, which is a narrow
 * exception to ADR-0010's "only the fields the harness reads": it is part of the
 * banner contract this type documents, and the test fixtures set it for
 * fidelity. The harness does NOT reconcile it against `modelChoice.model`; the
 * answering model is reported via `fallback_model` instead.
 */
export interface SdkModelRefusalMessage {
  type: 'system';
  subtype: 'model_refusal_no_fallback' | 'model_refusal_fallback';
  original_model?: string;
  fallback_model?: string;
  /** Open string: new categories ship on the wire ahead of schema updates. */
  api_refusal_category?: string | null;
  session_id?: string;
}

/**
 * Minimal structural view of the SDK's `SDKUserMessage` (sdk.d.ts:4292), read
 * by the in-band rewrite verifier (issue #84, D4). Only the fields the harness
 * reads are modelled: the message envelope (whose `content` carries the
 * `tool_result` blocks) and `parent_tool_use_id`. `content` is `unknown`
 * because the SDK types it `string | Array<ContentBlockParam>` and the verifier
 * walks it structurally. Parity-pinned both directions in sdk-types.test.ts.
 */
export interface SdkUserMessage {
  type: 'user';
  message: { content: unknown };
  parent_tool_use_id?: string | null;
}

export type SdkMessage =
  | SdkSystemMessage
  | SdkAssistantMessage
  | SdkModelRefusalMessage
  | SdkResultMessage
  | SdkUserMessage
  | { type: string };

/**
 * Structural views of the SDK's tool-hook inputs (ADR-0010 decision 2: minimal
 * views, no SDK import in this layer). The field names MUST match the installed
 * SDK's `PreToolUseHookInput` / `PostToolUseHookInput`; `src/session/sdk-types.test.ts`
 * pins that parity at compile time. In particular the post-tool result arrives as
 * `tool_response` (a `tool_output` field the SDK never sends silently blinded the
 * whole post-tool security path, issue #83).
 */
export interface SdkPreToolUseInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_use_id?: string;
  session_id?: string;
}

export interface SdkPostToolUseInput {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id?: string;
  session_id?: string;
}

/**
 * Structural view of the SDK's `PostToolUseFailureHookInput` (sdk.d.ts:2146),
 * fired instead of PostToolUse when a tool call FAILS (issue #84, D8, S-1). The
 * model receives `error` as the tool result; the harness scans and (data-plane)
 * redacts it, and annotates on a verdict, but CANNOT rewrite it — the failure
 * hook has no `updatedToolOutput` channel. Parity-pinned like the other two
 * inputs.
 */
export interface SdkPostToolUseFailureInput {
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;
  tool_input: unknown;
  tool_use_id?: string;
  error: string;
  is_interrupt?: boolean;
  session_id?: string;
}

export type SdkHookInput =
  | SdkPreToolUseInput
  | SdkPostToolUseInput
  | SdkPostToolUseFailureInput;

export interface SdkPreToolDenyOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

/**
 * Post-tool rewrite output (issue #84, D1/D2). On a SUCCESSFUL call either
 * channel may fire: `updatedToolOutput` replaces the model-facing copy (secret
 * redaction), `additionalContext` adds the harness injection notice. Written as
 * a union requiring AT LEAST ONE of the two keys, because the harness never
 * returns an identity rewrite — every returned rewrite is a chance for the SDK
 * to silently drop one (spike p2/p3). `updatedToolOutput: unknown` still admits
 * `undefined` as a value, so "unspellable" is not claimed (G-13).
 */
export type SdkPostToolRewriteOutput = {
  hookSpecificOutput:
    | { hookEventName: 'PostToolUse'; updatedToolOutput: unknown; additionalContext?: string }
    | { hookEventName: 'PostToolUse'; updatedToolOutput?: unknown; additionalContext: string };
};

/**
 * Failure-hook annotation output (issue #84, D8). A failed call has NO rewrite
 * channel — `PostToolUseFailureHookSpecificOutput` (sdk.d.ts:2159) declares
 * `additionalContext` only — so the harness can annotate but never rewrite it.
 */
export type SdkPostToolFailureAnnotateOutput = {
  hookSpecificOutput: { hookEventName: 'PostToolUseFailure'; additionalContext: string };
};

// Per-event output unions (D6, G-8). Each event's callback returns exactly the
// outputs valid for that event, plus the empty no-op.
export type SdkPreToolOutput = SdkPreToolDenyOutput | { hookSpecificOutput?: undefined };
export type SdkPostToolOutput = SdkPostToolRewriteOutput | { hookSpecificOutput?: undefined };
export type SdkPostToolFailureOutput =
  | SdkPostToolFailureAnnotateOutput
  | { hookSpecificOutput?: undefined };

/**
 * The bare/default hook output, kept SOURCE-COMPATIBLE with the pre-#84
 * definition (deny-or-empty). A value typed by the BARE `SdkHookCallback` must
 * still narrow `out.hookSpecificOutput?.permissionDecision` (U-8): three sites
 * cast `matcher.hooks as SdkHookCallback[]` and read it. A union that also
 * carried the rewrite/annotate arms would make `.permissionDecision`
 * inaccessible (only the deny arm declares it), so those members live on the
 * per-event outputs above, never here. `SdkHookOutputFor<SdkHookInput>` resolves
 * to this type.
 */
export type SdkHookOutput = SdkPreToolOutput;

/**
 * Maps a hook INPUT event to its valid output (D6). Non-distributive
 * (`[I] extends [...]`) so the BARE case (`I = SdkHookInput`, the whole union)
 * falls through to `SdkHookOutput` — the widest output that still narrows
 * `permissionDecision` (U-8) — rather than distributing member by member.
 */
export type SdkHookOutputFor<I extends SdkHookInput> = [I] extends [SdkPreToolUseInput]
  ? SdkPreToolOutput
  : [I] extends [SdkPostToolUseInput]
    ? SdkPostToolOutput
    : [I] extends [SdkPostToolUseFailureInput]
      ? SdkPostToolFailureOutput
      : SdkHookOutput;

export type SdkHookCallback<I extends SdkHookInput = SdkHookInput> = (
  input: I,
  toolUseID: string | undefined,
  context: { signal: AbortSignal },
) => Promise<SdkHookOutputFor<I>>;

export interface SdkHookMatcher<I extends SdkHookInput = SdkHookInput> {
  hooks: SdkHookCallback<I>[];
}

export interface QueryOptions {
  model?: string;
  systemPrompt?: string;
  maxTurns?: number;
  // Typed per event so a callback that reads a post-only field (`tool_response`)
  // cannot be registered under `PreToolUse`, and so each callback returns only
  // the outputs valid for its event (D6). `PostToolUseFailure` is the failure
  // seam (D8): the SDK routes a failed call there, never to PostToolUse (S-1).
  hooks?: {
    PreToolUse?: SdkHookMatcher<SdkPreToolUseInput>[];
    PostToolUse?: SdkHookMatcher<SdkPostToolUseInput>[];
    PostToolUseFailure?: SdkHookMatcher<SdkPostToolUseFailureInput>[];
  };
}

export type QueryFn = (args: {
  prompt: string;
  options?: QueryOptions;
}) => AsyncIterable<SdkMessage>;

export interface SessionDeps {
  query: QueryFn;
  hooks: HookRuntime;
  memory: MemoryStore;
  loadSkills: (dir: string) => LoadResult;
  route: (descriptor: TaskDescriptor) => ModelChoice;
  /** Optional durable metrics sink (ADR-0011). Failures warn, never abort. */
  telemetry?: Pick<TelemetryStore, 'record'>;
  /**
   * Optional prompt-injection scanner (S-1). Runs on each tool output (and, per
   * issue #84 D8, on a FAILED call's error text); the result feeds the
   * post-tool hook's `scan` field. On a `block`/`ask` verdict the harness now
   * ANNOTATES the model-facing copy with a plain-language note via the SDK's
   * `additionalContext` channel (issue #84, D2) — nothing is withheld
   * (withholding is #96). The INPUT side stays observe-and-log (D3). Failures
   * warn, never abort, and add no annotation (fail open, ADR-0026 decision 7).
   */
  scanInjection?: (text: string) => ScanResult;
  /**
   * Optional secret redactor (S-2). Applied to tool inputs (pre-tool,
   * observe-only, D3), tool outputs (both the telemetry row AND, per issue #84
   * D1, the model-facing copy rewritten in place through the SDK's
   * `updatedToolOutput` channel — a SUCCESSFUL call only; a failed call's error
   * text is redacted for telemetry but cannot be rewritten, D8), the memory
   * summary (`prompt`, `resultText`, `denied[]` reasons) and each assistant text
   * block before `onText` (issue #91). When absent, none of those are redacted:
   * both CLI composition roots inject `redact`; a library caller must too.
   * Failures fail CLOSED per leaf/sink to the `[REDACTION FAILED]` sentinel,
   * never the raw text.
   */
  redactSecrets?: (text: string) => RedactResult;
}

export interface SessionConfig {
  /** Directory to load skills from, or null to run with no skills at all —
   *  loading is skipped entirely: no read, no skill-load warnings. */
  skillsDir: string | null;
  descriptor?: TaskDescriptor;
  maxTurns?: number;
  /**
   * Streams assistant text as it arrives, after secret redaction (S-2) when
   * `redactSecrets` is injected: fail-closed to `[REDACTION FAILED]` on a
   * redactor throw or non-string, never the raw text (issue #91).
   */
  onText?: (text: string) => void;
  /** Non-fatal problems: skill load errors, memory write failure, hook errors. */
  onWarning?: (message: string) => void;
  /** Injected clock (epoch ms) for deterministic tests. */
  now?: () => number;
  /** Injected id source for the harness-side session id. */
  generateId?: () => string;
  /**
   * Turn-scoped telemetry correlation id. The composition root (cli) supplies
   * it so hook-sink events and session events share one id; defaults to an
   * independent randomUUID (never `generateId` — a constant-closure
   * generateId must not collapse turnId onto the session id).
   */
  turnId?: string;
  /**
   * Injected source for the per-run skill-section delimiter nonce (ADR-0028,
   * issue #45). Tests inject a constant to keep byte-exact prompt assertions
   * readable.
   *
   * Deliberately SEPARATE from `generateId`, for the same reason `turnId` is:
   * the CLI injects a constant-closure `generateId`, and reusing it here would
   * make the delimiter a fixed, publishable string — which is the entire
   * property the nonce exists to have. A caller who overrides this owns that
   * choice; the default is a fresh 64-bit value per run from `randomBytes`.
   */
  generateNonce?: () => string;
}

export interface DeniedToolCall {
  tool: string;
  reason: string;
}

/**
 * Which channel the refusal was detected on. `system-event` is the richer one
 * (it can carry a category and a fallback model); `result-stop-reason` is the
 * fallback channel that still works on CLIs old enough to omit the banner.
 */
export type RefusalSource = 'result-stop-reason' | 'system-event';

/**
 * A model-side refusal, surfaced so a consumer can tell it apart from an empty
 * success (ADR-0025, residual risk R-14).
 */
export interface SessionRefusal {
  source: RefusalSource;
  /** Refusal category ('cyber', 'bio', …), sanitized at capture. Null when the channel carried none. */
  category: string | null;
  /**
   * The model the turn was retried on, when the SDK reported a persistent
   * fallback swap. Non-null here means the answer did NOT come from
   * `SessionResult.modelChoice.model` (ADR-0025 §4).
   */
  fallbackModel: string | null;
}

export interface SessionResult {
  /**
   * The SDK's final result text, RAW: not redacted here. The memory copy is
   * redacted at the write and each `onText` block at emission (issue #91); a
   * caller that persists or prints this field must run it through `redact`.
   */
  resultText: string | null;
  /** SDK result subtype, e.g. 'success' or 'error_max_turns'; null if no result message arrived. */
  resultSubtype: string | null;
  /** Raw SDK `stop_reason` passthrough; null if absent or no result message arrived. */
  stopReason: string | null;
  /**
   * Non-null when the model refused. Distinguishing a refusal from an empty
   * success is the whole point (ADR-0025): `resultText` stays null on a refusal
   * and the banner's prose is never laundered into it. Note that a *successful*
   * fallback still reports `resultSubtype: 'success'` with a real answer, so
   * `refusal !== null` does not by itself mean the run failed.
   */
  refusal: SessionRefusal | null;
  /** SDK session id when the stream provided one, else the harness-generated id. */
  sessionId: string;
  modelChoice: ModelChoice;
  usage: SdkUsage | null;
  costUsd: number | null;
  numTurns: number | null;
  denied: DeniedToolCall[];
  memoryEntryId: string | null;
  skillErrors: SkillError[];
  /**
   * Skills that loaded but were kept OUT of the system prompt (ADR-0026).
   * Reported structurally, not only as a warning, so an eval oracle can
   * assert enforcement without scraping stderr. A dropped skill is still
   * present in the loader's result — the drop is a prompt-assembly decision,
   * not a load failure, which is why it is not a `SkillError`.
   */
  droppedSkills: DroppedSkill[];
  /**
   * Model-facing secret-redaction rewrites of SUCCESSFUL tool output (issue
   * #84, D1/D5), one per call that carried a detectable secret, failed a leaf
   * closed, was oversized, or was skipped/unrewritten. Reported structurally so
   * an eval oracle asserts enforcement without scraping stderr.
   *
   * `outputRewrites.length === 0` means "no successful call carried a detectable
   * secret in a rewritable leaf" — NOT "the model saw no secret" (U-3, U-17). A
   * `leaked`/`unobserved`/`unrewritten` row, or ANY failed call (which cannot be
   * rewritten, D8), each mean the model may have seen a raw secret. The input
   * side stays observe-only (D3).
   */
  outputRewrites: OutputRewrite[];
  /**
   * Injection-scanner verdicts surfaced to the model as a note (issue #84,
   * D2/D5): `block`/`ask` on a successful call (phase 'post-tool') or a failed
   * call (phase 'post-tool-failure'). Nothing is withheld; withholding is #96.
   */
  outputAnnotations: OutputAnnotation[];
}

/** Outcome of a model-facing tool-output rewrite (issue #84, D4/D5). */
export type OutputRewriteOutcome =
  /** A `[REDACTED:<id>]` marker was observed in the model's copy, no raw span. */
  | 'applied'
  /** A raw secret span survived into the model's copy (verifier alarm). */
  | 'leaked'
  /** The rewrite could not be confirmed in band (no user message, ambiguous, unwalkable). */
  | 'unobserved'
  /** The telemetry pass found a secret the per-leaf model pass did not (blind spot, G-9). */
  | 'unrewritten'
  /** Non-JSON or over-bound output: the walk was skipped, output left raw (D1). */
  | 'skipped'
  /** A leaf redaction failed closed to the sentinel and the blackout was delivered (A-1). */
  | 'failed-closed';

/**
 * A model-facing rewrite decision (issue #84). `tool_use_id` is the SDK's id
 * when it arrived, else null. `findings` is the per-leaf model-pass count;
 * `truncated` is true when an oversized leaf carried the redactor's
 * `[REDACTED:oversized-input]` marker.
 */
export interface OutputRewrite {
  tool: string;
  tool_use_id: string | null;
  findings: number;
  truncated: boolean;
  outcome: OutputRewriteOutcome;
}

/** A model-facing injection-verdict annotation (issue #84, D2/D5). */
export interface OutputAnnotation {
  tool: string;
  tool_use_id: string | null;
  phase: 'post-tool' | 'post-tool-failure';
  verdict: 'block' | 'ask';
  ruleIds: string[];
}

/** Why a loaded skill did not reach the system prompt. */
export type SkillDropReason =
  /** Injection scan returned a high-confidence `block` on its description or body. */
  | 'injection-block'
  /** Aggregate skill budget exhausted before this skill (pre-existing behaviour). */
  | 'prompt-budget';

/**
 * Which scan point (ADR-0026) blocked a skill. `session.ts` is the only author
 * of these literals, so the union lives here at the origin, mirroring its
 * sibling `SkillDropReason` above. Telemetry's structural mirror
 * (`SkillDropPayload.channels`, src/telemetry/types.ts) stays `string[]`:
 * narrowing the origin type does not obligate every structural mirror to
 * narrow too.
 *
 * ADDING A MEMBER HAS TWO CONSEQUENCES — one the compiler catches, one it
 * cannot:
 *
 * 1. `SKILL_DROP_CHANNEL_TEXT` (session.ts) is a `Record` over this union, so
 *    a new member is a COMPILE ERROR at the scan site. Deliberate: the array
 *    literal it replaced compiled clean and left the new channel unscanned.
 * 2. `SKILL_DROP_CHANNELS_MAX` (src/telemetry/types.ts) hand-copies this
 *    union's CARDINALITY, and no compiler can see that link — layering forbids
 *    telemetry importing session, so nothing derives one from the other. Leave
 *    it stale and a drop naming the new channel exceeds the cap, fails
 *    `isSkillDropPayload`, throws in `assertValidInput`, and `recordTelemetry`
 *    downgrades it to a single stderr warning: the row is gone and the suite
 *    is green. `session.test.ts` re-derives the equality — bump the cap in the
 *    same commit as the union.
 *
 * Member ORDER is observable: it is the scan order, the order of
 * `DroppedSkill.channels`, and the order the drop warning joins them in.
 */
export type SkillDropChannel = 'description' | 'body' | 'assembled section';

export interface DroppedSkill {
  name: string;
  /**
   * Absolute source path, run through `escapePathUnsafe` (src/internal/
   * sanitize.ts) rather than deleted/space-substituted like `name`. Carried
   * because skill NAMES are not unique — the loader applies no cross-file
   * uniqueness constraint, so two files may both declare `name: helper` and
   * only the path disambiguates them. Escaping, not stripping, matters here
   * specifically because of that: an invisible character renders as nothing
   * whether it is present or deleted, so deleting it buys no visibility
   * while destroying the one thing this field exists for — a hostile
   * `/skills/he<U+200B>lper.md` would otherwise collapse onto a benign
   * `/skills/helper.md` and misdirect an operator, following the drop
   * warning's own remediation instruction, to edit the wrong file (round-1
   * fix, issue #46 Finding 1).
   */
  path: string;
  /**
   * OUT-OF-BAND marker: true when the RAW path carried at least one
   * control/bidi/invisible character that `escapePathUnsafe` escaped.
   * It describes the PRE-IMAGE, not the `path` string above. Mirrors
   * SkillDropPayload.pathHasEscapes (telemetry/types.ts), which is the same
   * flag under the same contract. See `escapePathUnsafe`'s doc comment for
   * why escaping (not deletion) is the right transform for this field.
   *
   * Two things a consumer must not get wrong:
   *
   * Backslash-doubling alone does NOT set it. Doubling is lossless
   * formatting applied unconditionally so that a file literally named
   * `\u{200B}` cannot forge a real escape; it neutralises nothing, and on
   * win32 every separator doubles, so flagging those would make the signal
   * useless. `escapePathUnsafe('C:\Users\f.md')` reports `escaped: false`
   * (asserted in sanitize.test.ts).
   *
   * Do NOT re-derive it by scanning `path` for `\u{`. Besides the forgery
   * problem (a legitimately named file can contain that literal text), the
   * stored path is truncated AFTER escaping and `boundSkillDropPath` drops a
   * straddling token whole, so a stored path can legitimately contain zero
   * escape tokens while this flag is correctly true. A re-derived value
   * would silently disagree with the recorded one.
   */
  pathHasEscapes: boolean;
  reason: SkillDropReason;
  /**
   * Which scanned channels blocked the skill; empty for 'prompt-budget'.
   * Carried because the stderr warning names the channel and, without this,
   * the durable telemetry record would be strictly LESS informative than the
   * transient warning it exists to replace (issue #46).
   */
  channels: SkillDropChannel[];
  /**
   * Rule ids that triggered the block, cleaned at capture (`cleanSkillText`,
   * session.ts) — unlike `path`, a rule id identifies nothing on disk, so
   * deletion is the right transform here, the same as for `name`. Empty for
   * `prompt-budget`. `scanInjection` is caller-supplied (`SessionDeps`), not
   * the shipped rule table, so a rule id is untrusted input like any other.
   */
  ruleIds: string[];
}

export interface Session {
  run(prompt: string): Promise<SessionResult>;
}

export type { FireResult, HookEvent, HookPayloadMap };
