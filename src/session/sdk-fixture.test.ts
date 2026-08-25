import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import { redact, scan } from '../security/index.js';
import type { TelemetryEventInput } from '../telemetry/index.js';
import { createSession } from './session.js';
import type {
  QueryFn,
  SdkHookCallback,
  SdkMessage,
  SdkPostToolUseInput,
  SdkPreToolUseInput,
  SessionDeps,
} from './types.js';

/**
 * Replays GENUINE SDK hook events, captured by scripts/capture-sdk-hook-fixture.mjs
 * from a real keyed run, through the session. This is the structural gate that
 * a hand-written fake could not be: if a future SDK renames the result field
 * (as `tool_output` vs `tool_response` already caught us, issue #83), the
 * recorded event stops feeding the post-tool path and this test fails. CI has
 * no API key, so the capture is out-of-band; this replay runs per PR.
 */
interface Fixture {
  _provenance: { sdkVersion: string; marker: string };
  preToolUse: SdkPreToolUseInput;
  postToolUse: SdkPostToolUseInput;
}

const fixture: Fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sdk-hook-events.json'),
    'utf8',
  ),
) as Fixture;

const RESULT: SdkMessage = {
  type: 'result',
  subtype: 'success',
  result: 'done',
  session_id: 'sdk-1',
  num_turns: 1,
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 1 },
};

function replayQuery(): QueryFn {
  return (args) =>
    (async function* () {
      const signal = new AbortController().signal;
      for (const matcher of args.options?.hooks?.PreToolUse ?? []) {
        for (const cb of matcher.hooks as SdkHookCallback[]) {
          await cb(fixture.preToolUse, 'toolu_fix', { signal });
        }
      }
      for (const matcher of args.options?.hooks?.PostToolUse ?? []) {
        for (const cb of matcher.hooks as SdkHookCallback[]) {
          await cb(fixture.postToolUse, 'toolu_fix', { signal });
        }
      }
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1' } as SdkMessage;
      yield RESULT;
    })();
}

function makeDeps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  return {
    query: replayQuery(),
    hooks: createHookRuntime(),
    memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
    loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
    route,
    scanInjection: (text) => scan(text),
    redactSecrets: (text) => redact(text),
    ...overrides,
  };
}

describe('genuine SDK hook fixture', () => {
  it('carries the recorded Bash stdout into the post-tool telemetry summary', async () => {
    // Guard the fixture itself: it must be a PostToolUse event with the field
    // the SDK actually sends. If a re-capture wrote the wrong shape, fail here
    // rather than silently passing an empty-output run.
    expect(fixture.postToolUse.hook_event_name).toBe('PostToolUse');
    expect(fixture.postToolUse.tool_response).toBeDefined();

    const events: TelemetryEventInput[] = [];
    const deps = makeDeps({
      telemetry: {
        record: (event) => {
          events.push(event);
          return { ok: true, value: { ...event, id: 'evt', ts: 1 } };
        },
      },
    });
    const session = createSession(deps, { skillsDir: '/nowhere' });

    await session.run('echo the marker');

    const trace = events.find((e) => e.type === 'tool-trace');
    expect(trace?.type).toBe('tool-trace');
    if (trace?.type !== 'tool-trace') return;
    expect(trace.payload.resultSummary).not.toBeNull();
    expect(trace.payload.resultSummary).toContain(fixture._provenance.marker);
  });
});
