# ADR-0020: Two-pass adversarial verifier — offline, report-only, enum-confined (E-4)

- **Status:** Accepted
- **Date:** 2026-07-12
- **Requirements:** E-4 (SHOULD)
- **Relates to:** ADR-0016 (LLM-judge tighten-only/fail-closed design — this
  ADR's report-only floor is the analogue at a different authority level;
  §Router legality distinguishes the two judges' layers), ADR-0017 (golden
  runner — the verifier extends `GoldenScorecard`; its revisit-if M1,
  "a second runner composition appears," fires here), ADR-0018 (scorecard
  core the verification section builds beside; the gate-vs-measurement split
  this ADR's challenge-rate metric follows), ADR-0019 (row-determinism /
  hostile-input handling precedent this design borrows without reusing code)
- **Design:**
  [2026-07-12-e4-adversarial-verifier.md](../../process/designs/2026-07-12-e4-adversarial-verifier.md)
  · **Decision log (3 rounds):**
  [2026-07-12-e4-adversarial-verifier-decision-log.md](../../process/designs/2026-07-12-e4-adversarial-verifier-decision-log.md)

## Context

Requirement E-4 (SHOULD): "A two-pass adversarial verification module is
available as a runtime guardrail OR offline eval, with the second pass model
pluggable." Acceptance: "Test using Claude as both primary and adversary."

Golden oracles (ADR-0017) judge the `SessionResult` self-report only — a
named limitation, not an oversight. A task can pass its oracle while the
output is incomplete, wrong in ways the oracle doesn't assert on, or unsafe.
A second model challenging the primary's output is the one mechanism in the
eval layer that can surface information the deterministic oracle
structurally cannot see. E-4 builds that mechanism as an offline, report-only
eval step.

The design went through three review passes before implementation: a
3-reviewer structured panel (skeptic + constraint-guardian, blind, plus a
user-advocate) and arbiter ruling on the architecture (disposition APPROVED
on an "A-minimal" revision, 6 binding conditions, one option REJECTED
outright); a round-2 blind pass by the same panel roles against the
committed spec text (23 precision-gap findings, all folded same-day, no
architecture challenged); and a round-3 external Gemini adversarial pass
against the implementation plan (3 rounds, verdict SOUND, one real catch —
see §Round 3). This ADR is the durable record of that design as shipped.

## Decisions

### 1. Locked decisions (user, pre-panel)

