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
   closes. The permissions evaluator keeps its JSON-of-args fallback for a call whose field is
   absent or not a string, governed by a tool-only rule or the default decision, exactly as `Read`
   without `file_path` is today (executed for all five tools; the sandbox denies every such call).

3. **`MultiEdit` leaves the table.** The table's stated source of truth is `sdk-tools.d.ts`. An entry
   the SDK does not declare is a field name nothing can verify: the DEC-0016 shape (a hand-copied
   value with no re-derivation) inside a security table. The class it would defend against, tools
   the SDK dispatches without a declared input type, is R-9 by name and would equally need
   `NotebookRead` and `Cd`, which no `*Input` interface in `sdk-tools.d.ts` declares. (The bundled
   native CLI, a sibling optional dependency, does name them, and `Cd`'s target field is knowable
   from the binary; the harness derives its gate from the typed SDK surface, not the binary, so a
   field only the binary knows is out of reach by construction.) One policy for the class: tools the
   typed surface declares are derived and gated; the rest are R-9.

   Dropping `MultiEdit` needs its own evidence, because the removal converts a table entry into an
   unknown tool, and if the runtime could dispatch `MultiEdit` that would UNGATE it. The bundled
   binary (0.3.201) names `MultiEdit` (grep: seven hits), but only in permission-rule guidance prose
   ("a rule that an Edit/Write/MultiEdit deny rule covers"), a display gerund map
   (`MultiEdit:"Editing"`) and tool-name string lists; there is no tool-registration shape
   (`name:"MultiEdit"`, an input schema) for it, exactly as for `NotebookRead` and `Cd`. So at the
   pinned version `MultiEdit` is not a dispatchable tool and dropping it ungates nothing reachable;
   a later SDK that declares a `MultiEditInput` lands it as an entry on the next `npm ci`. The
   removal is visible in the commit, in the pin test's list, and in a sandbox test that now records
   `MultiEdit` passing through as an unknown tool.

