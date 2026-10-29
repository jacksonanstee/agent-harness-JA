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
   * flag to derive it from). Read, Glob and Grep read; Artifact and Projects
   * read for upload; Workflow reads and runs a script; EnterWorktree switches
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
  // Issue #86: declared at the pinned SDK since day one, never in the table.
  Artifact: { field: 'file_path', kind: 'path', writes: false },
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
