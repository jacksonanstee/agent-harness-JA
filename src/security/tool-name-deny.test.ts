import { describe, expect, it } from 'vitest';

import { ALLOWED_TOOL_NAMES, DENIED_TOOL_PREFIXES } from '../internal/tool-targets.js';
import { CODE_EXECUTION_DENY_REASON, CodeExecutionDenied } from './code-execution-deny.js';
import { toolNameDenyHook } from './tool-name-deny.js';
import { UNGATED_TOOL_DENY_REASON, UngatedToolDenied } from './ungated-tool-deny.js';
import { MCP_SERVER_DENY_REASON, McpServerDenied, UNKNOWN_TOOL_DENY_REASON, UnknownToolDenied } from './unknown-tool-deny.js';

const preTool = (tool: string, args: unknown) => ({ event: 'pre-tool' as const, tool, args, redactions: null });

/** Arguments that throw on any read, so a hook that touches them fails the test instead of passing by luck. */
const untouchable = (): unknown =>
  new Proxy(
    {},
    Object.fromEntries(
      ['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'].map((trap) => [
        trap,
        () => {
          throw new Error(`classifier read its arguments (${trap})`);
        },
      ]),
    ),
  );

describe('toolNameDenyHook (#230): the built-in denies that are pure functions of the tool name, as one hook', () => {
  const hook = toolNameDenyHook();

  // One probe per step, each the earliest step that refuses it. REPL and Artifact are also unlisted
  // (step 4 would refuse them) and the artifacts server is also MCP (step 3 would): first match wins.
  const steps = [
    { tool: 'REPL', error: CodeExecutionDenied, reason: CODE_EXECUTION_DENY_REASON },
    { tool: 'Artifact', error: UngatedToolDenied, reason: UNGATED_TOOL_DENY_REASON },
    { tool: 'mcp__claude-artifacts__publish_files', error: UngatedToolDenied, reason: UNGATED_TOOL_DENY_REASON },
    { tool: 'mcp__ide__executeCode', error: McpServerDenied, reason: MCP_SERVER_DENY_REASON },
    { tool: 'PowerShell', error: UnknownToolDenied, reason: UNKNOWN_TOOL_DENY_REASON },
  ];

  it.each(steps)('refuses $tool with the earliest matching step\'s reason', async ({ tool, error, reason }) => {
    await expect(hook(preTool(tool, {}))).rejects.toThrow(error);
    await expect(hook(preTool(tool, {}))).rejects.toThrow(reason);
  });

  it('never reads the arguments, for a refused tool or a passed one', async () => {
    for (const { tool, error } of steps) {
      await expect(hook(preTool(tool, untouchable())), tool).rejects.toThrow(error);
    }
    await expect(hook(preTool('Read', untouchable()))).resolves.toBeUndefined();
    await expect(hook(preTool('Agent', untouchable()))).resolves.toBeUndefined();
  });

  it('refuses whatever the arguments, and passes whatever the arguments', async () => {
    for (const args of [{}, null, 'x', [], 1, undefined, { isolation: 'remote' }, { file_path: '/x' }]) {
      for (const { tool, error } of steps) {
        await expect(hook(preTool(tool, args)), `${tool} ${JSON.stringify(args)}`).rejects.toThrow(error);
      }
      // A remote Agent call passes HERE: the argument check is remoteAgentDenyHook's.
      await expect(hook(preTool('Agent', args)), JSON.stringify(args)).resolves.toBeUndefined();
    }
  });

  it('passes every allowed tool', async () => {
    for (const tool of ALLOWED_TOOL_NAMES) {
      await expect(hook(preTool(tool, {})), tool).resolves.toBeUndefined();
    }
  });

  it('passes a tool under a listed server, and listing the artifacts server does not let it through', async () => {
    const listed = toolNameDenyHook({ allowedMcpServers: ['github', 'claude-artifacts', 'claude_artifacts'] });
    await expect(listed(preTool('mcp__github__create_issue', {}))).resolves.toBeUndefined();
    await expect(listed(preTool('mcp__ide__executeCode', {}))).rejects.toThrow(McpServerDenied);
    for (const prefix of Object.keys(DENIED_TOOL_PREFIXES)) {
      await expect(listed(preTool(`${prefix}publish_files`, {})), prefix).rejects.toThrow(UngatedToolDenied);
    }
  });

  it('copies the server list: a later change to the caller\'s array does not widen the hook', async () => {
    const servers = ['github'];
    const copied = toolNameDenyHook({ allowedMcpServers: servers });
    servers.push('ide');
    await expect(copied(preTool('mcp__ide__executeCode', {}))).rejects.toThrow(McpServerDenied);
  });

  it('throws a fresh error per call', async () => {
    const [a, b] = await Promise.all([hook(preTool('REPL', {})).catch((e: unknown) => e), hook(preTool('REPL', {})).catch((e: unknown) => e)]);
    expect(a).toBeInstanceOf(CodeExecutionDenied);
    expect(a).not.toBe(b);
  });
});
