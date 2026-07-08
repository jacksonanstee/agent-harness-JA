# ADR-0015: Sandbox boundaries as a pre-tool gate (S-4)

Date: 2026-07-06
Status: Accepted

## Context

S-4 (MUST) requires Bash/file tools to "execute inside a sandbox with a configurable allowlist of paths and commands", verified by negative tests asserting blocked paths fail closed. Three S-3 review findings were deferred here: hoisting the settings-file loader to a shared leaf, executor path-base parity, and the command-string bypass class.

**This harness has no tool executor — the Claude Agent SDK executes tools.** What S-4 can honestly build is a *pre-tool gate*: deny the call before the SDK runs it, through the same channel S-3 uses (any pre-tool throw denies). It is a policy boundary, not OS isolation. This ADR says so plainly and enumerates what a string-level gate cannot stop, because a sandbox that overclaims is worse than no sandbox.

## Decision

### 1. Presence-enabled dimensions, intersection across layers

Config extends the existing settings files: `{ "sandbox": { "paths": { "allow": [...] }, "commands": { "allow": [...] } } }`. Each dimension is enabled by its key's presence; absent everywhere → sandbox off (backwards compatible). There is deliberately no `mode: off` switch — an off-switch is a loosening channel a project file could flip.

Layers merge by **intersection**: when both user and project define a dimension, an entry survives only if both allow it (compared under the same identity grammar the gates use); a single defining layer applies alone — a restriction the other layer never opted into, never a widening. Allowlists invert the permissions problem — concatenation would let a cloned repo's `.harness/settings.json` grant itself `/`. Intersection is the allowlist analogue of ADR-0014's sticky deny: a project can only tighten. `MAX_ALLOW_ENTRIES = 1000` per list (same attacker-influenced-input rationale as `MAX_RULES`).

### 2. Path gate: shared tool table, case-aware lexical canonicalisation, refuse to guess

The gated tool surface lives in ONE shared table (`src/internal/tool-targets.ts`), consumed by both the sandbox and the permissions evaluator. The review of the first cut found each module keeping a private four-tool table while assuming the other covered the rest — `Glob`, `Grep`, `NotebookEdit` and `MultiEdit` bypassed **both** gates. The shared table covers all path/command-taking SDK tools and is pinned by a test, so extending it is a visible act. Network-egress tools (`WebFetch`/`WebSearch`) are deliberately absent: they need a URL/domain dimension, not a path prefix (Revisit if).

