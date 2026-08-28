# ADR-0034: settings are hostile input at every level; unknown keys and command entries the shell would rewrite fail loud, and the loader gets the file envelope

- **Status:** Accepted. Ships in the PR for issues #85, #94 and #93.
- **Date:** 2026-08-28
- **Requirements:** issues #85 (unknown keys), #94 (loader envelope), #93 (glob-shaped entries); external review 2026-08-25 (findings 1.2a, 7e, 7d, each verified by execution); the 3-lens review of this change (2026-08-28) which widened decision 2 and relocated decision 5; S-3 and S-4; follow-ups #107 (path-dimension globs) and #108 (JSON duplicate keys)
- **Relates to:** ADR-0014 §5 and §6 (the "unknown siblings ignored" sentence and the fail-loud contract this sharpens), ADR-0015 §3 and §5 (the argv[0] claim this corrects and the shared loader this hardens), ADR-0019 (the baseline loader whose envelope is hoisted), security-model §3.1 and R-8, R-13

## Context

Both settings parsers (`src/security/permissions/settings.ts`, `src/security/sandbox/settings.ts`)
destructured the keys they knew and dropped the rest. Executed at main `84c4ae0` by the external
review and re-executed at `9fccca2` for this ADR: `permissions.defaultDecison` (a typo) parsed to
an empty layer, so the default stayed `allow`; `permissions.rules[0].matchh: 'git *'` on an allow
rule parsed to `{ tool: 'Bash', decision: 'allow' }`, a blanket allow where a scoped one was
written; `sandbox.path` (for `paths`) parsed to `{}`, the dimension off; `sandbox.paths.alow`
beside a valid `allow` was dropped. Only a typo on a REQUIRED key failed loud, because the
required key was then missing. The permissions ignore was pinned by a test (`futureKnob`) and
blessed by ADR-0014 §5's "unknown siblings ignored", a sentence written about the ROOT of the
file. The sandbox parser's own comment promised "never skipped" three lines above the skip.

The settings loader (`loadJsonSettings`, `src/internal/settings.ts`) read the file with whatever
`readFile` the CLI passed, which was `readFileSync`. The red-team baseline loader
(`src/eval/redteam/baseline.ts`) had, since Week 4, an lstat on the leaf, a raw-component walk of
the ancestors, a single-descriptor `O_NOFOLLOW` read, a byte cap on the same descriptor, and a
parse error that deliberately avoided `String(error)` because V8's `SyntaxError` quotes a snippet
of the input. The settings path had none of these. Executed: a `.harness/settings.json` that was
a symlink loaded silently; a symlink to a file holding a credential put ten characters of that
file on stderr through the parse error; a 50 MB file loaded. `docs/security-model.md` §2
classes project settings as attacker-influenced, and the baseline loader's comment said to hoist
its guard "on a third consumer". This was the third consumer (the scorecard-directory refusal in
`src/cli/shared.ts` was the second).

The sandbox command allowlist accepted a glob-shaped entry verbatim. `/bin/s?`, `/bin/*`,
`/usr/local/bin/*` and `[s]h` each passed the parser, passed `isBlockedFirstToken` (the basename
as written is not a listed shell), raised no startup warning, matched an argv[0] of the same
string by exact comparison, and the executing shell expanded them to `/bin/sh` (executed under
bash and zsh). The review's stated exploit, a glob in the COMMAND against a literal entry, was
refuted by the same execution: the gate compares canonical strings, so `/bin/s?` never matched an
allowlisted `/bin/sh`, and `/bin/sh` is denied even when allowlisted. The hole was the entry.
ADR-0015 §3 said glob expansion "does not change which program starts" and called the blocklist
"unconditional"; both were true of arguments and of the basename as written, and false of argv[0]
as executed.

## Decision

