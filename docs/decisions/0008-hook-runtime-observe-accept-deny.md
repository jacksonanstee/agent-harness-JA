# ADR-0008: Hook runtime — observe + accept/deny only in v1.0

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Jackson Anstee
- **Related requirements:** [H-4](../../process/01-requirements.md)
- **Related:** [architecture.md §harness/hooks](../architecture.md), open question #3

## Context

`harness/hooks` provides event-driven extension points around tool execution and session lifecycle. Its public API is locked by architecture.md:

- `register(event: HookEvent, handler: HookHandler)`
- `fire(event: HookEvent, payload: HookPayload)`
- Events: `pre-tool`, `post-tool`, `session-start`, `stop`.
- Handlers are async, sequential, and can short-circuit: a pre-tool hook can deny execution by throwing a typed error.
- The module depends on nothing in this repo — it is the strictest node in the dependency graph — and should add zero runtime dependencies.

Open architectural question #3 (architecture.md) is the decision this ADR exists to settle:

> Should hooks be allowed to mutate tool arguments / results, or only observe + accept/deny?

This is the hard gate: no hook runtime code is written before this ADR lands. Two cross-cutting constraints shape the answer.

**Throwing is inverted here.** Everywhere else in the harness a throw is a programmer error and tagged results are the norm. In the hook layer, architecture.md makes a throw an *intentional control-flow primitive*: "Hook handlers that throw deny tool execution and record a `denied-by-hook` telemetry event." A deny is expected behaviour, not a bug.

**Telemetry is not built yet.** `denied-by-hook` is a named telemetry event kind, but the telemetry module is a Week 2 deliverable, and hooks depends on nothing. Hooks cannot import telemetry without inverting the dependency direction — telemetry → hooks is correct; hooks → telemetry is not.

## Decision

### 1. Observe + accept/deny only. No mutation in v1.0.

Handlers receive a payload and may (a) observe it and (b) for `pre-tool`, deny the pending tool call by throwing. Handlers cannot mutate tool arguments or results. Payloads are `Readonly` by contract; the runtime does not read back any handler return value as a replacement payload.

- **Coupling to internal state.** Mutation makes a hook a participant in the tool-execution data path, not an observer of it. The payload would become a bidirectional channel into permissions, the injection scanner, and the secrets scanner — all of which sit *below* hooks in the layer graph. A mutating hook that rewrites `args` after `pre-tool` but before `permissions.check` (step 7 → 8 of the turn diagram) would let a harness-layer extension route around a security-layer gate. Observe + deny keeps the security layer authoritative.

  **Enforcement (and its limit).** The runtime `Object.freeze`s the payload before dispatch, so a handler cannot swap a top-level field (`payload.tool`, `payload.args` reference). This is a *shallow* freeze: `args`/`result` are typed `unknown` and may hold nested objects the freeze does not reach, so a determined handler could still mutate nested state in place. The freeze raises the bar and makes the common case safe, but it is not a complete immutability guarantee. The authoritative mitigation remains structural — the H-1 SDK wiring must re-read `args` from its own authoritative source when calling `permissions.check`, never from the post-`fire` payload object. Deep-freezing arbitrary payloads is deferred (cost, and it would freeze objects the caller still owns); see Revisit if.
- **Typed-surface risk.** A safe mutation API must clone, re-validate, and re-scan the mutated value, and must define precedence when two handlers mutate the same field. That is a stricter typed surface than v1.0 can justify. Shipping a weak mutation API now (hand a handler the live object and hope) is worse than shipping none.
- **Testability.** Observe + deny is a pure predicate over an immutable payload: `fire` either denies or does not, and the set of fired handlers is deterministic. Mutation makes `fire`'s output a function of handler-order-dependent edits, multiplying the test matrix.

### 2. Locked type signatures

