# Adversarial evaluation for LLM agents: golden + red-team + two-pass

> **Status: Draft — awaiting author voice pass.** 2026-07-14.

The eval layer of [agent-harness-JA](../../README.md) has three parts: a
golden-task runner with executable oracles
([ADR-0017](../decisions/0017-golden-runner.md)), a red-team corpus with a
deterministic regression gate
([ADR-0018](../decisions/0018-redteam-corpus.md),
[ADR-0019](../decisions/0019-regression-gate.md)), and a two-pass
adversarial verifier ([ADR-0020](../decisions/0020-adversarial-verifier.md)).
The [eval methodology](../eval-methodology.md) describes how they fit. This
post is about the two judgment calls underneath them that I'd defend in an
interview — and one incident from this week that tested the whole apparatus.

## Gates and measurements are different machines

The scanner's detection rate across the 51-case red-team corpus is ~92%.
That number appears on every scorecard and **gates nothing**. What fails CI
is different: any *false block* (benign input blocked — `falseBlockCount`
must be exactly zero), and any *drift* from a committed baseline — including
drift in the "good" direction.

Failing on improvement sounds perverse until you say it plainly: an
improvement you didn't ask for is a change you didn't review. If a
dependency bump silently lifts detection from 92% to 94%, something about
scanning behavior changed, and the honest response is the same as for a
regression — stop, look, then deliberately re-baseline
(`--update-baseline` exists precisely so the change lands in a commit a
human approved). A threshold gate ("detection ≥ 90%") would have waved both
cases through. Determinism is the property that makes the gate cheap to
trust: the corpus is compiled in, the scanner is pure, and the whole gate
runs keyless in seconds on every PR.

The same boundary explains what the corpus records. Three cases are *known
misses* — jailbreak-03 gets through the heuristics today — and they are
carried with `expected: 'block'` against a live `pass`. The corpus states
what *should* happen; the scorecard states what *does*; the gate pins the
gap so it can only move by deliberate decision. Deleting or "expecting" a
known miss to make the numbers tidy would be the eval equivalent of fixing
the test instead of the bug.

Why is golden eval not in CI at all? Because its oracles are arbitrary
in-process code from the repo under evaluation (R-10 in the
[security model](../security-model.md)), and a fork PR plus a CI API key is
an exfiltration primitive. The keyed, oracle-executing arm is
operator-invoked; CI gets the keyless deterministic arm. Where a gate would
be unsafe, the design says so instead of pretending.

## The two-pass verifier distrusts itself

`eval --challenge` runs a second model over already-passed tasks and asks it
to challenge the oracle's verdict. The interesting design is in what the
adversary is *not allowed to do*: its findings are confined to closed enums,
its prose is never persisted or printed, it runs de-fanged (one turn,
deny-all pre-tool hook), and it can never change an exit code
([ADR-0020](../decisions/0020-adversarial-verifier.md)). The adversary reads
attacker-influenceable content, so it is itself injectable — a compromised
adversary can at worst generate noise in a report-only channel. The same
tighten-only philosophy shows up in the deferred LLM judge
([ADR-0016](../decisions/0016-llm-judge-design-deferred.md)): semi-trusted
components get one-way authority, so successful attacks on them degrade into
false positives, not policy bypasses.

Two properties of the verifier are pinned by tests rather than convention.
First, *exit-code invariance*: a differential test runs the same task set
with and without `--challenge` and asserts identical rows, totals, and exit
code — the verifier is structurally incapable of flipping a build red or
green. Second, the reported metric is a *rate with an honest denominator*:
`challenged / (passed − no-output)`, so tasks the adversary never got usable
output for can't dilute the signal. In its live acceptance run the verifier
challenged 0 of 2 passed tasks (agreed 2) for about $0.13 of adversary calls
— an unremarkable result that is exactly the point: a report-only skeptic
that mostly agrees is cheap, and the one time it doesn't will be worth every
prior boring run.

## The week the eval earned its keep

This week I built the first real consumer: a small
[Q&A agent](../../examples/repo-qa/README.md) with one skill and two golden
tasks. Within the first hour it found a defect that 859 green unit tests had
never touched: **skill bodies were never reaching the model.**
[ADR-0006](../decisions/0006-skill-schema-markdown-frontmatter.md) had
promised for weeks that the body "is what the agent reads when the skill is
loaded" — but prompt assembly injected only the name and description. Every
unit test asserted on names and descriptions, i.e. on exactly the fields the
code used, so the suite was green and the contract was broken. The fix, with
the security work the widened prompt surface required, is PR #28.

The part worth dwelling on is *how* the eval caught it, because the first
run didn't. The initial golden task — "which ADR defines the oracle
contract?" — **passed** on its first attempt: three turns, ~$0.10, the agent
happily ignoring the skill it couldn't see and tool-hunting through the repo
to find the answer. Right answer, wrong mechanism, green scorecard. Only
when I tightened the task to "answer directly from the loaded skill, without
tools" did the truth surface: the model had no skill content at all, and the
task failed.

That is the sharpest lesson of the week: **a passing eval is a claim about
the oracle, not just the system.** My oracle checked the answer's content;
it could not distinguish a grounded answer from a searched one. The task
descriptor and prompt are part of the oracle's precision. After the fix, the
same two tasks pass in one turn each at roughly half the cost — the
before/after is visible in the scorecards (2/2, single-turn, versus the
three-turn scavenger hunt; dollar figures here are dated and illustrative,
costs drift with models and prices):

| run | result | turns | cost |
|---|---|---|---|
| pre-fix, tools allowed | pass (by tool-hunting) | 3 | $0.1001 |
| pre-fix, "answer from the skill" | fail | — | — |
| post-fix | 2/2 pass | 1 per task | $0.0321 + $0.0159 |

A dogfooding hour did what no amount of additional unit testing at the same
altitude would have: it tested the *documented contract* instead of the
implementation's own reflection. The unit suite now pins the fixed behavior
(body injected, scanned raw, size-budgeted) — but the ordering matters. The
eval found it; the tests keep it found.

## What I'd tell someone building this

Decide per number: gate or measurement. Gate only what is deterministic and
cheap to re-derive; measure the rest and make drift loud. Keep the corpus's
"should" separate from the scorecard's "is." Give semi-trusted evaluators
tighten-only authority. And get a real consumer running *early* — the
[week-3 devlog](../../process/devlog/week-3.md) records the eval layer being
built; it took until week 4's first real example to learn which of my green
checkmarks were reflections.