- **U1 — Offline eval only.** The runtime-guardrail wiring is not built; the
  requirement's OR is resolved to the eval side. The verifier is a plain
  function over already-produced output, so a future runtime consumer is a
  wiring decision, not a redesign — but no runtime seam is shipped or typed
  in v1 (YAGNI; unlike ADR-0016's judge, nothing triggers it).
- **U2 — Challenges golden-run outputs, report-only.** Findings never flip
  an oracle verdict, never touch `totals`/`pass`/`failureKind`, never move
  the exit code. Authority stays with the deterministic oracles — the
  ADR-0016 tighten-only doctrine, transposed: here the LLM's authority is
  zero, not merely one-directional.
- **U3 — Option A-minimal** (panel + arbiter, disposition APPROVED):
  in-run composition, enum-confined findings. **Option B (persisted raw
  outputs) REJECTED on a CRITICAL** — it reverses ADR-0017 decision 6
  (structural no-raw-output allowlist) and ADR-0013 (everything persisted is
  redacted) at once, and creates a hostile-input surface larger than the one
  ADR-0019 just paid for. **Option C (contract-only) is the recorded
  schedule fallback**, trigger EOD 2026-07-16 (§9).

### 2. The load-bearing choice: enum-confined findings

The panel's CRITICAL objection: adversary findings as prose would downgrade
E-1's strongest invariant. ADR-0017 decision 6 makes "raw `resultText`
cannot enter a scorecard" a **structural** property — the row schema simply
has no field that could carry it. A competent adversary quotes the output it
challenges, so prose findings would make the no-leak property depend on
`cleanForScorecard` behaving correctly on every finding — procedural, a
strictly weaker guarantee class.

Resolution, by construction: **no adversary prose is persisted or printed,
anywhere — scorecard JSON, rendered markdown, or terminal.** A finding is a
fixed-shape record of closed enums and a task id (`src/eval/verifier/types.ts`):

```ts
export const CHALLENGE_CATEGORIES = [
  'incomplete', 'incorrect', 'unsupported-claim', 'unsafe', 'other',
] as const;
export type ChallengeStatus = 'agreed' | 'challenged' | 'verifier-error' | 'no-output';
export interface ChallengeFinding {
  taskId: string;
  status: ChallengeStatus;
  category: ChallengeCategory | null;   // non-null iff status === 'challenged'
  errorKind: ChallengeErrorKind | null; // non-null iff status === 'verifier-error'
}
```

The adversary's raw response text exists only inside the verifier's strict
parser (`src/eval/verifier/parse.ts`) and is never returned from `challenge()`.

The honestly-priced consequence, recorded rather than hidden: an individual
finding — `{di-01, challenged, incomplete}` — is a *prompt to re-examine*,
not a diagnosis. Re-examination means re-running the suite (or temporarily
isolating the task file in its own directory); there is **no single-task
selector in v1** (YAGNI, §Accepted limitations), and golden runs are
nondeterministic, so a re-run may not reproduce the challenged output.

### 3. Aggregate value, gate-vs-measurement framing, and the challenge-rate metric

The feature's value lives in the aggregate, not the individual finding —
the same standing ADR-0018's detection rate has relative to its gate. This
ADR is that metric's **interim consumer**, because `docs/eval-methodology.md`
does not exist yet (it is the Week-3 close item that follows E-4); when
written it must carry this definition forward plus a synthetic rendered
example (golden scorecards are gitignored, so no real one is ever committed
— without an example the portfolio audience never sees the payoff).

**Challenge rate, defined here:**

```
challenge rate = challenged / (passed − noOutput)
```

Read against the per-category split (`incomplete` / `incorrect` /
`unsupported-claim` / `unsafe` / `other`) in `verification.findings`, never
as a bare percentage — a run that is mostly `unsafe` challenges is a
materially different signal than one that is mostly `other`, the same way
ADR-0018 decision 9 requires the strength split, not the bare detection
percentage, to be read. `noOutput` findings (gating-behavior tasks with
`resultText: null`) are excluded from the denominator because no call was
ever made against them — including them would understate the rate against
rows that were never eligible to be challenged. `verifier-error` findings
stay in the denominator: a failed or timed-out call is a real attempt whose
outcome is unknown, not an ineligible row.

It **never gates**. Like ADR-0018's detection rate, it is a reported metric
with a named consumer (this ADR today; `docs/eval-methodology.md` and any
future S-5-style judge decision going forward), not a merge blocker.

### 4. Verifier contract

New module `src/eval/verifier/` (eval layer; may import router types — see
§6 Router legality).

```ts
export interface AdversaryResult { text: string; costUsd: number | null; }
export type AdversaryFn = (prompt: string) => Promise<AdversaryResult>;

export interface Verifier {
  adversaryModelId: string;
  challenge(input: { taskId: string; taskPrompt: string; redactedResultText: string }):
    Promise<{ finding: ChallengeFinding; costUsd: number | null }>;
}
export function createVerifier(deps: { adversary: AdversaryFn; adversaryModelId: string }): Verifier;
```

- **No `confidence` field.** A model's self-reported confidence has no
  calibration story (ADR-0012's tiers were grounded in rule authorship).
  Dropped for v1; revisit-if keyed to observed challenge data (§10).
- **No per-finding model id.** The adversary model id is section-level meta
  (`Verifier.adversaryModelId`); a per-finding copy would imply
  multi-adversary support that doesn't exist.

#### Prompt and parse hardening (ADR-0016 decision 4, binding)

- The task prompt and the redacted output are **delimited and explicitly
  labelled as untrusted content to be analyzed** — both are
  attacker-influenceable (the task file is repo-controlled; the output came
  from a live agent run). **The delimiting mechanism is per-call random
  boundary tokens**, not a fixed delimiter: `<<<UNTRUSTED-{nonce}>>> …
  <<<END-UNTRUSTED-{nonce}>>>`, `nonce` = 16 hex chars from
  `crypto.randomBytes(8)` per challenge call — the default `randomHex`
  (`src/eval/verifier/verifier.ts:createVerifier`), injected into
  `buildChallengePrompt` (`src/eval/verifier/prompt.ts`), with a label
  sentence naming each payload's origin. A payload cannot contain a boundary
  it has never seen — this closes the payload-contains-delimiter breakout
  that any fixed delimiter invites. The oracle `.mjs` source is **never**
  sent to the adversary (repo-controlled code; a direct injection channel,
  security-model R-10 adjacent).
- The adversary is instructed to return a single JSON object. The wire
  format is a two-branch `oneOf`
  (`src/eval/verifier/parse.ts:WIRE_SCHEMA`): `{verdict: 'agree'}` (category
  **forbidden**) or `{verdict: 'challenge', category: <string>}` (category
  **required**), `additionalProperties: false` on both branches, so the two
  wrong combinations (challenge-without-category, agree-with-category) fail
  validation as `unparseable` rather than landing in an undefined mapping
  cell. **`category` validates as a string in-schema; enum membership is
  checked after validation** — an out-of-enum category is therefore
  `unknown-enum`, not `unparseable`, keeping the two `errorKind`s distinct
  and both reachable.
- **Response handling order, pinned:** the adversary's response text is
  capped at **128 KiB before parsing** (`MAX_ADVERSARY_RESPONSE_BYTES =
  131_072`, the `redact()` `MAX_INPUT` precedent) — oversize → `unparseable`;
  the text is trimmed (leading/trailing whitespace only — a ` ```json `
  fence fails parse, deliberately: strict means strict); then `JSON.parse` →
  ajv `oneOf` validation → only then are fields read. Prototype-shaped keys
  are inert by construction (`JSON.parse` creates own properties;
  `additionalProperties: false` rejects `__proto__` as an extra field →
  `verifier-error`).
- **Timeout, owned by the verifier:** each adversary call races a
  **60_000 ms timer** (`ADVERSARY_TIMEOUT_MS`, `src/eval/verifier/verifier.ts`);
  on expiry the finding is `verifier-error`/`call-failed` and the orphaned
  promise's eventual settlement is discarded (both resolve/reject handlers
  are attached before the timer fires, so the settlement is always
  consumed — never an unhandled rejection). Neither `AdversaryFn` nor the
  SDK exposes an abort channel (ADR-0017's recorded reason golden tasks have
  no wall-clock timeout either), so the underlying call may still run to
  completion and bill — which is why timed-out findings count as unpriced
  spend (§7).
- **Unknown enum values are never widened at parse time** (binding condition
  3, §10): the category tuple will be wrong at the margins — it was designed
  before any real challenge was observed, which is what `other` and the
  revisit-if (§10) are for — and silent widening is the forbidden failure
  mode.
- **One formulation, used everywhere:** *adversary failure can never alter
  the authoritative result.* Per row: call failure, timeout, unparseable or
  out-of-enum response → `verifier-error` finding; the run continues; the
  oracle scorecard, `totals`, and exit code are untouched. One call, no
  retries (ADR-0016 §5 precedent). **This is the report-only analogue of
  ADR-0016 decision 4's fail-closed floor** — the two documents describe the
  same shape (a failure on the adversarial/semi-trusted side can never make
  the authoritative result worse) at different authority levels: ADR-0016's
  judge failure leaves a *tightening-capable* verdict standing at its floor;
  this verifier's failure leaves a *zero-authority* report incomplete. They
  are not the same mechanism and must not be read as one, but they are the
  same principle, stated once here so the two documents don't read as
  conflicting.

### 5. Runner integration

- **The run is TWO-PHASE, pinned.** Phase 1 (`createGoldenRunner`'s
  existing loop, unchanged): every task runs and its oracle scores it —
  `row.volatile.durationMs` is finalized here and **never includes
  challenge time**. Phase 2, only when `deps.verifier` is present
  (`src/eval/golden/runner.ts:runChallengePhase`): the runner walks the
  completed rows in taskId order and challenges each **oracle-pass row**.
  The **raw** `resultText` of each pass row is retained in memory **only
  when `--challenge` is active** (`deps.verifier` present) — a plain golden
  run never retains it, gated at the point of capture
  (`src/eval/golden/runner.ts:scoreTask`). Retained raw text is redacted
  **lazily, per row, immediately before that row's adversary call** (the
  "redaction responsibility" bullet below) — it is not redacted up front,
  and its retained size is **not bounded by `redact()`'s 128 KiB cap**
  (that cap applies to the text egressed to the adversary, not to the copy
  held in memory between phases; the retained copy is bounded in practice
  only by the session's own output size). If redaction fails for a row, the
  finding is `verifier-error`/`redaction-failed` and **no call is made** for
  that row. A mid-run crash in phase 2 loses only verification, never
  oracle results. An earlier draft challenged
  immediately after each row scored — rejected because the pre-adversary
  spend warning (§6 CLI) needs the pass-row count known before the first
  adversary call, which only phase 1 completing can guarantee.
- **Challenge eligibility: oracle-pass rows only** — failed/errored rows
  carry no information a challenge adds (`task-parse`/`oracle-load`/
  `session-error` rows have no output; `oracle-fail` rows are already red).
  Recorded scope limit: an `oracle-fail` row's output is never
  second-opinioned. A pass row with `resultText: null` (gating-behavior
  tasks — the oracle asserts on `denied[]`; ADR-0017's named first-class
  case) gets a **`no-output` finding**: no call is made, the
  one-per-pass-row cardinality holds, and the state is legible rather than
  a spurious `incomplete` challenge against an empty string.
- **Redaction responsibility, one sentence:** the runner redacts
  `resultText` with its (now required) `redactSecrets` and passes
  `redactedResultText` to the verifier; `taskPrompt` is deliberately NOT
  redacted — it is repo-committed text, already public in the artifact's
  own repo. If `redact()` throws, the finding is
  `verifier-error`/`redaction-failed` and **no call is made** (nothing
  egresses unredacted). The primary call needs raw output to function; the
  adversary does not — redact-before-egress is defense in depth on top of
  the same-provider pin (§6).
- **`redactSecrets` is now a REQUIRED `GoldenRunnerDeps` dep**
  (`src/eval/golden/runner.ts:39`, no `?`) — previously optional.
  ADR-0017's revisit-if M1 named this exact trigger — "a second runner
  composition appears" — and an egress path is a stronger trigger than M1's
  letter. Migration surface (stated, mechanical): of the 14
  `createGoldenRunner` call sites in `runner.test.ts`, ~12 previously
  omitted it and became type errors; each was given `identityRedact`, a
  no-op fake introduced in this same commit (not a pre-existing helper).
  Note for honesty: `cleanForScorecard`'s redactor parameter stays optional
  (it is shared with the redteam producer, whose rows carry no free text to
  redact) — the required-ness lives at the golden composition boundary,
  where the egress is.
- Verification cost is captured from `AdversaryResult.costUsd` per call and
  reported with the never-understated pattern (binding condition 4, §10):
  `verification.totalCostUsd` (sum of known) + `unpricedChallenges` — where
  `unpricedChallenges` counts every finding whose call was attempted and
  whose cost is unknown, **including `verifier-error` findings** (a
  timed-out or failed call may still have billed; unknown spend is counted
  as unpriced, never assumed zero). `redaction-failed` findings count in
  neither, since no call was ever attempted. `no-output` findings made no
  call and count in neither.
- **Progress cadence:** phase 2 reuses the existing `onProgress` channel,
  one line per challenge — `[challenge i/N] <taskId> … agreed|challenged|
  verifier-error|no-output` — so N live calls are never a silent phase (the
  oracle phase's own per-task cadence, extended). The CLI writes these
  lines to stderr; the runner itself never touches stdio directly (a
  layering point the round-3 Gemini pass flagged and the plan fixed — §11).

### 6. Adversary model

- **Fixed review-shaped descriptor through the router**:
  `{shape: 'review', sensitivity: 'low', expected_tokens: 8_000}` →
  `shape-review-small` (`src/router/table.ts:23-24`, matches
  `shape === 'review' && expected_tokens < 20_000`) → sonnet-tier. The
  earlier "different tier than primary by default" sketch is **dropped as
  unimplementable** — `route()` is a pure descriptor→model table with no
  exclusion or relative-selection channel, and building one for a SHOULD is
  scope smuggling. Same-model-as-primary overlap is possible and
  **recorded, not hidden**: the section reports `adversaryModelId`, and the
  reader can compare it with `meta.models`.
- **The call channel, pinned** (the repo has no raw Messages-API client and
  adds no new dependency): the composition root
  (`src/cli/eval-command.ts:buildAdversary`) builds `AdversaryFn` by
  wrapping the same Agent SDK `query()` the session uses — **without**
  `createSession` (no memory/telemetry pollution) and **de-fanged with two
  independent controls expressible in the existing typed `QueryOptions`**:
  `maxTurns: 1` (bounds the agentic loop) and a **deny-all `PreToolUse`
  hook** (any tool call the model attempts in its one turn fails closed via
  `permissionDecision: 'deny'`). A bare `query()` without these would be an
  ungated, tool-capable agent turn processing attacker-influenceable
  content — **strictly worse than R-4** (security-model.md's model-facing
  enforcement gap, which at least sits behind the existing hook/permission
  gates on a real session): an un-de-fanged adversary call would have *no*
  gates at all around a turn fed attacker-influenceable text. The two
  controls are why "compromised adversary = noise, never authority" holds
  for the tool channel as well as the verdict channel. `costUsd` is read
  from the result message's `total_cost_usd`, null when absent.
- **"Pluggable" = the injected `AdversaryFn`** (composition root builds it;
  tests inject fakes) — satisfying the requirement's letter the same way
  `InjectionJudge` does. The requirement's acceptance clause ("Claude as
  both primary and adversary") is satisfied by same-provider construction:
  the router-pinned adversary is itself Claude, called the same way the
  primary is.
- **Provider-pluggability is OUT OF SCOPE** until a redact-before-egress
  step is a hard precondition: the routing table is structurally
  all-Anthropic, so router-pinned selection is itself the same-provider
  control; a non-Anthropic adversary would egress primary output (which
  security-model R-4 says may contain un-rewritten secrets) to a new trust
  domain. `docs/security-model.md` carries this note (§2 below). **This
  resolves `docs/architecture.md` open question 4**: the adversarial
  verifier's second model is a second Claude model via the fixed review
  descriptor, no cross-provider support in v1.

**Router legality note (binding condition, stated once so it cannot drift):**
the eval-layer verifier's use of `route()` is **layer-legal** — `eval`
already depends on `harness` (architecture.md's dependency direction:
`eval → harness → security → SDK`). This is a different seam from
ADR-0016's judge, which is a **security-layer** component and is
deliberately barred from the router (ADR-0016 decision 5: the judge calls
the SDK directly, "preserving the security-below-harness dependency
direction"). **ADR-0016 decision 5 protects the security-below-harness seam
only** — it says nothing about the eval layer, which sits above harness and
may legally consume it. One sentence, stated here, so a future reader does
not "unify" the two judges' call channels on the mistaken belief that
ADR-0016 forbids router use in general.

### 7. Scorecard shape (golden-only, binding)

The verification section lives entirely in **golden-scoped types**
(`GoldenScorecard` in `src/eval/golden/scorecard-shape.ts`) — never on the
shared `ScorecardEnvelope`/core, which the redteam baseline's exact ajv
allowlist and ADR-0019's `envelope` drift class sit on. ADR-0019 decision
4's scalar-row contract independently forbids structural fields on rows, so
findings are a **section, never row fields**. `GoldenScorecard` is an
**intersection**, the shared envelope closed and never widened:

```ts
export type GoldenScorecard =
  ScorecardEnvelope<GoldenMeta, GoldenRow, GoldenTotals> &
  { verification?: VerificationSection };
```

**State legibility — four states, exhaustive**, rendered line always
relating finding counts to `totals.passed` so "ran over zero candidates"
can never read as "ran, nothing challenged"
(`src/eval/golden/markdown.ts:verificationLines`):

1. Section **absent** — not run. Rendered: `Adversarial challenge: not run
   — pass --challenge (adds a second model call per passed task)`.
2. Present, **`totals.passed === 0`** — ran, nothing eligible. Rendered:
   `Adversarial challenge (report-only): 0 passed tasks — nothing to
   challenge`. (Keyed to passed tasks, not call count N: a run whose passed
   tasks all have `resultText: null` has N = 0 but `totals.passed > 0` — it
   renders state 3/4 with its `no-output` findings, never this line.)
3. Present, every finding `agreed` — summary line, **no table** (the
   degenerate case of the table rule below).
4. Present with any non-agreed finding (`challenged` / `verifier-error` /
   `no-output`) — summary line + findings table.

**Table rule:** the table lists **non-agreed findings only** — agreed rows
are represented by the summary count, keeping the table signal-dense (a
40-row all-but-one-agreed table would bury the one challenge). The
`status`/`category`/`errorKind` cells are closed-enum values by
construction — the table cannot carry adversary prose.

Golden scorecards remain gitignored, live-key, never baselined (ADR-0019
decision 9) — adversary nondeterminism is admissible in this artifact class
and no other. If verification ever touches the deterministic red-team arm:
findings go to `meta` or nowhere (ADR-0019 decision 4's rule).

### 8. CLI

- Flag: **`eval --challenge`** (not `--verify` — "verify" is overloaded
  three ways in this repo and reads as a gate; "challenge" is the
  week-plan's own verb and cannot be mistaken for one). Default off
  (`src/cli/eval-command.ts:parseEvalArgs`).
- **Pre-adversary-spend warning** to stderr at the phase boundary (the
  two-phase shape, §5, is what makes N knowable):
  `warning: --challenge adds N adversary call(s) (one per passed task with
  output)`. When N = 0 the warning is replaced by `--challenge: no
  adversary calls needed (0 passed tasks with output)` — phase 2 still runs
  when there are passed tasks: it records their `no-output` findings (no
  calls are made), and the section renders per §7's state rules.
- Exit codes: **unchanged** — still `totals.failed === 0 ? 0 : 1`, exactly
  as before E-4 (`src/cli/eval-command.ts:252`); verification findings and
  verification failures never contribute to `totals.failed`. `totals.failed`
  already includes `task-parse`/`oracle-load`/`session-error` rows where no
  oracle ran.
- `USAGE` and the README quick-start both carry the `--challenge` line
  (`npx agent-harness-ja eval --challenge`; the README feature table
  already promised two-pass adversarial verification).
- Terminal output derived from findings is enum/count-only by construction;
  it still flows through `sanitizeForTerminal` like every other stdout path
  (two independent guards, ADR-0018's tampering-section doctrine).

### 9. Report-only as a tested property, and the C fallback

**A CI-safe differential invariance test** (binding condition 2, §10): run
the golden runner twice with **injected clock and fake sessions** (both
pinned — under the default `Date.now` clock nothing is reproducible), once
with a fake verifier and once without; assert `rows[]` and `totals` are
**deep-equal (field identity, not byte identity)** and the derived exit code
is equal, with the `verification` key the only top-level delta. The
two-phase shape makes row timing verifier-independent by construction
(`durationMs` is finalized in phase 1). "Report-only" is thereby a property
the suite enforces, not a sentence in this document.

**The Option C fallback did not fire.** The recorded schedule contract
(§1, U3) was: if E-4 is not built and reviewed by EOD 2026-07-16, ship
Option C (contract + design + a recorded requirements-row deviation) the
way ADR-0016 shipped the judge design without an implementation. E-4 was
designed, reviewed (3 rounds), implemented, and this ADR written on
**2026-07-12** — the same day the design was locked, well ahead of the
2026-07-16 trigger. Recorded here so a future reader does not need to infer
non-firing from the fallback's absence: the trigger condition was never
tested against reality because the work finished first.

### 10. Binding conditions of approval — round-2 reconciled readings

The arbiter's six binding conditions on the panel-approved A-minimal design,
each folded into a numbered section above, with the round-2 spec-level
review's reconciliation where the panel's wording and the shipped artifact
diverged:

1. Verification section validated against an exact ajv field allowlist,
   structural, ADR-0017-decision-6-style. **Reconciled reading (round 2):**
   the allowlist binds the adversary **wire response** — the untrusted
   input, discharged in `parseAdversaryResponse` (§4) — not the constructed
   `VerificationSection`, which needs no load-time validator because
   nothing ever re-reads a golden scorecard (no baseline, ADR-0019 decision
   9). Its shape is guaranteed by TS construction and pinned by the
   differential test (§9). The decision log's original condition-1 wording
   said "verification section"; this is the reconciled reading, folded into
   the round-2 table.
2. Report-only proven by a CI-safe differential invariance test — §9.
3. Unknown enum from the adversary is a per-row `verifier-error`, never
   parse-time widening — §4.
4. Adversary cost mirrors the never-understated totals pattern. Field names
   as shipped: `verification.totalCostUsd` + `unpricedChallenges` — an
   attempted call with unknown cost counts as unpriced (most
   `verifier-error` findings, e.g. `call-failed`/`unparseable`/
   `unknown-enum`; but not `redaction-failed`, where no call is ever made);
   `no-output` counts in neither — §5.
5. C fallback trigger EOD 2026-07-16, with a requirements-row deviation if
   invoked — §9 (did not fire).
6. `confidence` dropped (or explicitly uncalibrated with revisit-if) —
   dropped, §4.

### 11. Round 2 and round 3 review notes worth recording

Round 2 (same three blind reviewer roles, against the committed spec text)
found no architectural problems — every finding was a spec-precision gap,
folded same-day. The two most consequential: the phase-boundary
contradiction that produced the two-phase pin (§5), and the
condition-1 artifact mismatch reconciled in §10.1.

Round 3 (external Gemini 2.5-flash adversarial pass on the *implementation
plan*, 3 rounds, verdict SOUND) caught one real defect before code was
written: an earlier plan draft risked a **shared mutable clock/session fake
across differential-invariance test runs**, which would have let the two
runs (with and without the verifier) diverge for reasons unrelated to the
verifier — silently invalidating the property §9 exists to prove. The plan
was corrected to mandate a fresh clock and fresh session fakes per run
before implementation began. A progress-line wording risk (implying the
runner writes to stderr directly) was also caught and fixed to the
"runner emits via `onProgress` only; CLI writes stderr" layering stated in
§5. Five other probes (timeout race unhandled-rejection path, ajv `oneOf`
behavior, stream-throw absorption, intra-eval import direction, re-export
fallout) were confirmed clean, not defects.

## Consequences

### Positive

- E-1's structural no-raw-output-in-scorecard guarantee (ADR-0017 decision
  6) is extended to the adversarial channel by the same mechanism —
  construction, not procedure — rather than being downgraded to depend on
  correct sanitization of a new free-text field.
- The report-only property is machine-enforced (§9), not asserted in prose:
  a regression that let a challenge finding influence `totals` or the exit
  code would fail CI on the differential invariance test.
- The challenge-rate metric (§3) gives `docs/eval-methodology.md` and any
  future S-5-style judge decision a defined, reproducible aggregate to read
  — the same standing ADR-0018's detection rate has, extended to a second
  reported-not-gated dimension of the eval layer.
- The router-legality note (§6) forecloses a plausible but wrong future
  "simplification" that would have blurred the eval-layer verifier and the
  security-layer judge into one call channel, breaking ADR-0016 decision 5's
  layering guarantee.
- Cost accounting mirrors the never-understated pattern used everywhere else
  in this codebase (ADR-0018 decision 9's strength-split honesty, extended
  to spend): a timed-out or failed adversary call is never silently counted
  as free.

### Negative / accepted (accepted limitations, recorded)

- **Findings are un-investigatable without a live re-run.** Nothing is
  persisted to investigate against (E-1 doctrine, ADR-0017), and golden
  runs are nondeterministic, so a re-run may not reproduce the challenged
  output. This is the honest cost of keeping E-1's no-persistence guarantee;
  the option that fixed it (B) died on a worse CRITICAL (§1, §2).
- **No ground truth for finding quality.** The adversary's challenge rate is
  unmeasured and uncalibrated at ship time. Enum confinement bounds the
  blast radius (a bad adversary produces noise, never authority — the R-5
  shape: `docs/security-model.md` §6's residual-risk table records the same
  compromise-bounded-by-construction pattern for ADR-0016's judge ("tighten-
  only authority converts compromise into false positives at worst"); this
  verifier's report-only, zero-authority design is the same shape one rung
  further down — noise, never authority, at any severity); nothing
  cures it. Revisit-if: enough live `--challenge` runs accumulate to judge
  the category enum and challenge rate against human review (§12).
- **Oracle-fail rows are never challenged** (scope limit, §5) — the only
  info-add over self-report oracles is on rows the oracle already passed.
- **Same-model adversary overlap is possible** (§6, stated in the artifact
  via `adversaryModelId` next to `meta.models`, never hidden).
- **A 100%-verifier-error run still exits green.** Report-only means
  verification *failures* don't move exit codes either; mitigation is the
  stderr warning (§8) and the `verifierErrors` count in the section.
- **No single-task re-run surface.** `eval` takes a directory and runs every
  `*.task.md` in it; acting on a finding means re-running the suite or
  isolating the task file. A task selector is deliberately not built in v1
  (§2, §12).
- **The adversary call is a second wall-clock hazard, bounded but not
  aborted.** The 60 s verifier-owned race (§4) converts a hang into a
  `call-failed` finding, but the orphaned call may run to completion and
  bill (no abort channel exists — ADR-0017's recorded limitation, doubled
  here and mitigated where sessions couldn't be).
- **Long outputs reach the adversary truncated.** `redact()` caps input at
  128 KiB (tail replaced with a marker); a challenge over a truncated
  output judges the truncation. A fidelity caveat, not a security one.

## Alternatives considered

1. **Option B — persist raw adversary outputs (and/or raw challenged text)
   for later investigation.** Rejected on a CRITICAL: it reverses ADR-0017
   decision 6 (no raw `resultText` in a scorecard) and ADR-0013 (everything
   persisted is redacted) simultaneously, and the resulting run directory
   is a larger hostile-input surface than the one ADR-0019 just closed for
   the baseline file. The un-investigatability this rejection accepts is
   named explicitly in §Consequences rather than quietly absorbed.
2. **Option C — contract-only, no implementation.** Not chosen because the
   work finished ahead of its own recorded trigger (§9); recorded as the
   schedule fallback with an honest standing, not a hidden option — the
   round-1 skeptic's objection that "C is dismissed in one clause" was
   accepted and given its own binding condition (5, §10) precisely so C
   would ship with a recorded requirements-row deviation if it were ever
   invoked, the ADR-0019 decision 2 precedent.
3. **"Different tier than primary by default"** (e.g. always route the
   adversary to a cheaper or more expensive tier than the primary).
   Rejected as unimplementable: `route()` is a pure descriptor→model table
   with no exclusion or relative-selection channel (verified against
   `src/router/table.ts`), and building one for a SHOULD requirement is
   scope smuggling. A fixed review-shaped descriptor was chosen instead,
   with same-model overlap recorded rather than engineered away (§6).
4. **Route the judge/adversary through a shared call channel with
   ADR-0016's security-layer judge.** Not built, and explicitly foreclosed
   by the router-legality note (§6): the two are different seams at
   different layers, and unifying them would break ADR-0016 decision 5's
   security-below-harness dependency direction.
5. **Prose findings with a downstream sanitizer.** Rejected — this is
   exactly the skeptic's CRITICAL (§2): it would make the no-raw-output
   guarantee procedural (depends on `cleanForScorecard` behaving correctly
   on every finding) instead of structural (the schema has no field that
   could carry it).
6. **`confidence` on findings.** Cut (binding condition 6, §10) — a model's
   self-reported confidence has no calibration story in this codebase
   (ADR-0012's tiers were grounded in rule authorship, not model
   self-assessment). Revisit-if below.

## Revisit if

- Enough live `--challenge` runs accumulate that the category enum
  (`incomplete` / `incorrect` / `unsupported-claim` / `unsafe` / `other`)
  and the challenge rate (§3) can be judged against accumulated real
  operator runs rather than the pre-observation guess it shipped as —
  parallel to ADR-0018's revisit-if for the red-team category taxonomy.
- Operators ask for a single-task re-run selector — the accepted limitation
  (§Consequences) that a finding can only be chased by re-running the whole
  suite or isolating the task file becomes worth solving directly.
- A runtime consumer for the verifier appears — the offline-only decision
  (§1, U1) was YAGNI, not a permanent architectural stance; `Verifier` is
  already a plain function over produced output, so wiring it into a
  runtime guardrail is additive, not a redesign.
- `docs/eval-methodology.md` is written — it must carry the challenge-rate
  definition (§3) forward plus a synthetic rendered example of the
  verification section, per the round-2 finding that a named consumer
  cannot be a pointer to a nonexistent file (§11).
- Numeric confidence calibration becomes possible from accumulated
  challenge data — revisit the dropped `confidence` field (§4, §10.6),
  mirroring ADR-0012 decision 2's discrete-tier revisit-if.
