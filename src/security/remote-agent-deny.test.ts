import { describe, expect, it } from 'vitest';

import { REMOTE_AGENT_DENY_REASON, remoteAgentDenial, remoteAgentDenyHook, RemoteAgentDenied } from './remote-agent-deny.js';

const preTool = (tool: string, args: unknown) => ({ event: 'pre-tool' as const, tool, args, redactions: null });

describe('remoteAgentDenyHook (#225; its own hook since #230): a local or worktree subagent passes; a remote one is refused (its calls reach no local hook)', () => {
  const hook = remoteAgentDenyHook();

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

  it('passes every other tool, whatever its arguments (the name-based denies are toolNameDenyHook\'s)', async () => {
    for (const tool of ['Read', 'Bash', 'REPL', 'PowerShell', 'mcp__x__y', 'agent', 'Agent ', '']) {
      await expect(hook(preTool(tool, { isolation: 'remote', cwd: '/tmp' })), tool).resolves.toBeUndefined();
    }
  });

  it('the reason is fixed, says why, and carries its own prefix', () => {
    expect(REMOTE_AGENT_DENY_REASON).toMatch(/^remote agent deny: /);
    expect(REMOTE_AGENT_DENY_REASON).toContain('#225');
  });
});

describe('remoteAgentDenial (#230): the same check as a pure function', () => {
  it('returns a fresh RemoteAgentDenied for a remote Agent call and undefined otherwise', () => {
    const a = remoteAgentDenial({ tool: 'Agent', args: { isolation: 'remote' } });
    expect(a).toBeInstanceOf(RemoteAgentDenied);
    expect(a).not.toBe(remoteAgentDenial({ tool: 'Agent', args: { isolation: 'remote' } }));
    expect(remoteAgentDenial({ tool: 'Agent', args: {} })).toBeUndefined();
    expect(remoteAgentDenial({ tool: 'Read', args: { isolation: 'remote' } })).toBeUndefined();
  });
});
