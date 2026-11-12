import { describe, expect, it } from 'vitest';

import { argumentDenyHook } from './argument-deny.js';
import { BACKGROUND_BASH_DENY_REASON, backgroundBashDenial, BackgroundBashDenied } from './background-bash-deny.js';
import { REMOTE_AGENT_DENY_REASON, RemoteAgentDenied } from './remote-agent-deny.js';

const preTool = (tool: string, args: unknown) => ({ event: 'pre-tool' as const, tool, args, redactions: null });

describe('backgroundBashDenial (#250): a Bash call that asks to run in the background is refused', () => {
  it.each([{ command: 'ls' }, { command: 'ls', run_in_background: false }, { command: 'ls', run_in_background: undefined }, { command: 'ls', timeout: 3000 }, {}])(
    'passes %j',
    (args) => {
      expect(backgroundBashDenial({ tool: 'Bash', args })).toBeUndefined();
    },
  );

  // Fail closed: anything but an absent field or the literal `false` is refused, not only `true`.
  it.each([true, 'true', 'false', 1, 0, null, '', [], {}])('refuses run_in_background: %j', (value) => {
    const denial = backgroundBashDenial({ tool: 'Bash', args: { command: 'ls', run_in_background: value } });
    expect(denial).toBeInstanceOf(BackgroundBashDenied);
    expect(denial?.message).toBe(BACKGROUND_BASH_DENY_REASON);
    expect(denial?.name).toBe('BackgroundBashDenied');
  });

  it('refuses a Bash call whose arguments are not an object (the field cannot be read)', () => {
    for (const args of [null, 'ls', [], 1, undefined]) {
      expect(backgroundBashDenial({ tool: 'Bash', args }), JSON.stringify(args)).toBeInstanceOf(BackgroundBashDenied);
    }
  });

  it('reads only an own field (an inherited one is not the CLI input)', () => {
    const args = Object.create({ run_in_background: true }) as object;
    expect(backgroundBashDenial({ tool: 'Bash', args })).toBeUndefined();
  });

  it('passes every other tool, whatever its arguments', () => {
    for (const tool of ['Read', 'Agent', 'Monitor', 'bash', 'Bash ', 'BashOutput', 'PowerShell', '']) {
      expect(backgroundBashDenial({ tool, args: { run_in_background: true } }), tool).toBeUndefined();
    }
  });

  it('returns a fresh error each call; the reason is fixed, says why, and carries its own prefix', () => {
    const args = { command: 'ls', run_in_background: true };
    expect(backgroundBashDenial({ tool: 'Bash', args })).not.toBe(backgroundBashDenial({ tool: 'Bash', args }));
    expect(BACKGROUND_BASH_DENY_REASON).toMatch(/^background bash deny: /);
    expect(BACKGROUND_BASH_DENY_REASON).toContain('#250');
    // Fixed text: it never echoes an argument (ADR-0031).
    const denial = backgroundBashDenial({ tool: 'Bash', args: { command: 'cat SENTINEL-ARG', run_in_background: true } });
    expect(denial?.message).not.toContain('SENTINEL-ARG');
  });
});

describe('argumentDenyHook (#250): the one built-in hook for the denies that read arguments', () => {
  const hook = argumentDenyHook();

  it('refuses a remote Agent call with the remote-agent reason', async () => {
    await expect(hook(preTool('Agent', { prompt: 'p', isolation: 'remote' }))).rejects.toThrow(RemoteAgentDenied);
    await expect(hook(preTool('Agent', { prompt: 'p', isolation: 'remote' }))).rejects.toThrow(REMOTE_AGENT_DENY_REASON);
  });

  it('refuses a background Bash call with the background-Bash reason', async () => {
    await expect(hook(preTool('Bash', { command: 'ls', run_in_background: true }))).rejects.toThrow(BackgroundBashDenied);
    await expect(hook(preTool('Bash', { command: 'ls', run_in_background: true }))).rejects.toThrow(BACKGROUND_BASH_DENY_REASON);
  });

  it('passes a local Agent call, a foreground Bash call and every other tool', async () => {
    for (const [tool, args] of [['Agent', { prompt: 'p' }], ['Bash', { command: 'ls' }], ['Read', { run_in_background: true, isolation: 'remote' }]] as const) {
      await expect(hook(preTool(tool, args)), tool).resolves.toBeUndefined();
    }
  });
});
