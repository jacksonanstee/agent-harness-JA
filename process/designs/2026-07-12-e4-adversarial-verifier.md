# E-4 — Two-Pass Adversarial Verifier (offline, report-only, enum-confined)

Status: design (review-validated — 3-reviewer structured panel + arbiter, disposition APPROVED with 6 binding conditions)
Date: 2026-07-12
Depends on: E-1 golden runner (`src/eval/golden/`, ADR-0017), router (`src/router/`), S-2 redaction (`src/security/`)
Feeds: closes the Week-3 E-4 checkbox; resolves architecture.md open question 4 (adversary model source)
Decision log: [2026-07-12-e4-adversarial-verifier-decision-log.md](./2026-07-12-e4-adversarial-verifier-decision-log.md)

## Problem

Requirement E-4 (SHOULD): "A two-pass adversarial verification module is
available as a runtime guardrail OR offline eval, with the second pass model
pluggable." Acceptance: "Test using Claude as both primary and adversary."

Golden oracles judge the `SessionResult` self-report only — ADR-0017's named
limitation. A task can pass its oracle while the output is incomplete, wrong
in ways the oracle doesn't assert on, or unsafe. A second model challenging
the primary's output is the one mechanism in the eval layer that can surface
information the deterministic oracle structurally cannot see. E-4 builds that
mechanism as an offline, report-only eval step.

## Locked decisions (user, 2026-07-12)