1. **Unknown keys are errors at every object level inside `permissions` and `sandbox`; root
   siblings stay ignored.** Known sets: `permissions` is `{defaultDecision, rules}`;
   `permissions.rules[i]` is `{tool, match, decision}`; `sandbox` is `{paths, commands}`;
   `sandbox.paths` and `sandbox.commands` are `{allow}`. The first unknown key in document
   order is named, bounded to 64 characters (`MESSAGE_ECHO_MAX`, since it is attacker-authored
   bytes bound for stderr), with the known set beside it so the operator sees the typo. A pure
   `unknownKeys` and one `unknownKeyMessage` live in `src/internal/settings.ts` (mechanism); each
   parser throws its own error class (policy), the split ADR-0015 §5 set. Reject rather than
   warn: every other shape error in these parsers already throws (ADR-0014 §6), and a warning
   on a security config is the advisory pattern this project reserves for classifiers, where a
   false trip costs a run rather than a posture, and for inert allowlist entries. The
   `futureKnob` test now pins the rejection.
   ADR-0014 §5's forward-compatibility sentence is amended to the level it always meant.

2. **Every character the shell rewrites in a word before exec is refused in command allowlist
   entries at parse time and in argv[0] at the gate, through one predicate.** The class is "the
   shell starts a program other than the one the string names", and its members at the pinned
   shells are: glob (`*`, `?`, `[`, and the zsh extendedglob operators `^` and `#`), quote
   removal (`"` and `'`: `/bin/s"h"` and `/bin/'sh'` are `/bin/sh` to bash and zsh), equals
   expansion and assignment prefixes (`=sh` is `/bin/sh` to zsh; `FOO=bar sh` runs `sh` behind
   an argv[0] the gate compared), and NUL (dropped by a shell reading its command from stdin).
   The first cut of this ADR enumerated the three glob characters the issue named; the security
   lens of its review produced the quote and equals counterexamples by execution (each passed
   the parser, the blocklist and the gate, and bash and zsh each ran `/bin/sh`), which is the
   instance-versus-class lesson this project keeps relearning, applied to a character set.
   `hasShellRewriteCharacter` in `src/security/sandbox/sandbox.ts` is the shared brain of both
   refusals, the `isBlockedFirstToken` pattern, so the parser and the gate cannot drift. The gate
   check runs before the allowlist is consulted, so an entry that matches the argv[0] exactly
   cannot rescue it, and it covers a programmatic `createSandbox` caller that never saw the
   parser. Arguments keep their allowance: `git add *` and `git commit -m "x"` under an allowed
   `git` still pass, because expansion there happens inside the allowed program's argv. `~` is
   not refused: tilde expansion rewrites a prefix, never the basename the blocklist keys on. The
   set is an enumeration, so a rewrite nobody has enumerated is R-13's own residual shape one
   gate over, and R-13 says so. Path-dimension entries are NOT refused: a glob in a
   prefix-matched entry is inert and fails closed (nothing sits under a literal `/x/*`), a
   different class with no security gain from rejection; pinned as accepted by a test so a later
   warning is a visible change, and filed as issue #107. Issue #93 asked for "a test for each of
   the three entry shapes, under bash and zsh"; what shipped is a parser and a gate test for
   every member of the set, and the bash and zsh executions are the review's recorded evidence
   rather than a suite test, because after this change no entry of the class reaches a shell.
   ADR-0015 §3 is amended at both sentences.

3. **The settings loader gets the hostile-file envelope, on both layers uniformly.** Leaf
   symlink refused; parent-directory symlink refused (both settings paths are absolute, so the
   baseline's absolute-path rule applies: the parent only, since an operator's own path may
   traverse OS-owned symlinks such as macOS `/tmp`); single-descriptor
   `open(O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`, `fstat` on that descriptor for the type and the
   cap (a directory and anything that is not a regular file are refused: a FIFO with no writer
   would otherwise hang the blocking open forever and a device's size bounds nothing, both found
   by execution in the review of the first cut), then the read; `MAX_SETTINGS_BYTES =
   1_000_000`, the baseline's own figure, under which a thousand rules at a hundred bytes each
   fit ten times over; and the JSON parse error names the file and nothing from inside it. Uniform rather than project-only, ratified by Jackson on 2026-08-28: it is the
   project's own standard (the baseline loader applies the full envelope to operator-supplied
   absolute paths too); `O_NOFOLLOW` comes with the single-descriptor read that delivers the cap,
   so a user-layer exemption is a second code path rather than a subtraction; and the cost is one
   clear exit-2 line at startup for an operator whose `~/.harness` is itself a symlink (stow-style
   dotfiles), recorded under Consequences with the workaround.

