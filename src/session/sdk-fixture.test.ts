import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as pathScan from '../../scripts/fixture-path-scan.mjs';
import { buildFixture, findMachinePaths } from '../../scripts/fixture-path-scan.mjs';
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
  _provenance: { sdkVersion: string; marker: string; readMarker: string };
  preToolUse: SdkPreToolUseInput;
  postToolUse: SdkPostToolUseInput;
  // Second, structurally different tool (issue #103): Read.
  readPreToolUse: SdkPreToolUseInput;
  readPostToolUse: SdkPostToolUseInput;
}

/** The structured Read `tool_response` the SDK sends (not Bash's stdout/stderr). */
interface ReadResponse {
  type: string;
  file: { filePath: string; content: string; numLines: number; startLine: number; totalLines: number };
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

function replayQuery(
  pre: SdkPreToolUseInput = fixture.preToolUse,
  post: SdkPostToolUseInput = fixture.postToolUse,
): QueryFn {
  return (args) =>
    (async function* () {
      const signal = new AbortController().signal;
      for (const matcher of args.options?.hooks?.PreToolUse ?? []) {
        for (const cb of matcher.hooks as SdkHookCallback[]) {
          await cb(pre, 'toolu_fix', { signal });
        }
      }
      for (const matcher of args.options?.hooks?.PostToolUse ?? []) {
        for (const cb of matcher.hooks as SdkHookCallback[]) {
          await cb(post, 'toolu_fix', { signal });
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

describe('genuine SDK hook fixture: Read, a structurally different tool (issue #103)', () => {
  const readResponse = fixture.readPostToolUse?.tool_response as ReadResponse | undefined;

  it('is a Read event whose tool_response is the structured file object, not Bash stdout', () => {
    expect(fixture.readPreToolUse?.hook_event_name).toBe('PreToolUse');
    expect(fixture.readPreToolUse?.tool_name).toBe('Read');
    expect(fixture.readPostToolUse?.hook_event_name).toBe('PostToolUse');
    expect(fixture.readPostToolUse?.tool_name).toBe('Read');
    expect(readResponse).toBeDefined();
    expect(Object.keys(readResponse ?? {}).sort()).toEqual(['file', 'type']);
    expect(readResponse?.type).toBe('text');
    expect(Object.keys(readResponse?.file ?? {}).sort()).toEqual([
      'content',
      'filePath',
      'numLines',
      'startLine',
      'totalLines',
    ]);
    expect(readResponse).not.toHaveProperty('stdout');
    expect(readResponse?.file.content).toContain(fixture._provenance.readMarker);
  });

  it('pins the scrubbed path placeholder, never a machine path, at both nesting depths', () => {
    expect((fixture.readPreToolUse?.tool_input as { file_path?: string } | undefined)?.file_path).toBe('<read-target>');
    expect(readResponse?.file.filePath).toBe('<read-target>');
    // The SAME scan the capture script refuses to write on (one shared pattern
    // list: home-like POSIX roots, ~/, Windows drive and UNC paths), over every
    // string value at every depth, including model-written `description` and
    // the failure `command`/`error`.
    expect(findMachinePaths(fixture)).toEqual([]);
  });

  it('the shared scan flags every absolute or home-relative form and passes the placeholders', () => {
    // Inverted policy: ANY path-looking token is flagged, not a list of roots.
    const flagged = [
      '../../Users/x', '$HOME/x', '${HOME}/x', '~', '~user/x', '~/x', '/mnt/Users/x', '/./Users/x',
      '/opt/x', '/srv/x', '/nix/store/x', '/Library/x', '/etc/x', '/Users', 'cd /Users/a && ls', 'http://x/Users/jackson', 'https://x/a', 'ssh://h/Users/j',
      'vscode://file/Users/jackson/x',
      '(/Users/x)', 'C:\\Users\\x', 'C:/Users/x', '\\\\srv\\share', 'file:///Users/x', 'a/../b',
    ];
    for (const f of flagged) expect(findMachinePaths(f), f).not.toEqual([]);
    const allowed = [
      '<read-target>', '<cwd>/x.txt', 'cat: <cwd>/a: No such file', 'and/or', 'a~b',
      'echo harness-fixture-capture-marker',
    ];
    for (const a of allowed) expect(findMachinePaths(a), a).toEqual([]);
  });

  it('the shared scan finds a planted nested value and a planted KEY', () => {
    const planted = { a: { b: [{ filePath: '/Users/x/a' }] }, '/opt/key': 1 };
    const leaks = findMachinePaths(planted);
    expect(leaks).toHaveLength(2);
    expect(leaks.join('\n')).toContain('$.a.b[0].filePath: /Users/x/a');
    expect(leaks.join('\n')).toContain('<key "/opt/key">');
  });

  it('the .d.mts declares exactly the runtime exports of the .mjs', () => {
    const dts = readFileSync(join(here, '..', '..', 'scripts', 'fixture-path-scan.d.mts'), 'utf8');
    const declared = [...dts.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]).sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.keys(pathScan).sort()).toEqual(declared);
  });
});

// The capture script's "validate and scan, then write or refuse" decision is the
// pure buildFixture(); both refusals run here without a live capture.
describe('capture decision step: buildFixture (issue #103)', () => {
  const RAW_READ = '/machine/home/read-target.txt';
  const RAW_FAIL = '/machine/home/harness-fixture-capture-missing-84.txt';
  const RAW_CWD = '/machine/home';
  const cfg = {
    marker: fixture._provenance.marker,
    markerFail: 'harness-fixture-capture-missing-84.txt',
    readMarker: fixture._provenance.readMarker,
    readPlaceholder: '<read-target>',
    literals: [
      [RAW_READ, '<read-target>'],
      [RAW_FAIL, '<cwd>/harness-fixture-capture-missing-84.txt'],
      [RAW_CWD, '<cwd>'],
    ] as const,
    volatile: { session_id: '<session>', transcript_path: '<transcript>', cwd: '<cwd>', prompt_id: '<prompt>', tool_use_id: '<tool_use_id>', duration_ms: 0 },
    sdkVersion: fixture._provenance.sdkVersion,
  };
  // Re-materialise the machine paths the live run would have produced.
  const unscrub = (v: unknown): Record<string, unknown> =>
    JSON.parse(
      JSON.stringify(v)
        .split('<read-target>').join(RAW_READ)
        .split('<cwd>/harness-fixture-capture-missing-84.txt').join(RAW_FAIL),
    ) as Record<string, unknown>;
  const raw = () => ({
    pre: unscrub(fixture.preToolUse),
    post: unscrub(fixture.postToolUse),
    fail: unscrub((fixture as unknown as { postToolUseFailure: unknown }).postToolUseFailure),
    readPre: unscrub(fixture.readPreToolUse),
    readPost: unscrub(fixture.readPostToolUse),
  });

  it('round-trips: raw machine paths in, the committed fixture out', () => {
    const result = buildFixture(raw(), cfg);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fixture).toEqual(fixture);
  });

  it('refuses (bad) when Read touched a different file, so the path is not the placeholder', () => {
    const ev = raw();
    (ev.readPost as { tool_response: { file: { filePath: string } } }).tool_response.file.filePath = '/elsewhere/other.txt';
    const result = buildFixture(ev, cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('bad');
      expect(result.problems.join(' ')).toContain('readPost.tool_response.file.filePath');
    }
  });

  it('replaces the cwd only at a path boundary: a sibling stays a path and is refused', () => {
    const ev = raw();
    (ev.pre as { tool_input: { description: string } }).tool_input.description = `see ${RAW_CWD}-other/x`;
    const result = buildFixture(ev, cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('leaks');
      expect(result.problems.join(' ')).toContain('-other/x');
    }
  });

  it('refuses (leaks) on an unexpected path in a model-written field, naming where', () => {
    const ev = raw();
    (ev.pre as { tool_input: { description: string } }).tool_input.description = 'see /opt/secret/x';
    const result = buildFixture(ev, cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('leaks');
      expect(result.problems.join(' ')).toContain('$.preToolUse.tool_input.description: /opt/secret/x');
    }
  });
});

describe('genuine SDK hook fixture: Read replay continued (issue #103)', () => {
  it('carries the recorded Read content into the post-tool telemetry summary', async () => {
    const events: TelemetryEventInput[] = [];
    const deps = makeDeps({
      query: replayQuery(fixture.readPreToolUse, fixture.readPostToolUse),
      telemetry: {
        record: (event) => {
          events.push(event);
          return { ok: true, value: { ...event, id: 'evt', ts: 1 } };
        },
      },
    });
    const session = createSession(deps, { skillsDir: '/nowhere' });
    await session.run('read the marker file');

    const trace = events.find((e) => e.type === 'tool-trace');
    expect(trace?.type).toBe('tool-trace');
    if (trace?.type !== 'tool-trace') return;
    expect(trace.payload.resultSummary).not.toBeNull();
    expect(trace.payload.resultSummary).toContain(fixture._provenance.readMarker);
    // A Bash-shaped replay could not produce this: the summary is the stringified
    // NESTED object, so it carries the nested key and its scrubbed value.
    expect(trace.payload.resultSummary).toContain('"filePath":"<read-target>"');
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
