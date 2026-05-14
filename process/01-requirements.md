# Requirements

> Functional and non-functional requirements for v1.0. Written after [00-problem-framing.md](./00-problem-framing.md) and before any implementation.

## Method

Requirements are split into three layers matching the architecture (harness / security / eval) plus cross-cutting concerns. Each requirement has:

- **ID** — stable reference for ADRs and tests.
- **Priority** — `MUST` (v1.0 blocker), `SHOULD` (v1.0 if time), `COULD` (v1.x).
- **Verification** — how we will know it is met.

## Harness layer

| ID | Priority | Requirement | Verification |
|---|---|---|---|
| H-1 | MUST | The harness wraps the Claude Agent SDK without forking or shadowing its public surface. | Integration test runs a stock SDK example through the harness with zero SDK code modified. |
| H-2 | MUST | A model router selects between Haiku, Sonnet, and Opus based on a declarative task descriptor (shape, sensitivity, expected token volume). | Unit tests over a routing table; documented rules in `docs/architecture.md`. |
| H-3 | MUST | Skills are loaded from a configurable directory, validated against a schema, and made available to the agent at runtime. | `harness run` succeeds with ≥1 skill loaded; invalid skill files produce clear errors. |
| H-4 | MUST | Hooks fire on `pre-tool`, `post-tool`, `session-start`, and `stop` events with a documented contract. | Each hook event has an integration test asserting payload shape and ordering. |
| H-5 | SHOULD | Memory is typed (user / feedback / project / reference), persisted, and queryable from within an agent turn. | CRUD test suite + retrieval-by-type test. |
| H-6 | COULD | The router supports cost-budget constraints (e.g. "this session must not exceed $X"). | Deferred to v1.x. |

## Security layer

| ID | Priority | Requirement | Verification |
|---|---|---|---|
| S-1 | MUST | All tool-call return values pass through a prompt-injection scanner before being surfaced to the agent. | Red-team corpus pass rate ≥90% on the injection subset. |
| S-2 | MUST | Secret patterns (API keys, tokens, private keys) are scanned in tool inputs and outputs; matches are redacted with a logged event. | Unit tests for ≥20 secret patterns drawn from `trufflehog`/`gitleaks` rule sets. |
| S-3 | MUST | A permission model gates tool execution. Permissions are declarative (allow / ask / deny) and inheritable from settings files. | Integration test asserting denied tools never execute. |
| S-4 | MUST | Bash/file tools execute inside a sandbox with a configurable allowlist of paths and commands. | Negative tests asserting blocked paths fail closed. |
| S-5 | SHOULD | The injection scanner uses a hybrid heuristic + LLM-judge approach, with the LLM judge optional (off by default for cost). | Toggle test; documented in `docs/security-model.md`. |
| S-6 | COULD | Threat model document maintained in `docs/security-model.md` covering STRIDE categories. | Deferred but tracked. |

## Eval layer

| ID | Priority | Requirement | Verification |
|---|---|---|---|
| E-1 | MUST | A `harness eval` command runs a configured set of golden tasks and outputs a Markdown scorecard. | Sample golden task suite ships with the repo; CI runs it on every PR. |
| E-2 | MUST | A red-team corpus of ≥50 prompt-injection / jailbreak / exfil cases ships with the repo, each with a pass/fail oracle. | Corpus listed in `src/eval/corpus/`; per-case test runs. |
| E-3 | MUST | Eval results are persisted in SQLite with a stable schema; regression detection compares runs. | Schema documented; regression test detects a deliberately-broken baseline. |
| E-4 | SHOULD | A two-pass adversarial verification module is available as a runtime guardrail OR offline eval, with the second pass model pluggable. | Test using Claude as both primary and adversary. |
| E-5 | COULD | Export evaluation runs as OpenTelemetry traces for ingestion by external observability platforms. | Deferred to v1.x. |

## Cross-cutting (non-functional)

| ID | Priority | Requirement | Verification |
|---|---|---|---|
| N-1 | MUST | The repo runs end-to-end on a clean machine with only `node >=20` and a Claude API key. | Fresh-VM install test in CI. |
| N-2 | MUST | All public APIs are TypeScript-typed; `strict: true`. | `tsc --noEmit` green in CI. |
| N-3 | MUST | Every non-trivial design choice has a corresponding ADR in `docs/decisions/`. | ADR count ≥6 at v1.0 launch. |
| N-4 | MUST | `process/` folder documents the build chronologically (framing, requirements, scope cuts, weekly devlog). | Manual review at launch. |
| N-5 | MUST | License is MIT; LICENSE file present at repo root. | File check. |
| N-6 | SHOULD | A GitHub Pages site renders the README + `docs/` as a browsable site. | URL live at v1.0. |
| N-7 | SHOULD | Code coverage ≥70% on `src/`. Eval and security modules ≥85%. | `vitest --coverage` in CI. |

## Out of scope for v1.0

Listed to prevent scope creep — these requests should be deferred, not absorbed:

- Provider-agnostic abstraction over multiple SDKs.
- Web UI for browsing telemetry or eval results.
- Multi-tenant or hosted-service deployment.
- Real-time streaming dashboards.
- Custom DSL for skill authoring (Markdown frontmatter is sufficient).
- Auto-generated skill libraries from external sources.

## Traceability

Each requirement ID above will appear in:

- The ADR that decides its implementation approach (where applicable).
- The test(s) that verify it.
- The CHANGELOG entry on the release that ships it.

This means a reviewer can trace any code line back to a requirement, and any requirement forward to its test and release. That is the level of rigour this repo is trying to demonstrate.
