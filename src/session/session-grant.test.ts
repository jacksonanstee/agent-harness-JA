import { describe, expect, it } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import type { HookEventRecord, HookRuntime } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import {
  createPermissionEvaluator,
  createSandbox,
  mergeLayers,
  mergeSandboxLayers,
  parsePermissionSettings,
  parseSandboxSettings,
  permissionHook,
  sandboxHook,
} from '../security/index.js';
import type { GrantPolicy, PermissionEvaluator } from '../security/index.js';
import { createSession, HARNESS_HOOK_ALLOW_REASON } from './session.js';
import type { QueryFn, SdkHookCallback, SdkMessage, SdkPreToolUseInput, SessionDeps, SessionResult } from './types.js';

// Issue #140, ADR-0040 D3; spec 6a.3. The grant canary: a USER-layer rule allow
// reaches the SDK as an explicit `allow` carrying ONE fixed harness literal,
// and every other path stays exactly as before. INIT/RESULT/makeDeps are
// trimmed copies of session-isolation.test.ts.

const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sdk-123' };
const RESULT: SdkMessage = {
  type: 'result',
  subtype: 'success',
  result: 'hello from claude',
  session_id: 'sdk-123',
  num_turns: 1,
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5 },
};

type Call = { tool: string; input: unknown };

/** A fake query that awaits every PreToolUse callback per call, keeps the output by tool, then replays INIT/RESULT. */
function preToolDriver(calls: Call[]): { query: QueryFn; outputs: Map<string, unknown> } {
  const outputs = new Map<string, unknown>();
  const query: QueryFn = (args) =>
    (async function* () {
      for (const call of calls) {
        for (const matcher of args.options?.hooks?.PreToolUse ?? []) {
          for (const callback of matcher.hooks as SdkHookCallback<SdkPreToolUseInput>[]) {
            const out = await callback(
              { hook_event_name: 'PreToolUse', tool_name: call.tool, tool_input: call.input, tool_use_id: 'toolu_1' },
              'toolu_1',
              { signal: new AbortController().signal },
            );
            outputs.set(call.tool, out);
          }
        }
      }
      yield INIT;
      yield RESULT;
    })();
  return { query, outputs };
}

function makeDeps(query: QueryFn, hooks: HookRuntime): SessionDeps {
  return {
    query,
    hooks,
    memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
    loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
    route,
  };
}

const allowOut = {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: HARNESS_HOOK_ALLOW_REASON },
};
const evaluatorFor = (user: unknown, project: unknown): PermissionEvaluator =>
  createPermissionEvaluator(mergeLayers(parsePermissionSettings(user), parsePermissionSettings(project)));
const GIT = { tool: 'Bash', input: { command: 'git status' } };
// Bash is grantable here (a sandbox.commands list is configured in the real flow, D-8); Task 3 pins the policy itself.
const OPEN_POLICY: GrantPolicy = { ungrantableTools: new Set() };

async function drive(
  calls: Call[],
  evaluator: PermissionEvaluator | null,
  extra?: (hooks: HookRuntime) => void,
): Promise<{ outputs: Map<string, unknown>; records: HookEventRecord[]; result: SessionResult }> {
  const records: HookEventRecord[] = [];
  const hooks = createHookRuntime({ onEvent: (record) => records.push(record) });
  if (evaluator !== null) hooks.register('pre-tool', permissionHook(evaluator, undefined, OPEN_POLICY));
  extra?.(hooks);
  const { query, outputs } = preToolDriver(calls);
  const result = await createSession(makeDeps(query, hooks), { skillsDir: null }).run('p');
  return { outputs, records, result };
}

