import { describe, expect, it } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import { AgentDefinitionRefused, BUNDLED_AGENT_NAMES, UNSCANNED_AGENT_DENY_REASON } from '../security/index.js';
import type { AgentScanResult, SettingSource } from '../security/index.js';
import type { TelemetryEventInput } from '../telemetry/index.js';
import { createAgentGate, defaultAgentScan } from './agent-gate.js';
import { createSession } from './session.js';
import type { QueryFn, SdkHookCallback, SdkMessage, SdkPreToolUseInput, SessionDeps } from './types.js';

const clean = (names: string[] = []): AgentScanResult => ({ admittedNames: new Set(names), refusals: [], filesScanned: names.length });
const refused: AgentScanResult = {
  admittedNames: new Set(),
  refusals: [{ source: 'project', path: 'evil.md', reason: 'isolation' }],
  filesScanned: 1,
};

describe('this machine', () => {
  // Every session test that leaves `scanAgents` unset reads the real managed
  // agents directory (it loads whatever the setting sources say). If this
  // fails, the machine has a managed agent file the gate refuses, and that is
  // why other session suites are red.
  it('has no managed agent file the gate refuses', () => {
    expect(defaultAgentScan([]).refusals).toEqual([]);
  });
});

describe('createAgentGate', () => {
  it('passes the setting sources to the scan', () => {
    const seen: (readonly SettingSource[])[] = [];
    createAgentGate(['user', 'project'], (sources) => {
      seen.push(sources);
      return clean();
    });
    expect(seen).toEqual([['user', 'project']]);
  });

  it('throws AgentDefinitionRefused carrying the refusals', () => {
    expect(() => createAgentGate([], () => refused)).toThrow(AgentDefinitionRefused);
    try {
      createAgentGate([], () => refused);
    } catch (error: unknown) {
      expect((error as AgentDefinitionRefused).refusals).toEqual(refused.refusals);
    }
  });

  it('admits the bundled names plus the scanned names', () => {
    const gate = createAgentGate([], () => clean(['helper']));
    expect(gate.admitted).toEqual(new Set([...BUNDLED_AGENT_NAMES, 'helper']));
  });

  it.each([
    ['no subagent_type (the CLI default agent)', { prompt: 'x' }, null],
    ['subagent_type undefined', { prompt: 'x', subagent_type: undefined }, null],
    ['a bundled agent', { subagent_type: 'Explore' }, null],
    ['a scanned agent', { subagent_type: 'helper' }, null],
    ['an unscanned agent', { subagent_type: 'plugin:spy' }, UNSCANNED_AGENT_DENY_REASON],
    ['teammate (dynamic name, not bundled)', { subagent_type: 'teammate' }, UNSCANNED_AGENT_DENY_REASON],
    ['a non-string name', { subagent_type: 7 }, UNSCANNED_AGENT_DENY_REASON],
    ['a case variant of a bundled name', { subagent_type: 'explore' }, UNSCANNED_AGENT_DENY_REASON],
    ['a non-object (the default-deny refuses it)', 'x', null],
    ['an inherited subagent_type is not read', Object.create({ subagent_type: 'plugin:spy' }) as object, null],
  ])('%s', (_label, args, expected) => {
    expect(createAgentGate([], () => clean(['helper'])).refusalFor(args)).toBe(expected);
  });
});

// --- through createSession ---

type Call = { tool: string; input: unknown };
const RESULT: SdkMessage = {
  type: 'result',
  subtype: 'success',
  result: 'ok',
  session_id: 'sdk-1',
  num_turns: 1,
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 1 },
};

function driver(messages: SdkMessage[], calls: Call[]): { query: QueryFn; outputs: unknown[]; queried: () => number } {
  const outputs: unknown[] = [];
  let count = 0;
  const query: QueryFn = (args) => {
    count += 1;
    return (async function* () {
      for (const message of messages) yield message;
      for (const call of calls) {
        for (const matcher of args.options?.hooks?.PreToolUse ?? []) {
          for (const callback of matcher.hooks as SdkHookCallback<SdkPreToolUseInput>[]) {
            outputs.push(
              await callback(
                { hook_event_name: 'PreToolUse', tool_name: call.tool, tool_input: call.input, tool_use_id: 'toolu_1' },
                'toolu_1',
                { signal: new AbortController().signal },
              ),
            );
          }
        }
      }
      yield RESULT;
    })();
  };
  return { query, outputs, queried: () => count };
}

function setup(messages: SdkMessage[], calls: Call[], scan: () => AgentScanResult = () => clean(['helper'])) {
  const d = driver(messages, calls);
  const fired: string[] = [];
  const hooks = createHookRuntime();
  hooks.register('pre-tool', (payload) => {
    fired.push(payload.tool);
    return Promise.resolve();
  });
  hooks.register('session-start', () => {
    fired.push('session-start');
    return Promise.resolve();
  });
  const rows: TelemetryEventInput[] = [];
  const warnings: string[] = [];
  const deps: SessionDeps = {
    query: d.query,
    hooks,
    memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
    loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
    route,
    telemetry: {
      record: (input) => {
        rows.push(input);
        return { ok: true, value: { ...input, id: 'r', ts: 0 } as never };
      },
    },
    scanAgents: scan,
  };
  const session = createSession(deps, { skillsDir: null, onWarning: (w) => warnings.push(w) });
  return { session, d, fired, rows, warnings };
}

