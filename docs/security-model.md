# Security model

> Threat model for the security layer as shipped at the end of Week 2
> (S-1–S-4, ADRs 0012–0015), with dated Week-3 amendments where the eval
> layer touched the security surface (ADR-0019 hostile-baseline handling,
> ADR-0020 adversary-is-injectable, both 2026-07-12), and a Week-4
> amendment for PR #25's baseline load-path hardening (duplicate-row-id
> refusal, ancestor-chain symlink walk, single-fd `O_NOFOLLOW` read —
> 2026-07-13; see §5 Tampering) and a same-day amendment for the skill-content
> sanitization fix (issue #24: bidi-stripped diagnostics, invisible-char
> stripping + observe-only scan of skill descriptions before the system
> prompt — see §5 Tampering, §9 ASI06), and a 2026-07-28 amendment for the skill
channel becoming ENFORCED rather than observe-only (ADR-0026 — see §1, the §5
Update, R-4 in §6, and §9 ASI06). This document says
> what the layer defends, against whom, and — just as deliberately — what
> it does not. Claims here are anchored to shipped code and to incidents
> found and fixed in review, not to intentions.

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
recording at every step. One further enforcement point sits earlier, at prompt
assembly (step 3): a skill whose content trips a high-confidence injection
block is kept out of the system prompt entirely ([ADR-0026](./decisions/0026-skill-channel-block-on-flag.md)).

Defaults are deliberately conservative where cheap (fail-closed on ambiguity,
sticky deny, intersection merges) and honest where enforcement is not yet
possible (S-1/S-2 are observe-only in v1 for tool output — see §6, residual risk R-4 — with one deliberate exception: the harness-owned skill channel is ENFORCED since 2026-07-28, ADR-0026).

## 2. Attacker model

**In scope** — the attacker we actually expect:

