# ADR-0042: a built-in, non-configurable deny stops the agent writing the harness's own state

- **Status:** Accepted
- **Date:** 2026-10-29
- **Requirements:** issue #188; security-model R-23 (new), R-1, ASI03 and ASI08; S-4 (the sandbox's posture, which this does not change).
- **Amends:** ADR-0040 (`registerSecurityHooks` now registers three hooks and takes the protected roots; the library-caller property it records for the grant now holds for this guard too), ADR-0015 (a first pre-tool hook now runs before the permission and sandbox gates, it compares real paths for the paths it protects, and its "Revisit if: symlink escapes become a live concern" is partly answered for those paths), ADR-0033 (the shared tool table gains a `writes` marker), ADR-0041 (its later-run cap integrity consequence is closed for the paths named here). **Relates to:** ADR-0008 (`handlerIndex` is registration order), ADR-0014 (permissions), ADR-0023 (the root-barrel exports), ADR-0031 (deny reasons carry no values), ADR-0034 (the guarded settings read, which already refuses a symlinked settings file at load), #211 (a sibling per-tool capability marker, `executes`, not built here), #105 (restricting the tool set, which would cover REPL and MCP tools).

## Context

Before this change, nothing built in stopped the model writing the harness's own policy.
- The two settings files were protected only if the operator turned the sandbox's `paths` dimension on and left them out of `paths.allow`. The sandbox is off by default (ADR-0015 decision 1), and the default permission decision is `allow` (ADR-0014).
- The sandbox's command checks run only when `sandbox.commands` is set (`sandbox.ts` returns early otherwise). With the default settings, `echo {} > ~/.harness/settings.json` passed every gate.
- The user file is the one that matters most. It alone configures the judge, the Claude Code settings sources and, since ADR-0041, the dollar cap. Its denies also bind the project file. A model that edits it changes the policy for the next run: for example `{"budget": {"maxUsd": 100000}}` lifts the cap for every later run, and the current run cannot notice, because the SDK reads the cap once at spawn.
- The skills root and the telemetry database are the harness's other state. A model that writes a skill injects text into the next run's system prompt. One that writes the database rewrites the cost and audit trail.

The owner ruled on 29/10/2026: protect both `.harness` directories whole; compare targets both as written and by real path; deny any Bash or Monitor command that mentions a protected path; register the deny first.

## Decision

**D1. What is protected.** For each session, `buildProtectedRoots` (`src/security/self-protection.ts`) protects these directories and everything under them:
- `~/.harness/`: the user settings file, any telemetry databases kept there, and the recommended location of the red-team holdout;
- `<cwd>/.harness/`: the project settings file, the default telemetry database, and the eval scorecards;
- the run's skills root (`run --skills-dir`, or each eval task's own root).

It also protects the `run --db` file and its SQLite sidecars (`-wal`, `-shm`, `-journal`) when they lie outside those directories. The sidecars are named explicitly, so `tel.db.txt` is not protected. Eval's database is in memory; the project `.harness` directory is protected as a directory anyway.

**D2. Which tool calls.** Every entry in the shared tool table (ADR-0033) now carries a required `writes` flag, so a new tool cannot be added without the choice; the SDK has no read/write flag to derive it from. It is true for `Write`, `Edit` and `NotebookEdit`, the tools that write a local file at their target. A writer call whose target is protected is denied. So is one whose target is not a string, because a target the guard cannot read cannot be shown to be safe.

The other path tools carry `writes: false` and pass to the next gate:
- `Read`, `Glob` and `Grep` read;
- `Artifact` and `Projects` read for upload;
- `Workflow` reads and runs a script;
- `EnterWorktree` switches into a worktree, or creates one by `name`, so a checkout could in principle be placed under a protected directory (unverified where the CLI roots it; the harm is bounded, because it cannot overwrite an existing file).

`Bash` and `Monitor` are covered by D4.

A tool outside the table passes this guard untouched, as it passes the configurable gates (R-9). That includes an MCP tool (off by default, `strictMcpConfig`) and the SDK's `REPL` tool, whose `code` field has no path. Restricting the exposed tool set is #105's decision.

**D3. Aliases, resolved as the kernel resolves them.** The paths gate is lexical by design (ADR-0015 §2). This guard also resolves real paths, by walking the raw components of the absolute path left to right:
- each existing symlink is followed, a dangling one too, since `open(O_CREAT)` follows a dangling link and creates its target;
- a `..` is applied to the prefix already resolved, never textually first, so `<link>/../x` goes where the kernel goes. `guarded-read.ts` documents the same rule for the settings reader;
- a component that does not exist is kept as written;
- a target that cannot be resolved (more than 40 hops, or a link that vanishes while it is read) is denied.

Each protected root is resolved this way once, when the session is built. Each writer target is resolved on every call. A call is denied if its target, in either form (as written or by real path), is under any form of a root.

A relative target is resolved against the session's project directory, the working directory the SDK child inherits, never `process.cwd()`. A `~` or `~/` target is expanded against the user directory, in case the SDK expands it. On macOS and Windows both sides are case-folded and NFC-normalised, as in the paths gate.

**D4. Bash and Monitor: any path-shaped mention.** The command is first normalised for matching only:
- quotes and backslashes are removed;
- `$HOME`, `${HOME}` and `${HOME:-…}` (and the other parameter forms) are replaced by the user directory, and so is a `~` that starts a word.

