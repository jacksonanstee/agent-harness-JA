# Issue #59 round 2: design spec (v2, post-panel)

Date: 2026-08-07. Author: Claude (session with Jackson). Status: v2 — all panel findings
arbitrated. v1 is in git-less history (this file, superseded in place); the panel reviewed v1.

Panel: hostile skeptic (Fable), constraint-checker (Fable), user-advocate (sonnet), 2026-08-07.
Verdicts v1: skeptic A/CD/E all APPROVE-WITH-CHANGES; constraint A/CD/E all
APPROVE-WITH-CHANGES; advocate A APPROVE, CD APPROVE-WITH-CHANGES, E APPROVE. **Zero kills.**
22 findings (5 HIGH, 8 MEDIUM, 9 LOW), every HIGH carried an executed counterexample or a
file:line refutation. All findings folded below; none rejected. Full panel transcripts:
workflow wf_81ded27d-b2c.

## Arbitration log (finding → disposition)

| # | Lens | Sev | Finding | Disposition in v2 |
|---|------|-----|---------|-------------------|
| 1 | skeptic+constraint | HIGH | Required `pathForm` union bricks read-back: `rowToEvent` THROWS on payload mismatch and `query()` denies the whole trail (store.ts:426-428, 588); `isSkillDropPayload` requires `path: string` (store.ts:396-397); legacy rows fail; suppressed `path: null` silently vanishes via session.ts:713-716 | A revised: `pathForm` optional-on-READ (absent = legacy absolute row, the pathDigest pattern at store.ts:400-403); validator admits `path: null` only when `pathForm === 'suppressed'`; upgrade test exports a DB containing a pre-A row |
| 2 | skeptic+constraint | HIGH | Sub-cap cross-root rows byte-identical with NO digest (executed: two roots, same relative path → identical rows); ADR-0011 d17 already rejected relative DIGESTING on this exact objection; spec's "#50 preserved" claim true only for the truncated tail; digest-implies-truncated is ENFORCED at store.ts:429 so always-digest is forbidden without a separate decision | A revised: recorded as explicit accepted cost with the ADR-0011 d17 cross-reference and the argument why it kills digesting but not storage (rows keep sessionId; removal-only direction; recovery model = ADR-0030's operator-knows); always-digest alternative rejected with the two named reasons |
| 3 | skeptic+constraint | MED | Band tests are UNIT pins of `boundSkillDropPath` (unchanged by A) — they stay GREEN; my "#64 precedent, comment invites deletion" claim was false (checked 807-817, 864-868); re-deriving them would delete R-16's pinned evidence. The tests that actually redden are the session-level payload pins (session.test.ts:2390-2398 and the 2361-2700 block) plus the validator | A revised: band tests untouched; new integration assertions (production rows carry no home prefix); reddening tests enumerated; R-16 re-WORD not re-derive |
| 4 | constraint | HIGH | Escape-then-truncate pipeline unspecified: `boundSkillDropPath` requires ALREADY-ESCAPED input (store.ts:309-311); escaping happens at capture on the ABSOLUTE path (session.ts:504); literal implementation regresses the issue-#46 invisible-character fix | A revised: stored value = `escapePathUnsafe(relative(root, rawPath)).value` → `boundSkillDropPath`; transform-then-truncate contract kept; `pathHasEscapes` stays raw-pre-image-scoped (pinned store.test.ts:1088-1108) |
| 5 | constraint | MED | `LoadResult.root` blast radius understated: null-skillsDir literal (session.ts:574-575) has no root; 51 mocks + load.test.ts:186 redden; SessionDeps is PUBLIC on a published package (semver) | A revised: `root: string \| null` (null = no scan ran); classifier suppresses on null root (safe direction); mechanical breakage quantified; semver note for the PR body |
| 6 | skeptic | MED (CROSS) | Channel (a) is NARROWED, not closed: decision-4 ceiling binds A too (operator-authored client-named subdirs below root survive); on truncated rows the digest becomes the row's only home-prefix carrier | A section + re-scope now say exactly this; digest-as-sole-carrier folded into the R-16 re-word |
| 7 | skeptic+constraint | LOW | A docs-parity: README.md:147, store.ts:327-329 ("a complete path is its own identity" — premise A breaks), session.ts:747-753, types.ts field docs, sha256sum recipe (readers now prepend root) | Enumerated in A's docs-parity list |
| 8 | advocate | LOW | "Resolved root printed live" recovery claim was aspirational | Claim softened: the operator supplied the skills dir themselves; no new print channel shipped |
| 9 | skeptic+advocate | HIGH | `[rule N, layer]` recovery key FALSE as specced: evaluate swaps per-layer index for COMBINED index (evaluate.ts:187, 212; executed: project-file rule 0 reports "rule 2, project" with 2 user rules). Today harmless (glob in same string); after glob removal the index is the ONLY key → live wrong-attribution | CD revised: retained form uses the PER-LAYER index (winner.index is already the per-file position before the swap) so `[rule 0, project]` = "1st rule in your project settings.json". A `permissions list` CLI diagnostic is NOT scoped in (scope discipline) — filed as a follow-up issue instead |
| 10 | skeptic+constraint | MED/LOW | ADR-0014:44 quotes the glob-bearing format ("deny Bash(rm *) [rule 3, project]") as live mechanism | Named in CD docs-parity: annotate with superseded-by-ADR note, no silent rewrite. Blog row (glob-free) survives verbatim — verified |
| 11 | constraint | LOW | "One path, two sinks" undercounts: the MODEL also sees the deny reason and can echo it into memory — CD fixes that consumer too | Folded into CD's rationale |
| 12 | skeptic | HIGH | E prefix replacement without segment-boundary matching: `/home/al` fires on `/home/alice` leaving `[marker]ice/...` with applied=true (executed); trailing-separator prefix misses the bare form (executed) | E revised: validation strips trailing separators; replacement fires only at a segment boundary (separator, end-of-string, or defined non-path-continuation); applied=true documented as "≥1 replacement", NEVER "row is clean"; both executed fixtures in the test plan |
| 13 | skeptic | MED | Marker forgeable by tool output — counterfeits the decision-3 signal (executed) | E revised: `scrub: {applied, count, transform: 'prefix-v1'}` per row; forged markers exceed `count`; test pins the mismatch detection |
| 14 | constraint | MED | Decision 3's "in the row" ambiguous for an export-time transform (stored row carries no signal) | E revised + ADR-0031 will state the reading: for an export-time transform the emitted export row IS the retained artefact; matches decision 3's origin (Design C was an export-time no-op) |
| 15 | skeptic | LOW | cli.ts:203-206 "lossless" comment + README need the opt-in-lossy caveat; scrubbed exports nudge R-16's digest toward weakest-link | E docs list + one-line note in ADR-0031's E section |
| 16 | advocate | MED | Forgot-the-flag failure mode | E revised: stderr nudge on unscrubbed exports when a home-directory-shaped substring appears in ≥1 row (nudge only; keys on a static pattern, transforms nothing, default output byte-identical) |
| 17 | advocate | MED (CROSS) | No live smoke for A's suppress-warning branch through the real CLI | Verification plan: attempt the end-to-end smoke; the suppress arm is believed unreachable by construction (walk produces only under-root paths) — if confirmed, DECLARED as a verification limit in ADR-0031, mirroring ADR-0030's limits section |
| 18 | advocate | LOW ×3 + constraint LOW | E re-proposal framing (rigour, say so in ADR); per-row scrub metadata is signal not noise; root-relative form serves the investigator; re-scope keeps every leaned-on clause satisfiable (verified) | Kept as written; ADR-0031 will carry the framing note |

