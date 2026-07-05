export type HookEvent = 'pre-tool' | 'post-tool' | 'session-start' | 'stop';

export interface PreToolPayload {
  event: 'pre-tool';
  tool: string;
  args: unknown;
}

export interface PostToolPayload {
  event: 'post-tool';
  tool: string;
  result: unknown;
  /** Owned by security/injection-scanner; typed `unknown` to avoid a hooks→security import. */
  scan: unknown;
  /** Owned by security/secrets-scanner; typed `unknown` for the same reason. */
  redactions: unknown;
}

export interface SessionStartPayload {
  event: 'session-start';
  sessionId: string;
  /** epoch ms */
  startedAt: number;
}

export interface StopPayload {
  event: 'stop';
  sessionId: string;
  /** epoch ms */
  stoppedAt: number;
}

export interface HookPayloadMap {
  'pre-tool': PreToolPayload;
  'post-tool': PostToolPayload;
  'session-start': SessionStartPayload;
  stop: StopPayload;
}

export type HookPayload = HookPayloadMap[HookEvent];

export type HookHandler<E extends HookEvent = HookEvent> = (
  payload: Readonly<HookPayloadMap[E]>,
) => void | Promise<void>;

export type Unsubscribe = () => void;

export interface HookHandlerError {
  /** Registration-order index of the throwing handler. */
  handlerIndex: number;
  /** Sanitized message. */
  reason: string;
  /** Original thrown value, unmodified. */
  error: unknown;
}

interface FireResultBase {
  event: HookEvent;
  /** Handlers invoked, including one that denied. */
  handlersFired: number;
  /** Isolated, non-deny throws (post-tool / session-start / stop). */
  errors: HookHandlerError[];
}

export type FireResult =
  | (FireResultBase & { denied: false })
  | (FireResultBase & {
      denied: true;
      /** Registration-order index of the denying handler. */
      deniedBy: number;
      /** Sanitized denial message. */
      reason: string;
      /** Original thrown value (HookDenial or other). */
      error: unknown;
    });

/**
 * Injected telemetry seam. Default is a no-op. A later telemetry module
 * supplies an adapter; hooks never import telemetry.
 */
export type HookEventRecord =
  | {
      kind: 'denied-by-hook';
      event: 'pre-tool';
      handlerIndex: number;
      tool: string;
      reason: string;
    }
  | { kind: 'hook-error'; event: HookEvent; handlerIndex: number; reason: string }
  | { kind: 'hook-fired'; event: HookEvent; handlersFired: number };

export type HookSink = (record: HookEventRecord) => void;

export interface HookRuntimeOptions {
  onEvent?: HookSink;
}

export interface HookRuntime {
  register<E extends HookEvent>(event: E, handler: HookHandler<E>): Unsubscribe;
  fire<E extends HookEvent>(event: E, payload: HookPayloadMap[E]): Promise<FireResult>;
}
