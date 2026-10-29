# ADR-0042: a built-in, non-configurable deny stops the agent writing the harness's own state

- **Status:** Accepted
- **Date:** 2026-10-29
- **Requirements:** issue #188; security-model R-23 (new), R-1, ASI03 and ASI08; S-4 (the sandbox's posture, which this does not change).
- **Amends:** ADR-0015 (a first pre-tool hook now runs before the permission and sandbox gates, it compares real paths for the paths it protects, and its "Revisit if: symlink escapes become a live concern" is partly answered for those paths), ADR-0033 (the shared tool table gains a `writes` marker), ADR-0041 (its later-run cap integrity consequence is closed for the paths named here). **Relates to:** ADR-0014 (permissions), ADR-0031 (deny reasons carry no values), ADR-0034 (the guarded settings read, which already refuses a symlinked settings file at load), #211 (a sibling per-tool capability marker, `executes`, not built here).

## Context

Before this change, nothing built in stopped the model writing the harness's own policy.
- The two settings files were protected only if the operator turned the sandbox's `paths` dimension on and left them out of `paths.allow`. The sandbox is off by default (ADR-0015 decision 1), and the default permission decision is `allow` (ADR-0014).
- The sandbox's command checks run only when `sandbox.commands` is set (`sandbox.ts` returns early otherwise). With the default settings, `echo {} > ~/.harness/settings.json` passed every gate.
- The user file is the one that matters most. It alone configures the judge, the Claude Code settings sources and, since ADR-0041, the dollar cap. Its denies also bind the project file. A model that edits it changes the policy for the next run: for example `{"budget": {"maxUsd": 100000}}` lifts the cap for every later run, and the current run cannot notice, because the SDK reads the cap once at spawn.
- The skills root and the telemetry database are the harness's other state. A model that writes a skill injects text into the next run's system prompt. One that writes the database rewrites the cost and audit trail.

The owner ruled on 29/10/2026: protect both `.harness` directories whole; compare targets both as written and by real path; deny any Bash or Monitor command that mentions a protected path; register the deny first.

## Decision

**D1. What is protected.** For each session, `buildProtectedRoots` (`src/security/self-protection.ts`) protects these directories and everything under them:
- `~/.harness/`: the user settings file, any telemetry databases kept there, and the red-team holdout;
- `<cwd>/.harness/`: the project settings file, the default telemetry database, and the eval scorecards;
- the run's skills root (`run --skills-dir`, or each eval task's own root).

It also protects the `run --db` file and its SQLite sidecars (`-wal`, `-shm`, `-journal`) when they lie outside those directories. The sidecars are named explicitly, so `tel.db.txt` is not protected. Eval's database is in memory; the project `.harness` directory is protected as a directory anyway.

**D2. Which tool calls.** The shared tool table (ADR-0033) gains a `writes` marker on the tools that write a local file at their target: `Write`, `Edit` and `NotebookEdit`. A writer call whose target is protected is denied. So is one whose target is not a string, because a target the guard cannot read cannot be shown to be safe. `Read`, `Glob` and `Grep` read, `Artifact` and `Projects` read for upload, `Workflow` reads and runs a script, and `EnterWorktree` switches directory, so all of these pass to the next gate. `Bash` and `Monitor` are covered by D4.

**D3. Aliases.** The paths gate is lexical by design (ADR-0015 §2). This guard also compares real paths:
- each protected root is canonicalised as written and by real path, computed once when the session is built;
- each target is canonicalised the same two ways;
- the call is denied if any form of the target is under any form of a root.

For a target that does not exist yet, the real path of its nearest existing ancestor stands in, with the rest of the path appended. This catches a symlink to the settings file, or to the `.harness` directory, that was set up before the call. It also catches a real-path spelling of a protected directory, such as macOS `/var` read as `/private/var`. A `~` or `~/` target is expanded against the user directory, in case the SDK expands it. On macOS and Windows both sides are case-folded and NFC-normalised, as in the paths gate.

**D4. Bash and Monitor: any mention.** A command is denied when it names a protected path in any of these spellings:
- absolute, as written or by real path;
- `~/…`, `$HOME/…` or `${HOME}/…` for a path under the user directory;
- relative to the working directory (`.harness/…`, `./.harness/…`, `skills`) for a path under it.