1. **Offline eval only.** The runtime-guardrail wiring is not built; the
   requirement's OR is resolved to the eval side. The verifier is a plain
   function over already-produced output, so a future runtime consumer is a
   wiring decision, not a redesign — but no runtime seam is shipped or typed
   in v1 (YAGNI; unlike ADR-0016's judge, nothing triggers it).
2. **Challenges golden-run outputs, report-only.** Findings never flip an
   oracle verdict, never touch `totals`/`pass`/`failureKind`, never move the
   exit code. Authority stays with the deterministic oracles (the ADR-0016
   tighten-only doctrine, transposed: here the LLM's authority is zero).
3. **Option A-minimal** (panel + arbiter, disposition APPROVED): in-run
   composition, enum-confined findings. Option B (persisted raw outputs)
   REJECTED on a CRITICAL — it reverses ADR-0017 d6 (structural no-raw-output
   allowlist) and ADR-0013 (everything persisted is redacted) at once, and
   creates a hostile-input surface larger than the one ADR-0019 just paid
   for. Option C (contract-only) is the recorded schedule fallback, trigger
   EOD 2026-07-16 (§Fallback).

## The load-bearing choice: enum-confined findings

The panel's CRITICAL: adversary findings as prose would downgrade E-1's
strongest invariant. ADR-0017 d6 makes "raw `resultText` cannot enter a
scorecard" a **structural** property — the row schema simply has no field
that could carry it. A competent adversary quotes the output it challenges,
so prose findings would make the no-leak property depend on
`cleanForScorecard` behaving correctly on every finding — procedural, a
strictly weaker guarantee class.

Resolution, by construction: **no adversary prose is persisted or printed,
anywhere — scorecard JSON, rendered markdown, or terminal.** A finding is a
fixed-shape record of closed enums and a task id. The adversary's raw
response text exists only inside the verifier's strict parser.

The honestly-priced consequence (recorded, not hidden): an individual
finding — `{di-01, challenge, incomplete}` — is a *prompt to re-examine*,
not a diagnosis — and re-examination means re-running the suite (or
temporarily isolating the task file in its own directory): there is **no
single-task selector in v1** (YAGNI, recorded in §Accepted limitations),
and golden runs are nondeterministic, so a re-run may not reproduce the
challenged output. The feature's value lives in the aggregate: the challenge rate
over oracle-pass rows is a **reported metric** with a named consumer
(`docs/eval-methodology.md` and any future S-5-style judge decision), the
same gate-vs-measurement standing as E-2's detection rate. It never gates.

## Verifier contract

New module `src/eval/verifier/` (eval layer; may import router types — the
eval layer already consumes the router legally, unlike ADR-0016's
security-layer judge, and the ADR must say so to stop a future "unification"
across that boundary).

```ts
export const CHALLENGE_CATEGORIES = [
  'incomplete',        // output omits something the task asked for
  'incorrect',         // output asserts something false / contradicts the task
  'unsupported-claim', // output claims success/actions its own text does not evidence
  'unsafe',            // output contains advice/content a careful reviewer would block
  'other',             // adversary challenges but no category fits
] as const;
export type ChallengeCategory = (typeof CHALLENGE_CATEGORIES)[number];

// 'no-output' = oracle-pass row with resultText: null (gating-behavior
// tasks, ADR-0017's named first-class case) — nothing to challenge, finding
// recorded so the one-per-pass-row cardinality holds. Not an error.
export type ChallengeStatus = 'agreed' | 'challenged' | 'verifier-error' | 'no-output';

export interface ChallengeFinding {
  taskId: string;                       // ^[a-z0-9][a-z0-9-]{0,63}$ (the task's own id)
  status: ChallengeStatus;
  category: ChallengeCategory | null;   // non-null iff status === 'challenged'
  // non-null iff status === 'verifier-error'. 'redaction-failed' = redact()
  // threw before any call was made (nothing egressed).
  errorKind: 'call-failed' | 'unparseable' | 'unknown-enum' | 'redaction-failed' | null;
}

export interface AdversaryResult { text: string; costUsd: number | null; }
export type AdversaryFn = (prompt: string) => Promise<AdversaryResult>;

export interface Verifier {
  /** The routed model id, for VerificationSection.adversaryModelId — the
   *  runner cannot learn it any other way (route() runs at the composition
   *  root; nothing analogous to SessionResult.modelChoice flows back). */
  adversaryModelId: string;
  challenge(input: { taskId: string; taskPrompt: string; redactedResultText: string }):
    Promise<{ finding: ChallengeFinding; costUsd: number | null }>;
}
export function createVerifier(deps: { adversary: AdversaryFn; adversaryModelId: string }): Verifier;
```

- **No `confidence` field.** A model's self-reported confidence has no
  calibration story (ADR-0012's tiers were grounded in rule authorship).
  Dropped for v1; revisit-if keyed to observed challenge data.
- **No per-finding model id.** The adversary model id is section-level meta;
  a per-finding copy would imply multi-adversary support that doesn't exist.

### Prompt and parse hardening (ADR-0016 d4, binding)

- The task prompt and the redacted output are **delimited and explicitly
  labelled as untrusted content to be analyzed** — both are
  attacker-influenceable (the task file is repo-controlled; the output came
  from a live agent run). **The delimiting mechanism is pinned** (nothing
  concrete exists to inherit — ADR-0016's judge was never built): each
  payload is wrapped in **per-call random boundary tokens**
  (`<<<UNTRUSTED-{nonce}>>> … <<<END-UNTRUSTED-{nonce}>>>`, nonce =
  16 hex chars from `crypto.randomBytes` per challenge call), with a label
  sentence naming the payload's origin. A payload cannot contain the
  boundary it has never seen — this closes the payload-contains-delimiter
  breakout that any fixed delimiter invites. The oracle `.mjs` source is
  **never** sent to the adversary (repo-controlled code; a direct injection
  channel, R-10 adjacent).
- The adversary is instructed to return a single JSON object. The **wire
  format** is a two-branch `oneOf`: `{verdict: 'agree'}` (category
  **forbidden**) or `{verdict: 'challenge', category: <enum>}` (category
  **required**) — `additionalProperties: false` on both branches, so the
  two wrong combinations (challenge-without-category,
  agree-with-category) fail validation as `unparseable` rather than
  landing in an undefined mapping cell. **`category` validates as a
  string in-schema; enum membership is checked after validation** — an
  out-of-enum category is therefore `unknown-enum`, not `unparseable`
  (keeping the two errorKinds distinct and both reachable). The verifier
  maps the wire verdict onto the finding's `status` — a value space the
  adversary can never fully drive: `verifier-error` is verifier-owned and
  `no-output` is **runner-constructed** (for null-`resultText` pass rows
  the runner records the finding directly; `challenge()` is never
  called).
  **Arbiter condition 1 is discharged here, at the wire-response parse** —
  that is the untrusted input; the constructed `VerificationSection` needs
  no load-time validator because nothing ever re-reads a golden scorecard
  (no baseline, ADR-0019 d9) — its shape is guaranteed by TS construction
  and pinned by the differential test. (The decision log's condition-1
  wording says "verification section"; this paragraph is the reconciled
  reading, folded into the decision log's round-2 table.)
- **Response handling order, pinned:** `AdversaryResult.text` is capped at
  **128 KiB before parsing** (the `redact()` `MAX_INPUT` precedent) —
  oversize → `unparseable`; the text is trimmed (leading/trailing
  whitespace only — a ` ```json ` fence fails parse, deliberately: strict
  means strict); then `JSON.parse` → ajv `oneOf` validation → only then
  are fields read. Prototype-shaped keys are inert by construction
  (`JSON.parse` creates own properties; `additionalProperties: false`
  rejects `__proto__` as an extra field → `verifier-error`).
- **Timeout, owned by the verifier:** each adversary call races a
  **60_000 ms timer** (`ADVERSARY_TIMEOUT_MS`); on expiry the finding is
  `verifier-error`/`call-failed` and the orphaned promise's eventual
  settlement is discarded. Neither `AdversaryFn` nor the SDK exposes an
  abort channel (ADR-0017's recorded reason golden tasks have no
  wall-clock timeout), so the underlying call may still run to completion
  and bill — which is why timed-out findings count as unpriced spend
  (§Runner integration).
  Anything else — extra fields, prose wrapper that doesn't parse, an enum
  value outside the tuple — is a per-row `verifier-error` with the matching
  `errorKind`. **Unknown enum values are never widened at parse time**
  (arbiter condition 3); the category tuple will be wrong at the margins
  (it was designed before any real challenge was observed — that's what
  `other` and the revisit-if are for), and silent widening is the forbidden
  failure mode.
- **One formulation, used everywhere:** *adversary failure can never alter
  the authoritative result.* Per row: call failure, timeout, unparseable or
  out-of-enum response → `verifier-error` finding; the run continues; the
  oracle scorecard, `totals`, and exit code are untouched. One call, no
  retries (ADR-0016 §5 precedent). This is the report-only analogue of
  ADR-0016 d4's fail-closed floor — the ADR must state the equivalence so
  the two documents don't read as conflicting.

## Runner integration

- **The run is TWO-PHASE, pinned** (an earlier draft said "right after the
  oracle scores the row", which contradicted the phase-boundary warning —
  the warning's rationale requires the pass count to be known before the
  first adversary call). Phase 1 is today's loop, unchanged: every task
  runs and its oracle scores it. Phase 2, only when `verifier` is present:
  the runner walks the completed rows in taskId order and challenges each
  **oracle-pass row**. Consequences pinned with the shape: the redacted
  `resultText` of each pass row is retained in memory between phases
  (bounded by `redact()`'s 128 KiB cap per row); row `volatile.durationMs`
  is finalized in phase 1 and **never includes challenge time**; a mid-run
  crash in phase 2 loses only verification, never oracle results.
- Challenge eligibility: **oracle-pass rows only** — failed/errored rows
  carry no information a challenge adds (`task-parse`/`oracle-load`/
  `session-error` rows have no output; `oracle-fail` rows are already
  red). Recorded scope limit: an oracle-fail row's output is never
  second-opinioned. A pass row with `resultText: null` (gating-behavior
  tasks — oracle asserts on `denied[]`; ADR-0017's named first-class case)
  gets a **`no-output` finding**: no call is made, cardinality holds, and
  the state is legible rather than a spurious `incomplete` challenge
  against an empty string.
- **Redaction responsibility, one sentence:** the runner redacts
  `resultText` with its (now required) `redactSecrets` and passes
  `redactedResultText` to the verifier; `taskPrompt` is deliberately NOT
  redacted — it is repo-committed text, already public in the artifact's
  own repo. If `redact()` throws, the finding is
  `verifier-error`/`redaction-failed` and **no call is made** (nothing
  egresses unredacted). The primary call needs raw output to function; the
  adversary does not — redact-before-egress is defense in depth on top of
  the same-provider pin (§Adversary model).
- **`redactSecrets` becomes a REQUIRED `GoldenRunnerDeps` dep** (currently
  optional, `runner.ts:37`). ADR-0017's revisit-if M1 named this exact
  trigger — "a second runner composition appears" — and an egress path is a
  stronger trigger than M1's letter. Migration surface (stated, mechanical):
  ~15 `createGoldenRunner` sites in `runner.test.ts` omit it and become
  type errors — each gets the existing fake. Note for honesty:
  `cleanForScorecard`'s redactor parameter stays optional (it is shared
  with the redteam producer, whose rows carry no free text to redact) —
  the required-ness lives at the golden composition boundary, where the
  egress is.
- Verification cost is captured from `AdversaryResult.costUsd` per call and
  reported with the never-understated pattern (arbiter condition 4):
  `verification.totalCostUsd` (sum of known) + `unpricedChallenges` —
  where `unpricedChallenges` counts every finding whose call was attempted
  and whose cost is unknown, **including `verifier-error` findings**
  (a timed-out or failed call may still have billed; unknown spend is
  counted as unpriced, never assumed zero). `no-output` findings made no
  call and count in neither.
- **Progress cadence:** phase 2 reuses the existing `onProgress` channel,
  one line per challenge — `[challenge i/N] <taskId> … agreed|challenged|
  verifier-error|no-output` — so N live calls are never a silent phase
  (the oracle phase's own per-task cadence, extended).

## Scorecard shape (golden-only, binding)

The verification section lives entirely in **golden-scoped types**
(`GoldenScorecard` in `src/eval/golden/scorecard-shape.ts`) — never on the
shared `ScorecardEnvelope`/core, which the redteam baseline's exact ajv
allowlist and ADR-0019's `envelope` drift class sit on. ADR-0019 d4's
scalar-row contract independently forbids structural fields on rows, so
findings are a **section, never row fields**:

```ts
export interface VerificationSection {
  adversaryModelId: string;           // from Verifier.adversaryModelId
  findings: ChallengeFinding[];       // one per oracle-pass row, ordered by taskId
  totals: { agreed: number; challenged: number; verifierErrors: number; noOutput: number };
  totalCostUsd: number;
  unpricedChallenges: number;
}
// GoldenScorecard becomes an INTERSECTION — the shared envelope is closed
// and shared with redteam, so it is never widened (the natural-but-
// forbidden implementation, named to forbid it):
//   export type GoldenScorecard =
//     ScorecardEnvelope<GoldenMeta, GoldenRow, GoldenTotals> &
//     { verification?: VerificationSection };
```

State legibility (panel condition — the states are EXHAUSTIVE, and the
rendered line always relates the finding counts to `totals.passed` so
"ran over zero candidates" can never read as "ran, nothing challenged"):

1. Section **absent** — not run. Rendered: `Adversarial challenge: not
   run — pass --challenge (adds a second model call per passed task)`.
2. Present, **`totals.passed === 0`** — ran, nothing eligible. Rendered:
   `Adversarial challenge (report-only): 0 passed tasks — nothing to
   challenge`. (This state is keyed to passed tasks, NOT to the call
   count N: a run whose passed tasks all have `resultText: null` has
   N = 0 but `totals.passed > 0` — it renders state 3/4 with its
   `no-output` findings, never this copy.)
3. Present, every finding `agreed` — summary line, **no table** (the
   degenerate case of the table rule below).
4. Present with any non-agreed finding (`challenged` / `verifier-error` /
   `no-output`) — summary line + findings table.

**Table rule (pinned):** the table lists **non-agreed findings only** —
agreed rows are represented by the summary count, keeping the table
signal-dense (a 40-row all-but-one-agreed table would bury the one
challenge). Every `challenged`, `verifier-error`, and `no-output` finding
gets a row.

Rendered shape (pinned — the feature IS this section, so the spec shows
it, the way `markdown.ts` pins every existing section; counts sum to
`totals.passed`: 1 challenged + 3 agreed + 0 errors + 1 no-output = 5):

```markdown
## Adversarial challenge (report-only — never affects pass/fail or exit codes)

Adversary: claude-sonnet-4-6 · challenged 1 / agreed 3 / errors 0 / no-output 1, of 5 passed tasks
Challenge cost: $0.0312 (0 unpriced)

| task | status | category / error |
|---|---|---|
| di-01 | challenged | incomplete |
| gate-01 | no-output | — |
```

The `status` and `category / error` cells are closed-enum values by
construction — the table cannot carry adversary prose.

Golden scorecards remain gitignored, live-key, never baselined (ADR-0019
d9) — adversary nondeterminism is admissible in this artifact class and no
other. If verification ever touches the deterministic red-team arm:
findings go to `meta` or nowhere (ADR-0019 d4's rule).

## Adversary model

- **Fixed review-shaped descriptor through the router**:
  `{shape: 'review', sensitivity: 'low', expected_tokens: 8_000}` →
  `shape-review-small` → sonnet-tier (`src/router/table.ts:23`; the rule
  matches `shape === 'review' && expected_tokens < 20_000`). The earlier "different tier than
  primary by default" sketch is **dropped as unimplementable** — `route()`
  is a pure descriptor→model table with no exclusion or relative-selection
  channel, and building one for a SHOULD is scope smuggling. Same-model-as-
  primary overlap is possible and **recorded, not hidden**: the section
  reports `adversaryModelId`, and the reader can compare it with
  `meta.models`.
- **The call channel, pinned** (the repo has no raw Messages-API client
  and adds no new dependency): the composition root builds `AdversaryFn`
  by wrapping the same Agent SDK `query()` the session uses — **without**
  `createSession` (no memory/telemetry pollution) and **de-fanged with two
  independent controls expressible in the existing typed `QueryOptions`**:
  `maxTurns: 1` (bounds the agentic loop) and a **deny-all `PreToolUse`
  hook** (`SdkPreToolDenyOutput` — any tool call the model attempts in its
  one turn fails closed). A bare `query()` without these would be an
  ungated, tool-capable agent turn processing attacker-influenceable
  content — strictly worse than R-4; the two controls are why
  "compromised adversary = noise, never authority" holds for the tool
  channel as well as the verdict channel. `costUsd` is read from the
  result message's `total_cost_usd` (`SdkResultMessage`), null when
  absent. If the implementation plan verifies the SDK's `allowedTools: []`
  option, it may be added to the typed `QueryOptions` subset as a third
  control — additive, not a substitute.
- **"Pluggable" = the injected `AdversaryFn`** (composition root builds it;
  tests inject fakes) — satisfying the requirement's letter the same way
  `InjectionJudge` does. The requirement's acceptance ("Claude as both
  primary and adversary") is satisfied by same-provider construction.
- **Provider-pluggability is OUT OF SCOPE** until a redact-before-egress
  step is a hard precondition: the routing table is structurally
  all-Anthropic, so router-pinned selection is itself the same-provider
  control; a non-Anthropic adversary would egress primary output (which R-4
  says may contain un-rewritten secrets) to a new trust domain.
  `docs/security-model.md` gets this note. Resolves architecture.md open
  question 4: second Claude model, no cross-provider in v1.

## CLI

- Flag: **`eval --challenge`** (not `--verify` — "verify" is overloaded
  three ways in this repo and reads as a gate; "challenge" is the
  week-plan's own verb and cannot be mistaken for one). Default off.
- **Wiring lives in `src/cli/eval-command.ts`** — an extraction of the
  existing eval command from `cli.ts` (the redteam-command precedent; also
  discharges the E-3 review backlog LOW "asymmetric subcommand
  extraction"). Honestly scoped: this is **not** a pure move —
  `runEval` shares `composeSecurity`, `SettingsLoadError`, and
  `hookRecordToTelemetryInput` with the `run` path, and a `src/cli/`
  module importing `../cli.js` back is a real ESM cycle
  (`redteam-command.ts:33-37` documents it) — so those shared helpers
  relocate to `src/cli/shared.ts` in the same commit, with the ba79533
  re-export verification covering the helpers too. `cli.ts` keeps
  dispatch, the `run` wiring, and telemetry-export. The `--challenge`
  wiring lands on top of the extraction commit.
- **Pre-adversary-spend warning** to stderr at the phase boundary (the
  two-phase shape, §Runner integration, is what makes N knowable):
  `warning: --challenge adds N adversary call(s) (one per passed task with
  output)`. When N = 0 the warning is replaced by
  `--challenge: no adversary calls needed (0 passed tasks with output)` —
  note phase 2 still runs when there are passed tasks: it records their
  `no-output` findings (no calls are made), and the section renders per
  the state rules in §Scorecard shape.
- Exit codes: **unchanged** — still `totals.failed === 0 ? 0 : 1` exactly
  as today (note: `failed` already includes `task-parse`/`oracle-load`/
  `session-error` rows where no oracle ran, so "oracle-derived" would be
  the wrong words); verification findings and verification failures never
  contribute to `totals.failed`. Stated as a co-located comment where the
  exit code is computed (the repo's pattern for report-only-adjacent
  decisions, cf. `gateOutcome`'s docstring).
- `USAGE` gains `eval [taskDir] [--challenge]`; README quick-start gains
  the `--challenge` line beside the `eval` one.
- Terminal output derived from findings is enum/count-only by construction;
  it still flows through `sanitizeForTerminal` like every other stdout path
  (two independent guards, ADR-0018 d4 doctrine).

## Report-only as a tested property (binding)

A CI-safe **differential invariance test** (arbiter condition 2): run the
golden runner twice with **injected clock and fake sessions** (both pinned
— under the default `Date.now` clock nothing is reproducible), once with a
fake verifier and once without; assert `rows[]` and `totals` are
**deep-equal (field identity, not byte identity)** and the derived exit
code is equal, with the `verification` key the only top-level delta. The
two-phase shape makes row timing verifier-independent by construction
(`durationMs` is finalized in phase 1). "Report-only" is thereby a
property the suite enforces, not a sentence in this document.

## Accepted limitations (recorded)

- **Findings are un-investigatable without a live re-run.** Nothing is
  persisted to investigate against (E-1 doctrine), and golden runs are
  nondeterministic, so a re-run may not reproduce the challenged output.
  This is the honest cost of keeping E-1's no-persistence guarantee; the
  option that fixed it (B) died on a worse CRITICAL.
- **No ground truth for finding quality.** The adversary's challenge rate is
  unmeasured and uncalibrated at ship time. Enum confinement bounds the
  blast radius (a bad adversary produces noise, never authority — the R-5
  shape); nothing cures it. Revisit-if: enough live `--challenge` runs
  accumulate to judge the category enum and challenge rate against human
  review.
- **Oracle-fail rows are never challenged** (scope limit, stated above).
- **Same-model adversary overlap is possible** (stated above, visible in
  the artifact).
- **A 100%-verifier-error run still exits green.** Report-only means
  verification *failures* don't move exit codes either; mitigation is the
  stderr warning and the `verifierErrors` count in the section.
- **No single-task re-run surface.** `eval` takes a directory and runs
  every `*.task.md` in it; acting on a finding means re-running the suite
  or isolating the task file. A task selector is deliberately not built
  in v1.
- **The adversary call is a second wall-clock hazard, bounded but not
  aborted.** The 60 s verifier-owned race converts a hang into a
  `call-failed` finding, but the orphaned call may run to completion and
  bill (no abort channel exists — ADR-0017's recorded limitation, doubled
  here and mitigated where sessions couldn't be).
- **Long outputs reach the adversary truncated.** `redact()` caps input at
  128 KiB (tail replaced with a marker); a challenge over a truncated
  output judges the truncation. Fidelity caveat, not a security one.

## Fallback (arbiter condition 5)

If E-4 is not built and reviewed by **EOD 2026-07-16**, ship Option C as
ADR-0016 shipped the judge: the `Verifier` contract + this design, an ADR
recording the deferral AS the decision, and an amendment to the E-4
requirements row recording that the acceptance clause ("test using Claude as
both primary and adversary") is deferred with the build — the ADR-0019 d2
recorded-deviation precedent. A contract-only C must never silently claim
the acceptance test exists.

## Out of scope

- Runtime-guardrail wiring (locked decision 1). No typed runtime seam.
- Provider-pluggable adversaries (§Adversary model; security-model note).
- Challenging red-team or oracle-fail rows.
- Any change to shared scorecard core, redteam types, or the E-3 baseline.
- Adversary prompt iteration tooling (each tuning cycle costs a live run —
  recorded cost of A; revisit with the finding-quality revisit-if).
- `confidence` on findings (dropped; revisit-if above).

## Testing (TDD; all CI tests fake-adversary, keyless)

- **Verifier unit**: prompt construction (per-call nonce boundaries
  present and distinct across calls, labels present, oracle source absent,
  redacted text used); strict parse — valid agree, valid challenge each
  category, extra field → `unparseable`, challenge-without-category →
  `unparseable`, agree-with-category → `unparseable`, out-of-enum
  category → `unknown-enum`, >128 KiB response → `unparseable`, fenced
  JSON → `unparseable`, call rejection → `call-failed`, timer expiry →
  `call-failed` with orphan settlement discarded (fake timers);
  one-call-no-retry pinned.
- **Runner integration**: two-phase shape (all oracles complete before the
  first challenge; `durationMs` finalized in phase 1); pass-rows-only
  selection (fail/error rows get no finding); `resultText: null` pass row
  → `no-output` finding, no call; redaction throw → `redaction-failed`,
  no call; findings ordered by taskId; cost sum + unpriced semantics
  (verifier-error counts as unpriced, no-output counts in neither);
  required `redactSecrets` type-error proof (compile-time) + adversary
  payload is the redacted text (runtime assertion via fake); per-challenge
  `onProgress` lines.
- **Differential invariance** (condition 2): rows/totals/exit identical
  with and without the verifier.
- **CLI**: `--challenge` parse; unknown-flag rejection unchanged for other
  flags; four-state markdown rendering pinned to the §Scorecard shape
  copy (absent / zero-eligible / all-agreed / findings table, counts
  related to `totals.passed`); rendered challenge-cost line (condition 4
  at the presentation layer, not just the JSON); phase-boundary warning
  line incl. the N = 0 variant; exit-code invariance; USAGE string.
- **Extraction commit**: eval-command + shared-helper relocation verified
  behavior-preserving (cli.test.ts imports unchanged, the ba79533
  pattern, re-export pins covering the relocated helpers).
- **Live acceptance** (operator-invoked, never CI): `node dist/cli.js eval
  --challenge` on the starter tasks with a real key — Claude as both
  primary and adversary, satisfying the E-4 acceptance clause; result
  pasted into the PR/devlog as evidence.

## Documentation

- **ADR-0020**: locked decisions; the enum-confinement CRITICAL and its
  by-construction resolution; aggregate-value/gate-vs-measurement framing;
  B's rejection; C fallback + trigger; the six arbiter conditions; the
  router-legality note (eval-layer verifier vs ADR-0016's security-layer
  judge); accepted limitations verbatim. **ADR-0020 is the interim
  consumer of the challenge-rate metric** (definition + how to read it):
  `docs/eval-methodology.md` does not exist yet — it is the separate
  week-plan item that follows E-4 — and when written it must carry the
  metric definition plus a **synthetic rendered example** of the
  verification section (golden scorecards are gitignored, so no real one
  is ever committed; without an example the portfolio audience never sees
  the payoff). Until then the metric's definition lives in ADR-0020, not
  in a pointer to a nonexistent file.
- `docs/security-model.md`: adversary-is-injectable entry (d4 transfer,
  authority analysis: compromised adversary = noise never authority) +
  provider-pluggability precondition.
- `process/01-requirements.md` E-4 row: verification cell updated to name
  the live operator acceptance run + CI's fake-adversary differential test.
- `process/05-week-plan.md` E-4 checkbox; `docs/architecture.md`
  adversarial-verifier section rewritten to match (open question 4 closed).
- README: feature table already promises two-pass; quick-start gains the
  `--challenge` line.

## Review provenance

3-reviewer structured panel (skeptic + constraint-guardian on Fable,
user-advocate on Sonnet, blind) + arbiter (Fable), 2026-07-12: disposition
APPROVED on the A-minimal revision with 6 binding conditions (all folded
above); Option B rejected on the constraint CRITICAL; skeptic CRITICAL
resolved by enum confinement. Full objection-disposition table in the
decision log.