The command is denied if either check matches:
- **A path-shaped word.** It is split into words at whitespace and shell operators, keeping only what follows the last `=` in a word (so `of=…` and `--target-directory=…` count). Every word that contains a `/` goes through D3's test. This catches `"$HOME"/.harness/settings.json`, `$HOME//.harness`, `~/./.harness`, `.//skills/x`, `of=.harness/telemetry.db` and `<link>/../.harness/settings.json`.
- **An absolute mention anywhere.** Any form of a protected root that appears anywhere in the normalised command counts, inside a quoted `python -c "…"` too, when it is followed by the end of the command, a `/`, whitespace, a quote, a shell operator or a glob or brace character. So `rm -rf ~/.harness*` is a mention.

A bare word is not a path (owner ruling, 29/10/2026). `skills`, `.harness` or `harness` on their own do not match, so `git commit -m "add skills"`, `grep skills README.md` and `echo .harness` work. The cost is that `rm -rf skills` and `cd .harness` are not caught.

Reads are denied like writes: `cat ~/.harness/settings.json` in Bash is refused, although the `Read` tool may read the same file. A command that is present but not a string is denied. An absent command, which is Monitor's websocket mode, has nothing to match and passes.

**D5. Order and configurability.** `registerSecurityHooks` registers the guard first, before the permission hook and the sandbox. That is the one registration site for `run` and `eval`, and both now pass it the protected roots (`tsc` enforces the argument). Its reason is therefore the one reported. Because the guard throws before the permission hook runs, no rule can grant past it: not a user `{"tool": "*", "decision": "allow"}`, not an absent sandbox. No settings key reads or removes it.

The guard belongs to the CLI's composition, not to `createSession`. A library caller who builds their own hook runtime gets it only by registering it, so `buildProtectedRoots`, `selfProtectionHook`, `SelfProtectionViolation` and `SELF_PROTECTION_REASON` are exported from the root barrel. ADR-0040 records the same property for its grant.

**D6. The reason.** The model reads one fixed sentence: "self-protection: the agent may not change the harness's own settings, telemetry or skills; edit the file yourself if the change is intended (ADR-0042)". It never echoes the path (ADR-0031).

## Consequences

- **The Bash and Monitor half is defence in depth, not containment.** It matches text after a light normalisation, so anything that builds the path at run time gets past it:
  - a variable other than `HOME` (`H=~/.har; cp x "${H}ness/settings.json"`), a glob (`~/.harnes?/s*`), brace expansion, or `printf` and `base64` tricks;
  - `cd` into a parent and a bare name from there, or a bare `rm -rf skills` (D4's ruling);
  - `~user/…`, which is not expanded;
  - an interpreter computing the path, or a script written by one call and run by another;
  - anything an allowed program does internally (`git` hooks, `find -exec`).

  These are ADR-0015 decision 3's limits; the real fix is an OS sandbox. R-23 records them.
- **Aliases created after the check, and hard links, are not caught.** The check runs at pre-tool time, and the SDK writes later. A link made between the two (TOCTOU), or one made by an earlier Bash call that got past D4, is not seen. A hard link has its own real path, and only an inode comparison would catch one. The guarded settings read (ADR-0034) still refuses a symlinked settings file at the next load.
- **Over-matching is accepted.** A command that names a protected path for an innocent reason (`grep x ~/.harness/settings.json`, `ls ./skills`) is denied, and so is a write under a real-path alias of a protected directory. Failing closed is the intended direction, and the operator can always edit the files themselves.
- **Per-call filesystem reads.** Each writer target, and each path-shaped word in a command, is resolved with `lstat`/`readlink` calls, one per component plus one per link hop. That is bounded by the path's length and 40 hops.
- **Telemetry shifts by one handler.** The permission hook is now handler 1, not 0, and the sandbox handler 2. So `handlerIndex` in `granted-by-rule` and `denied-by-hook` rows moves by one for them; a pre-tool handler never produces a `hook-error` row. A self-protection deny is a `denied-by-hook` row with `handlerIndex` 0 and the fixed reason. Nothing in the harness keys on these indices (ADR-0008 defines them as registration order).
- **ADR-0041's later-run gap is closed for the named paths.** A model-authored `Write` or `Edit` to `~/.harness/settings.json`, through any alias set up beforehand, is now denied, and so is a Bash command that names it in a static spelling. A path built at run time in Bash is still the residual above. The budget start line ADR-0041 added stays as the visible backstop on `run`.

## Alternatives considered

- **Protect only the named files.** That leaves the holdout, old telemetry databases and the scorecards writable, and needs a sidecar list per file. Rejected (owner ruling).
- **Lexical comparison only, like the paths gate.** Any symlink alias set up beforehand gets straight past. Rejected (owner ruling). ADR-0015 rejected `realpath` for the general gate because it is impure and racy. Here it is applied only to a small fixed set computed once, with the race documented.
- **Bare relative words as mentions.** The first cut denied any word `skills` or `.harness`, which blocked ordinary git and grep work on the default layout. Rejected on review (owner ruling, 29/10/2026: path-shaped only).
- **Detect write intent in Bash.** Parsing `cp`, `mv`, `tee`, `sed -i`, redirections and `dd of=` is more code, and it fails open on every form the parser misses. Rejected for "any mention" (owner ruling).
- **No Bash check.** With the default settings, Bash writes would stay wide open. Rejected.
- **Register last.** The deny would still hold, but a permission or sandbox reason could be reported instead, hiding why. Rejected (owner ruling).

## Revisit if

- An OS-level sandbox lands: the Bash half can then defer to it.
- #211's `executes` marker lands: `writes` and `executes` should be pinned against the SDK together.
- The SDK starts reporting the child's working directory per call (the `cwd` assumption above).
- A legitimate agent workflow needs to write one of these paths: give it an explicit, operator-only escape hatch, never a project-file key.
