export type TelemetryEventType = 'turn-cost' | 'tool-trace' | 'hook-event';

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
}

export interface ToolTracePayload {
  tool: string;
  phase: 'post-tool';
  ok: boolean;
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
  | (TelemetryEventBase & { type: 'hook-event'; payload: HookEventPayload });

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
  | (TelemetryInputBase & { type: 'hook-event'; payload: HookEventPayload });

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
