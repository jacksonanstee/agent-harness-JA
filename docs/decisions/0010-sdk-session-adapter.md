# ADR-0010: SDK session adapter — injected `query`, structural SDK types, hook bridging

- **Date:** 2026-07-06
- **Status:** Accepted
- **Deciders:** Jackson Anstee
- **Related requirements:** H-1
- **Related ADRs:** 0003 (Claude SDK first), 0008 (hook runtime), 0009 (memory store)

## Context

H-1 wires the four Week-1 modules (router, skills, hooks, memory) into a Claude
Agent SDK session so `agent-harness-ja run "<prompt>"` executes an agent
end-to-end (architecture data-flow steps 2–15; security steps 8–11 are Week 2).
Three design questions:

1. How does the session module depend on the SDK so tests never touch the
   network or the bundled Claude Code binary?
2. Which types does the harness use for SDK messages and hook callbacks?
3. How do the SDK's hook events map onto the harness `HookRuntime` events?

## Decision

1. **Injected `query`.** `createSession(deps, config)` takes the SDK's `query`
   function as `deps.query` — the same injected-seam pattern as hooks
   (ADR-0008 sink) and memory (ADR-0009 connection). The CLI is the only place
   the real SDK is imported (dynamically, after arg/env validation). Tests
   inject fake async generators.

2. **Structural SDK types, not SDK imports.** `src/session/types.ts` declares
   minimal structural views (`SdkMessage`, `SdkHookCallback`, `QueryOptions`)
   containing only the fields the harness reads. The real `query` is cast to
   `QueryFn` at the CLI boundary. Rationale: the SDK's type surface is large
   and moving; depending only on observed fields keeps the session module
   testable with plain objects and shrinks the migration cost if the SDK
   changes (ADR-0003's named risk).

3. **Hook event mapping.** Harness events fire at the architecture's numbered
   steps; only the two tool events bridge through SDK hooks:

   | Architecture step | Harness event   | Fired by                                | SDK surface |
   |---|---|---|---|
   | 4  | `session-start` | session module, before `query()` starts | none |
   | 7  | `pre-tool`      | adapter callback                        | `options.hooks.PreToolUse` |
   | 12 | `post-tool`     | adapter callback                        | `options.hooks.PostToolUse` |
   | 15 | `stop`          | session module, in `finally` after the stream ends | none |

   `session-start`/`stop` are fired directly rather than via the SDK's
   `SessionStart`/`Stop` hooks so they fire exactly once, deterministically,
   even when the stream throws — and so their payloads (harness session id,
   injected clock) stay under harness control.

4. **Deny bridging.** A `pre-tool` denial (`FireResult.denied`) is translated
   to the SDK's `permissionDecision: "deny"` output with the sanitized harness
   reason; the tool never runs and the denial is recorded on the
   `SessionResult`. Non-deny hook errors are isolated (per ADR-0008) and
   surfaced as warnings, never thrown.

5. **Session identity.** The harness generates its own session id for the
   `session-start` payload (the SDK id is unknown until `system/init`); the
   SDK id, once seen, is used for `stop`, the memory entry
   (`session-<id>`), and the returned `SessionResult.sessionId`.

## Consequences

### Positive
- Session logic is fully unit-testable offline; the live SDK is exercised only
  in the manual E2E smoke.
- The harness compiles against zero SDK types — SDK upgrades break at the CLI
  cast, one file, not across the module.
- The hook mapping table makes steps 4/7/12/15 auditable against
  `docs/architecture.md`.

### Negative
- Structural types can drift from the real SDK silently (a renamed field would
  type-check but read `undefined` at runtime). Mitigated by the E2E smoke in
  the Week-1 checkpoint and by guarding every optional read.
- `session-start` fires with the harness id, `stop` with the SDK id — a
  consumer correlating the two must treat the memory entry as the join point.

## Revisit if
- The SDK exposes a stable, versioned public type package worth depending on.
- Week 2's security layer needs richer tool metadata than the structural
  `SdkHookInput` carries.
- Multi-turn interactive sessions (v1.x) need `resume` — the adapter currently
  models one `run()` per session.
