import { describe, expect, it } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import type { RedactResult } from '../security/index.js';
import { createSession } from './session.js';
import type { QueryFn, SdkHookCallback, SdkMessage, SessionDeps } from './types.js';

// Issues #112 (resultText returned raw to library callers) and #113 (a thrown
// redactor's message, whose input is secret-bearing, echoed on the warning
// channel). Fakes are trimmed copies of session.test.ts's.

const SECRET = 'AKIA' + 'IOSFODNN7EXAMPLE';
const MARKER = '[REDACTED:aws-access-key-id]';
const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sdk-1', tools: [], agents: [] } as SdkMessage;
const result = (text: string | undefined): SdkMessage =>
  ({ type: 'result', subtype: 'success', ...(text === undefined ? {} : { result: text }), session_id: 'sdk-1', num_turns: 1, total_cost_usd: 0 }) as SdkMessage;
const assistant = (text: string): SdkMessage => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

type Call = { tool: string; input: unknown; output?: unknown; failError?: string };

function fakeQuery(messages: SdkMessage[], calls: Call[] = []): QueryFn {
  return (args) =>
    (async function* () {
      const signal = new AbortController().signal;
      for (const call of calls) {
        const hooks = args.options?.hooks as Record<string, { hooks: unknown[] }[] | undefined> | undefined;
        for (const matcher of hooks?.['PreToolUse'] ?? []) {
          for (const cb of matcher.hooks as SdkHookCallback[]) {
            await cb({ hook_event_name: 'PreToolUse', tool_name: call.tool, tool_input: call.input, tool_use_id: 'toolu_1' }, 'toolu_1', { signal });
          }
        }
        const event = call.failError === undefined ? 'PostToolUse' : 'PostToolUseFailure';
        for (const matcher of hooks?.[event] ?? []) {
          for (const cb of matcher.hooks as SdkHookCallback[]) {
            await cb(
              (call.failError === undefined
                ? { hook_event_name: event, tool_name: call.tool, tool_input: call.input, tool_response: call.output, tool_use_id: 'toolu_1' }
                : { hook_event_name: event, tool_name: call.tool, tool_input: call.input, tool_use_id: 'toolu_1', error: call.failError }) as unknown as Parameters<SdkHookCallback>[0],
              'toolu_1',
              { signal },
            );
          }
        }
      }
      for (const message of messages) yield message;
    })();
}

function deps(query: QueryFn, redactSecrets?: (text: string) => RedactResult): SessionDeps {
  return {
    query,
    hooks: createHookRuntime(),
    memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
    loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
    route,
    scanAgents: () => ({ admittedNames: new Set(), refusals: [], filesScanned: 0 }),
    ...(redactSecrets === undefined ? {} : { redactSecrets }),
  };
}

const replacing = (text: string): RedactResult => ({ redacted: text.replaceAll(SECRET, MARKER), findings: [] });

describe('#112: SessionResult.resultText is redacted at the session boundary', () => {
  const run = async (text: string | undefined, redactSecrets?: (t: string) => RedactResult) =>
    createSession(deps(fakeQuery([INIT, result(text)]), redactSecrets), { skillsDir: null }).run('hi');

  it('a secret in the final result never reaches a library caller', async () => {
    const out = await run(`the key is ${SECRET}`, replacing);
    expect(out.resultText).toBe(`the key is ${MARKER}`);
  });

  it('fails closed to the sentinel when the redactor throws', async () => {
    const out = await run(`the key is ${SECRET}`, () => {
      throw new Error('boom');
    });
    expect(out.resultText).toBe('[REDACTION FAILED]');
  });

  it('fails closed to the sentinel when the redactor returns a non-string', async () => {
    const out = await run(`the key is ${SECRET}`, () => ({ redacted: undefined as unknown as string, findings: [] }));
    expect(out.resultText).toBe('[REDACTION FAILED]');
  });

  it('a null result stays null, and a redacted marker is not redacted again into something else', async () => {
    expect((await run(undefined, replacing)).resultText).toBeNull();
    expect((await run(`already ${MARKER}`, replacing)).resultText).toBe(`already ${MARKER}`);
  });

  it('with no redactor configured the text is returned as is (nothing to redact with)', async () => {
    expect((await run(`the key is ${SECRET}`)).resultText).toBe(`the key is ${SECRET}`);
  });
});

