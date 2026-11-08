# ADR-0044: on the SDK 0.3.312 bump, refuse the Artifact tool family, and hold REPL as a binary-only tool

- **Status:** Accepted
- **Date:** 2026-11-03
- **Requirements:** issue #219; security-model R-9, R-24, R-25 (new).
- **Amends:** ADR-0033 (Artifact leaves the table: a tool refused by name has no entry, and the refusal covers its target fields; REPL stays in `CODE_EXECUTING_TOOLS` on binary evidence), ADR-0040 (`registerSecurityHooks` now registers five hooks, the first three from `builtInDenyHooks`; D-8's parity test accepts an undeclared member through an evidence list), ADR-0042 (the permission hook is now handler 3, the sandbox handler 4). **Relates to:** ADR-0008 (`handlerIndex` is registration order), ADR-0031 (deny reasons carry no values), ADR-0043 (the harness prices runs itself, so the bump is not needed for correct telemetry), #105 (restricting the exposed tool set).

## Context

Issue #219 bumps `@anthropic-ai/claude-agent-sdk` from 0.3.201 to 0.3.312. 0.3.312 was published 27/10/2026, and it is the version the issue was analysed against. Later versions exist, and each is its own change. The full gate on main was green before the bump (3044 tests). After the bump, the SDK parity tests failed in four places, and each one was a real surface change.

**Artifact reaches local files in ways the tool table cannot see.** The table (ADR-0033) gates one scalar field per tool, and for Artifact that field is `file_path`. The findings below come from `sdk-tools.d.ts` and from reading the 0.3.312 binary's JS text and tool descriptions; none of the CLI behaviour was run. Three review passes on 03/11/2026 found, in turn:
- the declared `file_paths` (an upload list) and `out_dir` (a download directory, which also passed the self-protection deny of ADR-0042);
- `read_asset` with no `out_dir`, which still saves into the CLI's scratchpad folder, a save the CLI approves on its own;
- the undeclared `files` map (published path to a local source file) and the undeclared `read_file` action with its `path` field, both documented in the binary's tool description;
- a consolidated Artifact toolset, switched on by `CLAUDE_CODE_ARTIFACT_TOOLSET` or a remote flag that defaults off. It rewrites the model's input into the older form AFTER the PreToolUse hook has seen it (`{action: "read", paths}` becomes `read_file`). It also adds three tools, `ArtifactData`, `ArtifactComments` and `ArtifactCheck`, and `ArtifactData` reads local JSON files and saves into `out_dir`. Separately, an undeclared `edits` input writes the published file back to disk.

A per-input deny list was built after the first pass and extended after the second, and each later pass found inputs it missed. The CLI-side rewrite means no argument check at the hook can hold. A fourth pass found, again from the binary, that the CLI also ships the capability as its own stdio MCP server. The server is named by a fixed constant, `claude-artifacts`, and spawned as `claude --eval-artifacts-server`. Its tools (`publish_files`, `read_file`, `list_files` and others) stand in for the built-in. MCP tool names are formed as `mcp__` + the server name with characters outside `[A-Za-z0-9_-]` replaced, so they reach the hook as `mcp__claude-artifacts__<tool>`. As read, a default harness run never sees the feature: the CLI keeps it off for SDK runs unless `CLAUDE_CODE_ARTIFACT` is inherited, needs a claude.ai login, and skips the server under `strictMcpConfig`, which the harness sets whenever `sdk.settingSources` is empty, the default; an operator who sets `settingSources` turns it off. So every refusal here is defence in depth, not the only barrier.

**REPL is no longer declared** in `sdk-tools.d.ts`. The 0.3.312 binary still holds two `"REPL"` tool-name constants (`var Sh="REPL",ASn="REPL"`) and still reads `CLAUDE_CODE_REPL`. The tool bodies are Bun bytecode modules, so REPL's registration and permission check can't be read statically at 0.3.312. ADR-0040 D-8's parity test required every `CODE_EXECUTING_TOOLS` member to be SDK-declared, so it failed.

**The `SDKMessage` union became real.** 0.3.201 named two members it never declared, so the union accepted anything (issue #101). 0.3.312 declares both. The tripwire in `sdk-types.test.ts` fired as designed.

**Output literals changed** (issue #203's table). Every change was additive except `service_tier`, which is now `string | null` and so leaves the table.

Tools declared at 0.3.201 and not at 0.3.312 (both packages' `sdk-tools.d.ts`, read 03/11/2026): REPL, TaskOutput. Declared only at 0.3.312: OfferChromeSetup, ProposeGoal, ProposeSkills, ReadNotifications, RefreshMcpTools, SendFeedback. None of the added declarations has a target-shaped field. 0.3.312 also exports `BUILTIN_TOOL_NAMES`, which names tools with no declared input type, among them `PowerShell` and `SendUserFile`. That gap is filed separately (see Revisit if).

The owner ruled on 03/11/2026, in four steps:
1. After the bump: fail closed now and extend the table later; hold REPL through an evidence list; leave the new tools to #105.
2. After the first review: fix every finding in this change.
3. After the re-check: refuse the Artifact family by name rather than chase its inputs.
4. After the fourth pass: refuse the artifacts MCP server by prefix, and drop Artifact's table entry.

## Decision

**D1. Refuse the Artifact family by name, and its MCP server by prefix.** Two lists in `src/internal/tool-targets.ts` say what is refused. Each entry carries a reason and evidence:
- `DENIED_TOOLS`: `Artifact`, `ArtifactData`, `ArtifactComments` and `ArtifactCheck`, matched by exact name;
- `DENIED_TOOL_PREFIXES`: `mcp__claude-artifacts__`, plus the underscore spelling in case a build normalises the server name, matched as a whole `mcp__<server>__` segment.

`ungatedToolDenyHook` (`src/security/ungated-tool-deny.ts`) refuses any call that matches either list, whatever the rules say. It reads neither the arguments, which the CLI may rewrite after the hook, nor any settings. Its reason is the fixed `UNGATED_TOOL_DENY_REASON`. *Amended 08/11/2026 (issue #230): the check is now `ungatedToolDenial` in the same file, step 2 of `toolNameDenyHook`; it still reads neither arguments nor settings, and the reason is unchanged.*

In `shared.test.ts`, eight shapes go through the composed hook stack with a user allow-everything rule and a project-scoped path sandbox:
- six Artifact calls: `file_paths`, `out_dir`, `files`, `read_asset` with no `out_dir`, a consolidated `paths` read, and a plain single-file publish;
- one `ArtifactData` call;
- one `mcp__claude-artifacts__publish_files` call.

Each is refused with this reason. With the deny removed from `builtInDenyHooks`, all eight returned `denied: false` (measured 03/11/2026).

The cost is that the agent cannot publish to or read from claude.ai artifacts at all. That is a logged-in, outward-facing capability that headless runs did not rely on.

Artifact leaves the tool table. A refused tool has no table entry, the same rule as a `denied` code-executing tool. The parity test counts the refusal as covering its target fields, and it fails if a refused tool is re-added to the table. A walk check compares the fields it visits with a list computed independently from the SDK, so a wider or narrower exemption fails.

**D2. Evidence is checked, not asserted.** Each `DENIED_TOOLS` entry's `evidence` is either `declared` or `{ binaryNeedle }`. The prefix entries' needle is the server-name constant `"claude-artifacts"` itself, so a renamed server fails the parity test rather than slipping past:
- A `declared` entry must be a tool that `sdk-tools.d.ts` declares.
- A `binaryNeedle` entry must NOT be declared; once it is, it must move to `declared`. Its needle must also be found in the installed platform binary (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`).

A prefix entry must always carry a needle, because MCP tools are never declared. A missing binary FAILS the check rather than skipping it.

The darwin-arm64 and linux-x64 0.3.312 builds both hold every needle (read 03/11/2026 from both packages; only darwin-arm64 is installed on the dev machine, so CI's first run is the live check on Linux). A needle shows that the binary names something, not that the CLI still dispatches it. A stale needle after a removal leaves a dead deny, not a hole. Binary evidence is admitted only to deny more. The table itself stays derived from the typed surface (R-9).

**D3. REPL is held the same way.** `BINARY_ONLY_TOOLS` maps REPL to `{ binaryNeedle: 'CLAUDE_CODE_REPL', note }`. The D-8 parity test accepts an undeclared member only through this list. A second test fails if an entry is not a `CODE_EXECUTING_TOOLS` member, is declared by the SDK again, or its needle is gone from the binary.

The needle is weak evidence: it shows the CLI still reads the enabling variable, not that the tool still registers. That stays UNCHECKED statically. REPL stays `denied`. The deny matches the tool name, and both constants are exactly `"REPL"`.

**D4. One order for the built-in denies.** `builtInDenyHooks(roots)` (`src/security/built-in-denies.ts`) returns self-protection, the code-execution deny and the ungated-tool deny in that order. `registerSecurityHooks` registers them before permissions and the sandbox. It is on the root barrel, so a library caller that composes its own stack gets the same order instead of re-typing it. *Amended 05/11/2026 (issue #225, ADR-0045): a fourth deny, the unreviewed-tool deny, follows these three.* *Amended 08/11/2026 (issue #230), ADR-0045 D7: the code-execution, ungated-tool and unreviewed-tool denies are one classifier, `toolNameDenyHook`, in the same order; the ungated-tool check is now `ungatedToolDenial`, its second step. `builtInDenyHooks` returns self-protection, the tool-name deny and the remote-agent deny.*

The new reason has its own prefix, `built-in tool deny: `, so a telemetry row is attributable by reason even when handler indices differ between releases. A tool is in at most one of `DENIED_TOOLS` and `CODE_EXECUTING_TOOLS`, which the parity test pins.

**D5. The new tools are left to #105.** None of the added declarations carries a filesystem target. SendFeedback is outward-facing, and until #105 restricts the exposed tool set a headless run offers it like any other SDK default tool.

**D6. The type pins follow the SDK.** `_sdkMessageUnionIsReal` pins that `string` is not assignable to `SDKMessage`. `_retryIsStreamMember` pins `SDKAPIRetryMessage` as a member. `SDK_OUTPUT_LITERALS` is re-derived for 0.3.312.

`modelPricing` (#219 item 5) is an organisation managed-settings key. The harness's isolated settings can't set it and shouldn't. 0.3.312 also reports `costBasis` per model (`list`, `managed` or `unknown`). The harness doesn't capture it yet.

## Consequences

- Telemetry `handlerIndex` shifts by one: the permission hook is now 3 and the sandbox 4. A query that filters by index must be updated, as after ADR-0042. Rows carry no harness version, so prefer the reason prefix. *Amended 05/11/2026 (ADR-0045): now 4 and 5.* *Amended 08/11/2026 (issue #230): now 3 and 4.*
- A library caller that registers its own hooks gets no built-in deny unless it registers them. `builtInDenyHooks` is the supported way.
- Residual R-25: a tool that reaches local files outside the table is refused only if it is listed.
- Rules that name Artifact no longer match on its path: no rule can allow it. A library caller that registers the exported `sandboxHook` with a `paths` list but WITHOUT `builtInDenyHooks` used to have the sandbox gate Artifact's `file_path`, and refuse a call lacking one. It now passes Artifact as an untabled tool, so such a caller must register `builtInDenyHooks`. A permission rule naming Artifact now matches the arguments' JSON instead of a canonical path. Declared target-shaped fields are found by the parity test. Undeclared tools and inputs are found only by reading the binary, and nothing re-reads it automatically for new ones.
- REPL's 0.3.312 registration and permission check are UNCHECKED statically. The keyed observations below record what a run showed.

## Keyed observations (#219 items 2 and 3)

The owner ran these on 03/11/2026 against SDK 0.3.312 on Sonnet 5, with telemetry in a dedicated database. Each was one run, so the results are observations, not measurements of a rate. The REPL and Workflow runs went at the default $1.00 cap: their `--max-budget-usd 0.25` wrapped onto its own line in the terminal.

- **Fixture.** `capture-sdk-hook-fixture.mjs` re-captured the hook fixture at 0.3.312, and its unexpected-path guard passed. The suite then passed 3073/3073.
- **Cost (item 2).** A one-word reply cost $0.0510.
  - The SDK's Sonnet 5 figure ($0.050839) equals list price ($2/$10, 5-minute cache write $2.50) to six decimal places. So 0.3.312 prices Sonnet 5 at list, and the SDK-enforced cap (ADR-0041) now stops at a real figure.
  - The same run's per-model usage also showed a `claude-haiku-5-5` side call made by the CLI itself (1,174 input and 14 output tokens, $0.0001244). Its row was missing, so the harness figure was null. ADR-0043 is amended for it, and the amended code re-prices all three recorded runs to the SDK's figure.
- **REPL (item 3).** With `CLAUDE_CODE_REPL=1` exported, the model reported no REPL tool, including after a deferred-tool search, and telemetry shows no REPL call. So in this run the model saw no REPL tool, and `codeExecutionDenyHook` was not reached. The deny stays as defence in depth.
  - The model then ran `echo $((1+1))` through Bash, which the operator's settings allow. That is existing behaviour, not something this change affects.
- **Workflow (item 3).** Asked to run a one-step workflow, the model used the Skill tool and never called Workflow. So Workflow's 0.3.312 permission check is still unobserved, and ADR-0040 D-8's `withheld` ruling is unchanged.

## Revisit if

- The table can carry several fields per tool, list- and map-valued paths, and CLI-chosen default directories, and the CLI stops rewriting input after the pre-tool hook (follow-up issue). Artifact could then be gated rather than refused. A tool whose ONLY target is a list also needs that table.
- `BUILTIN_TOOL_NAMES` names a tool with no declared input type that runs commands or reads local files (follow-up issue). The fourth pass found `PowerShell`, `SendUserFile` (reads a local file and sends it to the user, behind a flag that defaults off) and `ShareOnboardingGuide` (uploads `./ONBOARDING.md`). It also found that `Agent` with `isolation: "remote"` runs tool calls where no local hook sees them.
- The SDK declares REPL or an Artifact-family tool it does not declare today, or the artifacts MCP server changes its name (the D2 and D3 tests fail and say so; D2 covers the server name), or a needle disappears from the binary.
- #105 lands: `disallowedTools` would remove REPL, the Artifact family and its MCP server from the child entirely, which is stronger than refusing their calls.
