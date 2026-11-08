import { describe, expect, it } from 'vitest';

import { DENIED_TOOL_PREFIXES, DENIED_TOOLS } from '../internal/tool-targets.js';
import { CODE_EXECUTION_DENY_REASON } from './code-execution-deny.js';
import { UNGATED_TOOL_DENY_REASON, ungatedToolDenial, UngatedToolDenied } from './ungated-tool-deny.js';

describe('ungatedToolDenial (#219; a toolNameDenyHook step since #230): a built-in deny for tools that reach local files in ways no gate can check', () => {
  // "Whatever the arguments" is pinned on toolNameDenyHook, whose test hands it arguments that throw on any read.
  it.each(['Artifact', 'ArtifactData', 'ArtifactComments', 'ArtifactCheck'])('denies %s with the fixed reason', (tool) => {
    expect(ungatedToolDenial(tool)).toBeInstanceOf(UngatedToolDenied);
    expect(ungatedToolDenial(tool)?.message).toBe(UNGATED_TOOL_DENY_REASON);
  });

  // Security review round 3: the CLI also ships Artifact as its own MCP server, `claude-artifacts`.
  it.each(['mcp__claude-artifacts__publish_files', 'mcp__claude-artifacts__read_file', 'mcp__claude_artifacts__copy_file'])(
    'denies the built-in artifacts MCP server tool %s by prefix',
    (tool) => {
      expect(ungatedToolDenial(tool)).toBeInstanceOf(UngatedToolDenied);
    },
  );

  it('a prefix matches only a whole server segment', () => {
    // The last probe holds the whole prefix mid-name: the match must be anchored at the start (security review, #230).
    for (const tool of ['mcp__claude-artifacts', 'mcp__claude-artifactsx__publish', 'mcp__my-claude-artifacts__x', 'claude-artifacts__x', 'mcp__github__mcp__claude-artifacts__x']) {
      expect(ungatedToolDenial(tool), tool).toBeUndefined();
    }
  });

  it('matches the exact tool name only', () => {
    for (const tool of ['artifact', 'ARTIFACT', 'Artifact ', 'Artifacts', 'mcp__x__Artifact', 'Read', 'Projects', 'Bash', '__proto__', 'constructor']) {
      expect(ungatedToolDenial(tool), tool).toBeUndefined();
    }
  });

  it('denies every DENIED_TOOLS entry, read from the list itself', () => {
    for (const tool of Object.keys(DENIED_TOOLS)) {
      expect(ungatedToolDenial(tool), tool).toBeInstanceOf(UngatedToolDenied);
    }
  });

  // A ratchet, not a derivation: growing or shrinking the list is a reviewed change to this line.
  it('the lists are exactly the Artifact family and its MCP server, ruled on 03/11/2026', () => {
    expect(Object.keys(DENIED_TOOLS).sort()).toEqual(['Artifact', 'ArtifactCheck', 'ArtifactComments', 'ArtifactData']);
    expect(Object.keys(DENIED_TOOL_PREFIXES).sort()).toEqual(['mcp__claude-artifacts__', 'mcp__claude_artifacts__']);
  });

  it('denies a tool under every DENIED_TOOL_PREFIXES entry, read from the list itself', () => {
    for (const prefix of Object.keys(DENIED_TOOL_PREFIXES)) {
      expect(ungatedToolDenial(`${prefix}any_tool`), prefix).toBeInstanceOf(UngatedToolDenied);
    }
  });

  it('every entry carries a reason, and the deny reason is fixed, says why, and has its own prefix', () => {
    for (const [tool, entry] of [...Object.entries(DENIED_TOOLS), ...Object.entries(DENIED_TOOL_PREFIXES)]) {
      expect(entry.reason.trim(), tool).not.toBe('');
    }
    expect(UNGATED_TOOL_DENY_REASON).toMatch(/^built-in tool deny: /);
    expect(UNGATED_TOOL_DENY_REASON).toContain('#219');
    // Telemetry attributes a deny by its reason prefix, so the built-in denies must differ there.
    expect(CODE_EXECUTION_DENY_REASON.startsWith('built-in tool deny: ')).toBe(false);
  });
});
