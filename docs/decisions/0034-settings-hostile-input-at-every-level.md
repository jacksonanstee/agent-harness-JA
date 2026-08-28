# ADR-0034: settings are hostile input at every level; unknown keys and glob-shaped command entries fail loud, and the loader gets the file envelope

- **Status:** Accepted. Ships in the PR for issues #85, #94 and #93.
- **Date:** 2026-08-28
- **Requirements:** issues #85 (unknown keys), #94 (loader envelope), #93 (glob-shaped entries); external review 2026-08-25 (findings 1.2a, 7e, 7d, each verified by execution); S-3 and S-4
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
   false trip costs a run rather than a posture. The `futureKnob` test now pins the rejection.
   ADR-0014 §5's forward-compatibility sentence is amended to the level it always meant.

2. **`*`, `?` and `[` are refused in command allowlist entries at parse time and in argv[0] at
   the gate, through one predicate.** `hasGlobCharacter` in `src/security/sandbox/sandbox.ts`
   is the shared brain of both refusals, the `isBlockedFirstToken` pattern, so the parser and the
   gate cannot drift. The gate check runs before the allowlist is consulted, so an entry that
   matches the argv[0] exactly cannot rescue it, and it covers a programmatic `createSandbox`
   caller that never saw the parser. Arguments keep their glob allowance: `git add *` under an
   allowed `git` still passes, because expansion there happens inside the allowed program's
   argv. `~` is not refused: tilde expansion rewrites a prefix, never the basename the blocklist
   keys on. Path-dimension entries are NOT refused: a glob in a prefix-matched entry is inert and
   fails closed (nothing sits under a literal `/x/*`), a different class with no security gain
   from rejection; pinned as accepted by a test so a later warning is a visible change, and
   filed as a follow-up. ADR-0015 §3 is amended at both sentences.

3. **The settings loader gets the hostile-file envelope, on both layers uniformly.** Leaf
   symlink refused; parent-directory symlink refused (both settings paths are absolute, so the
   baseline's absolute-path rule applies: the parent only, since an operator's own path may
   traverse OS-owned symlinks such as macOS `/tmp`); single-descriptor
   `open(O_RDONLY | O_NOFOLLOW)`, `fstat` on that descriptor for EISDIR and the cap, then the
   read; `MAX_SETTINGS_BYTES = 1_000_000`, the baseline's own figure, which holds a thousand
   rules at a kilobyte each many times over; and the JSON parse error names the file and nothing
   from inside it. Uniform rather than project-only, ratified by Jackson on 2026-08-28: it is the
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
   ENOENT on open is rethrown as the original error, code intact, because every consumer treats a
   missing file as an empty value. Consumers map `refusal` to their own error class: the baseline
   keeps every message shape, and its tests pass unmodified, the behavioural proof of the hoist
   that ADR-0015 §5 used for the loader; its `refuseSymlink` and `refuseAncestorSymlinks` exports
   remain as thin wrappers because `redteam --update-baseline` consumes them; `refuseSymlinkedDir`
   in `src/cli/shared.ts` wraps the primitive and keeps the eval layer's error type (its
   stat-failure case now throws a message-bearing `GuardedReadError` instead of the raw fs error;
   both call sites map any error to a message).

5. **The production reader is the default; injection is the test seam.**
   `readSettingsFile(path)` in `src/internal/settings.ts` is `readFileGuarded(path,
   MAX_SETTINGS_BYTES)`. `loadJsonSettings` maps a `GuardedReadError` from the reader to the
   caller's error class with a `refusing settings:` prefix; any other read error still propagates
   unwrapped (the pinned contract for programmer bugs). `ComposeSecurityDeps.readFile` is
   optional and defaults to `readSettingsFile`; both production callers (`run`, `eval`) omit it
   and no longer pass `readFileSync`. The wiring is pinned at the entrypoint: `main(['run', ...])`
   and `main(['eval', ...])` against a project directory (redirected with a `process.cwd` spy)
   whose `.harness/settings.json` is a symlink exit 2 with the path and "symlink" on stderr,
   before the SDK is imported. That is the DEC-0016 shape: the check is the production command.

