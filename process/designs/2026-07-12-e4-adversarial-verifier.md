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
finding — `{di-01, challenge, incomplete}` — is a *pointer to re-run*, not a
diagnosis. The feature's value lives in the aggregate: the challenge rate
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

export type ChallengeStatus = 'agreed' | 'challenged' | 'verifier-error';

export interface ChallengeFinding {
  taskId: string;                       // ^[a-z0-9][a-z0-9-]{0,63}$ (the task's own id)
  status: ChallengeStatus;
  category: ChallengeCategory | null;   // non-null iff status === 'challenged'
  errorKind: 'call-failed' | 'unparseable' | 'unknown-enum' | null; // non-null iff verifier-error
}

export interface AdversaryResult { text: string; costUsd: number | null; }
export type AdversaryFn = (prompt: string) => Promise<AdversaryResult>;

export interface Verifier {
  challenge(input: { taskId: string; taskPrompt: string; redactedResultText: string }):
    Promise<{ finding: ChallengeFinding; costUsd: number | null }>;
}
export function createVerifier(deps: { adversary: AdversaryFn }): Verifier;
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
  from a live agent run). The oracle `.mjs` source is **never** sent to the
  adversary (repo-controlled code; a direct injection channel, R-10
  adjacent).
- The adversary is instructed to return a single JSON object. The **wire
  format** is `{verdict: 'agree' | 'challenge', category?}` — the verifier
  maps it onto the finding's `status` (which adds the third,
  verifier-owned value `verifier-error` the adversary can never produce).
  The response is parsed with an **exact ajv field allowlist**, both values
  checked against the closed enums (arbiter condition 1).
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

- `GoldenRunnerDeps` gains optional `verifier?: Verifier`. When present, the
  runner challenges **oracle-pass rows only** — failed/errored rows carry no
  information a challenge adds (`task-parse`/`oracle-load`/`session-error`
  rows have no output; `oracle-fail` rows are already red). Recorded scope
  limit: an oracle-fail row's output is never second-opinioned.
- The challenge runs right after the oracle scores the row, on the
  **redacted** `resultText`: `redactSecrets` is applied to the adversary's
  request payload before the call. The primary call needs raw output to
  function; the adversary does not — redact-before-egress is defense in
  depth on top of the same-provider pin (§Adversary model).
- **`redactSecrets` becomes a REQUIRED `GoldenRunnerDeps` dep** (currently
  optional, `runner.ts:37`). ADR-0017's revisit-if M1 named this exact
  trigger — "a second runner composition appears" — and an egress path is a
  stronger trigger than M1's letter. Tests inject a fake; omission becomes a
  type error, not a silent no-redaction default.
- Verification cost is captured from `AdversaryResult.costUsd` per call and
  reported with the never-understated pattern (arbiter condition 4):
  `verification.totalCostUsd` (sum of known) + `unpricedChallenges` (count
  of null) — mirroring `GoldenTotals.totalCostUsd`/`unpricedTasks`.

## Scorecard shape (golden-only, binding)

The verification section lives entirely in **golden-scoped types**
(`GoldenScorecard` in `src/eval/golden/scorecard-shape.ts`) — never on the
shared `ScorecardEnvelope`/core, which the redteam baseline's exact ajv
allowlist and ADR-0019's `envelope` drift class sit on. ADR-0019 d4's
scalar-row contract independently forbids structural fields on rows, so
findings are a **section, never row fields**:

```ts
export interface VerificationSection {
  adversaryModelId: string;
  findings: ChallengeFinding[];       // one per oracle-pass row, ordered by taskId
  totals: { agreed: number; challenged: number; verifierErrors: number };
  totalCostUsd: number;
  unpricedChallenges: number;
}
// GoldenScorecard gains: verification?: VerificationSection
```

Tri-state legibility (panel condition): section **absent** = not run (and
the rendered markdown says so: "Adversarial challenge: not run — pass
`--challenge` (adds a second model call per passed task)"); section present
with `challenged: 0` = ran, nothing challenged; present with challenges =
the findings table. A reader of the bare artifact can distinguish all three.

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
- **Wiring lives in `src/cli/eval-command.ts`** — a pure-move extraction of
  the existing eval command from `cli.ts` (the redteam-command precedent;
  also discharges the E-3 review backlog LOW "asymmetric subcommand
  extraction"). `cli.ts` keeps dispatch only. The extraction commit is
  move-only, verified the same way ba79533 was; the `--challenge` wiring
  lands on top.
- **Pre-adversary-spend warning** to stderr at the phase boundary — after
  the oracle phase, before the first adversary call, because the pass-row
  count (= the number of adversary calls) is only knowable then:
  `warning: --challenge adds N adversary call(s) (one per passed task)`.
- Exit codes: **unchanged and solely oracle-derived** — stated as a
  co-located comment where the exit code is computed (the repo's pattern
  for report-only-adjacent decisions, cf. `gateOutcome`'s docstring).
- `USAGE` gains `eval [taskDir] [--challenge]`; README quick-start gains
  the `--challenge` line beside the `eval` one.
- Terminal output derived from findings is enum/count-only by construction;
  it still flows through `sanitizeForTerminal` like every other stdout path
  (two independent guards, ADR-0018 d4 doctrine).

## Report-only as a tested property (binding)

A CI-safe **differential invariance test** (arbiter condition 2): run the
golden runner with a fake adversary and without the verifier; assert
`rows[]`, `totals`, and the derived exit code are **identical** in both
runs, and the only delta is the presence of the `verification` section.
"Report-only" is thereby a property the suite enforces, not a sentence in
this document.

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

- **Verifier unit**: prompt construction (delimiters present, labels
  present, oracle source absent, redacted text used); strict parse — valid
  agree, valid challenge each category, extra field → `unparseable`,
  out-of-enum category → `unknown-enum`, call rejection → `call-failed`;
  one-call-no-retry pinned.
- **Runner integration**: pass-rows-only selection (fail/error rows get no
  finding); findings ordered by taskId; cost sum + unpriced count; required
  `redactSecrets` type-error proof (compile-time) + adversary payload is
  the redacted text (runtime assertion via fake).
- **Differential invariance** (condition 2): rows/totals/exit identical
  with and without the verifier.
- **CLI**: `--challenge` parse; unknown-flag rejection unchanged for other
  flags; tri-state markdown rendering (absent / zero-challenge / findings
  table); phase-boundary warning line; exit-code invariance; USAGE string.
- **Extraction commit**: eval-command move verified behavior-preserving
  (cli.test.ts imports unchanged, the ba79533 pattern).
- **Live acceptance** (operator-invoked, never CI): `node dist/cli.js eval
  --challenge` on the starter tasks with a real key — Claude as both
  primary and adversary, satisfying the E-4 acceptance clause; result
  pasted into the PR/devlog as evidence.

## Documentation

- **ADR-0020**: locked decisions; the enum-confinement CRITICAL and its
  by-construction resolution; aggregate-value/gate-vs-measurement framing;
  B's rejection; C fallback + trigger; the six arbiter conditions; the
  router-legality note (eval-layer verifier vs ADR-0016's security-layer
  judge); accepted limitations verbatim.
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