When enabled, a path-tool call is allowed only if the canonicalised target sits under some canonicalised entry with a boundary-safe check (`target === base || target.startsWith(base + sep)` — `/allowed` never matches `/allowed-extra`). Directory boundaries are **inclusive**: a `dir/*` permission match pattern matches the bare `dir` too (the permissions evaluator's `matchesPathGlob`), so a `{tool:'Glob', match:'/secrets/*'}` deny rule cannot be dodged by passing the bare directory — a verify-pass finding, since `Glob(path='/secrets')` enumerates the whole directory. Canonicalisation is lexical `resolve` **plus case folding on darwin/win32**, whose default filesystems are case-insensitive — verified live in review: without folding, `/ETC/passwd` is the same file as `/etc/passwd` but a different string, dodging permissions deny rules entirely. Trade-off (documented): on an opt-in case-*sensitive* volume on those platforms, folding conflates two distinct files. A **present but empty** allowlist denies everything. A gated tool whose target field is missing or non-string is **denied** — the sandbox refuses to guess — except `Glob`/`Grep`, where the SDK defines a missing `path` as cwd, so the cwd is what gets gated.

`realpath` is still rejected (impure, needs existence fallbacks for Write targets, TOCTOU-racy): **a symlink inside an allowed directory pointing outside it defeats the path gate** — documented limitation, not solved half-way. Both sides resolve against `process.cwd()`, the same base as the S-3 evaluator and the cwd the SDK inherits from the harness process (closes the S-3 parity finding for the current architecture; re-verify if an executor with its own working directory ever lands).

### 3. Command gate: first-token honesty

What a string-level allowlist can truthfully bound is *which program starts*. When enabled: empty/whitespace commands deny; any command containing a shell metacharacter (`; | & $ ` ( ) { } < > \n \r \ !`) denies outright — once those appear we can no longer name the program, so we refuse rather than pretend to parse shell (`\` escape/continuation and `!` history expansion added in review; `*`/`~` deliberately excluded — glob/tilde expansion happens inside the allowed program's argument list and does not change which program starts). Otherwise argv[0] is compared exactly against entries: entries containing `/` compare post-`resolve` against path-style invocations only; bare names match bare names only (`git` never matches `/tmp/git`). Layer intersection uses this same identity grammar (review fix: blanket `resolve` had made bare `git` equal `./git`).

**Shell runners are a hard blocklist, not a warning.** `sh`, `bash`, `zsh`, `dash`, `ksh`, `csh`, `fish`, `env`, and `xargs` are denied by basename — case-folded on darwin/win32 (*amended 2026-07-08, Week-2 milestone review: `SH -c` resolves the same binary as `sh -c` on APFS/NTFS, and a blocklist documented as unconditional must not be case-dodgeable; the path-shaped allowlist compare and command entry-identity moved from raw `resolve` to `canonicalizePath` in the same pass so all three share the path gate's identity grammar*) — even when an allowlist names them (review escalation: `bash -c '…'` makes argv[0] analysis meaningless by construction, and a warn-only stance was security theater for a bypass class this ADR names itself). The CLI still surfaces the conflict as a startup warning so the settings author learns why their entry is inert.

**What this cannot stop** (documented non-goals): interpreter escapes (`node -e`, `python -c`) when those binaries are allowed; argv-level execution (`find -exec`, `git -c core.fsmonitor=…`); glob expansion inside an allowed program's arguments; anything an allowed program does internally. Real containment is an OS sandbox and out of scope for v1.

### 4. Module shape and composition

`src/security/sandbox/` mirrors its peers: `createSandbox(config)` returns the architecture-reserved API `{ allowPath, allowCommand, pathsEnabled, commandsEnabled }` (pure; entries canonicalised once at construction); `sandboxHook(sandbox)` is a pre-tool handler throwing its own `SandboxViolation` (not hooks' `HookDenial` — same peer-leaf rationale as ADR-0014 §7); unknown tools pass through, since the permissions layer governs them. The composition root registers `sandboxHook` **after** `permissionHook`: the deny outcome is order-independent (runtime denies on first throw), but rule-attributed permission reasons are more actionable, so permissions get first say and the sandbox is the backstop.

### 5. Shared settings loader (`src/internal/settings.ts`)

The read → ENOENT-is-empty → JSON-parse-fail-loud → path-prefixed-rethrow mechanics moved from `permissions/settings.ts` to the shared internal leaf (`loadJsonSettings<T>`), closing the S-3 architecture finding before a third module copies it. Policy (what keys mean) stays in each module's parser; permissions' public `loadSettingsFile` signature is unchanged and its tests pass unmodified — behavioural proof of the hoist. The CLI reads each settings file **once** and feeds the parsed doc to both key-parsers; malformed anything → exit 2 before any tool runs.

## Consequences

### Positive

- Negative guarantees are real and tested end-to-end: a blocked path and a blocked command are denied at the pre-tool gate and never execute (integration test in `session.test.ts`).
- Honest scope: the ADR's "cannot stop" list means nobody mistakes this for OS isolation.
- Project settings can never widen the sandbox (intersection), consistent with S-3's trust model.
- One settings read per file; no third copy of loader mechanics.

### Negative / accepted

- Symlink escapes defeat the path gate (lexical resolve only).
- The command gate is defeated by allowlisting an interpreter or shell — mitigated by the startup warning, accepted otherwise.
- Metacharacter rejection is blunt: `git commit -m "a & b"` is denied when command sandboxing is on. Accepted — precision would require a shell parser, and false denies fail closed.
- Sandbox off by default (no settings → no gate), consistent with ADR-0014 §3's posture; hardening is a few settings lines.

## Alternatives considered

- **`realpath`-based canonicalisation** — closes symlink escapes but impure, needs existence fallbacks for Write targets, and still TOCTOU-racy. Rejected; documented instead.
- **Shell parsing for command rules** (quote-aware tokenisation, subcommand allowlists) — a parser is an attack surface and still can't see inside allowed programs. Rejected for the metachar-reject + argv[0] grammar.
- **Concatenation or max-severity layer merge** — both widen allowlists across layers. Rejected for intersection.
- **Folding the sandbox into the permissions evaluator** — one module, but conflates rule-based decisions with allowlist gating and bloats ADR-0014's grammar. Rejected; separate peer module matching the reserved architecture.

## Revisit if

- WebFetch/WebSearch need gating: add a URL/domain allowlist dimension (network egress is currently ungated by design — the path/command dimensions cannot honestly claim it).

- A tool executor or OS-level sandbox (seatbelt/bubblewrap/container) lands: re-anchor path bases to the executor's working directory and consider promoting the gate to real isolation.
- Symlink escapes become a live concern: add an optional `realpath` mode with documented TOCTOU caveats.
- Users hit the metacharacter false-deny wall: consider quote-aware tokenisation with an explicit threat-model review.
- A third settings consumer appears: `loadJsonSettings` may grow layer-discovery (`user`/`project` path resolution) too.
