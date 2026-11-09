import { describe, expect, it } from 'vitest';

import { CODE_EXECUTING_TOOLS } from '../internal/tool-targets.js';
import { grantPolicyFor } from './grant-policy.js';

// Issue #218 (ADR-0040 D-8): the grant rule as one pure, exported function, so
// the composition root, the smoke script and a library caller share one copy.

const members = (filter: (gate: string) => boolean): string[] =>
  Object.entries(CODE_EXECUTING_TOOLS)
    .filter(([, gate]) => filter(gate))
    .map(([name]) => name)
    .sort();

const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();

describe('grantPolicyFor (#218)', () => {
  it.each([
    ['no sandbox', {}],
    ['a sandbox with no commands key', { paths: { allow: ['/repo'] } }],
    ['an empty commands list', { commands: { allow: [] } }],
  ])('%s: every code-executing tool is ungrantable', (_label, sandbox) => {
    expect(sorted(grantPolicyFor(sandbox).ungrantableTools)).toEqual(members(() => true));
  });

  it('a non-empty user commands list frees only the commands-gated tools', () => {
    const policy = grantPolicyFor({ commands: { allow: ['git'] } });
    expect(sorted(policy.ungrantableTools)).toEqual(members((gate) => gate !== 'commands'));
    // Today: Bash and Monitor become grantable; Workflow and REPL never do.
    expect(policy.ungrantableTools.has('Bash')).toBe(false);
    expect(policy.ungrantableTools.has('Monitor')).toBe(false);
    expect(policy.ungrantableTools.has('Workflow')).toBe(true);
    expect(policy.ungrantableTools.has('REPL')).toBe(true);
  });

  it('returns a fresh set per call, so a caller that mutates one cannot widen the next', () => {
    const a = grantPolicyFor({});
    (a.ungrantableTools as Set<string>).clear();
    expect(grantPolicyFor({}).ungrantableTools.size).toBe(Object.keys(CODE_EXECUTING_TOOLS).length);
  });
});