## Objective and non-goals (unchanged from v1)

Close/narrow the R-17 channels the computed-value distinction reaches; decide the export
scrub. **Never described as closing issue #59's title** (ADR-0027 decision 4). #59 stays open,
re-scoped. Binding constraints: ADR-0027 decisions 3/4/5, ADR-0030/0028 removal-only +
enforced-precondition patterns, ADR-0011 d17 stays dormant (verified satisfiable by panel).

## Design A v2 — root-relative skill-drop path

1. `LoadResult.root: string | null` — the `resolve(dir)` the walk used (load.ts:301), null
   only for the no-scan case. Session threads it to the write site; null root → suppress arm.
2. Stored value pipeline: `escapePathUnsafe(relative(root, rawPath)).value` →
   `boundSkillDropPath(escapedRelative, rawPath)`. Digest pre-image STAYS the raw absolute
   lexical path (decision 5; store.test.ts:1048-1068 green). Transform-then-truncate kept.
3. Classifier = ADR-0030 decision 1 shape: both args absolute ENFORCED (non-absolute →
   suppress), `''` → `'.'`, non-absolute non-`..`-leading form stores, all else suppresses.
   Suppress arm believed unreachable by construction; exists because that is a claim.
4. Signal: WRITE side is the discriminated union
   `{path: string; pathForm: 'root-relative'} | {path: null; pathForm: 'suppressed'}`.
   READ side (`isSkillDropPayload`): `pathForm` OPTIONAL — absent = legacy absolute row
   (pathDigest precedent, store.ts:400-403); `path: null` admitted ONLY with
   `pathForm === 'suppressed'`. Upgrade test: export over a DB containing a pre-A row.