4. **A derived gate, both directions, with its reach written down.**
   `src/internal/tool-targets.sdk-parity.test.ts` reads the installed `sdk-tools.d.ts` and asserts:
   (a) every SDK tool with a target-shaped field (name matches `/path|file|command|cmd|cwd|dir/i`)
   has a table entry; (b) the entry's `field` is a field the SDK declares for that tool and `kind`
   agrees with the field's class; (c) every other target-shaped field of that tool is acknowledged
   with a reason, and every acknowledgement names a tool and field that still exist and are still
   target-shaped; (d) every table key is an SDK-declared tool; (e) an entry whose SDK field is
   required does not claim `missingMeansCwd`, and the set of entries that DO claim it is pinned to
   `{Glob, Grep}`, so a new cwd-default (which would turn an optional field's deny into gate-cwd) is
   a visible act. The parse takes its tool list from the SDK's own `ToolInputSchemas` union and
   requires every union member to resolve to a parsed `export interface` except the one known
   output-union alias (`ToolOutputSchemas`), acknowledged by name; a new alias, `extends` or generic
   member therefore fails loudly rather than being dropped for not ending in `Input` (a
   self-referential cross-check whose two sides shared one naming heuristic was the review finding
   that prompted this). Declarations are split at `export` boundaries so a stray column-0 brace
   cannot truncate a body, and quoted or `readonly` keys the generator may emit are read. The parse
   is three-state: the union must exist, name at least thirty members, and resolve its anchor tools,
   so a short or inconsistent parse fails as "could not check", never as clean. The vocabulary is
   pinned against a known-good and a known-bad sample so an edit that widens it to everything or
   narrows it to nothing is caught.

   Reach, stated so nobody reads it as total coverage. It catches: a declared path/command tool
   missing from the table; a table field the SDK renamed or removed; a table entry the SDK does not
   declare; a stale acknowledgement; a kind mismatch; a new `missingMeansCwd` outside `{Glob, Grep}`.
   It does not catch: a tool the SDK dispatches without a declared input type (`NotebookRead`,
   `Cd`); a target field whose name falls outside the vocabulary; a path carried inside an
   object-typed field, because the parse reads top-level fields only; WHICH of two target-shaped
   fields an entry gates (the sandbox and evaluate pins bind that instead); a tool whose dangerous
   dimension is not a path or a command (`WebFetch.url`, network egress, is R-3; `REPL.code` is
   arbitrary code execution, outside the path/command axis and carrying no residual row of its own
   yet); anything at production
   time, because it is a test (an operator whose caret range resolves a newer SDK gets no runtime
   check). An interface shape the regex cannot parse (`extends`, a type alias, a generic) is not a
   silent miss: it fails the union cross-check loudly (none but the acknowledged output alias exist
   at 0.3.201, executed). Mutations run for this ADR: the old
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
- **A mode-aware gate keyed on `Projects.method`.** `ProjectsInput.method` is a required enum in the
  typed surface (`project_info|project_read|project_search|project_write|project_delete`), so the
  gate could pass `project_search`/`project_info` (no filesystem contact) and gate only
  `project_write` + `local_path`, removing that tool's share of decision 2's over-blocking. Rejected
  for now: a per-tool special case in a table whose value is being uniform, relieving over-blocking
  that has no operator report behind it yet. Recorded as a Revisit-if trigger instead of adopted, so
  the cost stays visible.
- **Keep `MultiEdit` as a fail-closed extra.** Rejected per decision 3 (no tool-registration shape
  in the pinned binary, so nothing reachable to keep gated); it also breaks the invariant the gate
  enforces in the table-to-SDK direction, and a gate with a standing exemption is a gate with a
  second hand-maintained list. If a future SDK made a runtime-only tool both dispatchable and
  typeless, the `ACKNOWLEDGED_NON_TARGET_FIELDS` mechanism could carry an acknowledged fail-closed
  extra with a reason, rather than a bare exemption.
- **Guess entries for `NotebookRead` and `Cd`.** Rejected: "never guess" is the sandbox's own rule,
  and a wrong field name would deny every call while claiming knowledge the package does not hold.
- **Restrict `allowedTools` or `disallowedTools` at the session** so these tools are never exposed.
  Not this issue's fix surface; it changes what a headless run can do at all and deserves its own
  decision: filed as issue #105, recorded under Revisit if.
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

- A permissions `match` rule an operator wrote against the OLD `JSON.stringify(args)` fallback for
  one of the five tools (e.g. `match: '{"file_path":"/etc/*'`) stops firing, because the tool now
  has a canonical path target instead of the JSON blob. ADR-0014 marks such rules best-effort, so
  this is a behaviour note, not a regression; the tool is now gated on its real field.
- Under an enabled sandbox dimension, the non-filesystem modes of `Workflow`, `Monitor`,
  `EnterWorktree` and `Projects` are denied (decision 2). An operator who needs those modes turns
  the sandbox dimension off (and, if path policy is still wanted, expresses it as permissions deny
  rules instead); a permissions ALLOW rule cannot undo a sandbox denial, because the hook runtime
  denies on any pre-tool throw and permissions can only add denials, never suppress one. The sandbox
  does not gain a per-mode carve-out.
- The vocabulary is a heuristic on field names. A future filesystem field with a name outside it is
  unseen; the acknowledgement list is the place a reviewer will notice, not the gate.
- R-9 keeps its class (undeclared runtime tools); it is narrower and named, not closed.
- The gate is a dev and CI check. It does nothing on an operator's machine.

## Revisit if

- An SDK tool declares two GATEABLE fields (any mix of path and command, not only two filesystem
  paths): adopt the multi-field `ToolTarget` and decide the permissions combinator (most restrictive
  decision across fields).
- Operators hit the absent-optional-field deny wall (a denied `Projects` search or inline `Workflow`
  under an enabled sandbox dimension is reported as friction): consider the mode-aware
  `Projects.method` gate above, or a per-tool "no-target modes pass" opt-in, with a threat-model
  review. Same shape as ADR-0015's "users hit the metacharacter false-deny wall" trigger.
- The SDK ships a tool-name map or per-tool metadata: replace the alias map and the
  `<Tool>Input` naming heuristic with it.
- The SDK declares an input type for `NotebookRead` or `Cd`: the gate fails on the next `npm ci`
  and they land as entries.
- The harness restricts the exposed tool set at the session (`allowedTools`/`disallowedTools`,
  issue #105): R-9's class changes from "gate what is declared" to "expose only what is gated";
  that decision must also say what happens to `ToolSearch`, which can surface deferred tools.
- A caret-range SDK bump lands: read the gate's failures as the changelog of the tool surface, not
  as noise to silence.
