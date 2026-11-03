import { resolve } from 'node:path';

/**
 * The tool→argument-field table both security gates share (ADR-0015 review
 * finding: two hand-copied four-tool tables drifted from the SDK's real
 * surface — Glob/Grep/NotebookEdit/MultiEdit bypassed BOTH modules because each
 * assumed the other covered them; MultiEdit was later found undeclared by the
 * SDK and dropped, issue #86). One table, one place to extend when the SDK grows
 * a tool. Source of truth: @anthropic-ai/claude-agent-sdk sdk-tools.d.ts, and
 * since issue #86 that is enforced, not asserted: tool-targets.sdk-parity.test.ts
 * reads the installed declarations and fails when a declared path/command
 * tool is missing here, when an entry names a field or a tool the SDK does
 * not declare, or when a target-shaped field is neither gated nor listed in
 * ACKNOWLEDGED_NON_TARGET_FIELDS with a reason (ADR-0033). The table was
 * never complete before that gate existed: five tools were absent for seven
 * weeks under a pin test that only pinned the table to itself.
 *
 * A gated tool whose field is absent is DENIED by the sandbox unless the SDK
 * defines "missing" as cwd (ADR-0015 §2). For Workflow, Monitor, EnterWorktree
 * and Projects the field is optional and absence means a mode the gates
 * cannot see (an inline script, a websocket, a new worktree by name, a remote
 * doc operation); denying those under an enabled sandbox dimension is the
 * accepted cost (ADR-0033).
 *
 * Network-egress tools (WebFetch/WebSearch) are deliberately absent: gating
 * them needs a URL/domain dimension, not a path prefix — tracked as future
 * work in ADR-0015 §Revisit-if, not silently half-covered here. Tools the SDK
 * dispatches without a declared input type are not here either: NotebookRead
 * and Cd are named by the bundled native CLI (a sibling optional dependency,
 * @anthropic-ai/claude-agent-sdk-<platform>) but declared by no *Input
 * interface in sdk-tools.d.ts, and this table derives from the typed surface,
 * not from the binary (R-9).
 */
export interface ToolTarget {
  readonly field: string;
  readonly kind: 'path' | 'command';
  /**
   * The SDK treats a missing field as "current working directory" (Glob and
   * Grep search cwd when `path` is absent). Gates should evaluate the cwd in
   * that case rather than denying a call the SDK considers well-formed.
   */
  readonly missingMeansCwd?: boolean;
  /**
   * The tool writes a LOCAL file at the target (issue #188, ADR-0042): the
   * self-protection deny applies to it. Required on every entry, so a new
   * tool cannot be added without the choice (the SDK carries no read/write
   * flag to derive it from). Read, Glob and Grep read; Projects reads for
   * upload; Workflow reads and runs a script; EnterWorktree switches
   * into (or creates) a worktree. Always false for `kind: 'command'`:
   * commands are covered by kind.
   */
  readonly writes: boolean;
}

export const TOOL_TARGET_FIELDS: Readonly<Record<string, ToolTarget>> = {
  Bash: { field: 'command', kind: 'command', writes: false },
  Read: { field: 'file_path', kind: 'path', writes: false },
  Write: { field: 'file_path', kind: 'path', writes: true },
  Edit: { field: 'file_path', kind: 'path', writes: true },
  NotebookEdit: { field: 'notebook_path', kind: 'path', writes: true },
  Glob: { field: 'path', kind: 'path', missingMeansCwd: true, writes: false },
  Grep: { field: 'path', kind: 'path', missingMeansCwd: true, writes: false },
  Workflow: { field: 'scriptPath', kind: 'path', writes: false },
  Monitor: { field: 'command', kind: 'command', writes: false },
  EnterWorktree: { field: 'path', kind: 'path', writes: false },
  // Projects has two target-shaped fields; only local_path is a filesystem
  // path (an upload read from the working directory). See the acknowledgement
  // below for `path`.
  Projects: { field: 'local_path', kind: 'path', writes: false },
};

/**
 * What a user rule allow can do for a tool that runs code (issue #211, ADR-0040 D-8):
 * - `commands`: a grant only while the USER layer has a non-empty
 *   `sandbox.commands` list, whose argv check refuses a chained command;
 * - `withheld`: never a grant; the bundled CLI's own permission check decides,
 *   and it asks, which a headless run refuses;
 * - `denied`: refused by a built-in hook before any rule is read
 *   (`codeExecutionDenyHook`), because the CLI's own check allows it.
 */
