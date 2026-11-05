import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { builtInDenyHooks } from './built-in-denies.js';
import { CODE_EXECUTION_DENY_REASON } from './code-execution-deny.js';
import { buildProtectedRoots, SELF_PROTECTION_REASON } from './self-protection.js';
import { UNGATED_TOOL_DENY_REASON } from './ungated-tool-deny.js';
import { UNKNOWN_TOOL_DENY_REASON } from './unknown-tool-deny.js';

const preTool = (tool: string, args: unknown) => ({ event: 'pre-tool' as const, tool, args, redactions: null });

describe('builtInDenyHooks (#219): the shipped built-in denies, in their one order', () => {
  const home = mkdtempSync(join(tmpdir(), 'bid-home-'));
  const project = mkdtempSync(join(tmpdir(), 'bid-proj-'));
  const roots = buildProtectedRoots({ userDir: home, projectDir: project, skillsDir: null, dbPath: ':memory:' });

  // Position i must deny probe i with reason i and pass every LATER probe, so a
  // reorder, a dropped hook or a duplicate fails here rather than only in the CLI.
  // An earlier probe may also be refused by a later hook (#225: the unreviewed-tool
  // deny refuses REPL and Artifact too, as unlisted); the earlier hook runs first,
  // so its reason is the one the model reads.
  const probes = [
    { tool: 'Write', args: { file_path: join(home, '.harness', 'settings.json') }, reason: SELF_PROTECTION_REASON, unlisted: false },
    { tool: 'REPL', args: { code: '1' }, reason: CODE_EXECUTION_DENY_REASON, unlisted: true },
    { tool: 'Artifact', args: { action: 'read_asset', url: 'u' }, reason: UNGATED_TOOL_DENY_REASON, unlisted: true },
    { tool: 'PowerShell', args: { command: 'ls' }, reason: UNKNOWN_TOOL_DENY_REASON, unlisted: true },
  ];

  it('is exactly self-protection, code-execution deny, ungated-tool deny, unreviewed-tool deny, in that order', async () => {
    const hooks = builtInDenyHooks(roots);
    expect(hooks).toHaveLength(probes.length);
    for (const [i, hook] of hooks.entries()) {
      for (const [j, probe] of probes.entries()) {
        const outcome = hook(preTool(probe.tool, probe.args));
        if (i === j) await expect(outcome, `hook ${i} on probe ${j}`).rejects.toThrow(probe.reason);
        // Only the last (unreviewed-tool) deny also refuses an earlier probe: exactly the unlisted ones, with its own reason.
        else if (i === hooks.length - 1 && probe.unlisted) await expect(outcome, `hook ${i} on probe ${j}`).rejects.toThrow(UNKNOWN_TOOL_DENY_REASON);
        else await expect(outcome, `hook ${i} on probe ${j}`).resolves.toBeUndefined();
      }
    }
  });

  it('returns fresh handlers each call (no shared state between sessions)', () => {
    const a = builtInDenyHooks(roots);
    const b = builtInDenyHooks(roots);
    expect(a.every((hook, i) => hook !== b[i])).toBe(true);
  });
});
