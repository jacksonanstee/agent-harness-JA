# ADR-0030: `meta.taskDir` suppresses every escaping form (issue #64)

- **Status:** Accepted
- **Date:** 2026-08-04
- **Requirements:** issue #64, filed by the three-lens review of the #62 fix before that fix merged
- **Relates to:** ADR-0027 (decisions 3 and 4, and the revisit-if this fires a second time), ADR-0011 item 16 (field naming), ADR-0028 (the monotone-mitigation lesson), security-model R-17 channel (b), issues #59 and #62

## Context

`portableTaskDir` (issue #62) records the golden scorecard's task directory relative to the invoking working directory, which removed the unconditional home-directory disclosure from a file whose purpose is to be shared. It was explicitly not a general fix: when the working directory is not at or above the task directory, `relative()` walks up to the common ancestor and back down, so the intervening absolute segments survive — `relative('/tmp/scratch', '/Users/<name>/clients/acme/tasks')` is `'../../Users/<name>/clients/acme/tasks'`, home directory intact. That escape case was pinned by a test whose comment required any future fix to come and delete its expectation deliberately, and was filed as issue #64 because the fix is a type change on a public shape plus the signal field ADR-0027 decision 3 requires — a decision, not an edit.

What makes this channel fixable where the three #59 designs were not (ADR-0027's revisit-if says this and it held): the harness COMPUTED the value from operands it still holds at write time, `root` and `cwd`. No ambient `os.homedir()` appears anywhere, and `cwd` cannot be well-formed but WRONG the way `$HOME` can — it is the directory the run was actually invoked from, so the transform cannot degrade into a no-op that reports success.

A three-lens design panel reviewed this design on 2026-08-04 (hostile skeptic, constraint-checker, user-advocate): APPROVE-WITH-CHANGES from all three, no kills. The skeptic could not construct an under-suppressing input; two darwin-specific attack angles (filesystem case-folding, symlinked cwd) were refuted by execution, since `relative()` and `basename()` are pure string functions and `process.cwd()` returns the physically-resolved path. The changes the panel required are folded into the decisions below.

## Decisions

1. **Contract, one line: `taskDir` is populated only when the task directory is at or under the working directory the run was invoked from. Any other invocation stores null.** The classifier is pure string logic over `rel = relative(cwd, root)`: empty maps to `'.'`; a form that is not absolute and whose first segment is not `..` is stored as-is; everything else suppresses. Suppression is the fall-through, not a positive match, so a shape the classifier does not recognise fails safe by removing information rather than disclosing it.

2. **ALL walk-up forms suppress, including the bounded sibling shape (`../tasks`) that #62 shipped.** This supersedes #62's sibling behaviour deliberately, by operator decision on panel evidence: even the bounded shape reveals the task directory's own name, which is routinely a client or project name; the advocate verified no documented workflow produces a walk-up form (the CLI default is `./eval/golden`, the example is `eval .`); and the resulting contract is statable in one line where the bounded variant needs a paragraph. The skeptic's structural proof that the bounded shape reveals at most hop count plus `basename(root)` is recorded here as true — it was not the reason to keep the shape, because nothing needs the shape.

3. **The signal is `taskDirForm: 'relative' | 'suppressed'`, always present.** This is ADR-0027 decision 3's "boolean paired with an identifier for the transform that ran", encoded as a two-value union because there is exactly one transform to name; the value says whether it applied ('relative') or refused ('suppressed'). Nothing forbidden is recorded: no home value, no cwd. It is a discriminated union with `taskDir` — `{ taskDir: string; taskDirForm: 'relative' } | { taskDir: null; taskDirForm: 'suppressed' }` — so the invalid pairings are unrepresentable rather than merely documented. Two independently-settable fields whose relationship lived in prose already cost this codebase a review round once (`pathTruncated`/`pathDigest`, ADR-0011), and a golden scorecard has no read-time validator to retrofit a coherence check into, so the type level is the only defence available.

4. **Null, never a degraded value.** A bare basename (or any shortened path) shape-matches a resolvable relative path, and `resolve(cwd, basename)` silently yields a WRONG path — a trap, where null cannot be resolved by accident. The transform only ever REMOVES information, the property ADR-0028 made a requirement after an appending mitigation manufactured the vulnerability it prevented. A `taskDirBasename` hint field was rejected for the same reason plus disclosure: directory names are routinely client names, and deliberately storing that segment would re-open the door this field just closed.

5. **The field keeps its name through the type change.** ADR-0011 item 16 requires a new name when the read path is intolerant. Re-verified for this change, not inherited from #62's argument: nothing in `src/`, `scripts/` or `examples/` parses a golden scorecard back — no validator, no query, and `scorecard/diff.ts` touches only rows, never meta. Pre-#64 scorecards are distinguishable by the absence of `taskDirForm`.

6. **The CLI prints a warning on stderr when suppression fires**, adjacent to the `scorecard written to` line and routed through `sanitizeForTerminal`. This is operator-facing only and discloses nothing new: the same stream already prints the absolute root in the discovery progress line on every run. The retained artefact is what suppression protects; the terminal is where the operator recovers "which directory was this" if they need it, because the artefact deliberately cannot say.

7. **Scope: this closes R-17 channel (b) — the escape case, and with it the channel — and closes nothing else.** Issue #59 stays open; channels (a), (c), (d) and (e) are unchanged; R-16's "if #59 closes, re-cost" clause does not fire. ADR-0027 decision 4's prefix-hygiene ceiling is about normalising transforms that store a cleaned value; it does not bite here because suppression stores nothing at all in the refusing case. That is also why this must never be cited as progress on the #59 title: it is a channel closure, not a path-redaction capability.

## Rejected alternatives

- **Keep the bounded sibling walk-up** (decision 2 records the proof and the rejection).
- **Degrade to basename, or a `taskDirBasename` companion** (decision 4).
- **A bare boolean `taskDirSuppressed`** — reads well but drops the transform identifier half of decision 3's required form, and a boolean discriminant models "which of two forms is this field in" less directly than the form enum.
- **A discriminated-union object for `taskDir` itself** (`{form, value}`) — structurally forces readers past the signal, but nests the ubiquitous clean case; `"taskDir": "eval/golden"` staying flat is worth more to the artefact's human readers than the forcing is worth to its nonexistent programmatic ones.
- **Recording the invoking cwd so suppressed rows stay recoverable** — re-introduces the disclosure one field over, the same rejection as #62's.

## Consequences

An investigator holding a suppressed scorecard cannot tell which directory was scored from the artefact alone; rows still carry task ids. The recovery path is the operator, who saw the directory on their own terminal, in the discovery line and in the suppression warning. This is the accepted cost of never storing a walk-up, and it is the honest trade: the artefact is the thing that travels.

The #62 sibling behaviour is gone: a scorecard produced from a sibling working directory now records null where it recorded `../tasks`. Information loss only, never wrong data.

## Verification, and its named limits

Both live shapes executed against `dist/` on 2026-08-04, this branch:

- Clean: `eval .` from `examples/repo-qa` → `"taskDir": ".", "taskDirForm": "relative"`, 2/2 pass, zero occurrences of the home directory in the JSON, no warning line.
- Escape: the same task directory evaluated from an unrelated scratch directory → `"taskDir": null, "taskDirForm": "suppressed"`, warning line on stderr, zero occurrences of the home directory in the JSON, 2/2 pass.

The suppressed pair is asserted end-to-end through `run()` (the outside-directory test), not only at the unit, and the replaced pinned-weakness test deleted its disclosure expectation deliberately, per its own comment's instruction.

Characterisation was GREEN on write for the populated branches (the type change forces test and implementation to land together), so the binding evidence is a mutation gate, name-level, each mutation asserted applied before its run and the source restored and verified clean after:

- Fall-through flipped to populate (observationally identical to an always-populate stub, since the positive branch already populates): exactly the 5 suppression tests red — sibling, parent, HOME-independence, the escape shape, and the end-to-end outside-directory test.
- Positive branch flipped to suppress: exactly the 3 populated-path tests red, including the end-to-end clean test.
- Segment check replaced with `startsWith('..')`: exactly the `..foo` boundary test red.
- Empty-string branch storing `''` instead of `'.'`: exactly the working-directory test red.

**Limits.** The Windows cross-drive branch (`isAbsolute(rel)` → suppress) is reasoned, not executed: there is no Windows CI, and on POSIX `relative()` never returns an absolute path, so no test on this platform can bind that condition. It fails in the safe direction. All measurements are darwin, ASCII paths.

## Revisit if

- A consumer genuinely needs to know which directory a suppressed run scored. The artefact deliberately cannot say; if that stops being acceptable, the design space re-opens at decision 4, not at a quiet field addition.
- Windows CI arrives — execute the cross-drive branch and delete the limit above.
- A read path for golden scorecards appears in-repo. Decision 5's naming argument and decision 3's type-level-only coherence defence both lean on there being none; a validator changes both.