```ts
type HookEvent = 'pre-tool' | 'post-tool' | 'session-start' | 'stop';

interface PreToolPayload {
  event: 'pre-tool';
  tool: string;
  args: unknown;
}
interface PostToolPayload {
  event: 'post-tool';
  tool: string;
  result: unknown;
  scan: unknown;        // owned by security/injection-scanner; see Revisit if
  redactions: unknown;  // owned by security/secrets-scanner; see Revisit if
}
interface SessionStartPayload {
  event: 'session-start';
  sessionId: string;
  startedAt: number;    // epoch ms
}
interface StopPayload {
  event: 'stop';
  sessionId: string;
  stoppedAt: number;    // epoch ms
}

interface HookPayloadMap {
  'pre-tool': PreToolPayload;
  'post-tool': PostToolPayload;
  'session-start': SessionStartPayload;
  'stop': StopPayload;
}
type HookPayload = HookPayloadMap[HookEvent];

type HookHandler<E extends HookEvent = HookEvent> = (
  payload: Readonly<HookPayloadMap[E]>,
) => void | Promise<void>;

type Unsubscribe = () => void;

// Thrown by a pre-tool handler to deny the pending tool call. Any throw denies
// (per architecture.md); this class is the typed, reason-carrying way to do it.
class HookDenial extends Error {
  readonly reason: string;
}

interface HookHandlerError {
  handlerIndex: number; // registration-order index of the throwing handler
  reason: string;       // sanitized message
  error: unknown;       // original thrown value, unmodified
}

interface FireResultBase {
  event: HookEvent;
  handlersFired: number;       // handlers invoked (incl. one that denied)
  errors: HookHandlerError[];  // isolated, non-deny throws
}
type FireResult =
  | (FireResultBase & { denied: false })
  | (FireResultBase & {
      denied: true;
      deniedBy: number;        // registration-order index of denying handler
      reason: string;          // sanitized denial message
      error: unknown;          // original thrown value (HookDenial or other)
    });

// Injected telemetry seam. Default is a no-op. Telemetry (a later module)
// supplies an adapter; hooks never import telemetry.
type HookEventRecord =
  | { kind: 'denied-by-hook'; event: 'pre-tool'; handlerIndex: number; tool: string; reason: string }
  | { kind: 'hook-error'; event: HookEvent; handlerIndex: number; reason: string }
  | { kind: 'hook-fired'; event: HookEvent; handlersFired: number };
type HookSink = (record: HookEventRecord) => void;

interface HookRuntimeOptions {
  onEvent?: HookSink;
}
interface HookRuntime {
  register<E extends HookEvent>(event: E, handler: HookHandler<E>): Unsubscribe;
  fire<E extends HookEvent>(event: E, payload: HookPayloadMap[E]): Promise<FireResult>;
}
function createHookRuntime(opts?: HookRuntimeOptions): HookRuntime;
```

### 3. Factory + default instance (per-session state)

Unlike the router (stateless over an injected table) and skills (stateless over a locked schema), the hook runtime owns per-session mutable state: the list of registered handlers. `createHookRuntime(opts?)` returns a fresh `{ register, fire }` whose handler registry is private to that instance, so H-1 (SDK wiring) gives each session its own runtime and sessions cannot leak handlers into each other. Bare `register`/`fire` bound to a module-level default instance are also exported, for the config model's ES-module-registered handlers and for single-session / CLI use. This mirrors the router's `createRouter` + `defaultRouter` + bare `route` shape exactly.

### 4. `fire` catches deny; it does not rethrow

A handler deny is expected control flow, not a programmer error, so `fire` never propagates a handler throw to its caller. `fire` catches the throw and resolves to a structured `FireResult`. The typed error is still surfaced (`error` holds the original throw; `reason` holds its sanitized message). Callers branch on `result.denied` instead of wrapping every `fire` in `try/catch`. Programmer errors in `fire`/`register` arguments (invalid event name, non-function handler) still throw `TypeError`, consistent with the router's `assertValid` and skills' `TypeError` precedents.

### 5. Per-event throw semantics

- **`pre-tool` throw = deny.** The runtime stops firing remaining `pre-tool` handlers (short-circuit), emits one `denied-by-hook` record, and returns `{ denied: true, deniedBy, reason, error }`. The caller must not run the tool. First deny wins.
- **`post-tool` / `session-start` / `stop` throw = isolated error.** There is no pending tool call to deny. The throw is recorded to `errors[]` and emitted as a `hook-error` record; remaining handlers still run. One faulty observer must not silence the others. `fire` resolves `{ denied: false, ... }` with the errors collected.

Ordering is registration order, awaited sequentially. `fire` snapshots the handler array at entry, so a handler that unregisters another during a fire does not corrupt the in-flight sequence.

### 6. Telemetry seam is inverted and injected

`createHookRuntime({ onEvent })` takes an optional `HookSink` callback, defaulting to a no-op. The runtime emits `HookEventRecord`s to it (including the locked `denied-by-hook` kind). When telemetry lands, it supplies an adapter mapping `HookEventRecord` → `TelemetryEvent`; hooks keep zero repo dependencies and the layer direction holds.

### 7. Error-message sanitization

Every attacker-influenced string that reaches the sink (a log/terminal-adjacent surface) is stripped of control characters with the same control-char regex used by the router (`sanitizeReason`) and skills (`sanitize`). This covers denial and error `reason`s AND the `tool` field on a `denied-by-hook` record: for a real turn `tool` is the model-requested tool name (adversarial LLM output), and `pre-tool` fires before any tool-registry validation is guaranteed. Because hooks depends on nothing, the regex is copied locally into `runtime.ts` with a "keep in lockstep" comment. Extraction to a shared util is deferred (see Revisit if) because a `src/internal/*` import would give hooks its first in-repo dependency, which the locked "depends on nothing" forbids.

The sink is invoked through a swallowing wrapper: telemetry is observational and must never affect control flow, so a throwing sink adapter cannot turn a successful `fire` into a rejection or abandon later records.

### 8. Telemetry event accounting