const init = (tools: string[], agents: string[], sessionId: string | undefined = 'sdk-1'): SdkMessage =>
  ({ type: 'system', subtype: 'init', ...(sessionId === undefined ? {} : { session_id: sessionId }), tools, agents }) as SdkMessage;

describe('the session runs the agent gate (#229)', () => {
  it('a refused agent file rejects run() before the SDK is called or any hook fires', async () => {
    const { session, d, fired } = setup([], [], () => refused);
    await expect(session.run('hi')).rejects.toThrow(AgentDefinitionRefused);
    expect(d.queried()).toBe(0);
    expect(fired).toEqual([]);
  });

  it('refuses an Agent call naming an unscanned agent, before the hooks, with a telemetry row', async () => {
    const { session, d, fired, rows } = setup([init(['Agent'], ['general-purpose'])], [{ tool: 'Agent', input: { subagent_type: 'plugin:spy', prompt: 'p' } }]);
    const result = await session.run('hi');
    expect(d.outputs).toEqual([
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: UNSCANNED_AGENT_DENY_REASON } },
    ]);
    expect(fired).not.toContain('Agent');
    expect(result.denied).toEqual([{ tool: 'Agent', reason: UNSCANNED_AGENT_DENY_REASON }]);
    expect(rows).toContainEqual(
      expect.objectContaining({ type: 'hook-event', payload: expect.objectContaining({ kind: 'denied-by-hook', tool: 'Agent' }) }),
    );
  });

  it('an Agent call naming a scanned or bundled agent reaches the hooks', async () => {
    const { session, fired } = setup([init(['Agent'], ['helper'])], [
      { tool: 'Agent', input: { subagent_type: 'helper' } },
      { tool: 'Agent', input: { subagent_type: 'Plan' } },
    ]);
    const result = await session.run('hi');
    expect(fired.filter((t) => t === 'Agent')).toHaveLength(2);
    expect(result.denied).toEqual([]);
  });

  it('a non-Agent tool is not touched by the gate', async () => {
    const { session, fired } = setup([init(['Read'], [])], [{ tool: 'Read', input: { subagent_type: 'plugin:spy' } }]);
    await session.run('hi');
    expect(fired).toContain('Read');
  });

  it('clean init: no init warning, initCheck clean', async () => {
    const { session, warnings } = setup([init(['Read', 'Agent'], ['general-purpose', 'helper'])], []);
    const result = await session.run('hi');
    expect(result.initCheck).toEqual({ state: 'clean', unruledTools: [], unknownAgents: [], unruledToolCount: 0, unknownAgentCount: 0 });
    expect(warnings.filter((w) => w.includes('init check'))).toEqual([]);
  });

  it('found: warns once, naming the unruled tool and the unknown agent', async () => {
    const { session, warnings } = setup([init(['Read', 'FutureTool'], ['plugin:spy']), init(['Other'], ['x'])], []);
    const result = await session.run('hi');
    expect(result.initCheck).toEqual({
      state: 'found',
      unruledTools: ['FutureTool'],
      unknownAgents: ['plugin:spy'],
      unruledToolCount: 1,
      unknownAgentCount: 1,
    });
    const lines = warnings.filter((w) => w.includes('init check'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('FutureTool');
    expect(lines[0]).toContain('plugin:spy');
  });

  it('an init message with no session_id is still checked', async () => {
    const { session } = setup([init(['FutureTool'], [], undefined)], []);
    expect((await session.run('hi')).initCheck.state).toBe('found');
  });

  it('no init message: not-run, and says so', async () => {
    const { session, warnings } = setup([], []);
    const result = await session.run('hi');
    expect(result.initCheck.state).toBe('not-run');
    expect(warnings.some((w) => w.startsWith('init check did not run'))).toBe(true);
  });

  it('an init message without lists: not-run', async () => {
    const { session } = setup([{ type: 'system', subtype: 'init', session_id: 'sdk-1' }], []);
    expect((await session.run('hi')).initCheck.state).toBe('not-run');
  });

  it('the scan sees the config setting sources', async () => {
    const seen: (readonly SettingSource[])[] = [];
    const d = driver([], []);
    const session = createSession(
      {
        query: d.query,
        hooks: createHookRuntime(),
        memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
        loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
        route,
        scanAgents: (sources) => {
          seen.push(sources);
          return clean();
        },
      },
      { skillsDir: null, settingSources: ['project'] },
    );
    await session.run('hi');
    expect(seen).toEqual([['project']]);
  });
});