5. Accepted costs, stated: (i) cross-root sub-cap rows with equal relative paths are
   byte-identical with no digest — the objection that helped ADR-0011 d17 kill relative
   DIGESTING; it does not kill relative STORAGE because the digest's correlation job applies
   to the truncated tail (where raw pre-images stay distinct and digests differ — executed),
   rows keep sessionId, and removal-only is the design direction. Always-digest rejected:
   spends d17's zero-digest-row window AND violates the enforced digest-implies-truncated
   coupling (issue #55, store.ts:429). (ii) Decision-4 ceiling binds A: below-root disclosure
   survives, including operator-authored client-named subdirectories. (a) is NARROWED, not
   closed. (iii) On truncated rows the digest is now the row's only home-prefix carrier —
   goes into the R-16 re-word.
6. Tests: band tests + 792-797 + 1048-1068 stay GREEN (unit pins of an unchanged function).
   Reddening set, enumerated: session.test.ts:2390-2398 exact-payload pin, the absolute-path
   assertions in the 2361-2700 block, load.test.ts:186, 51 loadSkills mock literals,
   isSkillDropPayload validator tests. New: integration assertion that a production drop row
   contains no home prefix; suppression unit tests; upgrade/read-compat test.
7. ADR-0011 item 16 re-verified for THIS sink (it has a live read path, unlike scorecards):
   `path` keeps its name because legacy rows stay valid under the optional-pathForm read
   shape and `pathForm` absence distinguishes eras — argued in ADR-0031, not inherited.
8. Docs-parity list: README.md:147 (identical-path note + sha256sum recipe gains
   "prepend your root"), store.ts:327-329 comment, session.ts:747-753 comment, telemetry
   types field docs, security-model R-16 re-word + R-17 (a) narrowed row. Semver note for
   the published package (SessionDeps/LoadResult are public): minor-with-breaking-change
   note in PR body, version implication decided at PR time.
9. CLI stderr warning on suppression (sanitized), mirroring ADR-0030 decision 6. Recovery
   story stated honestly: the operator supplied the skills dir argument themselves.

## Design CD v2 — retained deny reason drops the glob; per-layer index

1. Retained form: `permission: deny Write [rule 0, project]` where **0 is the index within
   the named layer's own settings file** (winner.index before the indexOfRule swap at
   evaluate.ts:187/212 — the executed counterexample showed the combined index mis-attributes
   whenever user rules exist). An operator can now count rules in the one file the layer
   names. Combined-index semantics documented out of existence.
2. Glob (`(${match})`) removed from the reason string at the single formatting site
   (describeRule). Both retained sinks (telemetry hook-event row; memory denied[]) are fixed
   by the one edit — verified: evaluate.ts:135 is the only rule.match interpolation in src/.
   Third consumer fixed for free: the MODEL sees the deny reason and could echo it into
   memory; after CD it never receives the glob either.
3. denied[] gains redact-then-truncate on write (session.ts:1132), closing the bypass as
   defence in depth. Ordering matches the stated deliberate pattern (session.ts:1110-1114).
   Verified: no pinned test asserts the bypass or the glob-in-reason (session.test.ts uses
   stringContaining on surviving substrings).
