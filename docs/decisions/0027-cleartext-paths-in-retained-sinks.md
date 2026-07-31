# ADR-0027: cleartext filesystem paths in retained sinks (issue #59) accepted as residual R-17

- **Status:** Accepted
- **Date:** 2026-07-31
- **Requirements:** issue #59, which was raised by the three-reviewer design panel that settled issue #53
- **Relates to:** ADR-0011 decisions 16 and 17 (skill-drop `pathDigest`, and the #53 acceptance whose price this one sets), ADR-0013 (the secret rules, and why an unanchored generic rule was deliberately excluded), security-model R-16 and the new R-17, issues #53 and #54

## Context

Issue #59 observes that `DEFAULT_SECRET_RULES` is 25 rules and every one of them targets a credential. None matches a filesystem path, a username or a home directory, and nothing in the codebase claims otherwise. So any tool output that happens to name a path puts the operator's home directory verbatim into a durable row that `telemetry export` emits.

The mechanism was reproduced against `dist/` before any design work began: `redact()` returns `ls: /Users/<name>/clients/acme-corp/skills: No such file or directory` byte-identical, with zero findings.

This ADR exists because #59 sets the price of ADR-0011 decision 17. That decision accepted issue #53 partly on the argument that hardening a 128-bit digest is motion rather than security while the same home directory sits in cleartext one row over. If #59 closed, decision 17 would have to be re-costed. It has not closed, and this ADR records why.

### What the design round actually found

Three designs were built and each was given an independent hostile reviewer briefed with the #53 HMAC kill as the standard. All three were killed, for three different structural reasons. Every kill below was re-verified by execution before being recorded here, because the compression of a reviewer's finding into prose is where this project has previously strengthened claims past what was established.

**Design A, elide the home directory inside `truncate` (`src/session/session.ts:72-76`).** Killed because its own scope argument rested on a claim that execution refutes, and because it fires the ADR-0011 decision 17 revisit trigger it was built to avoid.

**Design B, normalise at every retained sink including the digest pre-image.** Killed because its injectivity proof is false. The proof reasons only about position 0, on the grounds that a real absolute POSIX path cannot begin with `~`. But the replacement is global, and a literal `~` is a legal directory name at any depth. Verified:

```
a = /Users/<name>/clone/a/Users/<name>/pad/evil.md
b = /Users/<name>/clone/a~/pad/evil.md
distinct before normalisation: true
both normalise to:             ~/clone/a~/pad/evil.md
digests as shipped today:      differ
digests under the design:      IDENTICAL
```

The two paths are shown short for readability, and that hides a precondition worth stating, because it is R-17 channel (a) restated: `boundSkillDropPath` returns early with **no digest at all** for any path at or under `SKILL_DROP_PATH_MAX - 1` (1023). So both fixtures must be padded past the cap before either has a digest to compare. Padded, the collision reproduces exactly as printed.

Two distinct skill files become indistinguishable in the one field whose sole documented purpose is to distinguish them. That is the exact property `pathDigest` was added for in issue #50, and `src/telemetry/types.ts` already puts it in the threat model, since an attacker authoring a cloned repo controls directory depth and naming and can therefore engineer the offset.

**Design C, scrub at `telemetry export` with a `--raw-paths` escape hatch.** Killed because its guard rejects only the *malformed* subset of `$HOME`. It cannot reject a well-formed but wrong one, and in that case the transform is a total no-op that still prints an affirmative assurance and still exits 0.

### The shared root cause

All three designs key the transform on `os.homedir()`, which returns `$HOME` verbatim. Verified:

```
HOME=/home/runner   ->  "/home/runner"      (GitHub Actions default)
HOME=/root          ->  "/root"             (container default)
HOME=/Users/<name>/ ->  "/Users/<name>/"    (trailing separator preserved)
```

That value is not recorded in the row, it is legitimately variable, and it degrades with no signal. `parseTelemetryArgs` accepts `--db <arbitrary path>` with no restriction, so exporting a database written on another machine is a first-class supported workflow, and the store has no TTL, so rows are arbitrarily old. This is structurally the same defect the panel killed the HMAC design for at decision 17: a mitigation that becomes a no-op along its success path while claiming closure.

### A correction to R-16, found by this round

R-16 justifies its severity by stating that truncation of a skill-drop `path` is tail preserving, so what it discards is the leading directories, "exactly where `/Users/<name>` or `/home/<name>` sits". That is true asymptotically and **false in a band immediately past the cap**.

Truncation keeps the last `cap` characters, where `cap = SKILL_DROP_PATH_MAX - 1`, so it drops exactly `length - cap` leading characters. The username therefore survives until the drop reaches it. Measured, and matching that arithmetic exactly across three different leading segments:

| home directory | leading segment | last raw length at which the username survives |
|---|---|---|
| `/Users/<name>` | `/Users/` | cap + 7 |
| `/home/<name>` | `/home/` | cap + 6 |
| `/var/lib/<svc>/<name>` | `/var/lib/<svc>/` | cap + 15 |

So the band is `[cap + 1, cap + lead.length]`, and its width is the length of whatever precedes the username, independent of the username's own length. Inside that band a row carries **both** a `pathDigest` and a cleartext username.

The wider finding, which R-16 does not reach at all: truncation removes the least identifying part first. A partial username survives past the band, and the client or project directory outlives the username by the username's own length plus the directory sitting between them, a margin that is measured rather than being a function of the home path's width. At the first truncating length the stored value literally begins `…Users/<name>/clients/acme/`.

This *strengthens* R-16's severity conclusion, since inside the band the digest is demonstrably not the weakest link, while making its stated reason wrong. Both halves are recorded, because the reason is what a future reader will act on.

## Decisions

1. **Issue #59 is accepted as a residual and stays OPEN, re-scoped.** It is not closed as wontfix. R-16 carries the clause "if #59 closes, this row must be re-costed", and closing #59 while the disclosure remains fully live would fire that clause on a technicality and force a security-model edit asserting something untrue.

2. **No code fix lands.** Three designs were built and killed on evidence, not skipped for cost. The kill reasons are recorded above in full, because a future reader who sees only "accepted as residual" will re-propose the export-time scrub within a month.

3. **Any future attempt must not key on an ambient `os.homedir()` without recording, in the row, a signal that says whether the transform fired.** A transform that cannot report whether it fired is not a mitigation, and that is what killed Design C. Note what the signal must NOT be: recording the home value itself would satisfy the letter of this while re-introducing into the same row the exact disclosure this ADR accepts. The usable forms are an explicit operator argument with no environment default, or a boolean paired with an identifier for the transform that ran. This constraint is generalised from Design C's kill alone; Designs A and B died of unrelated causes and are not evidence for it.

4. **The honest ceiling of any such transform is prefix hygiene, never path or username redaction.** Even a working normaliser leaves the client and project names intact. Issue #59's own reproduction string demonstrates it: `ls: /Users/<name>/clients/acme-corp/skills` becomes `ls: ~/clients/acme-corp/skills`, with `acme-corp` untouched. It must never be described as closing this issue's title.

5. **The digest pre-image stays the raw path.** Nothing here touches `src/telemetry/store.ts` `boundSkillDropPath`, so issue #54, the `printf '%s' "$path" | sha256sum` reproduction recipe in `README.md`, and decision 16 are all unaffected. This is stated rather than left implicit so a later reader does not assume it was overlooked.

6. **R-16's stated reason is corrected and R-17 is added** for the channels R-16 does not name. The severity of R-16 is unchanged at Low, and its conclusion is unchanged.

## Rejected alternatives

- **A path or home-directory rule in the redactor.** Rejected for three reasons, one borrowed and two added here, kept apart so a reader can see which is which. ADR-0013 decision 3 supplies the borrowed one, and its wording is narrower than a paraphrase suggests: an unanchored generic rule "over-matches code-heavy tool output". The two this ADR adds are that paths are not secrets, so a rule matching them would be the first in the set that is not targeting a credential, and that `resultSummary` exists to be readable. Issue #59 anticipated this and agreed.
- **Designs A, B and C above**, each with its kill reason recorded.
- **Closing #59 as wontfix.** Rejected under decision 1.

## Consequences

The security model now names a cleartext home-directory disclosure in an exportable sink and does nothing about it. That reads worse than R-16 does, and it should, because it is the accurate position. The mitigating facts, all of which belong in the row rather than in a footnote: reaching an adversary requires the export to be shared, which the operator does deliberately; this is disclosure by an operator, not exfiltration by an attacker; and nothing about it is new behaviour introduced by a recent change.

The zero-digest-row window that decision 17 depends on is **not spent** by this decision. Re-verified 2026-07-31 against the live database: 24 events, 0 rows carrying a `pathDigest`.

## Revisit if

- A future design records the home value in the row, or takes it as an explicit argument, and therefore escapes the root cause in decision 3.
- ~~The golden scorecard `meta.taskDir` sink (R-17, filed separately) is closed, since it is unconditional on every eval run and is the higher-frequency disclosure of the two.~~ **FIRED 2026-07-31, issue #62 partly closed (the escape case, where the working directory is not at or above the task directory, remains live, is pinned by test, and is tracked as issue #64).** It did not require revisiting this ADR's acceptance, and the reason sharpens decision 3 rather than weakening it: `meta.taskDir` is harness-authored and structured, so both operands of the transform are known at write time and `relative()` needs no ambient `os.homedir()`. The distinction is narrower than "incidental versus authored", and the review that found this said so: (e) and `resultSummary` carry paths incidentally inside prose the harness did not author, while (c) and (d) ARE harness-authored prose that interpolates an operator-supplied glob the harness has no second operand for. What (b) had that none of the others do is a value the harness itself COMPUTED, from an input it still held. The distinction to carry forward is not narrow-versus-wide scope, it is **whether the harness computed the value it is about to store**.
- `resultSummary` acquires a consumer that requires ground-truth absolute paths, which would make an export-time transform strictly better than a write-time one.

## Verification, and its named limits

The band arithmetic is pinned by two tests in `src/telemetry/store.test.ts`, both deriving from `SKILL_DROP_PATH_MAX` rather than hardcoding a length. Both are characterisation tests, GREEN on write, so there was no RED-first moment. The substitute is a mutation gate, and it is recorded here rather than claimed as a TDD cycle that did not happen:

- Widening the cap to `SKILL_DROP_PATH_MAX` reddens the band test.
- Swapping tail-preserving truncation for head-preserving truncation reddens **both** new tests, which is what proves they discriminate on truncation direction, the premise of R-16.
- Moving the boundary fixture into the band reddens the boundary assertion, proving it discriminates on length rather than holding vacuously.

Each mutation asserted its own replacement had landed before the suite was run, and the sources were restored and diffed byte-identical afterwards.

**Limits.** The band was measured on darwin with three leading segments and ASCII paths. Windows path spellings are reasoned about, never executed, and there is no Windows CI. The `os.homedir()` behaviour was executed on this platform only.
