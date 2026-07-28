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

export type SdkMessage =
  | SdkSystemMessage
  | SdkAssistantMessage
  | SdkModelRefusalMessage
  | SdkResultMessage
  | { type: string };

export interface SdkHookInput {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  session_id?: string;
}

export interface SdkPreToolDenyOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

export type SdkHookOutput = SdkPreToolDenyOutput | { hookSpecificOutput?: undefined };

export type SdkHookCallback = (
  input: SdkHookInput,
  toolUseID: string | undefined,
  context: { signal: AbortSignal },
) => Promise<SdkHookOutput>;

export interface SdkHookMatcher {
  hooks: SdkHookCallback[];
}

export interface QueryOptions {
  model?: string;
  systemPrompt?: string;
  maxTurns?: number;
  hooks?: {
    PreToolUse?: SdkHookMatcher[];
    PostToolUse?: SdkHookMatcher[];
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
   * Optional prompt-injection scanner (S-1). Runs on each tool output; the
   * result feeds the post-tool hook's `scan` field. Failures warn, never
   * abort. Enforcement (redact/drop) composes with S-2, not here.
   */
  scanInjection?: (text: string) => ScanResult;
  /**
   * Optional secret redactor (S-2). Runs on tool inputs (pre-tool) and outputs
   * (pre-telemetry, so secrets never reach the telemetry store); findings feed
   * the hook `redactions` field. Failures warn, never abort; on failure the
   * telemetry text is fail-closed to a sentinel, never the raw output.
   */
  redactSecrets?: (text: string) => RedactResult;
}

export interface SessionConfig {
  /** Directory to load skills from, or null to run with no skills at all —
   *  loading is skipped entirely: no read, no skill-load warnings. */
  skillsDir: string | null;
  descriptor?: TaskDescriptor;
  maxTurns?: number;
  /** Streams assistant text as it arrives. */
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
}

/** Why a loaded skill did not reach the system prompt. */
export type SkillDropReason =
  /** Injection scan returned a high-confidence `block` on its description or body. */
  | 'injection-block'
  /** Aggregate skill budget exhausted before this skill (pre-existing behaviour). */
  | 'prompt-budget';

export interface DroppedSkill {
  name: string;
  /**
   * Absolute source path. Carried because skill NAMES are not unique — the
   * loader applies no cross-file uniqueness constraint, so two files may
   * both declare `name: helper` and only the path disambiguates them.
   */
  path: string;
  reason: SkillDropReason;
  /** Rule ids that triggered the block; empty for `prompt-budget`. */
  ruleIds: string[];
}

export interface Session {
  run(prompt: string): Promise<SessionResult>;
}

export type { FireResult, HookEvent, HookPayloadMap };