4. No fired-signal needed: verified sound against decision 3's letter (binds ambient-keyed
   transforms; CD keys on nothing) and intent (no conditional path exists that can no-op).
5. Docs-parity, each named: ADR-0014:44 annotated (superseded-by-ADR-0031 note, no silent
   rewrite); blog row survives verbatim (glob-free, verified); grep re-run at merge.
6. Follow-up issue (NOT scoped in): a `permissions list` diagnostic printing the resolved
   table with per-layer indices — advocate option (b); scope discipline keeps it out of this
   diff.
7. Ephemeral surfaces may keep the full glob (constraint on retained sinks only).

## Design E v2 — export scrub, boundary-safe, counted

1. `telemetry export --scrub-prefix <path>` (repeatable). Validation: absolute, ≥2 segments,
   trailing separators STRIPPED. Replacement fires only when the prefix is followed by a
   separator or end-of-string (executed counterexamples from the panel become fixtures:
   `/home/al` vs `/home/alice` must NOT fire; `/Users/jackson/` input must still catch bare
   `/Users/jackson`).
2. Marker `[scrubbed-prefix-N]` (N = argument ordinal). Per-row signal:
   `scrub: {applied: boolean, count: number, transform: 'prefix-v1'}` — count exposes forged
   markers (a marker occurrence exceeding count is counterfeit); test pins the mismatch.
   `applied: true` means "≥1 replacement fired", NEVER "row is clean" — stated in ADR, help
   text, and README.
3. Decision-3 "row" reading stated: for an export-time transform, the emitted export row IS
   the retained artefact (matches decision 3's origin — Design C was an export-time no-op).
   Carried into ADR-0031 so it cannot be relitigated.
4. Transform operates on events BEFORE the single stringify/escape body pass — stdout/--out
   byte-identity preserved (cli.ts:190-214 constraint verified structurally by panel).
5. Unscrubbed-export nudge: when no `--scrub-prefix` is given and ≥1 row matches a static
   home-directory-shaped pattern, print one stderr line suggesting the flag. Transforms
   nothing; default stdout byte-identical.
6. Docs: cli.ts:203-206 lossless comment + README export section gain the opt-in-lossy
   caveat scoped to the flag; ADR-0031 carries the digest-toward-weakest-link-in-scrubbed-
   exports observation and the rigour framing of re-proposing against a recorded kill.
7. Residuals, named: wrong-prefix now visible-but-not-corrective; unmatched rows stay
   cleartext; client names survive (decision 4); memory categorically out of scope (no
   export path exists).

## Verification plan v2

- NULL MUTATION FIRST on classifier (A), formatter (CD), and scrub transform (E).
- A: ADR-0030-style name-level mutation gates on the classifier; read-compat upgrade test;
  integration no-home-prefix assertion; live smoke = real run with a dropped skill → export
  → zero home-dir occurrences; sha256sum recipe spot-check. Suppress-branch CLI smoke
  attempted; if unreachable by construction, DECLARED limit in ADR-0031.
- CD: retained-reason-never-contains-match test with a path-bearing fixture (mutation:
  restore the `(${match})` arm → red); per-layer-index test with user+project layers loaded
  (the panel's executed counterexample as fixture); denied[]-through-redact+truncate test.
- E: boundary fixtures (both executed cases); forged-marker count-mismatch test; wrong-prefix
  count=0 visibility; stdout/--out byte-identity across the scrub path; nudge-line test.
- Full suite green except the enumerated reddening set, each named in the PR body.

## Sequencing (regardless of scope pick)

Three PRs, one design each, review-gated individually: **PR-1 = CD** (smallest, no type
changes), **PR-2 = A** (LoadResult type change + validator read-compat), **PR-3 = E**.
One ADR (0031) lands with PR-1 covering the round; later PRs amend its status table.
R-17/R-16 re-words ride with the PR that makes them true.

## Options for Jackson

1. **A + CD + E** — the full round; E carries the boundary/count/nudge revisions.
2. **A + CD** — the two removal-only designs; E deferred with its kills-so-far recorded.
3. **CD only** — smallest diff; A deferred (LoadResult semver weight).
4. Defer all — record the panel round in ADR-0031 as analysis-only.
