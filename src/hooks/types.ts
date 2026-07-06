export type HookEvent = 'pre-tool' | 'post-tool' | 'session-start' | 'stop';

export interface PreToolPayload {
  event: 'pre-tool';
  tool: string;
  args: unknown;
  /** Owned by security/secrets-scanner; typed `unknown` to avoid a hooks→security import. */
  redactions: unknown;
}

export interface PostToolPayload {
  event: 'post-tool';
  tool: string;
  /**
   * The RAW tool result — NOT redacted (hooks may need the real content to
   * act, and injection detection needs raw text). A post-tool handler MUST NOT
   * persist or forward `result`/`scan` to an external/retained sink without
   * redacting first: unlike telemetry (which S-2 redacts), this field and
   * `scan.excerpts` can carry secret bytes. See ADR-0013 §9.
   */
  result: unknown;
  /** Owned by security/injection-scanner; typed `unknown` to avoid a hooks→security import. Excerpts are raw — see `result`. */
  scan: unknown;
  /** Owned by security/secrets-scanner; typed `unknown` for the same reason. Leak-safe (offsets only). */
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
  /**
   * Index of the throwing handler within this fire's snapshot of currently
   * active handlers. Snapshot-relative, not a stable per-handler id: after an
   * unregister, the same handler may report a different index on a later fire.
   */
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
      /** Snapshot-relative index of the denying handler (see HookHandlerError.handlerIndex). */
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