4. **The envelope is hoisted to `src/internal/guarded-read.ts`,** a zero-dependency leaf (node
   builtins only): `GuardedReadError` with a `refusal` discriminator (`symlink`,
   `ancestor-symlink`, `directory`, `oversize`, `unreadable`) and the path; `refuseSymlink`;
   `refuseAncestorSymlinks` (the raw-component walk, verbatim from the baseline including the
   `symlinkdir/..` rationale a security review produced); and `readFileGuarded(path, maxBytes)`.
   ENOENT on open is rethrown as the original error, code intact, so each consumer decides what
   absence means (the settings loaders read it as an empty layer; the baseline names the missing
   file). Consumers map `refusal` to their own error class: the baseline keeps every message
   shape its tests pin (`/symlink/`, `/exceeds/`, `/cannot read/`) and its tests pass unmodified,
   the behavioural proof of the hoist that ADR-0015 §5 used for the loader; two untested wordings
   changed, recorded here rather than claimed away: an ancestor refusal now carries an
   `(ancestor of <path>)` suffix, and a stat failure forwards the primitive's message (`baseline
   <path>: cannot stat directory <dir> (ENOTDIR)`) instead of a rebuilt "cannot read" that lost
   which operation failed. Its `refuseSymlink` and `refuseAncestorSymlinks` exports remain as
   thin wrappers because `redteam --update-baseline` consumes them and the eval barrel publishes
   them; `refuseSymlinkedDir` in `src/cli/shared.ts` wraps the primitive and keeps the eval
   layer's error type (its stat-failure case now throws a message-bearing `GuardedReadError`
   instead of the raw fs error; `writeScorecard` maps any error to a message as before, and the
   eval pre-flight now maps a `GuardedReadError` to exit 2 with its message where it used to
   rethrow the raw error uncaught).

5. **The production reader is the default of every loader; injection is the test seam.**
   `readSettingsFile(path)` in `src/internal/settings.ts` is `readFileGuarded(path,
   MAX_SETTINGS_BYTES)`, and it is the default `readFile` of `loadJsonSettings` (moved to the
   LAST parameter so the parser cannot be omitted by accident) and of the two published module
   loaders, `loadSettingsFile` and `loadSandboxSettingsFile`. The first cut put the default only
   in `composeSecurity`, which left the published loaders with a required plain reader, exactly
   the alternative rejected below; the architecture lens of the review found it and the default
   moved down. `loadJsonSettings` maps a `GuardedReadError` from the reader to the caller's error
   class with a `refusing settings:` prefix; any other read error still propagates unwrapped (the
   pinned contract for programmer bugs). `ComposeSecurityDeps.readFile` is optional and is passed
   through; both production callers (`run`, `eval`) omit it and no longer pass `readFileSync`.
   Pinned three ways: each loader refuses a real symlinked file when given no reader; a composed
   run refuses a symlinked USER layer and a symlinked PROJECT layer alike; and at the entrypoint,
   `main(['run', ...])` and `main(['eval', ...])` against a project directory (redirected with a
   `process.cwd` spy, since under vitest's worker pool `process.env.HOME` never reaches libuv's
   `getenv` and `os.homedir()` ignores it) whose `.harness/settings.json` is a symlink exit 2 with
   the path and "symlink" on stderr, before the SDK is used. That is the DEC-0016 shape: the
   check is the production command. What the entrypoint pin binds is the reader wiring; importing
   the SDK is side-effect-free, so the position of the import relative to `composeSecurity` is a
   reading of `cli.ts`, not an assertion of the test.

6. **`src/security/permissions/types.ts` states the scalar exemption.** The `SettingsLayer` doc
   said a project layer "can tighten but never loosen user policy" as a blanket rule; it now says
   RULES, and names `defaultDecision` as the by-override exemption recorded as R-8. R-8 itself is
   untouched; reversing it is a separate design call.

### Reach of the gates, stated

Each of the following was proven by mutation (NULL-first, an unmutated control run first, the
suite asserted to have run, files restored and hash-verified; re-run after the review fold, and
the counts below are the post-fold ones):

- Disabling unknown-key rejection in both parsers reddens exactly the six unknown-key tests
  (three permissions, two sandbox, one composed) and nothing else.
- `hasShellRewriteCharacter` returning false reddens thirty-six: twelve parser refusals (eleven
  entries and the NUL case), ten gate refusals, fourteen truth-table cases. Removing only the
  gate's argv[0] check reddens the ten gate cases and leaves the parser green: the two refusals
  are independent, as designed.
- Replacing `readSettingsFile` with a plain `readFileSync` reddens eleven: four composed-envelope
  cases (project symlink, user symlink, `.harness` directory symlink, oversize), both entrypoint
  pins, the reader's own symlink and oversize tests, and the three no-reader loader pins
  (`loadJsonSettings`, `loadSettingsFile`, `loadSandboxSettingsFile`). The round-trip tests stay
  green, which documents that the pin is the hostile cases, not the happy path.
- Restoring the V8 snippet in the parse error reddens the two no-snippet tests. Note for future
  tests of this class: V8 quotes a snippet only around an unexpected TOKEN; an unexpected END
  carries none, so the body must begin with a non-JSON token for the test to bind.
- Making the internal `refuseSymlink` a no-op reddens ten: the direct `refuseSymlink` test, both
  `refuseAncestorSymlinks` tests and the parent-symlink read test in the guarded-read suite; the
  parent, relative-grandparent and `symlinkdir/..` cases in the baseline suite; the composed
  `.harness`-directory case; `refuseSymlinkedDir`; and `writeScorecard`. Every LEAF-symlink case
  stayed green under that mutation, because the `O_NOFOLLOW` open refused the link with `ELOOP`
  and the mapping turned it into the same `symlink` refusal. The backstop the baseline's comment
  calls "belt-and-braces" is therefore proven live, and it covers the leaf only; the lstat walk
  is the sole guard for ancestors. The `ELOOP` branch is reached by no suite test (the lstat
  refuses first in every staged layout, and the race cannot be staged), so this mutation is its
  only coverage; the spec's proposed simulation could not reach it, and the branch says so.
- Removing the regular-file check reddens the two non-regular-file tests (a character device and
  a FIFO). Dropping `O_NONBLOCK` from the open reddens the FIFO test alone, on its elapsed-time
  bound: the test's background writer connects after three seconds, so a blocking open waits for
  it and then still refuses on type, and the bound is what turns "hung" into "failed". A first
  cut of that test had the writer connect at once, and the mutation showed it could not tell the
  two opens apart; the delay is the fix.

What the envelope does NOT do: it does not `realpath` (a symlink INSIDE an allowed directory
pointing outside it remains ADR-0015 §2's documented limitation, and a symlinked grandparent of an
absolute settings path is allowed by design, which is acceptable for the project layer because
`process.cwd()` is the physical path and the only attacker-committable directory component the
loader sees is `.harness`, the parent that IS checked); it does not refuse a hard link (git cannot
commit one, and a host user who can `ln` the target can already read it); it does not bound a
file that grows between the `fstat` and the read (a concurrent host writer, outside the model);
it does not bound anything the parsers do after the read beyond what `MAX_RULES` and
`MAX_ALLOW_ENTRIES` already bound; a duplicated JSON key keeps its LAST value inside `JSON.parse`
before any parser sees the document, so `"defaultDecision": "deny"` followed by `"allow"` is
`allow` with no signal (found by the security lens; issue #108 scans the raw body); the rewrite
character set is an enumeration at bash and zsh (R-13's shape one gate over); and a well-formed
but WRONG value (`/tpm` for `/tmp`, a rule on the wrong tool) is indistinguishable from intent
and is recorded as residual R-19.

## Alternatives considered

- **Warn on unknown keys instead of rejecting.** Rejected: the same parser throws on every other
  shape error, so a warning would be a second contract on one file, and it fails open by default.
  `composeSecurity` does warn about INERT entries (a blocklisted shell in the allowlist), and the
  E-3 and E-4 classifiers report rather than gate; a key that changes posture is neither.
- **Exempt the user layer from symlink refusal (it is the trusted layer).** Rejected per decision
  3, ratified. Revisit-if recorded below; an opt-out, if ever added, is a documented switch and
  never a silent one.
- **Reject glob characters in path entries too.** Deferred to a follow-up issue: fail-closed and
  inert today, a different severity, and outside the three issues' fix surfaces.
- **Put the envelope in `composeSecurity` only (the issue's literal wording).** Rejected: the
  read mechanics live in `loadJsonSettings`; an lstat beside `readFile` at the caller would leave
  the module-level `loadSettingsFile` and `loadSandboxSettingsFile` without it, a fourth copy in
  waiting.
- **Keep the three symlink-guard copies (each "deliberately" separate).** Rejected: the comments
  on both copies named the third consumer as the extraction trigger, and it arrived.
- **`realpath`-based containment instead of refusal.** Rejected, as in ADR-0015 §2 and the
  baseline: impure, TOCTOU-racy, and it needs existence fallbacks for paths that do not exist
  yet.
- **Redirect the user layer in the entrypoint test with `process.env.HOME`.** Rejected by
  execution: under vitest's worker-thread pool `process.env` is a JS-level copy that never reaches
  libuv's `getenv`, so `os.homedir()` ignored it and the run reached the SDK with the dummy key.
  The pin uses the project layer through a `process.cwd` spy, which is also the
  attacker-influenced layer, the better story for the pin.

## Consequences

### Positive

- A typo of any settings key, at any level, is an exit-2 line naming the level, the key and the
  known set, before any tool runs. The open-posture-with-no-signal class is closed for keys;
  values were already loud.
- The settings path meets the project's own hostile-input standard: symlink refused, capped,
  no attacker bytes in the parse error. `docs/security-model.md` §3.1 now claims it, with the
  reach stated.
- One implementation of the symlink guard, with three consumers and their existing tests as its
  regression suite; the `O_NOFOLLOW` backstop is now known to be live rather than assumed.
- The sandbox command gate's "which program starts" claim is true of argv[0] as executed, not
  only as written.

### Negative / accepted

- An operator whose `~/.harness` directory or `~/.harness/settings.json` is a symlink (stow-style
  dotfiles) gets `refusing settings: directory ~/.harness is a symlink` at startup and exit 2.
  Workaround: a real directory, or a real file copied into place. Recorded as the cost of one
  rule on both layers.
- A rule entry with an unknown key that a FUTURE version of this harness introduces is an error
  on the current version rather than an ignore. That is the forward-compatibility trade decision
  1 makes deliberately: inside the security dimensions, "I do not know this key" must not read as
  "this key does nothing".
- A settings file over 1,000,000 bytes is refused. No plausible hand-written policy approaches
  this; a generated one that does is the case to revisit.
- `refuseSymlinkedDir`'s stat-failure case changes error TYPE (a message-bearing
  `GuardedReadError` for the raw fs error). Both call sites map both errors it can raise to a
  message and an exit 2 (`writeScorecard` always did; the eval pre-flight now catches the
  `GuardedReadError` it used to rethrow), so the operator-visible behaviour is a different
  wording on an already-failing path.
- The rewrite refusal keeps `*`, `?`, `[`, `^`, `#`, `"`, `'`, `=` and NUL out of command
  allowlist entries and argv[0]. Binaries with those characters in their paths are not a case this
  project has met; an assignment-prefix invocation (`FOO=bar cmd`) is refused by design, since the
  gate cannot see the program behind the prefix.
- A settings file that exists but cannot be read (EACCES, ENOTDIR on an ancestor) now exits 2 with
  `refusing settings: cannot read <path> (<code>)` where it used to crash uncaught with the raw fs
  error; a DANGLING symlink at a settings path, which used to read as ENOENT and an empty layer,
  is now refused as a symlink. Both are tightenings, recorded because they change what an operator
  sees.

## Revisit if

- An operator reports the stow-style `~/.harness` symlink case: add a documented, explicit
  opt-out for the user layer's symlink refusal, never an environment-keyed or silent one, and
  keep the byte cap and the no-snippet parse error unconditional.
- Issue #107 (path-dimension globs) lands: fold its decision into decision 2's shape (one
  predicate, parser and gate) or record why paths differ. Issue #108 (duplicate JSON keys) lands:
  move the duplicate-key sentence from the residuals above into decision 1 and R-19.
- A shell rewrite outside the enumerated set is demonstrated at bash or zsh, or a third shell is
  pinned as the executor: extend `SHELL_REWRITE_CHARACTERS` and its truth table, and say which
  shell each member belongs to.
- A settings key is added: extend the known set at its level and the test that pins the
  rejection; the derived-from-source rule of ADR-0033 does not apply here because the schema is
  the harness's own, and the known sets ARE the schema.
- The SDK or the harness gains an executor with its own working directory: the absolute-path
  parent-only rule assumes `process.cwd()` is the operator's (ADR-0015 §2 parity note).
