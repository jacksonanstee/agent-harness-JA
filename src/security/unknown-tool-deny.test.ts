import { describe, expect, it } from 'vitest';

import {
  ACKNOWLEDGED_TOOLS,
  ALLOWED_TOOL_NAMES,
  CODE_EXECUTING_TOOLS,
  DENIED_TOOLS,
  REVIEWED_REFUSED_TOOLS,
} from '../internal/tool-targets.js';
import { CODE_EXECUTION_DENY_REASON } from './code-execution-deny.js';
import { SELF_PROTECTION_REASON } from './self-protection.js';
import { UNGATED_TOOL_DENY_REASON } from './ungated-tool-deny.js';
import {
  MCP_SERVER_DENY_REASON,
  McpServerDenied,
  REMOTE_AGENT_DENY_REASON,
  RemoteAgentDenied,
  UNKNOWN_TOOL_DENY_REASON,
  unknownToolDenyHook,
  UnknownToolDenied,
} from './unknown-tool-deny.js';

const preTool = (tool: string, args: unknown) => ({ event: 'pre-tool' as const, tool, args, redactions: null });

describe('unknownToolDenyHook (#225): default-deny for every non-MCP tool the harness has not reviewed', () => {
  const hook = unknownToolDenyHook();

  // Read from the binary at SDK 0.3.312 but not on BUILTIN_TOOL_NAMES: the reason the gate is an allowlist.
  it.each([
    'PowerShell', 'SendUserFile', 'SendUserMessage', 'SendFile', 'SendMessage', 'ShareOnboardingGuide',
    'PublishPlugin', 'DesignSync', 'AppifactRepl', 'LSP', 'Skill', 'RemoteTrigger', 'CronCreate',
    'memory_write', 'self_hosted_runner_spawn_local', 'ClaudeDesign', 'PushNotification', 'ExitWorktree',
    'ListConnectors', 'memory_read', 'some_tool_from_a_future_sdk',
  ])('refuses %s whatever the arguments', async (tool) => {
    for (const args of [{}, { command: 'ls' }, null, 'x', []]) {
      await expect(hook(preTool(tool, args)), JSON.stringify(args)).rejects.toThrow(UnknownToolDenied);
      await expect(hook(preTool(tool, args))).rejects.toThrow(UNKNOWN_TOOL_DENY_REASON);
    }
  });

  it('passes every allowed tool (the gated table, the gated code runners, the acknowledged tools)', async () => {
    for (const tool of ALLOWED_TOOL_NAMES) {
      await expect(hook(preTool(tool, {})), tool).resolves.toBeUndefined();
    }
  });

  describe('MCP: a tool passes only under a server the operator listed in sdk.allowedMcpServers (default none)', () => {
    // The CLI runs MCP servers no operator configured (read from the 0.3.312 binary): mcp__ide__executeCode
    // runs code in the IDE kernel, and claude-in-chrome, computer-use and remote-devices drive the machine.
    it.each(['mcp__ide__executeCode', 'mcp__claude-in-chrome__navigate', 'mcp__computer-use__click', 'mcp__github__create_issue', 'mcp__claude_ai_Gmail__send_message'])(
      'refuses %s when no server is listed',
      async (tool) => {
        await expect(hook(preTool(tool, {}))).rejects.toThrow(McpServerDenied);
        await expect(hook(preTool(tool, {}))).rejects.toThrow(MCP_SERVER_DENY_REASON);
      },
    );

    const listed = unknownToolDenyHook({ allowedMcpServers: ['github', 'my-db'] });

    it('passes a tool under a listed server', async () => {
      for (const tool of ['mcp__github__create_issue', 'mcp__my-db__query', 'mcp__github__x__y']) {
        await expect(listed(preTool(tool, {})), tool).resolves.toBeUndefined();
      }
    });

    it('refuses a tool under an unlisted server, and a server name that only starts like a listed one', async () => {
      for (const tool of ['mcp__ide__executeCode', 'mcp__githubx__create_issue', 'mcp__git__hub', 'mcp__GITHUB__x', 'mcp__my-db2__q']) {
        await expect(listed(preTool(tool, {})), tool).rejects.toThrow(McpServerDenied);
      }
    });

    // Security review round 2: the CLI turns every character outside [A-Za-z0-9_-] in a server name into `_`,
    // so `github.` runs as `github_` and its tools read `mcp__github___<tool>`.
    it('refuses a tool segment that starts with `_` (a normalised `github.` or `github _` server)', async () => {
      for (const tool of ['mcp__github___run', 'mcp__github____run', 'mcp__github___']) {
        await expect(listed(preTool(tool, {})), tool).rejects.toThrow(McpServerDenied);
      }
    });

    // Pinned residual (R-26): the CLI splits `mcp__a__b__c` the same ambiguous way, so a server named
    // `github__x` cannot be told from a tool `x__...` of `github`. A change here must update R-26.
    it('passes `mcp__github__x__run` under a listed github (the documented a__b alias)', async () => {
      await expect(listed(preTool('mcp__github__x__run', {}))).resolves.toBeUndefined();
    });

    it('refuses an MCP-shaped name with no tool segment, even under a listed server', async () => {
      for (const tool of ['mcp__github__', 'mcp__github', 'mcp__x', 'mcp____tool']) {
        await expect(listed(preTool(tool, {})), tool).rejects.toThrow(McpServerDenied);
      }
    });

    it('copies the list: a later change to the caller\'s array does not widen the hook', async () => {
      const servers = ['github'];
      const copied = unknownToolDenyHook({ allowedMcpServers: servers });
      servers.push('ide');
      await expect(copied(preTool('mcp__ide__executeCode', {}))).rejects.toThrow(McpServerDenied);
    });
  });

  it('matches the exact name only: a near miss of an allowed tool is unknown, so refused', async () => {
    for (const tool of ['read', 'READ', 'Read ', 'Reads', ' Bash', 'mcp_x__Read', '__proto__', 'constructor', 'toString', '']) {
      await expect(hook(preTool(tool, {})), JSON.stringify(tool)).rejects.toThrow(UnknownToolDenied);
    }
  });

  describe('Agent: a local or worktree subagent passes; a remote one is refused (its calls reach no local hook)', () => {
    it.each([{}, { isolation: 'worktree' }, { prompt: 'p', subagent_type: 'Explore' }, { isolation: undefined }])(
      'passes %j',
      async (args) => {
        await expect(hook(preTool('Agent', args))).resolves.toBeUndefined();
      },
    );

    // Fail closed: any isolation value other than the one known-local value is refused, not only "remote".
    it.each([{ isolation: 'remote' }, { isolation: 'Remote' }, { isolation: 'cloud' }, { isolation: null }, { isolation: 1 }, { isolation: ['remote'] }])(
      'refuses %j',
      async (args) => {
        await expect(hook(preTool('Agent', args))).rejects.toThrow(RemoteAgentDenied);
        await expect(hook(preTool('Agent', args))).rejects.toThrow(REMOTE_AGENT_DENY_REASON);
      },
    );

    it('refuses an Agent call whose arguments are not an object (the field cannot be read, so it is not known local)', async () => {
      for (const args of [null, 'x', [], 1]) {
        await expect(hook(preTool('Agent', args)), JSON.stringify(args)).rejects.toThrow(RemoteAgentDenied);
      }
    });

    // Security review: the CLI's Agent schema family has `cwd` ("Overrides the working directory for all filesystem
    // and shell operations within this agent"); the model-facing schema omits it today. The sandbox resolves relative
    // paths against the harness cwd, so a subagent elsewhere would be judged against the wrong directory.
    it('refuses an own cwd field, whatever its value', async () => {
      for (const cwd of ['/tmp', '', undefined, null]) {
        await expect(hook(preTool('Agent', { prompt: 'p', cwd })), String(cwd)).rejects.toThrow(RemoteAgentDenied);
      }
    });

    it('reads only an own isolation field (an inherited one is not the CLI input)', async () => {
      const args = Object.create({ isolation: 'remote' }) as object;
      await expect(hook(preTool('Agent', args))).resolves.toBeUndefined();
    });
  });

  it('every acknowledged and every reviewed-refused tool carries a reason, and no tool is in both', () => {
    for (const [tool, reason] of [...Object.entries(ACKNOWLEDGED_TOOLS), ...Object.entries(REVIEWED_REFUSED_TOOLS)]) {
      expect(reason.trim(), tool).not.toBe('');
    }
    expect(Object.keys(ACKNOWLEDGED_TOOLS).filter((tool) => Object.hasOwn(REVIEWED_REFUSED_TOOLS, tool))).toEqual([]);
  });

  // Literal anchors, not a re-derivation of ALLOWED_TOOL_NAMES (code review: a rebuilt expected set passes by construction).
  it('allows the anchor tools and refuses the anchor refusals, by literal name', () => {
    expect(ALLOWED_TOOL_NAMES.size).toBeGreaterThan(0);
    for (const tool of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Monitor', 'Workflow', 'Agent', 'WebFetch', 'ToolSearch', 'TodoWrite']) {
      expect(ALLOWED_TOOL_NAMES.has(tool), tool).toBe(true);
    }
    for (const tool of ['REPL', 'Artifact', 'PowerShell', 'Skill', 'SendMessage', 'SendUserFile', 'LSP', 'CronCreate', 'ExitWorktree', 'ReadMcpResourceTool', 'ListMcpResourcesTool']) {
      expect(ALLOWED_TOOL_NAMES.has(tool), tool).toBe(false);
    }
    expect([...ALLOWED_TOOL_NAMES].filter((tool) => tool.startsWith('mcp__'))).toEqual([]);
  });

  it('no refused tool is allowed (DENIED_TOOLS, denied code runners, reviewed refusals)', () => {
    const refused = [
      ...Object.keys(DENIED_TOOLS),
      ...Object.entries(CODE_EXECUTING_TOOLS).filter(([, gate]) => gate === 'denied').map(([tool]) => tool),
      ...Object.keys(REVIEWED_REFUSED_TOOLS),
    ];
    expect(refused.filter((tool) => ALLOWED_TOOL_NAMES.has(tool))).toEqual([]);
  });

  // A ratchet, not a derivation: growing the acknowledged list is a reviewed change to this line (owner, 05/11/2026).
  it('the acknowledged tools are exactly the ones ruled on 05/11/2026 (MCP resource tools refused in round 2)', () => {
    expect(Object.keys(ACKNOWLEDGED_TOOLS).sort()).toEqual([
      'Agent', 'AskUserQuestion', 'EndConversation', 'EnterPlanMode', 'ExitPlanMode',
      'RefreshMcpTools', 'ReportFindings', 'StructuredOutput',
      'SubagentHandback', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskUpdate', 'TodoWrite', 'ToolSearch',
      'WaitForMcpServers', 'WebFetch', 'WebSearch',
    ]);
  });

  it('the reasons are fixed, say why, and carry their own prefixes (telemetry attributes a deny by prefix)', () => {
    expect(UNKNOWN_TOOL_DENY_REASON).toMatch(/^unreviewed tool deny: /);
    expect(UNKNOWN_TOOL_DENY_REASON).toContain('#225');
    expect(REMOTE_AGENT_DENY_REASON).toMatch(/^remote agent deny: /);
    expect(REMOTE_AGENT_DENY_REASON).toContain('#225');
    expect(MCP_SERVER_DENY_REASON).toMatch(/^mcp server deny: /);
    expect(MCP_SERVER_DENY_REASON).toContain('sdk.allowedMcpServers');
    const prefixOf = (reason: string): string => reason.slice(0, reason.indexOf(': ') + 2);
    const prefixes = [UNKNOWN_TOOL_DENY_REASON, REMOTE_AGENT_DENY_REASON, MCP_SERVER_DENY_REASON, UNGATED_TOOL_DENY_REASON, CODE_EXECUTION_DENY_REASON, SELF_PROTECTION_REASON].map(prefixOf);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
