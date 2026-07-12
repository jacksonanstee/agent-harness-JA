# Security model

> Threat model for the security layer as shipped at the end of Week 2
> (S-1–S-4, ADRs 0012–0015). This document says what the layer defends,
> against whom, and — just as deliberately — what it does not. Claims here
> are anchored to shipped code and to incidents found and fixed in review,
> not to intentions.

## 1. Scope and posture

The harness is a **policy layer around the Claude Agent SDK**, not an
execution environment. The SDK executes tools; the harness decides, observes,
and records. Every guarantee below is therefore a *pre-execution gate* (deny
before the SDK runs a tool) or a *data-plane control* (scan/redact what the
harness persists and emits). Neither is OS isolation, and ADR-0015 makes that
explicit: a sandbox that overclaims is worse than no sandbox.

The enforcement points are steps 8–11 of the tool-call flow in
[architecture.md](./architecture.md#data-flow-a-single-agent-turn):
permissions → sandbox → injection scan → secret redaction, with telemetry
recording at every step.

Defaults are deliberately conservative where cheap (fail-closed on ambiguity,
sticky deny, intersection merges) and honest where enforcement is not yet
possible (S-1/S-2 are observe-only in v1 — see §6, residual risk R-4).

## 2. Attacker model

**In scope** — the attacker we actually expect:

- **Adversarial tool results.** A web page, file, or command output that
  contains instructions aimed at the agent (indirect prompt injection —
  Greshake et al., OWASP LLM01). This is the highest-frequency, highest-impact
  class and the reason the injection scanner exists.
- **A malicious or compromised cloned repository**, including its
  `.harness/settings.json`. Project-level config is attacker-influenced input:
  a repo you just cloned must not be able to widen what the agent may touch.
  **The `eval` command is a documented exception to "config only, never
  execution":** running `agent-harness-ja eval` against a cloned repo
  dynamically imports and executes that repo's oracle modules in-process
  (ADR-0017, R-10) — for the eval command specifically, cloning a malicious
  repo and running eval **is** code execution, and the harness says so at
  runtime (a stderr warning before the first oracle import) rather than
  pretending a gate exists.
- **Secret-bearing output.** Tool results that happen to contain credentials,
  which must not be persisted or emitted by the harness.
- **Jailbreak/manipulation text** in any scanned channel, including
  character-level smuggling (hidden Unicode, bidi controls).

**Out of scope** — attackers this layer does not claim to stop:

- A **malicious operator**. The user owns the machine and the user-level
  settings; the trust model is user > project, never the reverse.
- A **compromised SDK, Node runtime, or OS**. The gates run in the same
  process as everything else; there is no privilege boundary beneath them.
- A **network attacker** (TLS, DNS, supply chain). Nothing here inspects
  network traffic — see R-3 on the egress gap.
- **Post-execution containment.** Once a tool is allowed, what the program
  does internally is unbounded (ADR-0015 "what this cannot stop"). Real
  containment is an OS sandbox (seatbelt/bubblewrap/container), reserved for
  a future executor.

## 3. Trust boundaries

1. **User config vs project config.** User-level settings are trusted;
   project-level settings are attacker-influenced. Two mechanisms encode
   this: permission *rules* merge with **sticky deny** (a user deny survives
   any project allow — ADR-0014; note this protects rule-vs-rule conflicts
   only — the scalar `defaultDecision` is project-overrides-user by design,
   which is a real widening channel for hardened users, tracked as R-8) and
   sandbox allowlists merge by **intersection**
   (a project can only tighten, never widen — ADR-0015; concatenation would
   let a cloned repo grant itself `/`). Both settings parsers cap
   attacker-influenced list sizes (`MAX_RULES`, `MAX_ALLOW_ENTRIES` = 1000)
   and fail loud on malformed input before any tool runs.
2. **Tool results vs agent context.** Everything a tool returns is untrusted
   text until scanned. The scanner runs on the full output (not the truncated
   telemetry summary) via a cycle-safe stringifier, so odd shapes cannot
   silently bypass it (ADR-0012 §9).
3. **Harness vs SDK executor.** The harness's authority ends at the pre-tool
   throw. Both path gates resolve against `process.cwd()`, the same base the
   SDK inherits — parity that must be re-verified if an executor with its own
   working directory ever lands (ADR-0015 §2).
4. **The future LLM judge is semi-trusted.** It reads adversarial content and
   is itself injectable, so ADR-0016 grants it one-way authority: it may
   tighten a heuristic verdict, never loosen one. A successful attack on the
   judge can only produce false positives.

## 4. Assets

- **Secrets** in tool output (API keys, tokens, private keys) — 25 redaction
  rules, findings carry rule id + offsets only, never secret bytes.
- **The filesystem outside the allowlist** — sandbox path gate + permissions.
- **Command execution** — sandbox command gate (which program starts).
- **Instruction integrity of the agent** — injection scanner.
- **The telemetry record** — the audit trail everything else feeds.

## 5. STRIDE analysis

### Spoofing — content impersonating the operator or system

The channel: tool results carrying "system:" framing, role-impersonation
tokens (`<|system|>`), or "ignore previous instructions" phrasing, trying to
speak with authority they don't have. Countered by the heuristic injection
scanner (S-1): 17 detectors across 5 families (15 linear-time regex rules
plus 2 structural hidden-unicode detectors living in the pipeline), verdict
lattice
(any high-confidence hit → `block`, medium → `ask`), strip-and-rescan against
character-insertion smuggling — the re-scan triggers on *any* smuggling
character because two interleaved zero-widths defeat plaintext rules
(ADR-0012 §5, a review HIGH). Known evasions are named rather than papered
over: NFKC-normalization tricks and homoglyphs are deferred to the semantic
judge (ADR-0016), and the scanner is observe-only in v1 (R-4).

The judge itself is a spoofing target — content arguing "this is safe" to the
model evaluating it. ADR-0016's tighten-only rule bounds the blast radius.

### Tampering — corrupting policy or evaluated data

The interesting tampering target is **configuration**: a cloned repo's
settings file trying to widen policy. Sticky deny and intersection merge
(§3.1) close the widening channel by construction; there is deliberately no
sandbox `mode: off` switch, because an off-switch is a loosening lever a
project file could flip (ADR-0015 §1).

Two verified incidents shaped the anti-tampering posture of the gates
themselves:

- **The dual-table gap.** Permissions and sandbox each kept a private
  four-tool table and assumed the other covered the rest — `Glob`, `Grep`,
  `NotebookEdit`, `MultiEdit` (the exfiltration-shaped tools) bypassed
  *both* gates. Fixed with one shared table
  (`src/internal/tool-targets.ts`), pinned by a test. The pin is honest but
  bounded: it pins the table to *itself*, so it catches accidental edits, not
  SDK drift — a new path-taking SDK tool that nobody adds to the table is
  silently ungated (unknown tools pass through). That drift class is R-9, the
  same failure mode recurring, not a solved problem.
- **Case-fold bypass.** Lexical comparison on APFS let `/ETC/passwd` dodge a
  `/etc/*` deny rule — same file, different string, verified live.
  `canonicalizePath` now folds case on darwin/win32 (accepting conflation on
  opt-in case-sensitive volumes — R-6).

**The committed red-team baseline is treated as hostile input.**
`eval/redteam/baseline.json` (ADR-0019) is the keyless gate command's first
read of repo-controlled data, and a malicious cloned repo is in scope (§2).
Load order: size cap before read (1 MB, `stat` first), symlink refusal on
file and parent, full structural validation against an exact ajv field
allowlist (never just the discriminators), every baseline row id
re-validated against the corpus id charset (`^[a-z0-9][a-z0-9-]{0,63}$` —
the fresh side is guarded inside `runRedteam`, but the baseline side comes
from a file and bypasses that guard, so it gets its own check, which also
excludes `__proto__`/`constructor` as ids), `Map`-based row pairing (never
a plain-object index), and the drift report written through the CLI's
`sanitizeForTerminal`. A malformed or mismatched baseline exits 2 with a
typed message, never a best-effort diff or a mid-diff TypeError.

Excerpts are stripped of bidi controls before logging (Trojan-Source,
CVE-2021-42574), so a hostile payload cannot visually reorder the audit trail
that describes it.

### Repudiation — could an action escape the record?

This is the thinnest leg, and honestly so. Telemetry (ADR-0011) records every
step of the turn with session/turn correlation ids, hook denials land as
`denied-by-hook` events, and `rule_ids` is deliberately never capped by the
excerpt budget so the record of *which* rules fired is complete (ADR-0012
§8). But the store is a local SQLite file with no integrity protection: any
process with file access can rewrite history. Within the attacker model
(§2 — the operator and OS are trusted) that is acceptable; it stops being
acceptable if telemetry is ever used as evidence *against* a party with write
access to the machine.

### Information disclosure — secrets leaving through the harness

The secret redactor (S-2, ADR-0013) runs on tool output with 25 rules drawn
from the gitleaks/trufflehog lineage. Two properties matter more than rule
count: findings carry `rule_id` + offsets + length and **never the secret
bytes** (the audit trail cannot become the leak), and the pipeline **fails
closed** — inside the redactor a malformed rule is skipped per-rule, and at
the session wiring a redactor throw records the sentinel
`[REDACTION FAILED]` (`src/session/session.ts`), never the raw text.

The disclosure paths that remain open are stated in R-3 and R-4: network
egress tools (`WebFetch`/`WebSearch`) are ungated by design — they need a
URL/domain dimension the path gate cannot honestly claim — and the *model*
still sees unredacted output in v1, because redaction is a data-plane control
without an SDK rewrite channel. `Glob`/`Grep` — read-shaped tools an
exfiltrating agent reaches for first — are gated since the dual-table fix,
including the bare-directory case (`Glob(path='/secrets')` vs `/secrets/*`,
a verify-pass finding).

### Denial of service — resource exhaustion via hostile input

Hostile input can be pathological as well as persuasive. Every injection rule
is linear-time by construction (no backreferences, no lookbehind), enforced
by a ReDoS guard test at ~120 KB pathological input under 100 ms, and
`safeMatch` isolates any one rule's failure (ADR-0012 §7). Settings lists are
capped (§3.1) because a hostile project file is attacker-influenced input.
Judge cost — the economic DoS — is handled by keeping the judge off by
default, haiku-class, single-call, no-retry (ADR-0016 §5).

### Elevation of privilege — doing more than policy allows

The layered gate pair: permissions (S-3) answer *may this tool run with this
target* (specificity then severity, deny > ask > allow, `ask` fails closed
without a prompter); the sandbox (S-4) answers *is this target inside the
allowed universe* (boundary-safe prefix check — `/allowed` never matches
`/allowed-extra`; present-but-empty list denies all; missing target field on
a gated tool denies, because the gate refuses to guess).

The command gate claims only what a string-level check can deliver: it bounds
**which program starts**, nothing after that. Shell metacharacters deny
outright (naming the program is impossible once they appear), and shell
runners (`bash`, `sh`, `env`, `xargs`, …) are a **hard blocklist** even when
allowlisted — a review escalation, since `bash -c` makes argv[0] analysis
meaningless by construction and warn-only was security theater. What survives
is honest residue: interpreter escapes (`node -e`), argv-level execution
(`find -exec`), and symlink escapes of the lexical path gate — all named in
R-1/R-2 rather than half-solved.

## 6. Residual risks

| # | Risk | Severity | Why accepted | Tracked |
|---|------|----------|--------------|---------|
| R-1 | Symlink inside an allowed directory pointing outside defeats the path gate | High (targeted) | `realpath` is impure, needs existence fallbacks, still TOCTOU-racy; documented over half-solved | ADR-0015 §2, revisit-if |
| R-2 | Interpreter-as-wrapper (`node -e`, `python -c`) and argv-level exec when the interpreter is allowlisted | Medium | argv[0] honesty: the gate bounds which program starts; containment beyond that needs an OS sandbox | ADR-0015 §3 |
| R-3 | Network egress ungated (`WebFetch`/`WebSearch` absent from the tool table) | Medium | Needs a URL/domain dimension, not a path prefix; deliberate exclusion over false claim | ADR-0015 revisit-if |
| R-4 | Model-facing enforcement gap: S-1 verdicts observe-only, S-2 redaction doesn't rewrite what the model sees | High | No SDK result-rewrite channel exists yet; harness data plane (persist/emit) is covered | ADR-0012 §9 + revisit-if, ADR-0013 §9 |
| R-5 | LLM judge is injectable once implemented | Low (bounded) | Tighten-only authority converts compromise into false positives at worst | ADR-0016 §2 |
| R-6 | Case folding conflates distinct files on opt-in case-sensitive volumes (darwin/win32) | Low | The default-filesystem bypass it closes (`/ETC/passwd`) was live-verified; the conflation case is rare and fails toward stricter | ADR-0015 §2 |
| R-7 | Telemetry store has no integrity protection | Low | Operator and OS are trusted in this model (§2) | §5 Repudiation |
| R-8 | Project `defaultDecision` overrides the user's — a cloned repo can flip a hardened `deny` default back to `allow` for everything outside the user's explicit rules | High (for hardened users) | ADR-0014 §5 chose scalar-override deliberately; sticky deny still wins wherever a user rule exists | ADR-0014 §5 |
| R-9 | SDK tool-surface drift: a new path/command-taking SDK tool absent from `tool-targets.ts` is ungated by both gates | Medium | The pin test catches accidental table edits, not SDK additions; the tool set is manually curated | ADR-0015 §2, §5 Tampering |
| R-10 | Golden-eval oracles are arbitrary in-process code from the (in-scope) cloned repo, executed with no gate | High (targeted) | Eval is operator-invoked with a runtime stderr warning; golden eval never runs in per-PR CI (a fork PR plus a CI key secret is an exfiltration primitive) — the every-PR gate is E-3's keyless deterministic arm | ADR-0017 |

The single most important honest statement in this document is **R-4**: in
v1, a malicious tool result that the scanner flags still reaches the model,
and a secret the redactor catches is still visible to the model. The security
layer currently protects the *record* and gates the *next action*
(pre-tool denies are fully enforced); protecting the model's own context
requires a result-rewrite channel and is the named cross-cutting follow-up.

**Residual risks compose.** R-3 and R-4 chain into the most exploitable
end-to-end path under this attacker model: an adversarial tool result steers
the model (R-4 — flagged but not blocked from context), the model has seen an
unredacted secret (R-4 again), and `WebFetch` exfiltrates it in a URL query
string with no gate anywhere in the chain (R-3). Scored individually the
halves read Medium/High; composed, this is the critical-shaped scenario, and
it is why R-4's result-rewrite channel and R-3's URL/domain dimension are the
two highest-value follow-ups rather than independent nice-to-haves. Partial
mitigation today: permission/sandbox rules can deny `WebFetch`/`WebSearch`
outright (the tools are known to the permission grammar even though the
path-based sandbox table excludes them).

## 7. Verification posture

Numbers in this section are a frozen snapshot at Week-2 close (2026-07-08),
not live values:

- 572 tests, including negative tests for every fail-closed path (blocked
  paths/commands denied end-to-end in `session.test.ts`).
- The 31-case starter red-team corpus passes at ≥90% detection with ≥10
  blocks and zero benign false-positive blocks — the Week-2 checkpoint.
- Findings in this document marked "verified live" were demonstrated
  empirically during the 3-agent + differential review rounds, not reasoned
  about (`/ETC/passwd` bypass; dual-table gate gap).
- Week 3 replaces the starter corpus with the ≥50-case eval corpus (E-2) and
  the regression gate: ≥90% pass with security on, <50% with it off — the
  test that the layer is doing real work rather than decorating the repo.

## 8. ADR index

| ADR | Decision |
|-----|----------|
| [0005](./decisions/0005-injection-scanner-hybrid.md) | Hybrid heuristic + LLM-judge scanner design |
| [0012](./decisions/0012-injection-heuristics-implementation.md) | Heuristic stage implementation + S-5 seam |
| [0013](./decisions/0013-secret-redaction.md) | Secret redaction: rules, fail-closed, byte-free findings |
| [0014](./decisions/0014-declarative-permission-model.md) | allow/ask/deny permission model, sticky deny |
| [0015](./decisions/0015-sandbox-pre-tool-gate.md) | Sandbox as pre-tool gate, intersection merge |
| [0016](./decisions/0016-llm-judge-design-deferred.md) | Judge design locked (tighten-only), implementation deferred |
| [0019](./decisions/0019-regression-gate.md) | Red-team regression gate; committed baseline loaded as hostile input |
