import { describe, expect, it } from 'vitest';
import { REVIEWED_REFUSED_TOOLS } from '../internal/tool-targets.js';
import { BUNDLED_AGENT_NAMES } from './agent-definitions.js';
import { checkInit, initCheckWarning, isRuledTool, INIT_CHECK_LIST_MAX } from './init-check.js';

const init = (tools: unknown, agents: unknown = ['general-purpose']): Record<string, unknown> => ({
  type: 'system',
  subtype: 'init',
  tools,
  agents,
});
const admitted = new Set([...BUNDLED_AGENT_NAMES, 'helper']);

describe('isRuledTool: every name the harness has ruled on', () => {
  it.each([
    ['Read', 'a gated table tool'],
    ['Bash', 'a gated code runner'],
    ['REPL', 'a denied code runner'],
    ['Artifact', 'DENIED_TOOLS'],
    ['ArtifactCheck', 'DENIED_TOOLS (binary-only)'],
    ['AskUserQuestion', 'an acknowledged tool'],
    ['mcp__github__create_issue', 'an MCP tool (ruled by the server list)'],
  ])('%s is ruled (%s)', (name) => {
    expect(isRuledTool(name)).toBe(true);
  });

  it('every reviewed-refused tool is ruled', () => {
    for (const name of Object.keys(REVIEWED_REFUSED_TOOLS)) expect(isRuledTool(name), name).toBe(true);
  });

  it.each(['FutureTool', 'read', 'mcp_', ''])('%j is unruled', (name) => {
    expect(isRuledTool(name)).toBe(false);
  });
});

describe('checkInit: three states', () => {
  it('clean when every tool is ruled and every agent admitted', () => {
    expect(checkInit(init(['Read', 'Bash', 'mcp__x__y'], ['general-purpose', 'helper']), admitted)).toEqual({
      state: 'clean',
      unruledTools: [],
      unknownAgents: [],
      unruledToolCount: 0,
      unknownAgentCount: 0,
    });
  });

  it('found: names each unruled tool and each unknown agent, in init order, deduplicated', () => {
    expect(checkInit(init(['Read', 'NewTool', 'Other', 'NewTool'], ['Explore', 'plugin:spy', 'plugin:spy']), admitted)).toEqual({
      state: 'found',
      unruledTools: ['NewTool', 'Other'],
      unknownAgents: ['plugin:spy'],
      unruledToolCount: 2,
      unknownAgentCount: 1,
    });
  });

  it.each([
    ['tools missing', { type: 'system', subtype: 'init', agents: [] }],
    ['tools not an array', init('Read')],
    ['agents missing', { type: 'system', subtype: 'init', tools: [] }],
    ['agents not an array', init([], { a: 1 })],
    ['not an object', null],
  ])('not-run when %s', (_label, message) => {
    expect(checkInit(message, admitted).state).toBe('not-run');
  });

  it('a non-string entry counts as unruled / unknown (it cannot be shown to be ruled)', () => {
    const result = checkInit(init(['Read', 7], [null]), admitted);
    expect(result.state).toBe('found');
    expect(result.unruledTools).toEqual(['(non-string)']);
    expect(result.unknownAgents).toEqual(['(non-string)']);
  });

  it('strips control characters and bounds each name and the list', () => {
    const tools = ['Evil\u001b[2J', 'x'.repeat(500), ...Array.from({ length: 40 }, (_, i) => `T${i}`)];
    const result = checkInit(init(tools), admitted);
    expect(result.unruledTools[0]).toBe('Evil [2J');
    expect(result.unruledTools[1]?.length).toBeLessThanOrEqual(64);
    expect(result.unruledTools).toHaveLength(INIT_CHECK_LIST_MAX);
    expect(result.unruledToolCount).toBe(42);
  });

  it('strips bidi controls from a shown name', () => {
    expect(checkInit(init(['Evil\u202Eloot']), admitted).unruledTools).toEqual(['Evil loot']);
  });

  it('a name that only cleans to a ruled name stays unruled (judged on the raw name)', () => {
    expect(checkInit(init(['Re\u0000ad']), admitted).unruledTools).toEqual(['Re ad']);
  });
});

describe('initCheckWarning', () => {
  it('is null when clean', () => {
    expect(initCheckWarning({ state: 'clean', unruledTools: [], unknownAgents: [], unruledToolCount: 0, unknownAgentCount: 0 })).toBeNull();
  });

  it('says the check did not run', () => {
    expect(initCheckWarning({ state: 'not-run', unruledTools: [], unknownAgents: [], unruledToolCount: 0, unknownAgentCount: 0 })).toMatch(/^init check did not run/);
  });

  it('names the unruled tools and the unknown agents and says both are refused', () => {
    const line = initCheckWarning({ state: 'found', unruledTools: ['NewTool'], unknownAgents: ['spy'], unruledToolCount: 1, unknownAgentCount: 1 });
    expect(line).toContain('NewTool');
    expect(line).toContain('spy');
    expect(line).toMatch(/refuse/);
    expect(line).not.toMatch(/more/);
  });

  it('says how many names a capped list left out', () => {
    const line = initCheckWarning({ state: 'found', unruledTools: ['A', 'B'], unknownAgents: [], unruledToolCount: 5, unknownAgentCount: 0 });
    expect(line).toContain('A, B and 3 more');
    expect(line).not.toContain('agents');
  });
});
