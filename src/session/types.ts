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
}

export type SdkMessage =
  | SdkSystemMessage
  | SdkAssistantMessage
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

export interface SessionResult {
  resultText: string | null;
  /** SDK result subtype, e.g. 'success' or 'error_max_turns'; null if no result message arrived. */
  resultSubtype: string | null;
  /** SDK session id when the stream provided one, else the harness-generated id. */
  sessionId: string;
  modelChoice: ModelChoice;
  usage: SdkUsage | null;
  costUsd: number | null;
  numTurns: number | null;
  denied: DeniedToolCall[];
  memoryEntryId: string | null;
  skillErrors: SkillError[];
}

export interface Session {
  run(prompt: string): Promise<SessionResult>;
}

export type { FireResult, HookEvent, HookPayloadMap };
