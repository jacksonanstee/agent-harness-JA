# ADR-0031: retained deny reasons drop the permission glob (issue #59 round 2)

- **Status:** Accepted — design CD shipped 2026-08-07 (PR #76). **Design A shipped 2026-08-07 in its own PR** (root-relative skill-drop paths; verification appended below). **Design E shipped 2026-08-07 in its own PR** (`telemetry export --scrub-prefix`; verification appended below). All three designs of this round are now live
- **Date:** 2026-08-07
- **Amended:** 2026-08-25: decision 4's named asymmetry closed (issue #75, its own PR; verification appended below)
- **Requirements:** issue #59, second design round (the first is ADR-0027, which killed all three of its designs and constrained any successor)
- **Relates to:** ADR-0027 (decisions 3, 4 and 5 bind everything here; design CD fires no revisit bullet — it is a formatting decision, not a keyed transform — and design E, once shipped, fires the explicit-argument bullet for the FIRST time, that section's third fire overall counting the taskDir bullet's two; the ADR-0027 annotation rides with design E's PR), ADR-0030 (the computed-value distinction and suppress-not-normalise precedent this round applies), ADR-0014 §8 (the reason format this supersedes), ADR-0011 decisions 16 and 17, ADR-0028 (removal-only transforms), security-model R-16 and R-17

## Context

ADR-0027 accepted issue #59 as a residual after killing three designs, and its revisit-if
carried the distinction ADR-0030 later proved out: the fixable class is a value the harness
COMPUTED from operands it still holds at write time. This round asked what that distinction
reaches across the four channels R-17 still names.

A three-agent mapping pass (2026-08-07) established the operative facts with file:line
evidence, then a three-lens design panel (hostile skeptic and constraint-checker on the
session model, user-advocate) reviewed a three-design spec: **zero kills, 22 findings, every
HIGH carried an executed counterexample.** All findings were folded into the designs below.
Two panel executions changed the designs materially:

1. `describeRule` reasons carry a COMBINED-list rule index: with two user rules loaded, a
   project file's first rule reports `[rule 2, project]` (executed). Today that is harmless
   because the glob sits in the same string; once the glob is removed, the index is the only
   recovery key, so a combined index converts a latent mis-pointer into a live
   wrong-attribution. The fix is nearly free: `layerWinner`'s index is already the position
   within that layer's own settings file.
2. The panel refuted the spec's claim that the two truncation band tests should be re-derived
   for design A: they are unit pins of an unchanged function and re-deriving them would
   delete R-16's measured evidence. The reddening set is elsewhere and is now enumerated.

Also load-bearing, from the mapping: no live terminal channel for deny reasons exists — the
CLI prints only `denied=<count>`, so the operator's only sight of a reason is the
`telemetry export` read-back of the retained row. "Keep the glob on the terminal, not in the
artefact" is therefore not a repointing of an existing channel; the honest move is that the
retained string simply never contains the glob.

## Decisions

1. **The retained deny reason never carries the rule's `match` glob.** `describeRule` formats
   `<decision> <tool> [rule <index>, <layer>]` — the match arm is gone. Match globs are
   routinely absolute paths under the operator's home directory, and the one formatting site
   feeds both retained sinks (telemetry `denied-by-hook` rows via the hook runtime, and the
   memory summary's `denied[]`), so a single edit closes R-17 channels (c) and (d). A third
   consumer is fixed for free: the deny reason is returned to the MODEL as the SDK
   `permissionDecisionReason`, and a model that echoes it into later prose could re-import
   the glob into channel (e); after this change it never receives the glob at all.

2. **The rule index is the position within the winning rule's OWN layer's settings file**, in
   both the reason string and `Evaluation.ruleIndex`. `[rule 0, project]` now means "the
   first rule in your project `.harness/settings.json`" — a lookup the operator can do by
   opening the one file the layer tag names. The combined-index map is deleted; ADR-0014 §8's
   quoted format is superseded (annotated there, not silently rewritten).

3. **No fired-signal accompanies this change, and that is argued, not overlooked.**
   ADR-0027 decision 3 binds transforms keyed on ambient values that can silently no-op.
   This change keys on nothing: there is no conditional path, so there is no "did it fire"
   question — the string is glob-free by construction. Recorded so the next reader does not
   demand a signal where no transform exists.

4. **`denied[]` passes redact-then-truncate at the memory write**, the same seam and ordering
   as `prompt`/`resultText`. The deny reason is harness-authored today, but ANY registered
   hook's throw message becomes a `denied[]` entry, so the bypass was a standing trap for
   future reason sources. Defence in depth, not the fix itself. **Named asymmetry, found by
   this ADR's own review round with an executed PoC:** the TELEMETRY copy of the same reason
   (`denied-by-hook` rows) stays raw — control-char strip only, no redaction, no length
   bound — which sits below the codebase's own standard for attacker-influenced strings
   entering telemetry (`resultSummary` is redact-then-truncated at the same seam). No live
   exposure with the shipped hooks; filed as issue #75 rather than folded in, and this
   sentence exists so "defence in depth" is not read as covering a sink it does not.
   **Asymmetry CLOSED 2026-08-25 (issue #75, its own PR):** the telemetry copy now passes the
   same ORDER of redact-then-truncate, to the same ceiling, at the mapping seam
   (`hookRecordToTelemetryInput`, `src/cli/shared.ts`), with the cap owned by telemetry
   (`HOOK_EVENT_REASON_MAX`, `boundHookEventReason`) and the redactor a REQUIRED dependency of
   the mapper, a compile-time pin against omitting it rather than a guarantee about what the
   supplied redactor does. Verification, the exact parity, and what remains uncovered are appended below.

5. **Ephemeral surfaces may carry the glob.** The constraint is on retained sinks. A future
   live deny print or error message may name the glob; nothing here forbids that.

6. **Design A is accepted with the panel's changes and lands in its own PR**: skill-drop
   paths stored root-relative. `LoadResult` gains `root: string | null` (the `resolve(dir)`
   the walk used, captured once — reuse of a held operand, no fresh ambient read); the
   stored value becomes `escapePathUnsafe(relative(root, rawPath)).value` through
   `boundSkillDropPath` (escape-after-relativise, preserving the transform-then-truncate
   contract); an ADR-0030-shape classifier suppresses any non-clean form with
   `pathForm: 'root-relative' | 'suppressed'` as the signal, OPTIONAL on read so legacy rows
   stay admissible (`rowToEvent` throws on payload mismatch and one bad row denies the whole
   export — the pathDigest optionality precedent). Accepted costs, recorded now: cross-root
   sub-cap rows with equal relative paths become byte-identical with no digest — the exact
   objection that helped ADR-0011 decision 17 kill relative DIGESTING; it does not kill
   relative STORAGE because rows keep `sessionId`, the digest's correlation job lives in the
   truncated tail (where raw pre-images stay distinct), and removal-only is the direction.
   Always-digest is rejected twice over: it spends decision 17's zero-digest-row window and
   violates the enforced digest-implies-truncated coupling (issue #55). Channel (a) is
   NARROWED, not closed: ADR-0027 decision 4's ceiling binds design A too — everything below
   the root survives, including operator-authored client-named subdirectories, and on
   truncated rows the digest becomes the row's only home-prefix carrier. The R-16 re-word
   rides with that PR. The digest pre-image stays the raw absolute path (decision 5,
   untouched).

7. **Design E is accepted with the panel's changes and lands in its own PR**:
   `telemetry export --scrub-prefix <path>` (repeatable; explicit operator argument, no
   environment default). Replacement fires only at a segment boundary — the panel executed
   `/home/al` firing inside `/home/alice` and a trailing-separator prefix missing the bare
   form; both become fixtures. Each emitted row gains
   `scrub: {applied, count, transform: 'prefix-v1'}`; `count` exposes forged markers, and
   `applied: true` means "at least one replacement fired", NEVER "row is clean". ADR-0027
   decision 3's "in the row" is READ HERE, once, as the emitted export row for an export-time
   transform — the artefact being shared — matching the decision's origin (Design C was an
   export-time no-op with no signal). An unscrubbed export whose rows match a
   home-directory-shaped pattern gets one stderr nudge line; default output stays
   byte-identical. E's ceiling is prefix hygiene (decision 4) and its re-proposal against
   Design C's recorded kill is deliberate: the form shipped is the one decision 3 itself
   names as usable, and this ADR records the second corpse's anatomy next to the first so a
   third proposal must answer both.

8. **Scope.** On this PR's merge, R-17 channels (c) and (d) close. Channel (a) narrows when
   design A's PR lands; channel (e) is UNCHANGED (incidental prose, no second operand —
   ADR-0027's characterisation stands; E affects only the export copy, opt-in). Issue #59
   stays OPEN and this round must never be described as closing its title (ADR-0027
   decision 4). ADR-0011 decision 17's re-cost clause does not fire.

## Rejected alternatives

- **Structured deny fields threaded through the pipeline** (`PermissionDenied` properties,
  `FireResult`, `HookEventRecord`, `DeniedToolCall`): five types changed to carry what the
  flat string already carries once the glob is gone. Blast radius without benefit.
- **Keeping the combined index and documenting it**: the operator cannot compute a combined
  position from the one file the layer tag names, and documentation is not an affordance.
- **A fired-signal for design CD** (decision 3 above — no transform exists to signal).
- **A `permissions list` CLI diagnostic in this diff**: useful, out of scope; filed as a
  follow-up issue instead (scope discipline).

## Consequences

An operator investigating a shared export recovers the rule by opening the named layer's
settings file at the named position. If they edited that file between the deny and the
read-back, the index can point at the wrong rule — true before this change too, but the glob
no longer disambiguates; the per-layer index minimises the window and the residual is
accepted. Live debugging is unchanged: no live deny print existed to lose.

The blog's quoted telemetry row (`permission: deny Write [rule 0, project]`) was produced by
a tool-only rule and survives verbatim; its `[rule 0, project]` now also happens to be the
per-layer reading.

## Verification, and its named limits

Three RED-first tests bind the change (each observed failing against the shipped behaviour
before the fix): the glob-free exact reason string including a `not.toContain` on the
path-bearing fixture; the per-layer index with the panel's executed counterexample as the
fixture (two user rules ahead of a one-rule project file, asserting `[rule 0, project]`);
and the `denied[]` redact-then-truncate test (marker survives, secret does not, length capped
at the summary limit plus ellipsis).

Two mutation gates, each asserting its replacement applied before running and restored
byte-identical after: gutting `describeRule` to the bare decision reddens exactly SEVEN
reason-binding tests over the full suite (the two new evaluate tests, the tool-only and
cross-layer and sticky-deny pins, the `mergeLayers` end-to-end pin in `settings.test.ts`,
and the end-to-end S-3 session test); reverting the `denied[]` map to a raw passthrough
reddens exactly the new channel-(d) test. The count is a correction with a lesson attached:
the first run of this mutation covered only the two edited test files and its result was
recorded as "exactly six", an executed-exhaustiveness claim the review's independent
re-execution refuted by finding the seventh binding test in a file the author had not
touched. The gate was re-run over the full suite before this paragraph was amended.

**Limits.** The telemetry `denied-by-hook` row's glob-absence is asserted at the unit and
session level, not through a live SDK run in CI (the composition root hardwires the real
SDK; the suite deliberately mocks no modules) — a live match-rule deny smoke is run
out-of-band and recorded in the PR. The `ask`-path suffixes (`— declined by prompter` and
friends) append to the same glob-free base string and are covered by existing tests.

## Verification for design A (appended 2026-08-07, its own PR)

RED-first where runtime-visible: the three store-validator tests (suppressed shape
accepted; null path without the suppressed form and unknown `pathForm` values rejected; the
legacy-plus-suppressed upgrade trail) were observed failing against the shipped validator
before it changed. The session-level pins reddened exactly as the design record enumerated
(`process/designs/2026-08-07-issue-59-round2-design-spec.md`, Design A v2 item 6 — this
ADR's decision 6 records the design, not the test list): the exact-payload pin, the
distinct-row pin, the digest fixture that had to MOVE under the mocked root because an
out-of-root path now suppresses, and `load.test.ts`'s empty-dir equality, plus the
`loadSkills` mock literals at the type level — 49 shipped, where the spec's 51 was a
pre-implementation estimate. Suite 1174 → 1187, then 1189 after the review round's two
additions (the suppressed-arm coherence pins and the strictly-above-home documented-limit
pin), then 1190 after the verify round's equality-boundary pin. Semver obligation, recorded here so the PR cannot omit it: `LoadResult` gains a
REQUIRED `root` field (breaks external `loadSkills` implementers) and `SkillDropPayload`
changed from interface to union — the PR body carries the breaking-change note, version
implication decided there (package still pre-first-publish).

Mutation gates on `relativeSkillDropPath` and the write site, each asserting its
replacement applied and restored from a scratch copy (never `git checkout`) verified
byte-identical:

- NULL mutation FIRST (always-populate with the raw absolute path): 11 red at the
  implementation tree; 13 at the final tree. These two counts are a FUNCTION OF THE TREE —
  every later test that pins the populated arm raises them — and the verify round caught
  this section quoting implementation-tree numbers after the review round's additions had
  moved them. They are recorded here as measured at the tree that carries this sentence
  (1190 tests), and any future addition of a populated-arm pin moves them again.
- Positive branch flipped to suppress: 10 red at the implementation tree; 12 at the final
  tree, every populated-path pin including the end-to-end session ones.
- Segment check replaced with `startsWith('..')`: exactly the `..foo` boundary test.
- Precondition guard removed: exactly the enforced-precondition test — via the
  `('.', './x.md')` fixture added because the other non-absolute fixtures suppress through
  the fall-through even without the guard; a guard pin must be an input the unguarded code
  would POPULATE.
- Empty-string arm removed: exactly the totality test.
- Write-site `escapePathUnsafe` deleted: 2 red (the raw-digest test's stored-value
  assertion and the pathHasEscapes pre-image test), binding the
  relativise-then-escape-then-bound order.

The verify round on the review fixes produced this project's eighth consecutive
refutation-of-a-recorded-claim, and it landed on the CORRECTION itself: the qualifying
clause shipped as "a root at or above `$HOME` re-admits home segments" is false at its own
boundary — executed, a root EQUAL to `$HOME` strips the entire home prefix, so the
guarantee HOLDS at equality and only a root STRICTLY above re-admits. Six instances
corrected (README, R-16, R-17(a), the classifier docstring, the test title whose body only
ever exercised the strictly-above case, and this section), a seventh unconditional "never"
found at the session write-site comment and qualified, and the equality case now carries
its own executed pin. The lesson is the same one this section already records once: the
author of a correction is the worst-placed person to check it, and a boundary claim needs
an executed pin AT the boundary, not near it.

**Limits.** Through the real CLI the suppress arm is UNREACHABLE by construction — the
loader's join-based walk only produces paths under its own root — so no live smoke can
drive it end-to-end; it is bound instead through `run()` with a caller-supplied
`loadSkills` returning an out-of-root path (the suppression test), which is the same
trust boundary the arm exists for. The live smoke covers the populated arm: a real run
with a real dropped skill, exported, zero home-directory occurrences and the relative
stored form confirmed. All measurements darwin, ASCII paths; the Windows cross-drive
branch of the classifier is reasoned, not executed (no Windows CI), and fails in the
safe direction.

## Verification for design E (appended 2026-08-07, amended 2026-08-08 with the review and verify rounds, its own PR)

RED-first where the behaviour is new: six CLI tests were observed failing against the
shipped exporter before the change (repeatable-flag parse, per-row scrub signal, the
`--out` copy, the nudge line, the no-nudge-under-flag case, scrubbed-line parseability),
and the unit file failed wholesale on the missing module. Two pins were GREEN on write
and are recorded as such rather than claimed as TDD: the invalid-value parse test (every
unknown flag already parsed to an error) and the no-`scrub`-key-by-default byte-shape
pin. Their bindingness comes from the mutation gates below, not from a RED moment that
did not happen. Both panel-executed counterexamples are fixtures: `/home/al` must not
fire inside `/home/alice`, and a trailing-separator argument still catches the bare
form.

**The review round refuted the first cut in four executed places, and the fixes are
part of this PR** (three lenses; every finding below carried an executed PoC):

1. **The boundary was wider than the spec, and the width was the alice bug.** The
   first cut fired on any character outside a "segment continuation" class, so a
   sibling directory named `/Users/jackson (Work Laptop)` was corrupted to
   `[marker] (Work Laptop)` with `applied: true` — mis-attribution through every
   filename-legal punctuation character, NFD combining marks included. The shipped
   boundary is the spec's, literally: separator or end-of-string, nothing else — with
   "separator" resolved PER PREFIX FORM (see the ninth-refutation paragraph below).
   The cost runs the other way and is a NAMED residual: an occurrence terminated by
   prose punctuation (`cd /Users/jackson && ls`) survives in cleartext, pinned as
   documented behaviour.
2. **Payload KEYS were not scrubbed and the exempting comment was false.** The store
   validators are positive-conjunct checks that admit extra keys, so a planted row's
   KEY carried a home path in cleartext on a row stamped `applied: true` (executed
   through the public `record()` API). Keys are now scrubbed like values; two keys
   collapsing onto one scrubbed form (a plantable marker-key collision) refuse the row
   loudly rather than silently dropping data.
3. **The nudge's Windows arm was dead at its only call site.** Detection ran over the
   JSON-serialised body, where backslash-doubling made `\Users\` unmatchable — the
   unit pin was green while the seam never fired (executed with a seeded row; three
   lenses found this independently). Detection now walks RAW event values, keys
   included, with an iterative walk so a hostile deep row cannot crash the default
   export; the CLI seam has its own pins now, and the round-1 mutation gate that
   "passed" on the unit pin alone is the corrective-artefact lesson re-learned.
4. **A hostile deep row crashed only the scrubbed export** (stack overflow at depth
   ~2000, default export fine at 100000) — a downgrade pushing the operator back to
   cleartext. The walk now refuses beyond `MAX_SCRUB_DEPTH` (64, the skills scanner's
   cap) with a loud, untrusted-byte-free error naming the row position; the refusal
   denies the WHOLE scrubbed export, the rowToEvent precedent. The boundary is pinned
   by execution (62 nest levels scrub, 63 refuse).

Also folded from the round: `parseScrubPrefix` normalises (`/Users/./jackson` matched
nothing while suppressing the nudge — the likeliest typo was the exact case with no
signal); a SECOND stderr nudge fires when home-shaped paths SURVIVE a scrub (wrong or
misspelt prefix, case variant, NFC/NFD mismatch — observe-only, no row data, default
bytes untouched; an extension beyond the panel spec, argued here: the panel's nudge
clause covers only the no-flag case, and three review findings converged on "the
detector goes dark exactly when the operator relies on it"); the counterfeit check is
documented as AGGREGATE (total marker occurrences of ANY ordinal vs `count` — a
per-ordinal comparison is unsound once the flag repeats, executed) and pinned; and the
spec's "help text" venue for the applied-is-not-clean caveat collapsed into USAGE
because the CLI ships no help command — recorded as the venue's honest state.

**The verify round on those fixes produced this project's NINTH consecutive
refutation-of-a-recorded-claim, again at the correction's own boundary.** The fixed
boundary treated `\` as a separator on EVERY platform; backslash is filename-legal on
POSIX and `parseScrubPrefix` admits only POSIX-form prefixes on this host, so on darwin
the `\` arm could only ever fire as mis-attribution — executed end-to-end:
`/Users/testhome\backup/prod.env` was consumed to `[marker]\backup/prod.env`, stamped
`applied: true`, and NUDGE-SILENT, because consuming the home-shaped bytes also blinds
the survivor nudge. The correction's correction: the separator set is resolved per
prefix form (`/` for a POSIX-form prefix; both separators for a Windows-form prefix,
which only a win32 host's `parseScrubPrefix` admits). Both refuter fixtures are pinned,
the Windows-form arm is pinned directly through `scrubText` (which trusts its input, so
the form is exercisable on darwin), the near-miss now leaves the bytes intact so the
survivor nudge FIRES (pinned at the CLI seam), and the separator rule has its own
mutation gate. The verifier also independently re-executed all nine prior mutation-count
claims (measured equalled claimed at that tree) and byte-diffed the default export
against a scratch build of main across five seeded databases: identical.

Mutation gates, each asserting its replacement applied before running and restored from
a scratch copy (never `git checkout`) verified byte-identical. Counts are a FUNCTION OF
THE TREE (design A's lesson) and were measured over the full suite at the tree that
carries this sentence (1240 tests):

- NULL mutation FIRST (transform gutted to identity, count 0): 21 red — every unit pin
  of the transform plus the CLI integration pins.
- Boundary check removed (fires regardless of the following character): exactly its 8
  pins — the alice fixture, the punctuation-sibling set, the continuation set
  (dash/dot/unicode/NFD/astral), the longest-fails-fall-through pin, the
  prose-residual pin, both ninth-refutation backslash fixtures, and the Windows-form
  pin.
- Count decoupled from replacements (replacement fires, count stays 0): 18 red,
  including both counterfeit-arithmetic pins.
- `HOME_SHAPED` gutted to never-match: 7 red — the unit shapes AND both CLI nudge
  seams plus both survivor seams (the round-1 version of this gate passed with the
  seam unbound; it cannot any more).
- CLI wiring nulled (flag parsed, transform never applied): 6 red — signal row,
  `--out` copy, no-nudge-under-flag, both survivor-nudge seams, and the deep-row
  refusal.
- Key-scrub removed (keys pass through raw): exactly its 3 pins.
- Depth cap removed: exactly its 2 pins (unit boundary and the CLI refusal seam).
- Collision refusal removed: exactly its 1 pin.
- Survivor nudge removed: exactly its 2 pins (wrong-prefix and backslash-near-miss
  seams).
- Separator set collapsed to always-both (the ninth refutation re-introduced):
  exactly the 2 ninth-refutation pins.

One observation carried from the panel (finding 15), recorded here because it belongs
to this design's cost side: in a scrubbed export the skill-drop `pathDigest` becomes
the weakest link — its pre-image stays the raw absolute path (decision 5), so a reader
holding a guessable path list can confirm a home prefix through the digest that the
scrub removed from the cleartext. Removal-only still holds (the digest was already
there); the point is that `--scrub-prefix` does not touch it, and saying so beats a
reader discovering it.

**Limits.** The live smoke (a real run, exported with and without the flag, zero
home-directory occurrences in the scrubbed copy, byte-identical default output) is run
out-of-band and recorded in the PR — the suite deliberately mocks no modules and CI has
no API key. Matching is exact bytes: a case variant of the same directory on a
case-insensitive filesystem and an NFC/NFD spelling difference both evade the scrub
(executed), which is why the survivor nudge exists and why the README names both.
`parseScrubPrefix` uses this platform's `path.isAbsolute`; Windows-form prefixes on a
POSIX host are rejected, reasoned rather than executed (no Windows CI), and the
rejection fails closed. A row that cannot be scrubbed (depth, collision) denies the
scrubbed export while the lossless default stays available — a plantable denial,
accepted with the rowToEvent precedent and named here. All measurements darwin; the
executed boundary fixtures cover ASCII, BMP unicode (`ñ`), NFD combining marks, and
one astral (surrogate-pair) continuation case.

## Verification for issue #75 (appended 2026-08-25, its own PR)

**What changed.** `hookRecordToTelemetryInput` (`src/cli/shared.ts`) takes a REQUIRED third
argument `{ redactSecrets }` and passes the `reason` of `denied-by-hook` and `hook-error` rows
through redact-then-bound before the row reaches the store: redact first, then
`boundHookEventReason` (`src/telemetry/store.ts`), which cuts surrogate-safe to
`HOOK_EVENT_REASON_MAX = 200` (`src/telemetry/types.ts`, that file's total-stored-length
convention, ellipsis included). The whole transform sits inside one `try` and its result is
type-checked: a redactor that throws, or returns anything but a string, stores
`[REDACTION FAILED]`, never the raw reason. Both composition-root call sites (`src/cli.ts` run,
`src/cli/eval-command.ts`) supply the real `redact`. The payload SHAPE is unchanged and there is
no validator bound. Two further changes came out of the verify round (recorded below): `reasonOf`
in the hook runtime can no longer throw, and the session's own `fire failed:` hook-error row now
passes redact-then-bound as well, so all three writers of a hook reason are bounded.

**Where the cap lives, and the options named.** The first cut kept the constant in `cli/shared.ts`;
the architecture review moved it. The skill-drop precedent has three parts: a constant in
`telemetry/types.ts`, an exported write-side truncator the capture site calls
(`boundSkillDropName`), and a symmetric conjunct in the validator (`isSkillDropPayload` rejects an
over-long field on write and on read alike). This change takes the first two and deliberately not
the third. The module that owns the payload shape now owns its cap, and a telemetry constant is
importable from session, cli and eval alike, which is what let the third writer reuse it. Rejected:
the validator conjunct (it would serve `record()` and `rowToEvent` symmetrically, so a legacy
over-long row would be rejected on READ, and `rowToEvent` denies a whole export on one bad row, the
pathDigest-optionality precedent; skill-drop could afford the conjunct because no rows predate its
cap, and this field has rows that do); write-only validation (it would introduce the first
`record()`/`rowToEvent` asymmetry in that file, a property `store.ts` states on purpose); and
"optional on read like `pathForm`", which does not apply at all, since optionality is about field
PRESENCE and a legacy over-long reason is present and type-valid. No fired-signal, on decision 3's
reasoning: the transform keys on nothing ambient, and the `…` suffix is the same signal the memory
copy carries. Control characters are not stripped at this seam because the store's write-path
sanitiser strips them from every payload string (pinned in `store.test.ts`).

**Parity with the memory copy, stated exactly.** Same ORDER (redact before truncate) and the same
200 ceiling; not byte-identical. Telemetry's cap counts the ellipsis (a truncated row is 200 units)
while `SUMMARY_TEXT_LIMIT` bounds content (a truncated memory reason is 201); the memory seam cuts
with a bare `slice` where this one is surrogate-safe; the memory seam strips control characters in
band where this one leaves it to the store; and `redactForPersistence` passes the value raw when no
redactor is injected, which the mapper's required dependency forbids. Every difference runs in the
safe direction. Both seams now pin their value EXACTLY (`cli.test.ts`: 200; `session.test.ts`:
201, tightened in this PR from a `≤ 201` ceiling). That tightening is a correction: the first
cut's code comment claimed "drift is pinned by the tests asserting 200 on both seams" and the
session side had only ceilings, so `SUMMARY_TEXT_LIMIT = 50` would have stayed green. The review
caught the false verification claim; the fix was to add the pin, not to soften the sentence.

**RED-first.** Round one: five behaviour pins observed red against the shipped mapper, each for
raw passthrough (a secret persists on a denied-by-hook reason; on a hook-error reason; a
500-character reason stores at 500; a key straddling the cap survives; a throwing redactor is never
consulted); two pins green on write and named as such (the updated three-kinds shape test, and the
hook-fired pin: no reason, redactor never invoked). Round two, after review: three pins observed
red before the code moved (the cap at 200 stored units, was 201; a malformed `RedactResult`, where
the `TypeError` escaped the mapper, exactly the swallowed-throw hazard the architecture review
named; `boundHookEventReason` not yet a function), and the session-seam exact pin green on write.
Round three, after the verify pass: four pins observed red, each reproducing the verifier's
executed counterexample (a pre-tool handler throwing an object whose `String()` throws made
`fire()` reject with the handler's text; a post-tool handler throwing an `Error` with a throwing
`message` getter did the same; the session's `fire failed:` row stored a secret raw; an
array-shaped `redacted` value passed the mapper untouched). Two fixture corrections in round one
and two, recorded so they are not tidied out of the story: the straddling key was first glued to
the filler and the AWS rule is `\b`-anchored; and once the cap moved from 201 to 200 the redaction
marker was sliced before its colon, so the key was shifted to indices 180 to 199 (under a
truncate-first mutation a 19-character fragment remains, which still cannot satisfy the rule's
`{16}` tail, so the pin keeps its teeth).

**The tenth refutation, and what it landed on.** The first cut and the review round both scoped
the session's `fire failed:` writer OUT of this issue, on the claim that handler throws are caught
inside `fire()` and never reach it. The security review confirmed that claim by reading
`runtime.ts` and by executing throwing handlers on all four event kinds. The verify pass refuted it
by execution: `reasonOf()` ran INSIDE the catch that holds a handler's throw, so a handler throwing
a value whose coercion throws (an object with a throwing `toString`, an `Error` with a throwing
`message` getter, a null-prototype object) escaped the catch, `fire()` rejected with the
handler-chosen text, and the third writer stored it unredacted and unbounded. That is the exact
threat the issue names, landing on the one writer the record had declared handler-proof. Fixed at
both ends: `reasonOf` is guarded and falls back to a fixed string, and the session row passes
redact-then-bound as defence in depth, because any `HookRuntime` implementation can reject with
anything. The same pass found that an array-shaped `redacted` value passed the mapper's length cut
without throwing and was then rejected by the store with a throw the sink swallows (row dropped
silently); the mapper now type-checks the redactor's result. Lesson, recorded in the process log: a
scope-out is a security claim, and "confirmed by reading" plus a happy-path execution is not a
counterexample search.

**Mutation gates: twelve, each over the FULL suite (1203 tests) at this tree, each asserting the
replacement landed before running and the restore byte-identical after.** NULL (the mapper passes
the reason through) reddens exactly the seven mapper behaviour pins. Truncate-before-redact reddens
exactly the order pin. Raw-on-throw reddens exactly the throwing-redactor pin. Dropping the bound
call reddens exactly the cap pin. Dropping the `typeof` guard reddens exactly the non-string pin.
`HOOK_EVENT_REASON_MAX` 200 → 10 000 reddens exactly two: the cap pin and the session
`fire failed:` pin, the third writer proving it shares the constant. The helper's `MAX - 1` →
`MAX` off-by-one reddens exactly three: the cap pin, the `fire failed:` pin and the store's
exact-length helper pin. Raw passthrough on the hook-error arm alone reddens exactly the
hook-error pin. Raw passthrough on the denied arm alone reddens exactly the six denied-side pins.
`SUMMARY_TEXT_LIMIT` 200 → 50 on the memory seam reddens exactly the session-seam exact pin, the
gate that did not exist before this PR. Unguarding `reasonOf` (restoring the pre-fix body) reddens
exactly the two runtime pins. Writing the session's `fire failed:` row raw reddens exactly its pin.
Compared with round two, the malformed-result pin no longer reddens under the order, sentinel or
no-bound mutations, because the `typeof` guard now catches a malformed result on every path; the
non-string pin binds the guard on its own. No pin outside the four edited test files binds any
seam, and that is expected rather than a gap: the shipped hooks' reasons are value-free
(decision 1), so every existing end-to-end test passes clean strings through the identity half of
the transform.

**Limits.** No live SDK run drives a secret-bearing reason through the composition root: the
shipped hooks (`permissionHook`, `sandboxHook`) emit value-free reasons, so a live smoke can only
confirm the identity case. The required dependency is a compile-time pin against OMISSION (neither
call site compiles without it), not a runtime guarantee about the supplied redactor; an identity
redactor would persist raw. The verify pass executed the off-label case, calling the mapper with no
third argument at all from plain JavaScript, and it still stored the sentinel, because the property
access sits inside the `try`. Out of scope, and named so this section is not read as covering
them: (1) the sibling `tool` field on the same row, model-requested, control-char sanitised by the
store, neither redacted nor bounded; (2) two inherited limits of `redact()` itself, shared with the
memory seam and not introduced here, both executed by the reviews: the `\b`-anchored fixed-length
rules do not match a credential glued to an adjacent word character (or split by a control
character, which the runtime's `reasonOf` has already turned into a space before the mapper sees
it), so such a reason passes through unredacted; and the memory seam's `truncate()` is not
surrogate-safe. Both are follow-up issues, not folded in. (3) The session's `fire failed:` row
redacts through `redactForPersistence`, which passes the value raw when no redactor is injected
(the memory seam's optional-dependency posture); the composition root always injects one.
