# Architecture

> System design for `agent-harness-JA` v1.0. Establishes module boundaries, data flow, and dependency direction *before* implementation. Where a module's design has open questions, they are named here and resolved in an ADR.

## Goals of this document

1. Make the three-layer structure (harness / security / eval) concrete enough to implement.
2. Name every module that will exist, what it owns, and what it depends on.
3. Define the data flow for a single agent turn so that telemetry, scanning, and routing are unambiguous.
4. Establish the dependency direction so that modules remain composable and individually adoptable.

## The three layers

```
┌──────────────────────────────────────────────────────────────┐
│  EVAL LAYER                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐ │
│  │ Golden runs │  │  Red-team   │  │ Adversarial verifier │ │
│  └─────────────┘  └─────────────┘  └──────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│  HARNESS LAYER                                                │
│  ┌────────┐  ┌────────┐  ┌───────┐  ┌──────────┐  ┌───────┐ │
│  │ Router │  │ Skills │  │ Hooks │  │Telemetry │  │Memory │ │
│  └────────┘  └────────┘  └───────┘  └──────────┘  └───────┘ │
├──────────────────────────────────────────────────────────────┤
│  SECURITY LAYER                                               │
│  ┌─────────────┐ ┌─────────┐ ┌─────────────┐ ┌────────────┐ │
│  │  Injection  │ │ Secrets │ │ Permissions │ │  Sandbox   │ │
│  │   scanner   │ │ scanner │ │             │ │ boundaries │ │
│  └─────────────┘ └─────────┘ └─────────────┘ └────────────┘ │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                     Claude Agent SDK
```

### Why three layers in this order

- **Security is the foundation, not a wrapper.** It runs on every tool input and output, so it must be available to every other module. Placing it at the bottom makes that dependency direction explicit.
- **Harness is the operational middle.** Routing, skills, hooks, telemetry, and memory are what the agent *runs on*. They depend on the security layer but not on eval.
- **Eval is the outer layer.** It exercises the harness as a black box and observes results. It depends on everything below it; nothing in the lower layers depends on it.

This ordering enforces an important property: **a user can adopt the security layer alone, without harness or eval.** A user can adopt harness + security without eval. The reverse is not true. The dependency direction matches the value-density of each layer.

## Dependency direction

```
eval ──depends-on──▶ harness ──depends-on──▶ security ──depends-on──▶ Claude SDK
```

Hard rules:

- No module in the security layer imports from the harness layer.
- No module in the harness layer imports from the eval layer.
- Modules within the same layer may import from each other only via documented internal APIs (in `src/<module>/index.ts`); no reaching into siblings' internals.

Violating these rules is treated as a build failure (enforced by an ESLint `no-restricted-imports` config (leaf-module restrictions landed with H-1; extended as new layers land)).

## Module specifications

### Security layer

#### `security/injection-scanner`

- **Owns:** detection of prompt-injection patterns in arbitrary text.
- **Public API:** `scan(text: string): ScanResult` where `ScanResult = { verdict: 'pass' | 'block' | 'ask', rule_ids: string[], excerpts: string[], suspicious: boolean }` (`suspicious` = medium-only hits, the S-5 judge trigger). Heuristic stage shipped ([ADR-0012](./decisions/0012-injection-heuristics-implementation.md)); LLM-judge (S-5) is a typed seam.
- **Depends on:** `security/rules` (rule registry), optionally `router` for the LLM-judge stage (injected, not imported, to preserve layer direction).
- **Design notes:** Heuristic-first; LLM judge is off by default. See [ADR-0005](./decisions/0005-injection-scanner-hybrid.md).

#### `security/secrets-scanner`

