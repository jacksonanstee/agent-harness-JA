import { resolve } from 'node:path';

/**
 * The tool→argument-field table both security gates share (ADR-0015 review
 * finding: two hand-copied four-tool tables drifted from the SDK's real
 * surface — Glob/Grep/NotebookEdit/MultiEdit bypassed BOTH modules because
 * each assumed the other covered them). One table, one place to extend when
 * the SDK grows a tool. Source of truth: @anthropic-ai/claude-agent-sdk
 * sdk-tools.d.ts.
 *
 * Network-egress tools (WebFetch/WebSearch) are deliberately absent: gating
 * them needs a URL/domain dimension, not a path prefix — tracked as future
 * work in ADR-0015 §Revisit-if, not silently half-covered here.
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
}

export const TOOL_TARGET_FIELDS: Readonly<Record<string, ToolTarget>> = {
  Bash: { field: 'command', kind: 'command' },
  Read: { field: 'file_path', kind: 'path' },
  Write: { field: 'file_path', kind: 'path' },
  Edit: { field: 'file_path', kind: 'path' },
  MultiEdit: { field: 'file_path', kind: 'path' },
  NotebookEdit: { field: 'notebook_path', kind: 'path' },
  Glob: { field: 'path', kind: 'path', missingMeansCwd: true },
  Grep: { field: 'path', kind: 'path', missingMeansCwd: true },
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
 * Canonical form for path comparison: lexical resolve (collapses `.`/`..`,
 * anchors relative paths at cwd) plus case folding on case-insensitive
 * platforms. Both sides of every path comparison must go through this.
 */
export function canonicalizePath(
  path: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_PLATFORM,
): string {
  const resolved = resolve(path);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}