6. **`src/security/permissions/types.ts` states the scalar exemption.** The `SettingsLayer` doc
   said a project layer "can tighten but never loosen user policy" as a blanket rule; it now says
   RULES, and names `defaultDecision` as the by-override exemption recorded as R-8. R-8 itself is
   untouched; reversing it is a separate design call.

### Reach of the gates, stated

Each of the following was proven by mutation (NULL-first, an unmutated control run first, the
suite asserted to have run, files restored and hash-verified):

- Disabling unknown-key rejection in both parsers reddens exactly the six unknown-key tests
  (three permissions, two sandbox, one composed) and nothing else.
- `hasGlobCharacter` returning false reddens sixteen: five parser refusals, five gate refusals,
  six truth-table cases. Removing only the gate's argv[0] check reddens the five gate cases and
  leaves the parser green: the two refusals are independent, as designed.
- Replacing `readSettingsFile` with a plain `readFileSync` reddens seven: three composed-envelope
  cases, both entrypoint pins, and the reader's own symlink and oversize tests. The round-trip
  test stays green, which documents that the pin is the hostile cases, not the happy path.
- Restoring the V8 snippet in the parse error reddens the two no-snippet tests. Note for future
  tests of this class: V8 quotes a snippet only around an unexpected TOKEN; an unexpected END
  carries none, so the body must begin with a non-JSON token for the test to bind.
- Making the internal `refuseSymlink` a no-op reddens ten: every parent and ancestor case across
  the guarded-read tests, the baseline tests, `refuseSymlinkedDir` and `writeScorecard`. Every
  LEAF-symlink case stayed green under that mutation, because the `O_NOFOLLOW` open refused the
  link with `ELOOP` and the mapping turned it into the same `symlink` refusal. The backstop the
  baseline's comment calls "belt-and-braces" is therefore proven live, and it covers the leaf
  only; the lstat walk is the sole guard for ancestors.

What the envelope does NOT do: it does not `realpath` (a symlink INSIDE an allowed directory
pointing outside it remains ADR-0015 §2's documented limitation, and a symlinked grandparent of an
absolute settings path is allowed by design); it does not bound anything the parsers do after the
read beyond what `MAX_RULES` and `MAX_ALLOW_ENTRIES` already bound; and a well-formed but WRONG
value (`/tpm` for `/tmp`, a rule on the wrong tool) is indistinguishable from intent and is
recorded as residual R-19.

## Alternatives considered

- **Warn on unknown keys instead of rejecting.** Rejected: the same parser throws on every other
  shape error, so a warning would be a second contract on one file, and it fails open by default.
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
  `GuardedReadError` for the raw fs error). Both call sites map any error to a message, so the
  operator-visible behaviour is a different wording on an already-failing path.
- The glob refusal keeps a literal `*`, `?` or `[` out of command allowlist entries. Binaries with
  those characters in their names are not a case this project has met.

## Revisit if

- An operator reports the stow-style `~/.harness` symlink case: add a documented, explicit
  opt-out for the user layer's symlink refusal, never an environment-keyed or silent one, and
  keep the byte cap and the no-snippet parse error unconditional.
- The path dimension's inert-glob follow-up lands: fold its decision into decision 2's shape (one
  predicate, parser and gate) or record why paths differ.
- A settings key is added: extend the known set at its level and the test that pins the
  rejection; the derived-from-source rule of ADR-0033 does not apply here because the schema is
  the harness's own, and the known sets ARE the schema.
- The SDK or the harness gains an executor with its own working directory: the absolute-path
  parent-only rule assumes `process.cwd()` is the operator's (ADR-0015 §2 parity note).
