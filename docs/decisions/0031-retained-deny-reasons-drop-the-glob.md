# ADR-0031: retained deny reasons drop the permission glob (issue #59 round 2)

- **Status:** Accepted — design CD ships with this ADR's PR; designs A and E are accepted with their panel changes and land in their own PRs, which amend this status line
- **Date:** 2026-08-07
- **Requirements:** issue #59, second design round (the first is ADR-0027, which killed all three of its designs and constrained any successor)
- **Relates to:** ADR-0027 (decisions 3, 4 and 5 bind everything here; its revisit-if fires for the second time), ADR-0030 (the computed-value distinction and suppress-not-normalise precedent this round applies), ADR-0014 §8 (the reason format this supersedes), ADR-0011 decisions 16 and 17, ADR-0028 (removal-only transforms), security-model R-16 and R-17

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
   future reason sources. Defence in depth, not the fix itself.

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
byte-identical after: gutting `describeRule` to the bare decision reddens exactly the six
reason-binding tests (the two new evaluate tests, the tool-only and cross-layer and
sticky-deny pins, and the end-to-end S-3 session test); reverting the `denied[]` map to a raw
passthrough reddens exactly the new channel-(d) test.

**Limits.** The telemetry `denied-by-hook` row's glob-absence is asserted at the unit and
session level, not through a live SDK run in CI (the composition root hardwires the real
SDK; the suite deliberately mocks no modules) — a live match-rule deny smoke is run
out-of-band and recorded in the PR. The `ask`-path suffixes (`— declined by prompter` and
friends) append to the same glob-free base string and are covered by existing tests.