A match counts only at a boundary. After the path there must be the end of the command, a `/`, whitespace, a quote or a shell operator. A relative spelling must also start a word, so `.harnessrc`, `skills-lint`, `myskills` and `foo.harness/x` are not matches. Reads are denied too: `cat ~/.harness/settings.json` in Bash is refused, although the `Read` tool may read the same file. The guard does not try to tell whether a command writes. A command that is not a string is denied.

**D5. Order and configurability.** `registerSecurityHooks` registers the guard first, before the permission hook and the sandbox. That is the one registration site for `run` and `eval`, and both now pass it the protected roots (`tsc` enforces the argument). Its reason is therefore the one reported. Because the guard throws before the permission hook runs, no rule can grant past it: not a user `{"tool": "*", "decision": "allow"}`, not an absent sandbox. No settings key reads or removes it.

**D6. The reason.** The model reads one fixed sentence: "self-protection: the agent may not change the harness's own settings, telemetry or skills; edit the file yourself if the change is intended (ADR-0042)". It never echoes the path (ADR-0031).

## Consequences

- **The Bash and Monitor half is defence in depth, not containment.** It matches text, so anything that builds the path at run time gets past it:
  - a variable (`H=~/.har; cp x "${H}ness/settings.json"`), a glob (`~/.harnes?/s*`), brace expansion, or `printf` and `base64` tricks;
  - `cd` into a parent and a relative name from there;
  - an interpreter computing the path, or a script written by one call and run by another;
  - anything an allowed program does internally (`git` hooks, `find -exec`).

  These are ADR-0015 decision 3's limits; the real fix is an OS sandbox. R-23 records them.
- **Aliases created after the check, and hard links, are not caught.** The check runs at pre-tool time, and the SDK writes later. A link made between the two (TOCTOU), or one made by an earlier Bash call that got past D4, is not seen. A hard link has its own real path, and only an inode comparison would catch one. The guarded settings read (ADR-0034) still refuses a symlinked settings file at the next load, which closes the symlink-swap half for the settings files only.
- **Over-matching is accepted.** A command that merely names a protected path for an innocent reason (`ls skills`, `grep x ~/.harness/settings.json`) is denied, and so is a write under a real-path alias of a protected directory. Failing closed is the intended direction. The operator can always edit the files themselves.
- **The `cwd` assumption.** Relative targets and relative spellings are resolved against the harness's working directory. If an `EnterWorktree` call changes the SDK child's directory, a relative write is resolved against the wrong base. That was already true of the paths gate (ADR-0015 §2).
- **Telemetry shifts by one handler.** The permission hook is now handler 1, not 0, so `handlerIndex` in `granted-by-rule`, `denied-by-hook` and `hook-error` rows moves by one for the permission and sandbox hooks. A self-protection deny is a `denied-by-hook` row with `handlerIndex` 0 and the fixed reason.
- **ADR-0041's later-run gap is closed for the named paths.** A model-authored `Write` or `Edit` to `~/.harness/settings.json` is now denied, and so is a Bash command that names it. A constructed path in Bash is still the residual above. The budget start line ADR-0041 added stays as the visible backstop on `run`.

## Alternatives considered

- **Protect only the named files.** That leaves the holdout, old telemetry databases and the scorecards writable, and needs a sidecar list per file. Rejected (owner ruling).
- **Lexical comparison only, like the paths gate.** Any symlink alias set up beforehand gets straight past. Rejected (owner ruling). ADR-0015 rejected `realpath` for the general gate because it is impure and racy. Here it is applied only to a small fixed set computed once, with the race documented.
- **Detect write intent in Bash.** Parsing `cp`, `mv`, `tee`, `sed -i`, redirections and `dd of=` is more code, and it fails open on every form the parser misses. Rejected for "any mention" (owner ruling).
- **No Bash check.** With the default settings, Bash writes would stay wide open. Rejected.
- **Register last.** The deny would still hold, but a permission or sandbox reason could be reported instead, hiding why. Rejected (owner ruling).

## Revisit if

- An OS-level sandbox lands: the Bash half can then defer to it.
- #211's `executes` marker lands: `writes` and `executes` should be pinned against the SDK together.
- The SDK starts reporting the child's working directory per call (the `cwd` assumption above).
- A legitimate agent workflow needs to write one of these paths: give it an explicit, operator-only escape hatch, never a project-file key.