- **Adversarial tool results.** A web page, file, or command output that
  contains instructions aimed at the agent (indirect prompt injection —
  Greshake et al., OWASP LLM01; "Agent Goal Hijack", OWASP ASI01 — see §9).
  This is the highest-frequency, highest-impact
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
character-insertion smuggling — the re-scan triggers on any character in the
enumerated smuggling set, because two interleaved zero-widths defeat plaintext
rules (ADR-0012 §5, a review HIGH). That set is now a **property, not a list**
(`\p{Default_Ignorable_Code_Point}`, `\p{Cf}`, `\p{Mn}`, `\p{Me}`), which is
the second correction it took to get right. On 2026-07-28 a review found a
class in neither this set nor the sanitiser's (U+2061–2064, U+206A–206F,
U+180E, U+FFF9–FFFB, U+1D173–1D17A) that both survived cleaning into the system
prompt and defeated the plaintext rules; the first fix enumerated exactly those
code points, and a follow-up review immediately found U+2065 — the single gap
between the range just added and the bidi range — still open, along with ~1,700
combining marks. Enumerating a class one proof-of-concept at a time does not
converge. The property form closes it by construction and tracks ICU, and a
test sweeps every code point in the class (6,080 of them) rather than a
sample. Known evasions are named rather than papered
over: NFKC-normalization tricks and homoglyphs are deferred to the semantic
judge (ADR-0016), and the scanner is observe-only in v1 for tool output (R-4); the skill channel is enforced (ADR-0026).

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
Load order (hardened in Week 4, PR #25): the file is opened once with
`O_NOFOLLOW` and `fstat`-ed on that same descriptor (no separate
stat-then-read race); for relative baseline paths every ancestor path
component is symlink-checked via a raw-component walk (raw `split`, not a
lexically normalized string — normalization would cancel `link/..`
textually while the real syscall follows the link), size cap before read
(1 MB), full structural validation against an exact ajv
field allowlist (never just the discriminators), explicit refusal of
duplicate baseline row ids at load (`BaselineError`, exit 2 — previously a
duplicate surfaced only as a confusing `removed` drift), every baseline row id
re-validated against the corpus id charset (`^[a-z0-9][a-z0-9-]{0,63}$` —
the fresh side is guarded inside `runRedteam`, but the baseline side comes
from a file and bypasses that guard, so it gets its own check; the charset
also rejects `__proto__`, though not `constructor`), `Map`-based row
pairing — which, not the charset, is what makes pairing immune to
prototype-key ids like `constructor` (a plain-object index would not be) —
and the drift report written through the CLI's `sanitizeForTerminal`. A malformed or mismatched baseline exits 2 with a
typed message, never a best-effort diff or a mid-diff TypeError.

Excerpts are stripped of bidi controls before logging (Trojan-Source,
CVE-2021-42574), so a hostile payload cannot visually reorder the audit trail
that describes it. As of 2026-07-13 (issue #24) the same stripping covers the
skills-loader diagnostics (`SkillError` file/field/message) and the skill
name/description lines that `buildSystemPrompt` emits — previously separate,
weaker sinks (the prompt sink also drops invisible smuggling chars:
zero-width, tag block, variation selectors — combining marks are deliberately
left, as they are legitimate in NFD accented text). Skill descriptions are
additionally run through the injection
scanner at session start (observe-only, the R-4 posture): they enter the
system prompt, which made them a context-poisoning channel that bypassed the
scanner entirely.

As of 2026-07-14 (ADR-0006 amendment) the same treatment covers full skill
**bodies**, which now enter the system prompt whole — the body is the skill's
actual content, and until then it never reached the model at all. This is a
deliberate widening of the R-4 observe-only surface, and a materially
stronger one than tool output: a hostile body lands at system-prompt
authority, unconditionally, at session start, with no tool call required.
Accepted for v1 because the channel is operator-opted-in (the operator
chooses the skills directory), every body is scanned raw before charset
stripping with a per-skill-labelled warning, and the aggregate injected size
is budget-capped in `buildSystemPrompt` (whole-skill drop + warning, on top
of the loader's per-file 1 MB cap). The named follow-up is a stricter policy
for this channel specifically — unlike arbitrary tool output, a legitimate
skill has no reason to contain scanner-flagged override phrasing, and unlike
tool output the harness owns this channel, so blocking is implementable
without an SDK rewrite channel.

**Update 2026-07-28 ([ADR-0026](./decisions/0026-skill-channel-block-on-flag.md)): that follow-up shipped, and this
risk acceptance is largely discharged.** A high-confidence `block` on a skill's
description or body now keeps the whole skill out of the system prompt; the
session continues on the remaining skills. Enforcement covers the description as
well as the body, because otherwise the payload simply moves there at identical
authority. What remains accepted is narrower, and named honestly in ADR-0026:
the premise above — that a legitimate skill has no reason to contain
scanner-flagged phrasing — is FALSE for several high-confidence rules
(`markdown-image-exfil` catches a shields.io badge, the chat-template rules catch
a skill that quotes a chat template, the override-phrasing rules catch a skill
that *documents* injection, and `do-not-tell-user` catches
instruction-shaped prose that skills legitimately contain), so real
false-positive drops are possible and the remedy is editing the skill file —
which degrades to forking for a third-party pack. Enforcement is also a property
of the COMPOSITION, not the session: `scanInjection` is optional, and a consumer
who omits it gets no enforcement at all.

**The adversarial verifier's adversary reads attacker-influenceable content
and is itself injectable (ADR-0020, E-4).** Two payloads reach the
`--challenge` model on every call: the golden task prompt (repo-controlled —
a malicious cloned repo is in scope, §2) and the primary agent's own output
(a live, redacted tool-use result — content an adversarial tool result may
already have steered, per R-4). Both are delimited with per-call random
boundary tokens (`crypto.randomBytes`, distinct per call — a fixed delimiter
would let either payload contain and forge the boundary) and labelled
untrusted; the oracle `.mjs` source is never sent to it. **Authority
analysis: a compromised adversary is noise, never authority.** Three
independent controls hold that line, not one: (1) **enum confinement** — the
adversary's response can only ever select a closed `{status, category}` pair
via a strict two-branch `oneOf` schema (ADR-0016 decision 4's structured-verdict-
only requirement, applied here); a compromised or manipulated adversary
cannot inject prose, cannot widen the category set, and an out-of-enum or
malformed response degrades to a `verifier-error` finding rather than an
undefined mapping cell. (2) **Report-only, machine-enforced** — findings can
never touch `totals`, `pass`, `failureKind`, or the exit code (a CI-safe
differential invariance test pins this, ADR-0020 §9), so "convince the
adversary" is not an attack with any payoff: there is nothing for a
successful manipulation to unlock. (3) **A de-fanged call channel** — the
adversary call wraps the SDK's `query()` with `maxTurns: 1` and a deny-all
`PreToolUse` hook, so even a fully compromised adversary turn cannot execute
a tool; this is deliberately stricter than a normal session (which at least
sits behind the real permission/sandbox gates), because the adversary call
has no session-level gates to fall back on otherwise. The composed guarantee
mirrors ADR-0016 decision 2's judge posture (compromise can only ever
produce a false positive) at zero authority instead of one-way authority —
ADR-0020 states the two documents' equivalence explicitly so they don't read
as conflicting.

**Provider-pluggability is out of scope for the adversary until
redact-before-egress is a hard precondition.** The routing table is
structurally all-Anthropic (`src/router/table.ts`), so router-pinned
adversary selection is itself a same-provider control: sending primary
output to a non-Anthropic model would egress content that may carry
un-rewritten secrets (R-4) to a new trust domain with no redaction gate in
front of it. The runner redacts `resultText` before it ever reaches the
verifier (`redactSecrets` is a required `GoldenRunnerDeps` dependency as of
ADR-0020, closing ADR-0017's revisit-if M1) as defense in depth on top of
the same-provider pin, but that redaction step is what a future
cross-provider adversary would need to make a hard precondition, not an
optional layer.

### Repudiation — could an action escape the record?

This is the thinnest leg, and honestly so. Telemetry (ADR-0011) records every
step of the turn with session/turn correlation ids, hook denials land as
`denied-by-hook` events, and `rule_ids` is deliberately never capped by the
excerpt budget so the record of *which* rules fired is complete (ADR-0012
§8). Since 2026-07-29 (issue #46) the harness's one model-facing enforcement
action is covered too: a skill dropped from the system prompt writes a
`skill-drop` row naming the skill, the reason, the scanned channels and the
rules that fired, so "when did this skill stop reaching the model, and why?"
is answerable from the record rather than only from a stderr line that scrolls
away. Two limits on that, stated rather than glossed: recording is best-effort
(`deps.telemetry` is optional and a failed write is downgraded to a warning),
and the row carries which rules fired, not the matched text (R-c). But the
store is a local SQLite file with no integrity protection: any
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

**Model choice is a disclosure dimension, not only a cost one (2026-07-27,
ADR-0024).** The provider-pluggability note below blocks a cross-provider
adversary because primary output may carry un-rewritten secrets (R-4) into a
trust domain with no redaction gate. The same reasoning applies *within*
provider: `claude-fable-5` is nameable from a custom routing table and
requires 30-day data retention, so a consumer who opts into it converts their
retention posture and composes that with R-4 — a flagged-but-unredacted
secret in a Fable-routed turn is retained vendor-side for 30 days. No shipped
default rule selects it (ADR-0024 decision 1), so this is reachable only by
explicit opt-in, which is why it is a documented consequence rather than a
control. See R-14, and R-15 for the related case where a fallback swap moves a
turn to a model the router did not choose.

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
| R-4 | Model-facing enforcement gap for TOOL OUTPUT: S-1 verdicts observe-only, S-2 redaction doesn't rewrite what the model sees. NARROWED 2026-07-28 (ADR-0026): the skill channel — descriptions and bodies, which enter the system prompt at system-prompt authority — is now ENFORCED, because R-4's no-rewrite-channel rationale never applied to a prompt the harness assembles itself. A high-confidence block drops the whole skill | High | No SDK result-rewrite channel exists yet; harness data plane (persist/emit) is covered. Skill bodies: raw-scanned + charset-stripped + aggregate size budget; block-on-flag for this harness-owned channel SHIPPED 2026-07-28 (ADR-0026), with its accepted false-positive classes named there; enforcement is a property of the composition, since `scanInjection` is optional | ADR-0012 §9 + revisit-if, ADR-0013 §9, ADR-0006 amendment |
| R-5 | LLM judge is injectable once implemented | Low (bounded) | Tighten-only authority converts compromise into false positives at worst | ADR-0016 §2 |
| R-6 | Path canonicalization conflates distinct files that share a canonical form: case folding on opt-in case-sensitive volumes (darwin/win32), and NFC folding of a file that genuinely differs only by Unicode form (added 2026-07-15, audit finding V11, to close the NFC/NFD deny-rule bypass) | Low | Both fold toward "same file → same string"; the bypasses they close (`/ETC/passwd`, NFC-vs-NFD deny dodge) were live-verified, and both conflation cases are rare and fail toward stricter for deny rules | ADR-0015 §2 |
| R-7 | Telemetry store has no integrity protection | Low | Operator and OS are trusted in this model (§2) | §5 Repudiation |
| R-8 | Project `defaultDecision` overrides the user's — a cloned repo can flip a hardened `deny` default back to `allow` for everything outside the user's explicit rules | High (for hardened users) | ADR-0014 §5 chose scalar-override deliberately; sticky deny still wins wherever a user rule exists | ADR-0014 §5 |
| R-9 | SDK tool-surface drift: a new path/command-taking SDK tool absent from `tool-targets.ts` is ungated by both gates | Medium | The pin test catches accidental table edits, not SDK additions; the tool set is manually curated | ADR-0015 §2, §5 Tampering |
| R-10 | Golden-eval oracles are arbitrary in-process code from the (in-scope) cloned repo, executed with no gate | High (targeted) | Eval is operator-invoked with a runtime stderr warning; golden eval never runs in per-PR CI (a fork PR plus a CI key secret is an exfiltration primitive) — the every-PR gate is E-3's keyless deterministic arm | ADR-0017 |
| R-11 | The SDK's bundled Claude Code runtime reads ambient user-level configuration outside the harness's assembly of the system prompt — operator machine config can surface in agent output, unfiltered by S-1/S-2 and invisible to the harness (observed live, 2026-07-14, while dogfooding `examples/repo-qa`) | Low (today; rises with multi-user or PII-bearing deployments) | The harness is a policy layer around the SDK, not an isolator (§1); no SDK channel exists to suppress or inspect the bundled runtime's config surface. Named so operators know the system prompt is not fully self-contained | ADR-0003, ADR-0010; [docs/blog/harness-not-framework.md](./blog/harness-not-framework.md) |
| R-12 | Keyword-anchored secret rules bound delimiter whitespace at 20 chars (widened from 3 after a 2026-07-14 audit finding): an assignment padded with 21+ whitespace characters between keyword and value still evades redaction, and the deliberately excluded unanchored generic rule (ADR-0013) means no other rule backstops it | Low | Any fixed bound has an edge; 20 covers realistic column-aligned config, and every widening trades a little false-positive surface. The pattern stays a single-level bounded quantifier per the linear-time contract | ADR-0013; `src/security/secrets/rules.ts` |
| R-13 | The command gate's exec-wrapper blocklist (shells plus `sudo`/`timeout`/`nohup`/… ) is necessarily non-exhaustive: an argv-passthrough wrapper nobody has enumerated still runs if an operator allowlists it | Medium | A blocklist over an allowlist is defence-in-depth, not the boundary — the allowlist decides which programs run at all, and the blocklist only catches known wrappers an operator allowlisted by mistake (added 2026-07-15, audit finding V10) | ADR-0015 §3 |
| R-14 | **Closed as a code gap 2026-07-28 (ADR-0025); what remains is a detection-fidelity residual.** A refusal is now surfaced on `SessionResult.refusal` / `stopReason`, warned about, recorded in telemetry, and printed to stderr by `run`. Residual: the refusal *category* and the *fallback model* come from SDK banners the SDK documents as absent from older CLIs, so on such a CLI a refusal is still detected (via `stop_reason`) but reports `category: null`. The `stop_reason` channel itself is verified live (a real run captured `end_turn` through to both retained sinks, 2026-07-28); the `'refusal'` value on it and both banners are verified against the pinned SDK contract and scripted-stream tests only, never by a provoked live refusal (ADR-0025 "Verification, and its named limit") | Low | Two independent channels are read precisely because neither covers every deployment; the weaker one still answers "did the model refuse". Deliberately not captured: `api_refusal_explanation`, which is model-authored prose that would open a new untrusted channel into two retained sinks (ADR-0025 decision 2) | ADR-0025, ADR-0024, ADR-0010; `src/session/session.ts` |
| R-15 | A refusal retried on a **fallback model** returns a genuine answer from a model the router did not choose, and `SessionResult.modelChoice` plus the telemetry `model` field still name the routed one. The harness never sets `fallbackModel` itself, and **reachability is deliberately not bounded here**: known channels are the operator's own ambient configuration (R-11), an on-disk enterprise managed-settings/MDM tier, and a **server-supplied settings payload** via the SDK's `'remote'` policy origin, which is documented as passing non-restrictive keys through unfiltered and is authored by neither the operator nor any administrator on the machine. The SDK also references server-side gating of the fallback path ("declined or gate-failed") whose conditions it does not document | Medium | Detected and reported rather than prevented: `refusal.fallbackModel` names the answering model, a warning fires, `run` annotates the model claim on stdout as well as printing the refusal line to stderr, and both the telemetry row and the golden scorecard carry the channel. The run still exits 0, because there is a real answer and a non-zero exit would misreport the outcome (ADR-0025 decision 4). Rated Medium rather than Low because an operator can inherit a swap they never configured and cannot see, and because it composes with R-4: the answering model's retention posture may not be the one ADR-0024 decision 1 vetted for the routed model. An earlier draft of this row claimed the swap was reachable only via R-11; that claim was refuted from the SDK typings during verification and the correction is recorded in ADR-0025 | ADR-0025 decision 4, §6 R-4/R-11; `src/session/session.ts` |
| R-16 | **`pathDigest` is an unsalted hash of a pre-image whose discarded part carries the operator's home directory.** Truncation of a skill-drop `path` is tail preserving, so what it discards is the LEADING directories, where `/Users/<name>` or `/home/<name>` sits. **Reason corrected 2026-07-31 (ADR-0027), severity and conclusion unchanged:** that holds asymptotically but NOT in a band immediately past the cap. Truncation keeps the last `cap` characters, so it drops exactly `length - cap` leading ones and the username survives until the drop reaches it. The band is `[cap + 1, cap + lead.length]`, its width being the length of the segment preceding the username, independent of the username's own length (measured: 7 for `/Users/`, 6 for `/home/`, 15 for a longer service-account lead). Inside that band a row carries BOTH a digest and a cleartext username, and past it a partial username survives further still while the client or project directory outlives the username by the username's own length plus the directory sitting between them, a margin that is measured rather than being a function of the home path's width. Pinned by two tests in `src/telemetry/store.test.ts` that derive from `SKILL_DROP_PATH_MAX` rather than hardcoding a length. The stored digest covers the full raw path, and `telemetry export` emits it. The attack is not a collision search but a confirmation of one of N guesses: the attacker authored the skill pack, so they already know the tail, and the only unknown is a short low-entropy prefix. Digest WIDTH is therefore irrelevant to it, verified by a review PoC that recovered the correct home directory at both 64 and 128 bits. **Amended 2026-08-07 (ADR-0031 decision 6): the STORED-VALUE half of this row is closed for new rows** — the stored path is root-relative, so the band a truncated value retains is below-root segments, which exclude the username whenever the skills root sits below or disjoint from `$HOME` (a root at or above it re-admits home segments as below-root content — operator-chosen, documented); the two band tests keep pinning the truncator's arithmetic, which is unchanged at the function level. **The DIGEST half is unchanged and is now the row's only home-prefix carrier**: the pre-image deliberately stays the raw absolute path (ADR-0027 decision 5), so the confirm-one-of-N-guesses attack this row describes still applies to truncated rows, and legacy rows on an operator's disk keep their absolute stored values (nothing regenerates them) | Low, and it is **not the weakest link in its own export**: `tool-trace.resultSummary` carries redacted tool output in which no secret rule matches a path or a username, so ordinary output (`pwd`, `ls`, an `ENOENT` message) puts the same home directory into an adjacent row in cleartext (issue #59, verified against `dist/`: the redactor returns such a path byte-identical with zero findings). Reaching an adversary requires the export to be shared, which the operator does deliberately. **If #59 closes, this row must be re-costed**, because the digest would then be the weakest link it currently is not | A keyed HMAC was designed and **rejected on evidence** after a three-reviewer panel (2026-07-29), not skipped for cost. Three objections, two independent of the first: the placement it chose is `./.harness/`, which §2 names attacker-influenced input, so a cloned repo can ship its own key and the mitigation becomes a no-op along its success path while claiming closure (a trusted placement under `homedir()` DOES exist and is reachable per §3, but it would introduce this project's first at-rest secret, first write under `homedir()` and first file-permission requirement, so it is ruled out on cost rather than impossibility); HMAC zero-pads its key, so an empty or zero-filled key file collapses every installation onto one globally known key with no error from Node (verified empirically); and "omit the digest when the key is unavailable" is attacker-triggerable and overloads an absence that, on a row where `pathTruncated` is true, four places currently define as meaning "this row predates the field". The accepted state is honest disclosure. ADR-0011 **decision 17** carries the full argument, the rejected alternatives and the revisit condition; decision 16 carries the field's collision-resistance history | ADR-0011 decisions 17 and 16; issue #53; issue #59; `src/telemetry/store.ts` `boundSkillDropPath` |
| R-17 | **Cleartext filesystem paths reach retained sinks through five channels R-16 does not name, three of which are now closed, and no secret rule matches a path or a username** (issue #59; `DEFAULT_SECRET_RULES` is 25 rules and every one targets a credential). (a) ~~A skill-drop `path` is stored in FULL for every path at or under the cap, because `boundSkillDropPath` returns early with no digest when nothing was discarded (`src/telemetry/store.ts`), so the realistic case is cleartext rather than digested and R-16 covers only the long-path tail of the distribution.~~ **(a) NARROWED, not closed (issue #59 round 2 / ADR-0031 decision 6, 2026-08-07):** the stored `path` is now ROOT-RELATIVE to the skills directory the loader scanned (`relativeSkillDropPath`, `src/session/skill-drop-path.ts`), classified against the loader's own captured root (`LoadResult.root` — a held operand, never a fresh ambient resolve) with an ADR-0030-shape suppress fall-through and an always-present `pathForm` signal, optional on read so legacy absolute rows still read. The home directory and everything above the skills root no longer reach the row — for a root below or disjoint from `$HOME`; a root at or above it (`/`, `/Users`) places home segments below the root, where they store like any other segment (operator-chosen configuration, pinned as documented behaviour by a classifier test). What SURVIVES, and why this is narrowing under ADR-0027 decision 4's ceiling rather than closure: everything BELOW the root stores in cleartext, operator-authored client-named subdirectories included; on truncated rows the digest (pre-image deliberately still the raw absolute path, decision 5) is now the row's only home-prefix carrier; and cross-root sub-cap rows at equal relative positions store byte-identically with no digest, an accepted cost recorded in ADR-0031 with the ADR-0011 decision 17 cross-reference. (b) ~~The golden scorecard embeds `resolve(taskDir)` verbatim in `meta.taskDir` on every eval run, unconditionally; measured on this machine, 22 of 22 golden scorecards on disk (11 in `.harness/eval/`, 11 in `examples/repo-qa/.harness/eval/`) contained the operator's home directory.~~ **CLOSED in two steps (issue #62, 2026-07-31; issue #64 / ADR-0030, 2026-08-04), and the closure mechanism is the load-bearing part:** `meta.taskDir` is recorded relative to the working directory when the task directory sits at or under it, and suppressed to null otherwise (`portableTaskDir`, `src/eval/golden/runner.ts`). This channel was fixable where the others were not because `taskDir` is a single harness-computed field whose input and output the harness both know at write time, so `relative()` closes it without consulting `os.homedir()`. The only ambient value it reads is the invoking `cwd`, which unlike `$HOME` cannot be well-formed but wrong, so the transform cannot degrade into a no-op that reports success (ADR-0027 decision 3). Since issue #64 (ADR-0030) the escape case suppresses instead of storing a walk-up: when `cwd` is not at or above the task directory (`relative()` would spell out the intervening absolute segments, home directory included, on its way back down from the common ancestor), the scorecard stores `taskDir: null` with `taskDirForm: 'suppressed'` as the in-row signal ADR-0027 decision 3 requires, and the CLI warns on stderr. Suppression stores nothing in the refusing case, which is why decision 4's prefix-hygiene ceiling does not bite here, and why this is a closure of channel (b) only, never progress on this issue's title. Verified live on freshly produced scorecards (pre-#62 scorecards on an operator's disk keep their absolute paths; nothing regenerates them): a clean-shape run writes `"taskDir": ".", "taskDirForm": "relative"` and an escape-shape run writes `"taskDir": null, "taskDirForm": "suppressed"`, both with zero occurrences of the home directory anywhere in the JSON. (c) ~~Hook-event `reason` and (d) the `denied[]` entries persisted into `memory_entries` both interpolate the operator's own permission glob verbatim through `describeRule` (`src/security/permissions/evaluate.ts`), which is routinely an absolute path and requires no tool output and no model output at all; the `denied[]` copy additionally bypasses both `redactForPersistence` and `truncate` (`src/session/session.ts`).~~ **(c) and (d) CLOSED (issue #59 round 2 / ADR-0031, 2026-08-07):** the retained reason format no longer contains the `match` glob at all — `describeRule` emits `<decision> <tool> [rule <index>, <layer>]`, with the index now counting within the winning layer's OWN settings file so the identifier the operator recovers with actually indexes the file the layer tag names (a combined-list index mis-attributes whenever user rules exist; panel-executed counterexample). No fired-signal accompanies this because no transform exists to signal: the string is glob-free by construction, with no conditional path that can silently no-op (ADR-0027 decision 3 binds ambient-keyed transforms, and this keys on nothing). The `denied[]` copy additionally now passes redact-then-truncate at the memory write as defence in depth — any registered hook's throw message lands there, not only harness-authored reasons. The model-facing copy (`permissionDecisionReason`) is glob-free too, closing the echo-into-memory path as a side effect — a passive-disclosure closure only: every `evaluate()` remains an allow/deny oracle, so an adversarial model can still learn rule boundaries by gated, telemetry-visible probing, which predates this change and is not claimed closed. (e) `memory_entries.content` carries `prompt` and `resultText`, redacted and truncated but not path filtered (`src/session/session.ts`) | Low, on the same basis as R-16: reaching an adversary requires the artefact to be shared, which the operator does deliberately, and this is disclosure BY an operator rather than exfiltration by an attacker. Two qualifications this row must carry rather than bury: (b) **was unconditional and per run**, making it a higher-frequency disclosure than the conditional one #59 was filed about, and it was named by neither #59 nor R-16 until issue #62 was filed from this row; it is now closed, in the two steps recorded above. And the memory channel's route is sharing the database file, NOT an export, because there is no memory export subcommand | **(a): NARROWED to below-root disclosure (ADR-0031 decision 6, shipped 2026-08-07). (e): accepted, not mitigated. (b): closed, issue #62 for the unconditional case (2026-07-31) and issue #64 / ADR-0030 for the escape case (2026-08-04). (c) and (d): closed, issue #59 round 2 / ADR-0031 (2026-08-07).** Three fixes were designed and all three killed by independent review, each for a different structural reason (ADR-0027): elision at the summary seam, normalisation at every sink, and an export-time scrub. All three key on `os.homedir()`, which returns `$HOME` verbatim, is unrecorded in the row, and degrades with no signal, so a well-formed but WRONG `$HOME` (CI's `/home/runner`, a container's `/root`, or a `--db` exported from another machine) turns the mitigation into a total no-op that still reports success. The sink-wide variant additionally collapsed two distinct paths onto one identical `pathDigest`, destroying the correlation property the field exists for (issue #50), verified by execution. Any future attempt must record the home value in the row or take it as an explicit operator argument with no environment default. Even a working transform reaches only prefix hygiene: the client and project names survive it | ADR-0027; ADR-0030; ADR-0031; issue #59; ADR-0013 (why no unanchored path rule); `src/telemetry/store.ts`, `src/eval/golden/runner.ts`, `src/security/permissions/evaluate.ts`, `src/session/session.ts` |
| R-18 | **A skill BODY reaching column 0 can emit block-level markdown the harness does not authenticate, and the largest instance is an unclosed code fence that swallows every LATER section.** Issue #45 preserves newlines in bodies, so a body can end inside an open ```` ``` ```` fence; the next skill's correctly nonced header then reads as an illustration INSIDE that fence, and the operator policy skill can be the section absorbed. Load order is ordinal by bare filename, so the attacker picks a name that sorts first. `scan()` returns `pass`, `droppedSkills` is empty and no warning fires. The same reachability admits `# HARNESS OVERRIDE` (an H1, structurally above `##`), `---`, HTML comments and a forged restatement of the delimiter contract. **The `description` half of the fence case IS closed** (`defangFenceOpener`, ADR-0028 decision 8), and that half was reachable on every release before it | Medium. It is context-swallowing, NOT nonce forgery: verified during review that the genuine 16-hex token never appears in attacker-controlled text and the real header arrives byte-identical, so the model retains an authenticated signal even inside a swallowed region. The defence is the nonce plus the preamble rather than markdown structure, exactly as decision 2 already accepts | **Accepted, and two appending mitigations were BUILT AND WITHDRAWN rather than skipped for cost.** Both manufactured section-swallowing leaks no release before them had, one firing on an honest authoring typo with no attacker present, because whether a line opens a fence is a fact about block context that a line-based pass does not have. Defanging the body instead would destroy the feature #45 exists to deliver. Pinned by a test that asserts the WEAKNESS ("does NOT stop a hostile body leaving a fence open"), plus two benign-input tests that go red under either bad mitigation. Revisit when the S-5 judge lands (ADR-0016) or prompt assembly gains a real parser | ADR-0028 decision 8 + Consequences; ADR-0026; issue #45; `src/session/session.ts` |

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
- Week 3 replaced the starter corpus with the 51-case eval corpus (E-2,
  ADR-0018) and the regression gate (E-3, ADR-0019). The gate is **not** a
  pass-rate threshold — gating on a detection percentage would strand
  honest new cases the scanner misses (ADR-0018's gate-vs-measurement
  split). The every-PR gate is `falseBlockCount === 0` plus no drift
  against the committed baseline; detection rate (92.5% measured at E-2
  design time, with the security-off null-scanner control at a
  guaranteed 0%) is a **reported** metric feeding the ADR-0016 §6 S-5
  decision. That reported on/off split is the test that the layer does
  real work rather than decorating the repo.

## 8. ADR index

| ADR | Decision |
|-----|----------|
| [0005](./decisions/0005-injection-scanner-hybrid.md) | Hybrid heuristic + LLM-judge scanner design |
| [0012](./decisions/0012-injection-heuristics-implementation.md) | Heuristic stage implementation + S-5 seam |
| [0013](./decisions/0013-secret-redaction.md) | Secret redaction: rules, fail-closed, byte-free findings |
| [0014](./decisions/0014-declarative-permission-model.md) | allow/ask/deny permission model, sticky deny |
| [0015](./decisions/0015-sandbox-pre-tool-gate.md) | Sandbox as pre-tool gate, intersection merge |
| [0016](./decisions/0016-llm-judge-design-deferred.md) | Judge design locked (tighten-only), implementation deferred |
| [0017](./decisions/0017-golden-runner.md) | Golden runner; oracles are ungated in-scope code with runtime warning (R-10) |
| [0018](./decisions/0018-redteam-corpus.md) | 51-case red-team corpus; gate-vs-measurement split |
| [0019](./decisions/0019-regression-gate.md) | Red-team regression gate; committed baseline loaded as hostile input |
| [0020](./decisions/0020-adversarial-verifier.md) | Two-pass adversarial verifier: offline, report-only, enum-confined; adversary is injectable but zero-authority |
| [0022](./decisions/0022-npm-publish.md) | Publish via OIDC trusted publishing with provenance; pack allowlist audited; `id-token: write` confined to a job that runs no dependency code (2026-07-24 amendment); gate sequence shared via one `workflow_call` workflow so the deploy path cannot drift weaker than CI (2026-07-28 amendment, R6) |
| [0025](./decisions/0025-refusal-handling.md) | A refusal is a distinguishable outcome, not an empty success; two detection channels; model-authored refusal prose deliberately not retained (R-14, R-15) |
| [0026](./decisions/0026-skill-channel-block-on-flag.md) | Skill channel is ENFORCED, not observe-only: a high-confidence block drops the whole skill from the system prompt (scoped exception to R-4, since the harness assembles this prompt itself); accepted false-positive classes named |
| [0027](./decisions/0027-cleartext-paths-in-retained-sinks.md) | Cleartext paths in retained sinks: three fixes designed and all three killed on evidence; `taskDir` closure begun (R-16, R-17; completed by ADR-0030) |
| [0028](./decisions/0028-skill-section-nonce-delimiter.md) | Nonce-authenticated skill-section delimiter; bodies keep their markdown; `description` fence defanged and the body fence accepted as residual after two appending mitigations were withdrawn (R-18) |
| [0030](./decisions/0030-taskdir-escape-suppression.md) | Golden scorecard `meta.taskDir` suppresses every escaping form: null plus an always-present `taskDirForm` signal instead of any walk-up; R-17 channel (b) closed, the other four channels unchanged |
| [0031](./decisions/0031-retained-deny-reasons-drop-the-glob.md) | Retained deny reasons drop the permission glob and index within the rule's own layer file (R-17 channels (c) and (d) closed); skill-drop paths store root-relative with a `pathForm` signal (channel (a) narrowed); the explicit-argument export scrub stays accepted for its own PR |

## 9. OWASP Agentic Top 10 mapping

*Added 2026-07-13. The [OWASP Top 10 for Agentic Applications](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) (ASI01–ASI10, December 2025) is the current reference taxonomy for agent-specific risk; earlier sections of this document cite the older LLM Top 10 where individual controls were designed against it. This table maps each ASI risk to this harness's control — or to the honestly-named residual gap.*

| ASI | Risk | This harness | Ref |
|-----|------|--------------|-----|
| ASI01 | Agent Goal Hijack | Heuristic injection scanner (S-1) on tool results; LLM-judge stage designed, not yet implemented. Residual: verdicts are observe-only in v1 (R-4) | ADR-0012, ADR-0016, §6 R-4/R-5 |
| ASI02 | Tool Misuse & Exploitation | Pre-tool permission + sandbox gates, fail-closed | ADR-0014, ADR-0015, §6 R-2/R-9 |
| ASI03 | Agent Identity & Privilege Abuse | Sticky deny; intersection merge (project config tightens, never widens). Residual: scalar `defaultDecision` override (R-8) | ADR-0014 §5, §6 R-8 |
| ASI04 | Agentic Supply Chain Compromise | Cloned repo is in-scope attacker (§2); baseline loaded as hostile input; skills-loader symlink containment. Outbound: publish is OIDC trusted publishing with provenance, SHA-pinned actions, and `id-token: write` confined to a job that runs no dependency code — the gates it depends on run from a shared `workflow_call` workflow whose jobs are capped by the permissions of the *calling* job (a callee can only downgrade, never elevate) and by its own `contents: read` declaration, so the deploy path runs the same checks as PR CI and no more privilege. Residual: the approval environment is inert until reviewers are configured, the tarball is packed at publish time rather than being the byte-identical gated artefact, and no Dependabot config exists so no pin auto-updates | ADR-0022 (+2026-07-24, 2026-07-28 amendments), ADR-0019, §3, §5 Tampering |
| ASI05 | Unexpected Code Execution | Oracles named as ungated in-scope code, runtime-warned, never in per-PR CI; frontmatter JS-engine neutralized | ADR-0017, §6 R-10, §5 Tampering |
| ASI06 | Memory & Context Poisoning | Skill descriptions (2026-07-13) and full bodies (2026-07-14) scanned + smuggling-stripped before the system prompt; aggregate injected-size budget. Since 2026-07-28 a high-confidence block DROPS the whole skill from the prompt (ADR-0026); the observe-only gap now applies to tool output only. Section headers are nonce-authenticated (ADR-0028), and bodies now keep their newlines, so flattening no longer prevents a body from reaching column 0; the block-level structure that reachability admits is tracked as R-18 | §6 R-4 and R-18, §5 Tampering, ADR-0012 §9, ADR-0026, ADR-0028, ADR-0006 amendment |
| ASI07 | Insecure Inter-Agent Communication | Verifier channel: per-call random boundary tokens, untrusted labelling, oracle source never sent | ADR-0020 |
| ASI08 | Cascading Agent Failures | Fail-closed posture; drift gate fails red rather than degrading | §1, ADR-0015, ADR-0019 |
| ASI09 | Human-Agent Trust Exploitation | Named gap: no control. The §5 spoofing detectors defend the agent from impersonated authority (the ASI01 direction), not the human from over-trusting agent output; the harness ships no mechanism that flags persuasive output or requires independent validation before human approval | §5 Spoofing (contrast) |
| ASI10 | Rogue Agents | Adversary de-fanged by construction: maxTurns=1, deny-all PreToolUse on the challenge channel | ADR-0020 |

Rows deliberately point at §5/§6/ADR anchors rather than restating mechanism —
those sections are the single source of truth; this table is an index.
The composed R-3+R-4 chain in §6 is the ASI01→ASI06 escalation narrative in
this taxonomy's terms.

<!-- FORWARD-REF discharged 2026-07-24: ADR-0022 landed (and was amended for
     audit finding V20), the ASI04 row above now cites it, and ADR-0019's
     "Revisit if" records the report-only branch as resolved at publish. -->