- **Owns:** redaction of secrets in tool inputs and outputs.
- **Public API:** `redact(text: string): { redacted: string, findings: SecretFinding[] }`.
- **Depends on:** built-in pattern registry; optional user-supplied patterns via config.
- **Design notes:** Patterns drawn from `gitleaks` and `trufflehog` rule sets (25 rules; entropy-gated heuristics). Redaction format: `[REDACTED:<rule_id>]`. `SecretFinding` carries only `rule_id`+offsets+length (no secret bytes). Shipped ([ADR-0013](./decisions/0013-secret-redaction.md)); **observe-only** — redacts everything the harness persists/emits, but the model still sees the raw result (no SDK rewrite channel), same limit as S-1.

#### `security/permissions`

- **Owns:** allow / ask / deny decisions for tool invocations, plus the settings-file loader (`~/.harness/settings.json` under `<cwd>/.harness/settings.json`).
- **Public API:** `createPermissionEvaluator(opts).evaluate(tool, args): Evaluation`; `permissionHook(evaluator, prompter?)` (a pre-tool handler that throws `PermissionDenied` on deny); `loadSettingsFile` / `mergeLayers` / `parsePermissionSettings`.
- **Depends on:** nothing in this repo — the composition root loads settings and registers the hook (injected, not imported).
- **Design notes:** Rules are `{ tool, match?, decision }` with trailing-`*` prefix globs only. Precedence is specificity (match > tool > wildcard) then severity (deny > ask > allow), so merged layers evaluate order-independently and a user deny survives a project allow (sticky deny). Unmatched tools get `defaultDecision` (default allow; harden with one settings line). `ask` fails closed without a prompter; malformed settings fail loud at startup. Shipped ([ADR-0014](./decisions/0014-declarative-permission-model.md)).

#### `security/sandbox`

- **Owns:** path and command allowlists for file and bash tools, enforced as a pre-tool gate (deny before the SDK executes — a policy boundary, not OS isolation).
- **Public API:** `createSandbox(config): Sandbox` with `allowPath(path): boolean` / `allowCommand(cmd): boolean`; `sandboxHook(sandbox)` (pre-tool handler throwing `SandboxViolation`); `mergeSandboxLayers` / `parseSandboxSettings`.
- **Depends on:** `internal/settings` (shared loader mechanics); otherwise pure functions over config.
- **Design notes:** Dimensions enabled by key presence in `.harness/settings.json`; layers merge by **intersection** (project can only tighten). Paths: lexical `resolve` both sides + boundary-safe prefix; missing target field on a gated tool → deny (fail closed). Commands: shell metacharacters deny outright, else exact argv[0] match; bounds *which program starts*, not what it does — non-goals documented. Shipped ([ADR-0015](./decisions/0015-sandbox-pre-tool-gate.md)).

### Harness layer

#### `harness/router`

- **Owns:** model selection given a task descriptor.
- **Public API:** `route(descriptor: TaskDescriptor): ModelChoice` where `ModelChoice = { model: 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-8', rule_id: string, reason: string }`.
- **Depends on:** routing-table config; no other modules.
- **Design notes:** Task descriptor includes `shape` (review / build / research / lookup), `sensitivity` (low / medium / high), and `expected_tokens`. Routing is deterministic given config. Locked in [ADR-0007](./decisions/0007-task-descriptor-schema.md).

#### `harness/skills`

- **Owns:** discovery, validation, and loading of skill files.
- **Public API:** `load(dir: string): LoadResult` (amended 2026-07-05 — see ADR-0006 amendment), `validate(file: string): ValidationResult`.
- **Depends on:** `gray-matter` for frontmatter parsing, `ajv` for schema validation.
- **Design notes:** Markdown + YAML frontmatter; see [ADR-0006](./decisions/0006-skill-schema-markdown-frontmatter.md).

#### `harness/hooks`

- **Owns:** event-driven extension points around tool execution and session lifecycle.
- **Public API:** `register(event: HookEvent, handler: HookHandler)`, `fire(event: HookEvent, payload: HookPayload)`.
- **Events:** `pre-tool`, `post-tool`, `session-start`, `stop`.
- **Depends on:** nothing.
- **Design notes:** Handlers are async, sequential, and can short-circuit (e.g. a pre-tool hook can deny execution by throwing a typed error).

#### `harness/telemetry`

