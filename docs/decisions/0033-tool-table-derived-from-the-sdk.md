# ADR-0033: the tool table is derived from the SDK's own declarations, in both directions

- **Status:** Accepted. Ships in the PR for issue #86.
- **Date:** 2026-08-26
- **Requirements:** issue #86; external review 2026-08-25 (finding 1.3, verified by execution); S-3 and S-4 (the two pre-tool gates)
- **Relates to:** ADR-0015 §2 (the shared table and the "covers all" claim this corrects), ADR-0014 (the permissions evaluator), ADR-0032 (the same lesson one seam over: a harness-owned pin can only confirm its author's beliefs), security-model R-9 and R-3

## Context

Both pre-tool gates read one table, `src/internal/tool-targets.ts`, to learn which argument field
of a tool is the path or command to check. ADR-0015 §2 said the table "covers all
path/command-taking SDK tools and is pinned by a test, so extending it is a visible act". The pin
test pinned the table to itself.

At the only SDK version the harness has ever run (`@anthropic-ai/claude-agent-sdk` 0.3.201, pinned
2026-07-06 and never bumped), `sdk-tools.d.ts` declares forty `*Input` interfaces, and thirteen
(tool, field) pairs among them carry a path or a command. The table gated eight tools. Five declared
tools were never in it: `Projects` (`local_path`, a file read from the working directory for
upload), `Workflow` (`scriptPath`), `Monitor` (`command`), `Artifact` (`file_path`) and
`EnterWorktree` (`path`). `MultiEdit` was in the table and is declared by no SDK version the
harness has run.

For an unknown tool the sandbox returns early, and the permissions evaluator's match target is
`JSON.stringify(args)`, which starts with `{"` and so matches no path or command glob; only a
tool-only rule or `defaultDecision: deny` could touch the five. The external review's verifier
executed calls to each with `/etc` paths and `rm -rf` and watched both gates pass. A live smoke the
same day listed `Workflow` among the tools a headless run exposes (the session passes no
`allowedTools`, so the SDK default applies). R-9 recorded the mechanism as an accepted residual and
called it a future "new tool" problem. It had already happened, seven weeks earlier, under a green
suite.

The shape of the failure is ADR-0032's, one seam over: everything the harness owned was tested
against a list the harness wrote, and the one thing a self-referential pin cannot see is the vendor
surface it never read.

## Decision

1. **Five entries; the single-field `ToolTarget` shape stays.** `Artifact.file_path` (path,
   required), `Workflow.scriptPath` (path, optional), `Monitor.command` (command, optional),
   `EnterWorktree.path` (path, optional) and `Projects.local_path` (path, optional). `Projects` is
   the only tool with two target-shaped fields, and only one is a filesystem path: the SDK's own
   declaration describes `local_path` as "a file inside the working directory to upload" and `path`
   as "project_read/project_write/project_delete: doc path", a key in a remote knowledge base.
   `Projects.path` is therefore recorded, not gated, in `ACKNOWLEDGED_NON_TARGET_FIELDS` with that
   reason, and the gate in decision 4 reads the acknowledgement.

2. **An absent optional field is the existing rule, applied, not a new flag.** ADR-0015 §2 already
   denies a gated tool whose target field is missing or non-string ("refusing to guess") unless the
   SDK defines missing as cwd. None of the five defines missing as cwd, so under an enabled sandbox
   dimension the non-filesystem modes of these tools (an inline `Workflow` script or named workflow,
   `Monitor` over a websocket, `EnterWorktree` by name, `Projects` search, info or inline write) are
   denied. That is over-blocking by construction and is the accepted cost: the sandbox cannot see
   what those modes do, and a gate that passes what it cannot see is the defect this decision
   closes. The permissions evaluator keeps its JSON-of-args fallback for a call without the field,
   governed by a tool-only rule or the default decision, exactly as `Read` without `file_path` is
   today.

3. **`MultiEdit` leaves the table.** The table's stated source of truth is `sdk-tools.d.ts`. An entry
   the SDK does not declare is a field name nothing can verify: the DEC-0016 shape (a hand-copied
   value with no re-derivation) inside a security table. The class it would defend against, tools
   the SDK dispatches without a declared input type, is R-9 by name and would equally need
   `NotebookRead` and `Cd`, which appear exactly once in the SDK package (a permission-syntax
   validator list) with no input schema, so their field names are unknowable. One policy for the
   class: declared tools are derived and gated; undeclared tools are R-9. The removal is visible in
   the commit, in the pin test's list, and in a sandbox test that now records `MultiEdit` passing
   through as an unknown tool.

4. **A derived gate, both directions, with its reach written down.**
   `src/internal/tool-targets.sdk-parity.test.ts` reads the installed `sdk-tools.d.ts` and asserts:
   (a) every SDK tool with a target-shaped field (name matches `/path|file|command|cmd|cwd|dir/i`)
   has a table entry; (b) the entry's `field` is a field the SDK declares for that tool and `kind`
   agrees with the field's class; (c) every other target-shaped field of that tool is acknowledged
   with a reason, and every acknowledgement names a tool and field that still exist and are still
   target-shaped; (d) every table key is an SDK-declared tool; (e) an entry whose SDK field is
   required does not claim `missingMeansCwd`. The parse is three-state: the file must exist, yield
   at least thirty interfaces, include anchor tools, and its interface set must equal the members of
   the SDK's own `ToolInputSchemas` union, so a short or inconsistent parse fails as "could not
   check", never as clean (mutation-verified: a broken interface regex exits 1 with "parsed 0
   *Input interfaces ... the parser is broken, not the SDK"). The vocabulary is pinned against a
   known-good and a known-bad sample so an edit that widens it to everything or narrows it to
   nothing is caught.

   Reach, stated so nobody reads it as total coverage. It catches: a declared path/command tool
   missing from the table; a table field the SDK renamed or removed; a table entry the SDK does not
   declare; a stale acknowledgement; a kind mismatch. It does not catch: a tool the SDK dispatches
   without a declared input type (`NotebookRead`, `Cd`); a target field whose name falls outside the
   vocabulary; a tool whose dangerous dimension is not a path or a command (`REPL.code`,
   `WebFetch.url`, R-3); anything at production time, because it is a test (an operator whose
   caret range resolves a newer SDK gets no runtime check). Mutations run for this ADR: the old
   eight-entry table reddens nine pins across five files; an emptied vocabulary reddens its own pin
   and, through the `Projects.path` acknowledgement becoming "dead weight", the acknowledgement
   check; a removed acknowledgement, a flipped `kind`, and an acknowledgement for an undeclared
   tool each redden one named assertion.

5. **The explicit pin test stays.** `tool-targets.test.ts` keeps its sorted key list (now twelve
   names) so a change to the surface is plain text in a diff; the derived gate is what makes the
   surface complete. Its comment no longer claims completeness.

## Alternatives considered

- **A multi-field `ToolTarget`** (`fields: [...]`, gate every present field, deny when none is
  present). Rejected for now: the only two-field tool has one filesystem field, and the permissions
  evaluator's single match-target contract, with the deny-reason plumbing of ADR-0031 behind it,
  would widen for no gated surface. Revisit-if below.
- **Pass through when an optional target field is absent.** Rejected: fail-open on a mode the gate
  cannot see, which is the defect being fixed.
- **Keep `MultiEdit` as a fail-closed extra.** Rejected per decision 3; it also breaks the invariant
  the gate enforces in the table-to-SDK direction, and a gate with a standing exemption is a gate
  with a second hand-maintained list.
- **Guess entries for `NotebookRead` and `Cd`.** Rejected: "never guess" is the sandbox's own rule,
  and a wrong field name would deny every call while claiming knowledge the package does not hold.
- **Restrict `allowedTools` or `disallowedTools` at the session** so these tools are never exposed.
  Not this issue's fix surface; it changes what a headless run can do at all and deserves its own
  decision. Recorded under Revisit if.
- **A TypeScript AST walk instead of regex.** The compiler API is available, but the generated
  `.d.ts` is regular enough that a regex with a union cross-check is simpler to read and to
  mutation-test; `src/ci-drift.test.ts` sets the precedent for a proxy parser that is made loud.

## Consequences

### Positive

- The table can no longer disagree silently with the installed SDK declarations in either direction;
  the disagreement that lasted seven weeks would have failed the suite on day one.
- Five tools are gated, including the one proven exposed in headless runs.
- Every deliberate non-gate has a reason next to the table, and the gate reads it, so the reason
  cannot rot.

### Negative / accepted

- Under an enabled sandbox dimension, the non-filesystem modes of `Workflow`, `Monitor`,
  `EnterWorktree` and `Projects` are denied (decision 2). Operators who want them need the sandbox
  dimension off or a permissions rule; the sandbox does not gain a per-mode carve-out.
- The vocabulary is a heuristic on field names. A future filesystem field with a name outside it is
  unseen; the acknowledgement list is the place a reviewer will notice, not the gate.
- R-9 keeps its class (undeclared runtime tools); it is narrower and named, not closed.
- The gate is a dev and CI check. It does nothing on an operator's machine.

## Revisit if

- An SDK tool declares two filesystem fields: adopt the multi-field `ToolTarget` and decide the
  permissions combinator (most restrictive decision across fields).
- The SDK ships a tool-name map or per-tool metadata: replace the alias map and the
  `<Tool>Input` naming heuristic with it.
- The SDK declares an input type for `NotebookRead` or `Cd`: the gate fails on the next `npm ci`
  and they land as entries.
- The harness restricts the exposed tool set at the session (`allowedTools`/`disallowedTools`):
  R-9's class changes from "gate what is declared" to "expose only what is gated"; that decision
  should also say what happens to `ToolSearch`, which can surface deferred tools.
- A caret-range SDK bump lands: read the gate's failures as the changelog of the tool surface, not
  as noise to silence.
