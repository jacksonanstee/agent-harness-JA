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
 * from a real keyed run, through the session. What each gate actually catches,
 * stated precisely because overstating this gate is the same class of error as
 * issue #83 itself:
 *   - This replay is a REGRESSION pin (harness code must keep feeding the
 *     recorded shape into the post-tool path) AND a view-staleness detector: if
 *     the view changes to require a field the frozen JSON lacks, the guard below
 *     goes red. It replays a snapshot through a fake `query`, so it does NOT
 *     observe the live SDK and cannot, on its own, detect an SDK-side rename.
 *   - The SDK-side rename detector is the compile-time parity pin in
 *     sdk-types.test.ts, which reads the installed SDK's own types.
 *   - ADDITIVE SDK drift (a new field the harness ought to read) is caught by
 *     NEITHER; only a re-capture on an SDK bump surfaces it, which is why the
 *     version assertion below forces a re-capture rather than letting a caret
 *     bump run the old fixture against a new SDK.
 * CI has no API key, so the capture is out-of-band and this replay runs per PR.
 */
interface Fixture {
  _provenance: { sdkVersion: string; marker: string };
  preToolUse: SdkPreToolUseInput;
  postToolUse: SdkPostToolUseInput;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Fixture = JSON.parse(
  readFileSync(join(here, 'fixtures', 'sdk-hook-events.json'), 'utf8'),
) as Fixture;

// The version the SDK is pinned at right now (read, not hard-coded). If the
// fixture was captured from a different SDK, the replay proves nothing about
// the installed one: re-capture with scripts/capture-sdk-hook-fixture.mjs.
const installedSdkVersion: string = JSON.parse(
  readFileSync(
    join(here, '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
    'utf8',
  ),
).version;

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
  it('was captured from the SDK version currently installed', () => {
    // A version field nothing compares is a proxy check (DEC-0016): assert it,
    // so an SDK bump under the caret range fails here until the fixture is
    // re-captured, instead of replaying a stale snapshot against a new SDK.
    expect(fixture._provenance.sdkVersion).toBe(installedSdkVersion);
  });

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

// ---- Issue #84 pin 5: rewrite shape by construction against genuine traffic --
//
// Replay the FROZEN Bash post-tool event with stdout swapped for a synthetic
// secret (assembled at runtime, never a literal in the repo). The returned
// updatedToolOutput must carry EXACTLY the fixture's tool_response key set: the
// shape-preserving walk is pinned against a real SDK payload, so a future SDK
// that changes the Bash output shape reddens after re-capture.
const FAKE_AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

describe('genuine SDK hook fixture: rewrite channel (issue #84)', () => {
  it('rewrites the frozen Bash output in place, preserving exactly the fixture key set (pin 5)', async () => {
    const swapped: SdkPostToolUseInput = {
      ...fixture.postToolUse,
      tool_response: { ...(fixture.postToolUse.tool_response as Record<string, unknown>), stdout: `logged ${FAKE_AWS_KEY}` },
    };
    const outputs: unknown[] = [];
    const query: QueryFn = (args) =>
      (async function* () {
        const signal = new AbortController().signal;
        for (const matcher of args.options?.hooks?.PostToolUse ?? []) {
          for (const cb of matcher.hooks as SdkHookCallback[]) {
            outputs.push(await cb(swapped, 'toolu_fix', { signal }));
          }
        }
        yield { type: 'system', subtype: 'init', session_id: 'sdk-1' } as SdkMessage;
        yield RESULT;
      })();
    const session = createSession(makeDeps({ query }), { skillsDir: '/nowhere' });
    await session.run('echo the marker');

    const hso = (outputs[0] as { hookSpecificOutput?: { updatedToolOutput?: unknown } } | undefined)?.hookSpecificOutput;
    expect(hso?.updatedToolOutput).toBeDefined();
    const rewritten = hso?.updatedToolOutput as Record<string, unknown>;
    expect(Object.keys(rewritten).sort()).toEqual(
      Object.keys(fixture.postToolUse.tool_response as Record<string, unknown>).sort(),
    );
    expect(rewritten.stdout).toContain('[REDACTED:aws-access-key-id]');
    expect(rewritten.stdout).not.toContain(FAKE_AWS_KEY);
  });

  // A genuine `postToolUseFailure` event was captured out-of-band 2026-09-08
  // (scripts/capture-sdk-hook-fixture.mjs driving `cat <cwd>/missing`, which
  // executes and fails), so this leg RUNS and pins D8's failure-hook shape
  // against real traffic. `skipIf` remains only as a guard for a future
  // re-capture that could not elicit the event; re-run the capture after an SDK
  // bump the same way.
  const failureFixture = (fixture as unknown as { postToolUseFailure?: { hook_event_name?: string; error?: string } }).postToolUseFailure;
  it.skipIf(!failureFixture)('replays a genuine PostToolUseFailure event (skips until captured)', () => {
    expect(failureFixture?.hook_event_name).toBe('PostToolUseFailure');
    expect(typeof failureFixture?.error).toBe('string');
  });
});