- **Owns:** durable storage of per-turn cost, cache hit/miss, tool traces, and hook events.
- **Public API:** `record(event: TelemetryEvent)`, `query(filter: TelemetryFilter): TelemetryEvent[]`.
- **Depends on:** `better-sqlite3`; schema migrations in `src/telemetry/migrations/`.
- **Design notes:** Single-writer, append-heavy. Single `telemetry_events` table (type discriminator + JSON payload + indexed `session_id`/`turn_id`/`ts`); the numbered-migration runner owns the shared-DB schema (memory's DDL is migration 001). Events correlate on harness-generated session/turn ids supplied by the composition root. Export via `agent-harness-ja telemetry export` (JSONL). See [ADR-0004](./decisions/0004-sqlite-for-telemetry.md) and [ADR-0011](./decisions/0011-telemetry-store-and-migrations.md).

#### `harness/memory`

- **Owns:** typed memory entries (user / feedback / project / reference) with persistence and retrieval.
- **Public API:** `write(entry: MemoryEntry)`, `read(filter: MemoryFilter): MemoryEntry[]`.
- **Depends on:** `harness/telemetry`'s SQLite connection (shared DB, separate tables).
- **Design notes:** Type-tagged for retrieval-by-type. Optional decay/staleness fields.

#### `harness/session`

- **Owns:** the harness entry point — orchestrates one agent turn end-to-end (route → load skills → hooks → SDK stream → memory summary). Added with H-1; see [ADR-0010](./decisions/0010-sdk-session-adapter.md).
- **Public API:** `createSession(deps, config)` → `session.run(prompt): SessionResult`.
- **Depends on:** `harness/router`, `harness/skills`, `harness/hooks`, `harness/memory`, and an injected Claude Agent SDK `query` function (structural types only; the SDK import lives in the CLI).
- **Design notes:** Fires `session-start`/`stop` directly around the SDK stream; bridges `pre-tool`/`post-tool` through the SDK's hook callbacks with denials translated to the SDK's deny output.

### Eval layer

#### `eval/golden`

- **Owns:** running a set of golden tasks and scoring them.
- **Public API:** `run(taskDir: string, opts?: RunOptions): Scorecard`.
- **Depends on:** the full harness — runs real agents through it.
- **Design notes:** Each task is Markdown frontmatter + body + an oracle function (TypeScript module exported from the task file's sibling).

#### `eval/red-team`

- **Owns:** the ≥50-case adversarial corpus and per-case pass/fail evaluation.
- **Public API:** `run(corpusDir: string, opts?: RunOptions): RedTeamScorecard`.
- **Depends on:** `eval/golden` for the underlying scoring machinery; `security/injection-scanner` for verdict comparison.
- **Design notes:** Corpus categories — direct injection, indirect injection, jailbreak, exfil. Each case includes a `source` field citing the public research it draws from.

#### `eval/adversarial-verifier`

- **Owns:** the two-pass verification pattern (primary model produces output → adversary model challenges it → reconcile).
- **Public API:** `verify(primaryOutput: string, ctx: VerificationContext): VerificationResult`.
- **Depends on:** the router (for adversary model selection).
- **Design notes:** Adversary model defaults to a different family than the primary (e.g. Haiku vs Sonnet) to reduce shared-failure modes. Pluggable to external models in v2.

## Data flow: a single agent turn

The sequence below traces what happens when the user sends a message to a harness-managed agent. Telemetry recording is shown explicitly; in reality it happens at every numbered step.

```
1. User message arrives at the harness entry point
   │
   ▼
2. router.route(descriptor)                              [harness]
   → model selection logged
   │
   ▼
3. skills.load() returns relevant skills                 [harness]
   → skill manifest logged
   │
   ▼
4. hooks.fire('session-start')                           [harness]
   │
   ▼
5. Claude SDK turn begins                                [SDK]
   │
   ▼
6. SDK requests a tool call
   │
   ▼
7. hooks.fire('pre-tool')                                [harness]
   │
   ▼
8. permissions.evaluate(tool, args)                      [security]
   → block / ask / allow logged
   │
   ▼
9. (if allow) tool executes inside sandbox               [security + tool]
   │
   ▼
10. injection-scanner.scan(tool_result)                  [security]
    → verdict logged
    │
    ▼
11. secrets-scanner.redact(tool_result)                  [security]
    → redactions logged
    │
    ▼
12. hooks.fire('post-tool', { result, scan, redactions })[harness]
    │
    ▼
13. SDK receives the tool result — NB: scan/redact are observe-only in v1 (harness data plane); model-facing rewriting is a documented follow-up (ADR-0012 §9, ADR-0013 §9)
    │
    ▼
14. SDK turn completes
    │
    ▼
15. hooks.fire('stop')                                   [harness]
    → turn cost, tokens, cache hit/miss logged
```

Every step's output is recorded in `telemetry` with a turn-scoped correlation ID, so a full trace can be reconstructed after the fact.

## Configuration model

A single `harness.config.ts` (or `.yaml`) at the consumer's project root defines:

- Skills directory path.
- Hook handlers (registered as ES modules).
- Routing table.
- Security defaults (injection mode, secret patterns, permission policy, sandbox allowlist).
- Telemetry path.
- Eval task directories.

Configuration is fully optional — every module ships sensible defaults. The starter project produced by `harness init` ships with a minimal config that runs end-to-end on a fresh machine.

## Cross-cutting concerns

### Error handling

- All public APIs return tagged results (`{ ok: true, value } | { ok: false, error }`) rather than throwing, except for programmer errors (invalid arguments, contract violations) which throw. Aggregate/batch operations may instead return an un-tagged result carrying both successes and per-item errors (e.g. `LoadResult { skills, errors }`) — partial failure is not a failure of the operation itself; see the ADR-0006 amendment.
- Hook handlers that throw deny tool execution and record a `denied-by-hook` telemetry event.
- The eval layer treats any uncaught exception in a task as a hard fail and reports the stack in the scorecard.

### Logging vs telemetry

- **Telemetry** is structured, queryable, persistent. Anything an evaluator might want to reason about later.
- **Logging** is unstructured, ephemeral, for the developer's eyes during a single run. Routed through `pino` to stdout.
- The two never substitute for each other. A change that should be queryable later belongs in telemetry, not in a log line.

### Concurrency

- v1.0 assumes single-process, single-agent execution.
- Telemetry's SQLite writer is single-writer by construction.
- The hook runtime is sequential to preserve ordering guarantees in pre-/post-tool flows.
- Concurrent multi-agent execution is explicitly out of scope; see [01-requirements.md](../process/01-requirements.md) "Out of scope."

## Open architectural questions

These are not yet resolved. Each will be answered in an ADR before the affected module is built.

1. **How is the LLM judge in the injection scanner invoked?** The scanner is in the security layer; the router is in the harness layer. The harness depending on security is correct; security depending on harness is not. Resolution: the judge calls Claude directly via the SDK, not via the router. The router is a harness-layer concept; the security layer talks to the SDK directly when it needs a model. ADR pending.

2. **What is the exact schema for a `TaskDescriptor`?** Field names matter for clarity; the routing table is a public API. Will be locked in an ADR before Week 1 implementation.

3. **Should hooks be allowed to mutate tool arguments / results, or only observe + accept/deny?** Mutation is powerful but couples hooks to internal state. Likely answer: observe + accept/deny only in v1.0; mutation deferred to v1.x with a stricter typed surface. ADR pending.

4. **Where does the adversarial verifier's adversary model come from?** A second Claude model (Haiku reviewing Sonnet, Sonnet reviewing Opus) is the simplest answer. Whether to support an entirely different family (e.g. Gemini) in v1.0 is open — leaning no, since cross-provider would require multi-SDK support that is explicitly deferred.

These open questions are part of the demonstrated thinking. They are not weaknesses to hide — they are the work-in-progress that proves the architecture was reasoned about, not copied.
