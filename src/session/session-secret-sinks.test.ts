import { describe, expect, it } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import type { HookRuntime } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import type { MemoryStore } from '../memory/index.js';
import { route } from '../router/index.js';
import type { RedactResult, ScanResult } from '../security/index.js';
import { boundHookEventReason, HOOK_EVENT_REASON_MAX } from '../telemetry/index.js';
import { judgeScanFailedWarning } from './judged-scan-lines.js';
import { createSession } from './session.js';
import type { QueryFn, SdkHookCallback, SdkMessage, SessionDeps } from './types.js';

// Issue #234: three more sinks of the #113 class, each rendering text whose
// input is secret-bearing. Fakes are trimmed copies of session-redaction-gaps.

const SECRET = 'AKIA' + 'IOSFODNN7EXAMPLE';
const MARKER = '[REDACTED:aws-access-key-id]';
const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sdk-1', tools: [], agents: [] } as SdkMessage;
const RESULT: SdkMessage = { type: 'result', subtype: 'success', result: 'ok', session_id: 'sdk-1', num_turns: 1, total_cost_usd: 0 } as SdkMessage;
const WITHHELD = 'its message is withheld because it can carry the input';

type Call = { tool: string; input: unknown; output: unknown; failError?: string };

const modelReasons: string[] = [];

function fakeQuery(calls: Call[]): QueryFn {
  return (args) =>
    (async function* () {
      const signal = new AbortController().signal;
      for (const call of calls) {
        let denied = false;
        for (const matcher of args.options?.hooks?.PreToolUse ?? []) {
          for (const cb of matcher.hooks as SdkHookCallback[]) {
            const out = await cb({ hook_event_name: 'PreToolUse', tool_name: call.tool, tool_input: call.input, tool_use_id: 'toolu_1' }, 'toolu_1', { signal });
            if ('hookSpecificOutput' in out && out.hookSpecificOutput?.permissionDecision === 'deny') {
              denied = true;
              modelReasons.push(String(out.hookSpecificOutput.permissionDecisionReason));
            }
          }
        }
        if (denied) continue;
        if (call.failError !== undefined) {
          const failure = (args.options?.hooks as Record<string, { hooks: unknown[] }[] | undefined> | undefined)?.['PostToolUseFailure'] ?? [];
          for (const matcher of failure) {
            for (const cb of matcher.hooks as SdkHookCallback[]) {
              await cb(
                { hook_event_name: 'PostToolUseFailure', tool_name: call.tool, tool_input: call.input, tool_use_id: 'toolu_1', error: call.failError } as unknown as Parameters<SdkHookCallback>[0],
                'toolu_1',
                { signal },
              );
            }
          }
          continue;
        }
        for (const matcher of args.options?.hooks?.PostToolUse ?? []) {
          for (const cb of matcher.hooks as SdkHookCallback[]) {
            await cb(
              { hook_event_name: 'PostToolUse', tool_name: call.tool, tool_input: call.input, tool_response: call.output, tool_use_id: 'toolu_1' } as Parameters<SdkHookCallback>[0],
              'toolu_1',
              { signal },
            );
          }
        }
      }
      yield INIT;
      yield RESULT;
    })();
}

interface Setup {
  calls: Call[];
  skills?: { name: string; description: string; version: string; body: string; path: string }[];
  hooks?: HookRuntime;
  redactor?: (text: string) => RedactResult;
  scanInjection?: (text: string) => ScanResult;
  memory?: MemoryStore;
}

async function run(setup: Setup) {
  const warnings: string[] = [];
  const deps: SessionDeps = {
    query: fakeQuery(setup.calls),
    hooks: setup.hooks ?? createHookRuntime(),
    memory: setup.memory ?? createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
    loadSkills: () => ({ skills: setup.skills ?? [], errors: [], root: '/skills' }),
    route,
    scanAgents: () => ({ admittedNames: new Set(), refusals: [], filesScanned: 0 }),
    ...(setup.redactor === undefined ? {} : { redactSecrets: (text: string) => (setup.redactor as (t: string) => RedactResult)(text) }),
    ...(setup.scanInjection === undefined ? {} : { scanInjection: setup.scanInjection }),
  };
  const result = await createSession(deps, { skillsDir: setup.skills === undefined ? null : '/skills', onWarning: (w) => warnings.push(w) }).run('hi');
  return { result, warnings };
}

