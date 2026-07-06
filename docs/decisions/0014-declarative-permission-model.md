# ADR-0014: Declarative permission model (S-3)

Date: 2026-07-06
Status: Accepted

## Context

S-3 (MUST) requires a permission model that gates tool execution: declarative allow / ask / deny rules, inheritable from settings files, verified by an integration test proving denied tools never execute.

The enforcement channel already exists: the hook runtime denies a tool call when any pre-tool handler throws (ADR-0008 §4), and the session adapter maps that to the SDK's `permissionDecision: 'deny'`. What S-3 adds is the *policy* layer: a rule language, an evaluator, and a settings loader. No settings loader existed anywhere in the codebase before this ADR; `docs/architecture.md` reserved the seam as "injected — not imported".

## Decision

### 1. Minimal rule grammar

A rule is `{ tool, match?, decision }`. `tool` is an exact name or a trailing-`*` prefix glob (`'Bash'`, `'mcp__*'`, `'*'`). `match` is an optional prefix-glob tested against a canonical string extracted from the args: `args.command` for Bash, `args.file_path` for Read/Write/Edit, else the JSON of the args. A `*` anywhere but the end is a literal. The matcher is ~10 lines and has no regex, so there is nothing to ReDoS and nothing to mis-parse. Deep path/command allowlisting (canonicalisation, traversal, symlinks) is deliberately **not** attempted here — that is S-4's job, and doing it half-way in a string glob would create false confidence.

### 2. Specificity-then-severity precedence

Among matching rules: a `match` rule beats a tool-only rule beats a `tool: '*'` rule; at equal specificity, `deny > ask > allow`. Conflicting rules therefore fail closed. Rule order never matters, which makes merged multi-layer rule lists safe to reason about.

### 3. `defaultDecision` knob, default `'allow'`

Tools no rule matches get `defaultDecision` (default `'allow'`). A conservative-by-default `'ask'` would deny every tool for every existing user the moment this module landed, because no prompter is wired (see §4) — a security default that breaks hello-world gets turned off, not configured. The hardened posture is one line of settings: `"defaultDecision": "deny"`.

### 4. `'ask'` fails closed without a prompter

`ask` resolves through an injected `Prompter` (`(req) => Promise<boolean>`). No prompter configured, a prompter that throws, and a prompter that rejects all deny. The CLI does not yet wire a TTY prompter; the seam is fully unit-tested with fakes. Wiring an interactive prompter is deferred until the CLI grows an interactive mode.

### 5. Layer merge with sticky deny

Two layers: user `~/.harness/settings.json`, then project `<cwd>/.harness/settings.json`. Rules concatenate (user first, tagged with their layer) and evaluate under §2 — so a user-layer `deny` survives a project-layer `allow` of equal specificity. A project can tighten but not loosen the user's policy. `defaultDecision` is scalar: project overrides user. File shape is `{ "permissions": { "defaultDecision"?, "rules": [] } }`, leaving the file open for future settings keys (unknown siblings ignored).

### 6. Malformed settings fail loud at startup

A missing settings file is an empty layer. A file that exists but is invalid (bad JSON, bad schema) throws `PermissionSettingsError` before any tool runs and the CLI exits 2. Silently skipping a broken security config would fail open; crashing is the conservative behaviour. Validation is hand-rolled (no schema dependency), matching S-1/S-2 style; bad entries under `permissions` are errors, never skipped.

### 7. Security throws its own `PermissionDenied`, not `HookDenial`

Security and hooks are import-free peers (layering rules, enforced by lint + `layering.test.ts`). The runtime denies on *any* pre-tool throw and extracts `Error.message` as the reason, so `permissionHook` throws a locally-defined `PermissionDenied` and types its payload structurally (`PreToolLike { tool, args }`). Same enforcement contract, no cross-leaf import. The composition root (`cli.ts`) registers the hook.

### 8. Telemetry reuses `denied-by-hook`

Permission denials flow through the existing `denied-by-hook` telemetry record; the reason string carries the rule (`permission: deny Bash(rm *) [rule 3, project]`). One deny channel, greppable reasons, no schema change.

## Consequences

### Positive

- Denied tools provably never execute (integration test in `session.test.ts` drives the full parse → merge → evaluate → hook → SDK-deny path).
- Zero changes to the hook runtime or session adapter.
- Policy is data: auditable JSON, no callbacks in config.
- Fail-closed on every ambiguous path: rule conflicts, `ask` without prompter, prompter failure, malformed settings.

### Negative / accepted

- Default-allow means the module protects nothing until a settings file exists. Accepted: documented hardening is one line, and breaking every existing flow by default is worse (§3).
- `match` on Bash is a prefix glob over the raw command string — trivially bypassable (`cd /; rm ...`), and `Bash(rm *)` misses `sudo rm`. Accepted and documented: argument-level enforcement is S-4's sandbox, not this grammar.
- No per-rule audit of which layer *file* a rule came from beyond the user/project tag.

## Alternatives considered

- **Claude Code-style `"Bash(npm *)"` string syntax** — compact, but needs a parser with quoting/escaping edge cases; the object form is self-validating and diff-friendly. Rejected.
- **zod (or similar) schema validation** — a new runtime dependency for ~60 lines of hand validation. Rejected; consistent with S-1/S-2's no-new-deps stance.
- **A distinct `permission-denied` telemetry kind** — cleaner queries, but a schema migration and a second deny channel to keep consistent. Rejected for now (§8); revisit when the eval layer needs to count permission denials separately.
- **Importing `HookDenial` from hooks** — simplest code, but violates the peer-leaf layering rule that keeps every module independently extractable. Rejected (§7).

## Revisit if

- S-4 lands a real sandbox: `match` may then shrink to tool-name-only rules, with argument policy owned by S-4.
- The CLI grows an interactive mode: wire a TTY prompter and consider flipping the recommended default to `ask`.
- The eval layer needs permission-denial metrics: split the telemetry kind (§8).
- More than two settings layers appear (e.g. enterprise/managed): generalise `SettingsLayer` and the merge.
