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
- the links followed are counted against ONE budget of 40 for the whole path, nested links included, as Linux counts them (macOS's own limit is 32, and on macOS the `/var` link spends one hop of the budget). A path that needs more is denied, as are a link that vanishes while it is read and a loop. A per-nesting limit would not do: a doubling link tree (`Ln -> L(n-1)/L(n-1)`), which the agent can build with plain `ln -s`, is exponential in total hops and hung the hook in review.

Each protected root is resolved this way once, when the session is built. Each writer target is resolved on every call, so a link that already exists when a later call is checked is followed. A call is denied if its target, in either form (as written or by real path), is under any form of a root.

A relative target is resolved against the session's project directory, the working directory the SDK child inherits, never `process.cwd()`. A `~` or `~/` target is expanded against the user directory, in case the SDK expands it. Both sides are NFC-normalised on every platform; on macOS and Windows they are also case-folded, as in the paths gate. The walk splits on the platform separator and is not exercised on Windows, which is not in CI.

**D4. Bash and Monitor: any mention that names a protected path.** The command is first rewritten for matching only:
- the `$` of ANSI-C `$'…'` quoting is dropped;
- `$HOME` and every `${HOME…}` form, to one level of nesting (`${HOME%/}`, `${HOME:-${HOME}}`), become the user directory;
- a `~` that starts a word becomes the user directory, and `~+` the working directory.

It is then split into shell-style words: quoted parts join their neighbours (`"$HOME"/.harness` is one word), quotes and backslashes are removed, and unquoted whitespace and shell operators separate words. The candidate paths are:
- every word that contains a `/`, every piece of it split at spaces, commas, quotes, brackets, `;`, braces and `=`, and a value glued to a short option, alone or after a cluster of flags (`-o.harness/x`, `-C.harness`, `-tskills`, `-rt.harness`), so `of=.harness/telemetry.db`, `skills/x=1/SKILL.md` and `shutil.copy('/tmp/x','.harness/settings.json')` inside one quoted argument all count;
- every word with no space and no `/`, which is an argument, so a bare `skills` or `.harness` counts as that folder (owner ruling, revised 29/10/2026). `cp -r /tmp/evil skills`, `tar -C .harness` and `cp x 'skills'` write there and are denied. Quoted text with a space in it is not an argument, so `git commit -m "add skills"` passes, and so does a word that is not the folder's name (`build:skills`, `myskills`, `.harnessrc`).

Each candidate goes through D3's test. Separately, any form of a protected root that appears anywhere in the rewritten command is a match when it is followed by the end, a `/`, whitespace, a quote, a shell operator or a glob or brace character, so `rm -rf ~/.harness*` is denied.

Reads are denied like writes: `cat ~/.harness/settings.json`, `ls skills` and `grep skills README.md` are refused, although the `Read` tool may read the same files. A command that is present but not a string is denied. An absent command, which is Monitor's websocket mode, has nothing to match and passes.

**D5. Order and configurability.** `registerSecurityHooks` registers the guard first, before the permission hook and the sandbox. That is the one registration site for `run` and `eval`, and both now pass it the protected roots (`tsc` enforces the argument). Its reason is therefore the one reported. Because the guard throws before the permission hook runs, no rule can grant past it: not a user `{"tool": "*", "decision": "allow"}`, not an absent sandbox. No settings key reads or removes it.

The guard belongs to the CLI's composition, not to `createSession`. A library caller who builds their own hook runtime gets it only by registering it, so `buildProtectedRoots`, `selfProtectionHook`, `SelfProtectionViolation` and `SELF_PROTECTION_REASON` are exported from the root barrel. ADR-0040 records the same property for its grant.

**D6. The reason.** The model reads one fixed sentence: "self-protection: the agent may not change the harness's own settings, telemetry or skills; edit the file yourself if the change is intended (ADR-0042)". It never echoes the path (ADR-0031).

## Consequences

- **The Bash and Monitor half is defence in depth, not containment.** It reads text after a light rewrite, so anything that builds the path at run time, or spells it in a form D4 does not rewrite, gets past it:
  - a variable other than `HOME` (`H=~/.har; cp x "${H}ness/settings.json"`), a glob (`~/.harnes?/s*`), brace expansion, or `printf` and `base64` tricks;
  - `cd` somewhere else and a relative name from there (`cd .. && cp x proj/.harness/x`);
  - `~user/…` and `~-/…`, which are not expanded, and escapes inside `$'…'` (`$'\x2eharness'`), which are not decoded;
  - an ancestor of a protected directory (`rm -rf .`, `rm -rf ~`, `mv` of the whole project), which removes or moves the protected directories with it: only paths at or under a root are matched, because matching ancestors would deny `ls .` and `cd ~`;
  - an interpreter computing the path, or a script written by one call and run by another;
  - anything an allowed program does internally (`git` hooks, `find -exec`).

  These are ADR-0015 decision 3's limits; the real fix is an OS sandbox. R-23 records them.
- **A link made in the gap between the check and the write, and hard links, are not caught.** The check runs at pre-tool time, and the SDK writes later. A link that appears between the two (TOCTOU), for example one made by a background process an earlier call started, is not seen. A hard link has its own real path, and only an inode comparison would catch one. The guarded settings read (ADR-0034 decisions 3 and 5) still refuses a symlinked settings file at the next load.
- **Over-matching is accepted.** On the default layout, any bare `skills` argument, quoted or not, is the folder, so `ls skills`, `grep skills README.md`, `git commit -m "skills"`, `git checkout skills`, `npm run skills` and a here-doc body with the word on its own are all denied (only quoted text with a space in it passes), as is a command that names a protected path for an innocent reason (`grep x ~/.harness/settings.json`). A write under a real-path alias of a protected directory is denied too. Failing closed is the intended direction, and the operator can always edit the files themselves.
- **Per-call filesystem reads.** Each writer target and each candidate path in a command is resolved with one `lstat` per component plus one `readlink` per link, at most 40 links per path in total.
- **Telemetry shifts by one handler.** The permission hook is now handler 1, not 0, and the sandbox handler 2. So `handlerIndex` in `granted-by-rule` and `denied-by-hook` rows moves by one for them; a pre-tool handler never produces a `hook-error` row. A self-protection deny is a `denied-by-hook` row with `handlerIndex` 0 and the fixed reason. Nothing in the harness keys on these indices (ADR-0008 defines them as registration order).
- **ADR-0041's later-run gap is closed for the named paths.** A model-authored `Write` or `Edit` to `~/.harness/settings.json`, through any alias that exists when the call is checked, is now denied, and so is a Bash command that names it in a form D4 rewrites. A path built at run time, or a spelling D4 does not rewrite, is still the residual above. The budget start line ADR-0041 added stays as the visible backstop on `run`.

## Alternatives considered

- **Protect only the named files.** That leaves the holdout, old telemetry databases and the scorecards writable, and needs a sidecar list per file. Rejected (owner ruling).
- **Lexical comparison only, like the paths gate.** Any symlink alias set up beforehand gets straight past. Rejected (owner ruling). ADR-0015 rejected `realpath` for the general gate because it is impure and racy. Here it is applied only to a small fixed set computed once, with the race documented.
- **Any word `skills` or `.harness`, quoted or not.** The first cut did this, which blocked `git commit -m "add skills"`. Rejected on review.
- **Path-shaped words only.** The next ruling counted a bare word only with a `/`. The security re-check showed the cost: a bare destination (`cp -r /tmp/evil skills`) is a one-command skill injection. Rejected (owner ruling, revised 29/10/2026: a bare argument, quoted or not, is the folder).
- **Detect write intent in Bash.** Parsing `cp`, `mv`, `tee`, `sed -i`, redirections and `dd of=` is more code, and it fails open on every form the parser misses. Rejected for "any mention" (owner ruling).
- **No Bash check.** With the default settings, Bash writes would stay wide open. Rejected.
- **Register last.** The deny would still hold, but a permission or sandbox reason could be reported instead, hiding why. Rejected (owner ruling).

## Revisit if

- An OS-level sandbox lands: the Bash half can then defer to it.
- #211's `executes` marker lands: `writes` and `executes` should be pinned against the SDK together.
- The SDK starts reporting the child's working directory per call (the `cwd` assumption above).
- A legitimate agent workflow needs to write one of these paths: give it an explicit, operator-only escape hatch, never a project-file key.
