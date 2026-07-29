# Week 5: the pre-publish audit, and deciding not to publish (2026-07-15 → 2026-07-26)

Week 4 ended with the publish path built and one human click left. Week 5
was supposed to be that click. Instead it was a large adversarial audit,
four security fixes, a locked public API, a rebuilt publish workflow, and
a deliberate decision to not publish yet. Nothing in that list was
blocked by a bug. The version number was the constraint: `0.1.0` is cheap
to shape now and expensive to change later, so every item below is
something that wanted to land before the number existed in public.

## 2026-07-15: an audit that crashed, and was worth having anyway

The pre-publish audit ran as a large fan-out and died on a session usage
limit after its find phase. Thirteen finders produced fifty merged
findings; every verify, critic and synthesis agent failed. The run
reported status "completed" and named a report path. The report had never
been written.

**Lesson banked: a run that reports success and names an output is
claiming two separate things, and the second one needs checking.** The
findings were fully recoverable from the run's journal, so the loss was
an afternoon rather than the work.

The recovery found the week's worst defect, and it was ours, not the
audit tooling's. **`memory delete({ tag })` wiped the entire
`memory_entries` table.** The guard accepted `tag` as a non-empty filter,
the clause builder ignored it, and the result was `DELETE WHERE 1=1`. The
fix was written test-first, with three regression tests watched failing
before any implementation. The repair is the part worth recording: rather
than adding a `tag` clause, `delete`'s filter path now reuses `read()`
inside a transaction, so there is exactly one definition of which rows
match a filter. On top of that sits a fail-loud net that refuses any
future filter field which produces no WHERE clause. The first change
fixes the bug; the second closes the class, which is what the architecture
review asked for.

A continuation run put twenty-six adversarial verifiers over the
recovered findings: twelve confirmed, thirteen partial, one refuted. Both
of the original HIGH gradings came down, because the harness is
observe-only on that path, so the true impact was loss of a detection
signal rather than a bypass. The refuted one had conflated documentation
on the publish branch with documentation on main.

**The audit's value was not its finding count.** Half its output survived
contact with a verifier, and the single most serious item was a plain
logic bug in a delete path that no amount of threat modelling would have
surfaced.

## 2026-07-20: four merges, and the shape of a real bypass

Two security fixes landed alongside the audit remediations.

**Exec wrappers.** The sandbox command gate already blocked shell runners.
It did not block the argv-passthrough wrappers that reach the same place
by a different route: `sudo`, `timeout`, `nohup`, `setsid`, `nice`,
`chroot`, `unshare` and their siblings. All of them take a command as
arguments and run it. The fix added them to the blocklist, but the more
useful part was structural: a single exported predicate now backs both
the enforcement path and the CLI's startup warning, which had been
drifting apart, so the warning could tell an operator a command was fine
while the gate denied it.

**Unicode path folding.** `canonicalizePath` now normalises to NFC after
`resolve()` rather than before. Review caught that ordering: normalising
first leaves the current-directory component unfolded, because `resolve()`
splices it in afterwards. Centralised in a shared internal so the sandbox
and the permission model are fixed by the same change rather than
separately.

**Lesson banked:** the vitest worker pool forbids `process.chdir`, so a
regression test for that ordering cannot run in-suite. Where the test
harness cannot reach, say so and rely on gate-level tests plus a live
reproduction, rather than writing a test that quietly proves something
weaker.

## 2026-07-24: locking the public API while it is still free

Publishing a package fixes its import surface. ADR-0023 completed the root
barrel and locked it behind an `exports` map before that happened.

The test for it is the part worth keeping. It uses Node's package
self-reference through `createRequire`, which is only legal once an
`exports` field exists, so the test was genuinely red before the fix
rather than red for a setup reason. Deep paths are asserted to fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED` specifically, not merely to fail.

One reviewer suggestion was arbitrated against. Making the test
conditional would have let it skip silently in environments where the
mechanism was unavailable, and a skipped gate reads green. The hard
failure was kept and the reasoning written into the test comment, so the
next person to hit it finds an argument rather than an obstacle.

**Lesson banked:** a stale incremental `dist/` can produce a false
positive when auditing what ships. Audit the tarball only after
`rm -rf dist && npm run build`, which is the path the publish gate
actually takes.

## 2026-07-25: the job that holds the token should hold nothing else

The publish workflow was one job that installed dependencies, ran the
gates, and published. GitHub injects the credentials that mint an OIDC
token into every step of a job holding `id-token: write`. So that single
job let arbitrary dependency code, executing during install or test, mint
a publishing token for the package.

Split into a `build` job holding `contents: read` and a `publish` job
holding the token, doing nothing but downloading the built artifact and
publishing it. `--ignore-scripts` on the publish step turned out to be
required rather than merely prudent: that job has no `node_modules`, so
an unsuppressed lifecycle script hard-fails.

The review closed a documentation gap with real teeth. The threat model's
row for the publish surface still said hardening was a pending decision,
carrying its own forward-reference tripwire, un-actioned since the publish
ADR had landed eleven days earlier. The tripwire had worked exactly as
designed and nobody had read it.

**The finding that mattered most was about something that did not exist.**
The workflow named an `npm-publish` environment as its approval gate. That
environment had never been created. GitHub auto-creates a referenced
environment with zero protection rules, so the gate was decorative. Under
trusted publishing there is no stored credential to steal, which means the
ability to cut a release *is* the entire publishing authority, and the
approval gate is the only thing standing in front of it.

**Lesson banked: verify that a named protection exists, not just that it
is referenced.** A workflow file referring to an environment is not
evidence the environment has rules, and the failure mode is silent in the
direction that matters.

## 2026-07-26: deciding not to publish

State check: repo public and clonable, npm a hard 404, no release tag, the
publish workflow never fired, every gate green, no build work outstanding.

The decision was to hold the click and gather feedback from two readers
first. This is not a blocker being reported as a choice. Publishing would
have been a keystroke. The reasoning is that `0.1.0` can absorb what
early readers say before the version number makes changes semver
expensive, and there is no deadline pressure to spend that flexibility.

One honesty note, recorded because it degrades the result slightly. The
standing rule for these shares is that the questions stay byte-identical
across readers, so the answers are comparable. The second share's
questions were reconstructed from a paraphrase rather than copied from the
first message, so the two answer sets will only be loosely comparable.
Worth knowing when synthesising them, and worth not repeating.

## Week 5 in one line

An audit that crashed still found a table-wiping delete bug; two real
sandbox bypasses closed; the public API locked before publishing could fix
it; the publishing token confined to a job that does nothing else; and the
publish itself deliberately deferred behind real feedback. The recurring
shape: the dangerous gap is the one a document already claimed was closed.