export type CodeExecutionGate = 'commands' | 'withheld' | 'denied';

/**
 * Every tool that runs a command or script, and its gate. Each value is a
 * per-tool ruling (owner, 30/10/2026), not derived from the table kind:
 * Workflow's `scriptPath` is a path, but a `paths` list checks where a script
 * is, not what it runs, and the SDK's own loop is Write the script, then run
 * it. tool-targets.sdk-parity.test.ts fails when an SDK tool with a field
 * named for code is missing here, when a member is not SDK-declared, when
 * `commands` is not exactly the command-kind entries, or when a `denied`
 * member has a table entry.
 */
export const CODE_EXECUTING_TOOLS: Readonly<Record<string, CodeExecutionGate>> = {
  Bash: 'commands',
  Monitor: 'commands',
  // The CLI's check is `ask` for an inline script, a name and a scriptPath alike.
  Workflow: 'withheld',
  // `code` is arbitrary JavaScript; the CLI's check is a flat `allow` (read from
  // the bundled binary, 30/10/2026). Off in SDK runs unless CLAUDE_CODE_REPL is set.
  REPL: 'denied',
};

/**
 * Target-shaped SDK fields (name says path or command) that are deliberately
 * NOT gated, each with its reason. The derived gate fails on a target-shaped
 * field that is neither gated nor listed here, and on an entry here that names
 * a tool or field the SDK no longer declares, so this list cannot go stale
 * silently. It is documentation the gate reads.
 */
export const ACKNOWLEDGED_NON_TARGET_FIELDS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  Projects: {
    path:
      'a remote knowledge-base document key ("project_read/project_write/project_delete: doc path" ' +
      'in the SDK declaration), not a filesystem path; the filesystem field is local_path',
  },
};

/**
 * Where a deny entry's premise comes from. `declared`: sdk-tools.d.ts declares
 * the tool. `binaryNeedle`: the SDK types do NOT declare it, but the bundled
 * native CLI names it; the parity test scans the
 * installed platform binary for the needle and FAILS if the binary is missing
 * or the needle is gone, so the evidence is checked, not asserted (#219).
 * The table itself stays typed-surface-only (R-9): binary evidence is admitted
 * only to DENY more, never to gate or allow.
 */
export type DenyEvidence = 'declared' | { readonly binaryNeedle: string };

/** A tool the harness refuses by name, whatever the rules say, with the evidence for its premise. */
export interface DeniedTool {
  readonly reason: string;
  readonly evidence: DenyEvidence;
}

/**
 * Tools that reach local files in ways no harness gate can check, refused by
 * name by `ungatedToolDenyHook` (issue #219). At SDK 0.3.312 that is the
 * Artifact family: Artifact reads and writes local files through inputs the
 * one-field table cannot carry (`file_paths`, `out_dir`, `read_asset`'s default
 * folder, and the undeclared `files`, `paths`, `edits`, `read_file`), and a
 * consolidated toolset, switched by `CLAUDE_CODE_ARTIFACT_TOOLSET` or a remote
 * flag, rewrites the input AFTER the pre-tool hook sees it and adds three more
 * tools. A per-field deny list lost that race twice in review, so the family
 * is refused whole. A refused tool has no table entry, the same rule as a
 * `denied` code-executing tool: the parity test counts the refusal as covering
 * its target fields, and fails if one is re-added to the table.
 */
export const DENIED_TOOLS: Readonly<Record<string, DeniedTool>> = {
  Artifact: {
    reason: 'publishes local files to claude.ai and saves files locally through inputs the table cannot gate',
    evidence: 'declared',
  },
  ArtifactData: {
    reason: 'consolidated-toolset tool: reads local JSON files (file_path, writes[]) and saves into out_dir',
    evidence: { binaryNeedle: '"ArtifactData"' },
  },
  ArtifactComments: {
    reason: 'consolidated-toolset tool for artifact comment threads; refused with its family',
    evidence: { binaryNeedle: '"ArtifactComments"' },
  },
  ArtifactCheck: {
    reason: 'consolidated-toolset tool for artifact checks; refused with its family',
    evidence: { binaryNeedle: '"ArtifactCheck"' },
  },
};