const replacing = (text: string): RedactResult => ({ redacted: text.replaceAll(SECRET, MARKER), findings: [] });
const READ_SECRET: Call = { tool: 'Read', input: { file_path: '/x' }, output: `key ${SECRET}` };

describe('#234 (1): a thrown injection scanner never puts its message on the warning channel', () => {
  it('the session scan path names only the error class', async () => {
    const { warnings } = await run({
      calls: [READ_SECRET],
      scanInjection: (text) => {
        throw new TypeError(`bad input: ${text}`);
      },
    });
    const lines = warnings.filter((w) => w.startsWith('injection scan failed'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toBe(`injection scan failed: the scanner threw TypeError; ${WITHHELD} (#234)`);
    }
  });

  // #234 review: a scanner that RETURNS (no throw) can echo its input into rule ids.
  const echoingIds = (text: string): ScanResult =>
    text.includes(SECRET)
      ? { verdict: 'block', rule_ids: [`saw ${text}`], excerpts: [], suspicious: false }
      : { verdict: 'pass', rule_ids: [], excerpts: [], suspicious: false };

  it('a rule id that is not an identifier is replaced at the source, so no warning can carry it', async () => {
    // No redactor configured: the replacement alone must keep the secret out.
    const { warnings } = await run({ calls: [READ_SECRET], scanInjection: echoingIds });
    const lines = warnings.filter((w) => w.startsWith('injection scan block on Read output'));
    expect(lines).toEqual(['injection scan block on Read output (rules: non-conforming-rule-id)']);
  });

  it('on the skill channel too, and the blocked skill is still DROPPED (the warning runs at load time)', async () => {
    const skill = { name: 'helper', description: 'benign', version: '1.0.0', body: `do this ${SECRET}`, path: '/skills/helper.md' };
    const { result, warnings } = await run({ calls: [], skills: [skill], scanInjection: echoingIds });
    expect(result.droppedSkills).toHaveLength(1);
    expect(result.droppedSkills[0]?.ruleIds).toEqual(['non-conforming-rule-id']);
    const lines = warnings.filter((w) => w.startsWith('injection scan block'));
    expect(lines.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).not.toContain(SECRET);
    expect(warnings.some((w) => w.startsWith('injection scan failed'))).toBe(false);
  });

  it('the judged-scanner rejection line names only the error class', () => {
    expect(judgeScanFailedWarning(new Error(`bad input: ${SECRET}`))).toBe(`injection scan failed: the scanner threw Error; ${WITHHELD} (#234)`);
    expect(judgeScanFailedWarning(`bad input: ${SECRET}`)).toBe(`injection scan failed: the scanner threw a non-standard error; ${WITHHELD} (#234)`);
  });
});

describe('#234 (2): a post-tool hook reason is redacted before it is warned', () => {
  const echoingHook = (): HookRuntime => {
    const hooks = createHookRuntime();
    hooks.register('post-tool', (payload) => Promise.reject(new Error(`saw ${String(payload.result)}`)));
    return hooks;
  };

  it('a hook that echoes the raw result into its error: the warning carries the marker, not the secret', async () => {
    const { warnings } = await run({ calls: [READ_SECRET], hooks: echoingHook(), redactor: replacing });
    const lines = warnings.filter((w) => w.startsWith('post-tool hook error'));
    expect(lines).toEqual([`post-tool hook error: saw key ${MARKER}`]);
  });

  it("the failed-call path too: a hook echoing the call's error text is redacted before the warning", async () => {
    const { warnings } = await run({
      calls: [{ tool: 'Read', input: { file_path: '/x' }, output: '', failError: `ENOENT ${SECRET}` }],
      hooks: echoingHook(),
      redactor: replacing,
    });
    const lines = warnings.filter((w) => w.startsWith('post-tool hook error'));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(MARKER);
    expect(lines[0]).not.toContain(SECRET);
  });

  it('a throwing redactor: the sentinel, never the raw reason', async () => {
    const { warnings } = await run({
      calls: [READ_SECRET],
      hooks: echoingHook(),
      redactor: () => {
        throw new Error('boom');
      },
    });
    expect(warnings.filter((w) => w.startsWith('post-tool hook error'))).toEqual(['post-tool hook error: [REDACTION FAILED]']);
    expect(warnings.join('\n')).not.toContain(SECRET);
  });

  it('a very long reason is bounded', async () => {
    const hooks = createHookRuntime();
    hooks.register('post-tool', () => Promise.reject(new Error('x'.repeat(10_000))));
    const { warnings } = await run({ calls: [READ_SECRET], hooks, redactor: replacing });
    expect(warnings.find((w) => w.startsWith('post-tool hook error'))).toBe(`post-tool hook error: ${boundHookEventReason('x'.repeat(10_000))}`);
    expect(boundHookEventReason('x'.repeat(10_000)).length).toBeLessThanOrEqual(HOOK_EVENT_REASON_MAX);
  });
});

describe('#234 review: a rejected post-tool fire() is redacted before it is warned', () => {
  // A HookRuntime is injectable; one whose fire() rejects with the raw result
  // (the payload it was handed) must not put it on the warning channel.
  const rejectingFire = (): HookRuntime => {
    const real = createHookRuntime();
    return {
      register: real.register,
      fire: ((event, payload) =>
        event === 'post-tool'
          ? Promise.reject(new Error(`fire saw ${String((payload as { result?: unknown }).result)}`))
          : real.fire(event, payload)) as HookRuntime['fire'],
    };
  };

  it.each([
    ['the success path', READ_SECRET],
    ['the failed-call path', { tool: 'Read', input: { file_path: '/x' }, output: '', failError: `ENOENT ${SECRET}` }],
  ])('%s', async (_label, call) => {
    const { warnings } = await run({ calls: [call as Call], hooks: rejectingFire(), redactor: replacing });
    const lines = warnings.filter((w) => w.startsWith('post-tool fire failed'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(MARKER);
    expect(lines[0]).not.toContain(SECRET);
  });
});

describe('#234 (3): SessionResult.denied[].reason is redacted at the boundary', () => {
  const echoingDeny = (): HookRuntime => {
    const hooks = createHookRuntime();
    hooks.register('pre-tool', (payload) => Promise.reject(new Error(`blocked ${JSON.stringify(payload.args)}`)));
    return hooks;
  };
  const CALL: Call = { tool: 'Bash', input: { command: `echo ${SECRET}` }, output: '' };

  it('a deny reason that echoes the tool input reaches a library caller redacted, and memory shares it', async () => {
    const memory = createMemoryStore(openMemoryDatabase({ path: ':memory:' }));
    const { result } = await run({ calls: [CALL], hooks: echoingDeny(), redactor: replacing, memory });
    expect(result.denied).toHaveLength(1);
    expect(result.denied[0]?.reason).toContain(MARKER);
    expect(result.denied[0]?.reason).not.toContain(SECRET);
    const stored = JSON.parse(memory.read({})[0]?.content ?? '{}') as { denied?: { reason: string }[] };
    expect(stored.denied?.[0]?.reason).toBe(result.denied[0]?.reason);
  });

  it('a throwing redactor fails the reason closed, with a class-only warning', async () => {
    const { result, warnings } = await run({
      calls: [CALL],
      hooks: echoingDeny(),
      redactor: (text) => {
        throw new Error(`bad input: ${text}`);
      },
    });
    expect(result.denied[0]?.reason).toBe('[REDACTION FAILED]');
    expect(warnings).toContain(`secret redaction failed for a deny reason: the redactor threw Error; ${WITHHELD} (#113)`);
    expect(warnings.join('\n')).not.toContain(SECRET);
  });

  it('the deny reason sent to the model is unchanged (the model wrote the input it echoes)', async () => {
    modelReasons.length = 0;
    const { result } = await run({ calls: [CALL], hooks: echoingDeny(), redactor: replacing });
    expect(modelReasons).toHaveLength(1);
    expect(modelReasons[0]).toContain(SECRET);
    expect(result.denied[0]?.reason).not.toContain(SECRET);
  });

  it('with no redactor configured the reason is returned as is', async () => {
    const { result } = await run({ calls: [CALL], hooks: echoingDeny() });
    expect(result.denied[0]?.reason).toContain(SECRET);
  });
});