describe('#113: a thrown redactor never puts its message on the warning channel', () => {
  // A hostile or buggy redactor that echoes its input into the error it throws.
  const echoing = (text: string): RedactResult => {
    throw new Error(`bad input: ${text}`);
  };

  const warningsFor = async (messages: SdkMessage[], calls: Call[], redactSecrets: (t: string) => RedactResult = echoing) => {
    const warnings: string[] = [];
    await createSession(deps(fakeQuery(messages, calls), redactSecrets), {
      skillsDir: null,
      onText: () => undefined,
      onWarning: (w) => warnings.push(w),
    }).run('hi');
    return warnings.filter((w) => w.startsWith('secret redaction failed'));
  };

  const expectWithheld = (lines: string[], kind: string): void => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain('bad input');
      expect(line).toContain(`the redactor threw ${kind}`);
    }
  };

  it('tool output (the post-tool path)', async () => {
    expectWithheld(await warningsFor([INIT, result('ok')], [{ tool: 'Read', input: { file_path: '/x' }, output: `key ${SECRET}` }]), 'Error');
  });

  it('assistant text (the onText path)', async () => {
    expectWithheld(await warningsFor([INIT, assistant(`key ${SECRET}`), result('ok')], []), 'Error');
  });

  it("a failed call's error text (the failure-hook path)", async () => {
    expectWithheld(await warningsFor([INIT, result('ok')], [{ tool: 'Read', input: { file_path: '/x' }, failError: `ENOENT ${SECRET}` }]), 'Error');
  });

  it('names a standard error class, and nothing a custom error chooses (its name can carry the input too)', async () => {
    const typeError = await warningsFor([INIT, assistant('x'), result('ok')], [], () => {
      throw new TypeError(`bad input: ${SECRET}`);
    });
    expectWithheld(typeError, 'TypeError');

    class Hostile extends Error {
      constructor(input: string) {
        super(`bad input: ${input}`);
        this.name = input;
      }
    }
    const hostile = await warningsFor([INIT, assistant(`key ${SECRET}`), result('ok')], [], (text) => {
      throw new Hostile(text);
    });
    expectWithheld(hostile, 'a non-standard error');

    const thrownString = await warningsFor([INIT, assistant(`key ${SECRET}`), result('ok')], [], (text) => {
      // The point: a redactor can throw anything, not only an Error.
      throw `bad input: ${text}`;
    });
    expectWithheld(thrownString, 'a non-standard error');
  });

  it('a subclass that only calls itself TypeError is non-standard (matched by prototype, not by name)', async () => {
    class Impostor extends Error {
      constructor() {
        super('x');
        this.name = 'TypeError';
      }
    }
    expectWithheld(
      await warningsFor([INIT, assistant('x'), result('ok')], [], () => {
        throw new Impostor();
      }),
      'a non-standard error',
    );
  });

  it('a revoked Proxy or a throwing prototype trap cannot escape the catch blocks: the run completes, nothing leaks', async () => {
    const revoked = (): never => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      throw proxy;
    };
    const trapping = (text: string): never => {
      throw new Proxy({}, {
        getPrototypeOf: () => {
          throw new Error(`bad input: ${text}`);
        },
      });
    };
    for (const redactor of [revoked, trapping]) {
      const lines = await warningsFor(
        [INIT, assistant(`key ${SECRET}`), result(`key ${SECRET}`)],
        [
          { tool: 'Read', input: { file_path: '/x' }, output: `key ${SECRET}` },
          { tool: 'Read', input: { file_path: '/y' }, failError: `ENOENT ${SECRET}` },
        ],
        redactor,
      );
      expectWithheld(lines, 'a non-standard error');
    }
  });
});

describe('#112 review fold: the result text is redacted once, and a failure says so', () => {
  it('the redactor sees the result text exactly once, and memory and the return share the outcome', async () => {
    const seen: string[] = [];
    const counting = (text: string): RedactResult => {
      seen.push(text);
      return { redacted: `${text.replaceAll(SECRET, MARKER)} #${seen.length}`, findings: [] };
    };
    const memory = createMemoryStore(openMemoryDatabase({ path: ':memory:' }));
    const out = await createSession({ ...deps(fakeQuery([INIT, result(`final ${SECRET}`)]), counting), memory }, { skillsDir: null }).run('hi');
    expect(seen.filter((t) => t === `final ${SECRET}`)).toHaveLength(1);
    const stored = JSON.parse(memory.read({})[0]?.content ?? '{}') as { resultText?: string };
    expect(stored.resultText).toBe(out.resultText);
    expect(out.resultText).toMatch(new RegExp(`^final \\[REDACTED:aws-access-key-id\\] #\\d+$`));
  });

  it('a failed redaction of the result text warns, naming only the class', async () => {
    const warnings: string[] = [];
    const out = await createSession(deps(fakeQuery([INIT, result(`final ${SECRET}`)]), (text) => {
      throw new RangeError(`bad input: ${text}`);
    }), { skillsDir: null, onWarning: (w) => warnings.push(w) }).run('hi');
    expect(out.resultText).toBe('[REDACTION FAILED]');
    expect(warnings).toContain(
      'secret redaction failed for the result text: the redactor threw RangeError; its message is withheld because it can carry the input (#113)',
    );
    expect(warnings.join('\n')).not.toContain(SECRET);
  });
});