A `pre-tool` deny emits exactly one `denied-by-hook` record and NO `hook-fired`; a non-denied fire emits one `hook-fired` (plus a `hook-error` per isolated throw). A telemetry consumer reconstructing how many fires happened must count `denied-by-hook` + `hook-fired`, not `hook-fired` alone.

## Consequences

### Positive
- Security layer stays authoritative: hooks cannot swap top-level payload fields (the payload is frozen), and the SDK re-reads `args` from its own source, so a hook cannot route around `permissions.check` or the scanners.
- `fire` is a clean, testable predicate over a frozen payload; deny is deterministic and order-defined.
- Callers never `try/catch` normal control flow; they branch on `result.denied`.
- Zero runtime dependencies preserved; telemetry wiring is inverted, so the layer graph is intact before telemetry exists.
- Per-session isolation via the factory prevents cross-session handler leakage.

### Negative / accepted
- No mutation means use cases like "normalize a path before permissions check" or "add a redaction" cannot be expressed as hooks in v1.0. Accepted; those belong to the security layer today, and mutation is a v1.x promotion.
- `scan` and `redactions` are typed `unknown` in `PostToolPayload` to avoid a hooks → security type import. Handlers that need them must narrow. Tightening is deferred until the security contracts stabilize.
- The `denied-by-hook` / `hook-error` / `hook-fired` record shape is a wire format the future telemetry module must accept; changing it later is a coordinated change.
- **No per-handler timeout.** A handler that returns a never-settling promise stalls the sequential await and freezes the turn (for `pre-tool`, a soft-DoS on the session). Accepted for v1.0: handlers are trusted, config-registered extension code, and the fail-open-vs-fail-closed choice on timeout is itself security-relevant. Named in Revisit if for when handlers become less trusted.
- **The bare `register`/`fire` exports share one process-global registry** (the module-level default instance). Intended for single-session / CLI / config-registered use, but a footgun for a library or multi-tenant embedding consumer, who must use `createHookRuntime()` per session.
- **Payload freeze is shallow.** Nested `args`/`result` state is not deep-frozen; the SDK re-read obligation (§1) is what fully closes the mutation-bypass, not the freeze alone.

## Alternatives considered

1. **Allow full mutation of args and results in v1.0.** Rejected — couples hooks to security-layer state, lets a harness extension bypass a security gate, and demands a clone/re-validate/re-scan surface plus a handler-precedence model that v1.0 cannot justify. Deferred to v1.x.
2. **Mutation of `pre-tool` args only (middle ground).** Rejected for v1.0 — even args-only mutation reopens the "hook rewrites args after `pre-tool`, before `permissions.check`" bypass, which is the exact coupling this ADR exists to prevent. It is the most likely first mutation feature, so it is named as a Revisit-if trigger rather than shipped.
3. **`fire` rethrows the handler deny.** Rejected — forces every caller to `try/catch` expected control flow, contradicts the tagged-results convention, and makes "which handler denied and why" awkward to surface.
4. **Import telemetry directly to emit `denied-by-hook`.** Rejected — inverts the layer direction (hooks → telemetry) and gives hooks an in-repo dependency it is specified not to have. The injected `HookSink` achieves the same telemetry outcome with the dependency pointing the correct way.
5. **Bare `register`/`fire` on a singleton, no factory (skills-style).** Rejected — hooks hold per-session mutable state; a process-wide singleton would leak handlers across sessions. The router-style factory + default instance is the correct precedent here.
6. **Use an EventEmitter / third-party pub-sub package.** Rejected — cannot guarantee sequential async ordering or short-circuit-on-deny out of the box, and adds a runtime dependency to the one module specified to have none. Sequential dispatch is roughly thirty lines by hand.

## Revisit if

- A concrete consumer needs a `pre-tool` hook to rewrite `args` (path normalization, prompt-preamble injection) — promote to a mutation API with a cloned, re-validated, re-scanned payload and a defined handler-precedence rule.
- A consumer needs `post-tool` hooks to contribute additional redactions or annotate results — same promotion, results side.
- The security layer's `ScanResult` / redaction types stabilize enough that typing `PostToolPayload.scan` / `.redactions` as `unknown` is costing handler authors — introduce a shared contracts type or generic parametrization rather than a hooks → security import.
- A consumer needs `session-start` or `stop` throws to abort the session (currently isolated-error-only) — define abort semantics for lifecycle events.
- Handlers become less-trusted (third-party plugins) — add a per-handler timeout, and make the `pre-tool` timeout **fail-closed** (deny). Also revisit deep-freezing the payload rather than the current shallow freeze.
- Concurrent / parallel hook dispatch is requested — out of scope in v1.0 (it would break the ordering guarantee); would need a new ADR.
- The control-char sanitizer gains a fourth consumer or the "depends on nothing" constraint is relaxed — extract `CONTROL_CHARS` to a shared `src/internal` kernel and migrate router + skills + hooks.