/**
 * MCP tool-name prefixes refused whole, for a built-in MCP server the bundled
 * CLI runs itself. The CLI ships Artifact a second time as its own stdio MCP
 * server `claude-artifacts` (spawned as `claude --eval-artifacts-server`), whose
 * tools stand in for the built-in and reach the pre-tool hook as
 * `mcp__claude-artifacts__<tool>`, so the exact-name list above cannot see them
 * (security review round 3, #219). The needle is the server-name constant
 * itself, so a renamed server fails the parity test instead of slipping past.
 * The underscore spelling is listed too, in case a build normalises the name. A prefix must be a whole
 * `mcp__<server>__` segment; MCP tools are never declared in sdk-tools.d.ts, so
 * evidence is always a binary needle.
 */
export const DENIED_TOOL_PREFIXES: Readonly<Record<string, DeniedTool>> = {
  'mcp__claude-artifacts__': {
    reason: 'the CLI-owned artifacts MCP server: the Artifact capability under MCP tool names',
    evidence: { binaryNeedle: '"claude-artifacts"' },
  },
  'mcp__claude_artifacts__': {
    reason: 'the same server under an underscore-normalised name',
    evidence: { binaryNeedle: '"claude-artifacts"' },
  },
};

/**
 * CODE_EXECUTING_TOOLS members that sdk-tools.d.ts no longer declares but that
 * the bundled native CLI still names (whether it still registers them is
 * bytecode, so unread). The parity test accepts an
 * undeclared member only through this list, scans the installed binary for the
 * needle, and fails once the SDK declares the tool again, so the exception
 * cannot outlive its cause (issue #219, ADR-0044 D3). Binary evidence keeps a DENY in
 * place; it never adds a tool to the table (R-9).
 */
export const BINARY_ONLY_TOOLS: Readonly<Record<string, { readonly binaryNeedle: string; readonly note: string }>> = {
  REPL: {
    binaryNeedle: 'CLAUDE_CODE_REPL',
    note: 'undeclared from SDK 0.3.312; the binary still holds two "REPL" tool-name constants and reads CLAUDE_CODE_REPL',
  },
};

/**
 * The default filesystems on darwin (APFS) and win32 (NTFS) are
 * case-insensitive: `/SAFE/x` and `/safe/x` are the same file but different
 * strings, so purely lexical comparison lets a deny rule be dodged by case
 * variation (verified live in the S-4 security review). Folding on these
 * platforms restores "same file → same string". Known trade-off, documented
 * in ADR-0015 §2: on an opt-in case-SENSITIVE volume on these platforms,
 * folding treats two distinct files as one (over-matching is fail-closed for
 * deny rules, over-permissive for allowlists on such volumes).
 */
export const CASE_INSENSITIVE_PLATFORM =
  process.platform === 'darwin' || process.platform === 'win32';

/**
 * Canonical form for path comparison: Unicode NFC normalization, then lexical
 * resolve (collapses `.`/`..`, anchors relative paths at cwd), then case
 * folding on case-insensitive platforms. Both sides of every path comparison
 * must go through this.
 *
 * NFC folding closes the same "same file, different string" bypass as case
 * folding, on the orthogonal Unicode-form axis: an accented character has
 * byte-distinct NFC (single codepoint) and NFD (base + combining mark)
 * encodings, so a deny rule written in one form would otherwise be dodged by a
 * tool call in the other. Filesystems preserve whichever form was given (APFS
 * is byte-preserving but does canonical-equivalence-aware lookup; most Linux
 * filesystems are byte-preserving too), so a rule and a tool argument can
 * arrive in different forms; comparing in NFC makes them agree.
 *
 * Normalize AFTER resolve, not before: resolve() prepends process.cwd() for a
 * relative input, and those bytes never passed through the caller's
 * normalize(); folding the resolved absolute string catches the cwd component
 * too (a relative tool call from a non-NFC-stored directory would otherwise
 * still slip the deny rule).
 */
export function canonicalizePath(
  path: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_PLATFORM,
): string {
  const resolved = resolve(path).normalize('NFC');
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}
