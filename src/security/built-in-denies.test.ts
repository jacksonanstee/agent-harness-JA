import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { builtInDenyHooks } from './built-in-denies.js';
import { REMOTE_AGENT_DENY_REASON } from './remote-agent-deny.js';
import { buildProtectedRoots, SELF_PROTECTION_REASON } from './self-protection.js';
import { MCP_SERVER_DENY_REASON, UNKNOWN_TOOL_DENY_REASON } from './unknown-tool-deny.js';

const preTool = (tool: string, args: unknown) => ({ event: 'pre-tool' as const, tool, args, redactions: null });

describe('builtInDenyHooks (#219): the shipped built-in denies, in their one order', () => {
  const home = mkdtempSync(join(tmpdir(), 'bid-home-'));
  const project = mkdtempSync(join(tmpdir(), 'bid-proj-'));
  const roots = buildProtectedRoots({ userDir: home, projectDir: project, skillsDir: null, dbPath: ':memory:' });

  // Position i must deny probe i with reason i and pass every OTHER probe, so a
  // reorder, a dropped hook or a duplicate fails here rather than only in the CLI.
  // The step order inside the tool-name deny is pinned in tool-name-deny.test.ts.
  const probes = [
    { tool: 'Write', args: { file_path: join(home, '.harness', 'settings.json') }, reason: SELF_PROTECTION_REASON },
    { tool: 'PowerShell', args: { command: 'ls' }, reason: UNKNOWN_TOOL_DENY_REASON },
    { tool: 'Agent', args: { prompt: 'p', isolation: 'remote' }, reason: REMOTE_AGENT_DENY_REASON },
  ];

  it('is exactly self-protection, the tool-name deny, the remote-agent deny, in that order (#230)', async () => {
    const hooks = builtInDenyHooks(roots);
    expect(hooks).toHaveLength(probes.length);
    for (const [i, hook] of hooks.entries()) {
      for (const [j, probe] of probes.entries()) {
        const outcome = hook(preTool(probe.tool, probe.args));
        if (i === j) await expect(outcome, `hook ${i} on probe ${j}`).rejects.toThrow(probe.reason);
        else await expect(outcome, `hook ${i} on probe ${j}`).resolves.toBeUndefined();
      }
    }
  });

  it('passes allowedMcpServers through to the tool-name deny (default none)', async () => {
    const run = async (hooks: ReturnType<typeof builtInDenyHooks>, tool: string) => {
      for (const hook of hooks) await hook(preTool(tool, {}));
    };
    await expect(run(builtInDenyHooks(roots), 'mcp__github__create_issue')).rejects.toThrow(MCP_SERVER_DENY_REASON);
    await expect(run(builtInDenyHooks(roots, { allowedMcpServers: ['github'] }), 'mcp__github__create_issue')).resolves.toBeUndefined();
  });

  it('returns fresh handlers each call (no shared state between sessions)', () => {
    const a = builtInDenyHooks(roots);
    const b = builtInDenyHooks(roots);
    expect(a.every((hook, i) => hook !== b[i])).toBe(true);
  });
});