describe('the grant canary (#140, ADR-0040 D3; spec 6a.3)', () => {
  it('(a) no settings: the PreToolUse callback returns {} (the CLI floor decides)', async () => {
    const { outputs, records } = await drive([GIT], evaluatorFor({}, {}));
    expect(outputs.get('Bash')).toEqual({});
    expect(records.map((r) => r.kind)).not.toContain('granted-by-rule');
  });

  it('(b) a user-layer rule allow returns allow with HARNESS_HOOK_ALLOW_REASON exactly, and one granted-by-rule record with the rule identity', async () => {
    const { outputs, records } = await drive(
      [GIT],
      evaluatorFor({ permissions: { rules: [{ tool: 'Bash', match: 'git *', decision: 'allow' }] } }, {}),
    );
    expect(outputs.get('Bash')).toEqual(allowOut);
    expect(records.filter((r) => r.kind === 'granted-by-rule')).toEqual([
      { kind: 'granted-by-rule', event: 'pre-tool', handlerIndex: 0, tool: 'Bash', reason: 'permission: allow Bash [rule 0, user]' },
    ]);
  });

  it('(c) the same rule in the PROJECT document only returns {} and no record (D-7)', async () => {
    const { outputs, records } = await drive(
      [GIT],
      evaluatorFor({}, { permissions: { rules: [{ tool: 'Bash', match: 'git *', decision: 'allow' }] } }),
    );
    expect(outputs.get('Bash')).toEqual({});
    expect(records.map((r) => r.kind)).not.toContain('granted-by-rule');
  });

  it('(d) a user deny plus a project allow returns deny (sticky deny)', async () => {
    const { outputs, result } = await drive(
      [GIT],
      evaluatorFor({ permissions: { rules: [{ tool: 'Bash', decision: 'deny' }] } }, { permissions: { rules: [{ tool: 'Bash', decision: 'allow' }] } }),
    );
    expect(outputs.get('Bash')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'permission: deny Bash [rule 0, user]' },
    });
    expect(result.denied).toEqual([{ tool: 'Bash', reason: 'permission: deny Bash [rule 0, user]' }]);
  });

  it('(e) ask with no prompter returns deny with the existing reason', async () => {
    const { outputs } = await drive([GIT], evaluatorFor({ permissions: { rules: [{ tool: 'Bash', decision: 'ask' }] } }, {}));
    expect(outputs.get('Bash')).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringMatching(/^permission: ask Bash \[rule 0, user\] .* 'ask' with no prompter configured$/),
      },
    });
  });

  it('(f) a custom handler returning true returns {}', async () => {
    const { outputs, records } = await drive([GIT], null, (hooks) => hooks.register('pre-tool', () => true as never));
    expect(outputs.get('Bash')).toEqual({});
    // Three fires: session-start, pre-tool, stop (preflight ruling 4).
    expect(records.filter((r) => r.kind === 'hook-fired').map((r) => r.event).sort()).toEqual(['pre-tool', 'session-start', 'stop']);
    expect(records.map((r) => r.kind)).not.toContain('granted-by-rule');
  });

  it('Review Focus 3: a user allow followed by the sandbox deny at the shipped order is a deny with the sandbox reason and no grant record', async () => {
    const sandbox = createSandbox(
      mergeSandboxLayers(parseSandboxSettings({ sandbox: { commands: { allow: ['ls'] } } }), parseSandboxSettings({})),
    );
    const { outputs, records } = await drive(
      [GIT],
      evaluatorFor({ permissions: { rules: [{ tool: 'Bash', match: 'git *', decision: 'allow' }] } }, {}),
      (hooks) => hooks.register('pre-tool', sandboxHook(sandbox)),
    );
    expect(outputs.get('Bash')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(records.map((r) => r.kind)).not.toContain('granted-by-rule');
  });

  it('the SDK-facing allow reason is the fixed literal, never the rule identity (spec 2c)', async () => {
    const { outputs } = await drive(
      [GIT],
      evaluatorFor({ permissions: { rules: [{ tool: 'Bash', match: 'git *', decision: 'allow' }] } }, {}),
    );
    const reason = (outputs.get('Bash') as typeof allowOut).hookSpecificOutput.permissionDecisionReason;
    // Deliberate pin: the literal is re-typed here so renaming the constant's value fails this test.
    expect(reason).toBe('allowed by a harness pre-tool hook grant (ADR-0014)');
    expect(reason).not.toContain('rule 0');
  });

  it('a rejecting fire() can never grant: the output is the generic deny', async () => {
    const records: HookEventRecord[] = [];
    const hooks = createHookRuntime({ onEvent: (record) => records.push(record) });
    const real = hooks.fire.bind(hooks);
    const rejecting: HookRuntime = {
      ...hooks,
      fire: ((event: string, payload: unknown) =>
        event === 'pre-tool' ? Promise.reject(new Error('boom')) : real(event as never, payload as never)) as HookRuntime['fire'],
    };
    const { query, outputs } = preToolDriver([GIT]);
    await createSession(makeDeps(query, rejecting), { skillsDir: null }).run('p');
    expect(outputs.get('Bash')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'pre-tool hook failure' },
    });
  });
});
