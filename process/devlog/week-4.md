# Week 4: docs, dogfooding, and ship (2026-07-13 → 2026-07-14)

Planned scope: final docs pass, three blog essays, the `harness init`
scaffolder, and npm publish. The plan review at the start of the week
resequenced these deliberately: the highest-value hiring payload (docs +
blog) was originally scheduled *last*, behind a net-new feature and an
irreversible publish, and would have published an un-audited README
advertising an unbuilt `init`. Corrected order: docs, then blog, then
`init` (marked cut-if-slip), then publish (last, hard-gated).

## S1: docs final pass

Hybrid mode: three read-only audit agents produced punch-lists, then the
prose/pitch half stayed interactive. The worst hiring-read defect the
audit caught: the README Status table said "Repo scaffold: In progress"
while 849 tests were green. Truth-aligned the table, corrected the
architecture.md API signatures against the shipped contracts, added the
ASI01–10 mapping to the security model, and shipped a new `check-links`
gate as its own CI job. A security catch in review downgraded an "ASI01
hybrid scanner" claim to heuristic-only. Merged as #26.

Then a security follow-up (#27, issue #24): the injection scanner's
`stripBidi` was hoisted to an internal, invisible-char stripping added,
and the skill-description scan closed. **Lesson banked:** the local gate
chain piped `lint` through `tail`, which masked eslint's exit code; CI
caught what local "green" missed. Never pipe a gate command when its exit
code is the signal.

## S2: blog essays, and the hour dogfooding paid for itself

The plan called for the essays to cite real usage, so the first move was
to build a real consumer: `examples/repo-qa/`, a small Q&A agent with one
skill and two golden tasks. **Within the first hour it found a defect 859
green unit tests had never touched: skill bodies were never reaching the
model.** ADR-0006 had promised for weeks that the body "is what the agent
reads," but prompt assembly injected only the name and description. Every
unit test asserted on the fields the code actually used, so the suite was
green and the contract was broken.

The sharper lesson was in *how* the eval caught it. The first golden task
("which ADR defines the oracle contract?") *passed*: right answer, wrong
mechanism: three turns of tool-hunting through the repo, with the skill
nowhere in context. Only when the task was tightened to "answer from the
loaded skill, without tools" did the truth surface. A passing eval is a
claim about the oracle, not just the system; the task descriptor is part
of the oracle's precision. Fixed in #28 (body injection, raw-body scan,
an aggregate size budget); after the fix the two tasks pass in one turn
each at roughly half the cost.

Two incidents from this stretch, both recorded because they are the kind
that only show up in anger:

- A code-reviewer subagent ran `git checkout --` mid-review and destroyed
  uncommitted tests. It self-restored, but the lesson stuck: dispatch
  reviewers read-only, and re-verify the tree independently after any
  reviewer discloses it probed the working copy.
- The eval must run *from* the example directory, or the committed
  `.harness/settings.json` policy is inert (settings load from cwd). The
  security review caught this before it shipped as a broken demo.

The three essays went through an author voice pass (a `jackson-voice`
skill now encodes the tone contract; the house rule that came out of it:
never use em-dashes, anywhere). Merged as #30 after the draft banners
came off.

## S3: `harness init`, design-first

The cut-if-slip feature, so the bias was smallest-honest-surface. A
skeptic/constraint/advocate panel produced 15 findings *before any code*,
and the two most valuable were cases where the spec asserted things from
memory that the code contradicted: the exit-code map was backwards (usage
errors already exit 2), and a "missing-key preflight" the spec proposed
already shipped. Both re-grounded against source. The settings posture
(deny the network tools, no `defaultDecision`) was arbitrated 2-1, with
the dissent carried into the scaffolded README as a named limitation
rather than smoothed over.

Then the review pattern this repo keeps proving: `/review3` found a HIGH
(init wrote the policy file *through* a pre-planted `.harness` symlink,
because `existsSync` follows links), and the adversarial verify pass on
the fix found a residual (the shared parse-error sink echoed argv
unsanitized, reachable via `init *`). Both fixed and re-verified live.
The milestone differential review came back APPROVE. Merged as #31; a
scaffolded starter passes its own eval in one turn.

## S4: npm publish, last and hardest-gated

Publish is a one-way door, so it was built to the point where only the
operator's authenticated actions remain. It publishes from CI via **OIDC
trusted publishing** (no long-lived token) with **build provenance**,
triggered by a GitHub Release. The pack was audited for real
(`npm pack --dry-run`, not a glance): the test-only fake-secret fixtures
were stripped from the public barrels and excluded from the build so no
credential-shaped strings ship, and dead source maps (pointing at
unshipped `src/`) were turned off. The tarball dropped from 309 files /
614 KB to 155 / 362. The `engines` floor was corrected `>=20.1` ->
`>=20.10` (the shipped code uses import attributes; the CI matrix's
latest-minor resolution had hidden the overclaim).

The three-lane review earned its place again. The code and security lanes
both flagged the version-guard step as a GitHub script-injection vector:
`release.tag_name` interpolated straight into a `run:` body, in the job
that holds `id-token: write` immediately before `npm publish`. A crafted
tag could have executed code inside the exact trust boundary the workflow
exists to protect. Fixed with env-var indirection, the npm install pinned
in the same pass, the README's premature "Published" claim walked back to
honest future tense, and the lockfile version synced. Opened as #32;
CI green.

The authenticated publish stays a human action: link the npm trusted
publisher once, then cut the `v0.1.0` release.

## Week 4 in one line

Docs truth-aligned, three essays shipped, `init` scaffolder merged, and
the publish path built and hardened to the last irreversible click. The
recurring lesson across all four: the dangerous bug is the one the remedy
introduces, and the eval that passes is a claim about the oracle. 899
tests; #26, #27, #28, #30, #31 merged; #32 open for the operator.
