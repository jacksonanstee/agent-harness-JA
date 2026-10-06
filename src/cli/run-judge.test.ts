import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../cli.js';
import { JUDGE_SESSION_STATES } from '../session/index.js';
import type { JudgeSummary, QueryFn, QueryOptions, SdkHookCallback, SdkMessage } from '../session/index.js';
import { JUDGE_SYSTEM_PROMPT } from '../session/judge.js';
import { createTelemetryStore, openTelemetryDatabase } from '../telemetry/index.js';
import type { JudgeCallPayload } from '../telemetry/index.js';
import { judgeStartLine, judgeSummaryLines, runJudgeDeps } from './run-judge.js';

// Issue #96 PR-B1, spec D2 and D7 at the CLI. `main` is driven with CliSeams
// (the user dir, which a vitest worker cannot redirect through HOME, lesson
// 2026-08-28, and the SDK importer). The fake SDK serves both the primary
// session and the judge (told apart by the judge's system prompt). D8a: the
// real SDK is never loaded (the Task 1 guard would fail the test).

const MARKER = 'MARKER-cli-77b2';
const tmp: string[] = [];
const saved = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

function dir(settings?: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'run-judge-'));
  tmp.push(d);
  if (settings !== undefined) {
    mkdirSync(join(d, '.harness'));
    writeFileSync(join(d, '.harness', 'settings.json'), JSON.stringify(settings));
  }
  return d;
}

function fakeSdk(judgeReply: string) {
  const primary: QueryOptions[] = [];
  const judge: QueryOptions[] = [];
  const query: QueryFn = (args) => {
    const o = args.options;
    if (o?.systemPrompt === JUDGE_SYSTEM_PROMPT) {
      judge.push(o);
      return (async function* () {
        yield { type: 'result', subtype: 'success', result: judgeReply, session_id: 'j', total_cost_usd: 0.0021 } as SdkMessage;
      })();
    }
    if (o !== undefined) primary.push(o);
    return (async function* () {
      const signal = new AbortController().signal;
      for (const m of o?.hooks?.PostToolUse ?? []) {
        for (const cb of m.hooks as unknown as SdkHookCallback[]) {
          await cb(
            { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: `notes ${MARKER}`, tool_use_id: 'toolu_1' },
            'toolu_1',
            { signal },
          );
        }
      }
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1' } as SdkMessage;
      yield { type: 'result', subtype: 'success', result: 'done', session_id: 'sdk-1', num_turns: 1, total_cost_usd: 0.01 } as SdkMessage;
    })();
  };
  return { query, primary, judge, calls: () => primary.length + judge.length };
}

async function runMain(argv: string[], userSettings: unknown, projectSettings: unknown, query: QueryFn | undefined) {
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
  vi.spyOn(process, 'cwd').mockReturnValue(dir(projectSettings));
  const userDir = dir(userSettings);
  const code = await main(argv, { userDir, importSdk: async () => ({ query }) });
  return { code, stdout: out.join(''), stderr: err.join(''), userDir };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The settings failure line, anchored at column 0 (lesson 2026-09-09, plan review P-16): `<user settings path>: <message>`. */
function settingsLine(userDir: string, message: string): RegExp {
  return new RegExp(`^${escapeRegExp(join(userDir, '.harness', 'settings.json'))}: ${escapeRegExp(message)}`, 'm');
}

function runArgs(): { argv: string[]; db: string } {
  const db = join(dir(), 'telemetry.db');
  return { argv: ['run', 'hi', '--db', db, '--skills-dir', dir()], db };
}

const summaryOf = (over: Partial<JudgeSummary>): JudgeSummary => ({
  cap: 200,
  calls: 0,
  byState: Object.fromEntries(JUDGE_SESSION_STATES.map((s) => [s, 0])) as JudgeSummary['byState'],
  annotated: 0,
  tightened: 0,
  costUsd: 0,
  costUnknown: 0,
  pendingAtEnd: 0,
  ...over,
});

describe('run path with the judge on (D2, D7; pins 3, 16, 32)', () => {
  it('composes deps.judge, prints the start and summary lines, writes a judge-call row, and the judge query carries the abort key and no post hooks', async () => {
    const sdk = fakeSdk('{"verdict":"block"}');
    const { argv, db } = runArgs();
    const { code, stderr } = await runMain(argv, { judge: { mode: 'always', maxCallsPerRun: 3 } }, undefined, sdk.query);
    expect(code).toBe(0);
    expect(stderr).toMatch(/^\[harness\] judge: on \(always, cap 3\): each tool result waits for one judge call, typically about 15 s and at most 60 s$/m);
    expect(stderr).toMatch(/^\[harness\] judge: 1\/3 call\(s\), 1 note\(s\) added by the judge path, cost=\$0\.0021 \(not included in cost= above\)$/m);
    expect(sdk.judge).toHaveLength(1);
    expect(sdk.judge[0]?.abortController).toBeInstanceOf(AbortController);
    expect(Object.keys(sdk.judge[0]?.hooks ?? {})).toEqual(['PreToolUse']);
    expect(sdk.primary[0]?.hooks?.PostToolUse?.[0]?.timeout).toBe(600);
    const handle = openTelemetryDatabase({ path: db });
    try {
      const rows = createTelemetryStore(handle).query({ type: 'judge-call' });
      expect(rows.map((r) => (r.payload as JudgeCallPayload).state)).toEqual(['judged']);
      expect(JSON.stringify(rows)).not.toContain(MARKER);
    } finally {
      handle.close();
    }
    expect(stderr).not.toContain(MARKER);
  });

  it('judge off: no judge line, no judge query, no timeout key, no judge-call row', async () => {
    const sdk = fakeSdk('{"verdict":"block"}');
    const { argv, db } = runArgs();
    const { code, stderr } = await runMain(argv, {}, undefined, sdk.query);
    expect(code).toBe(0);
    expect(stderr).not.toMatch(/^\[harness\] judge:/m);
    expect(sdk.judge).toEqual([]);
    expect(Object.keys(sdk.primary[0]?.hooks?.PostToolUse?.[0] ?? {})).toEqual(['hooks']);
    const handle = openTelemetryDatabase({ path: db });
    try {
      expect(createTelemetryStore(handle).query({ type: 'judge-call' })).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('runJudgeDeps: off carries no judge key; on carries exactly call and maxCallsPerRun (pins 3, 32)', () => {
    const query: QueryFn = () => (async function* () {})();
    expect('judge' in runJudgeDeps(null, query)).toBe(false);
    const on = runJudgeDeps({ mode: 'always', maxCallsPerRun: 7 }, query);
    expect(Object.keys(on.judge ?? {}).sort()).toEqual(['call', 'maxCallsPerRun']);
    expect(on.judge?.maxCallsPerRun).toBe(7);
  });
});

describe('malformed user judge blocks exit 2 before any tool runs (pin 1)', () => {
  it.each([
    [{ judge: { mode: 'always' } }, 'judge.maxCallsPerRun is required'],
    [{ judge: { mode: 'suspicious', maxCallsPerRun: 5 } }, 'judge.mode "suspicious" is not available'],
    [{ judge: { mode: 'always', maxCallsPerRun: 1001 } }, 'judge.maxCallsPerRun must be an integer from 1 to 1000'],
  ])('run with %j', async (settings, message) => {
    const sdk = fakeSdk('{"verdict":"pass"}');
    const { code, stderr, userDir } = await runMain(runArgs().argv, settings, undefined, sdk.query);
    expect(code).toBe(2);
    expect(stderr).toMatch(settingsLine(userDir, message));
    expect(sdk.calls()).toBe(0);
  });
});

describe('eval shares composeSecurity (G-5; pin 23)', () => {
  it('a malformed user judge block exits 2 on eval too', async () => {
    const { code, stderr, userDir } = await runMain(['eval', './tasks'], { judge: { mode: 'always' } }, undefined, undefined);
    expect(code).toBe(2);
    expect(stderr).toMatch(settingsLine(userDir, 'judge.maxCallsPerRun is required'));
  });

  it('a project judge key warns on eval\'s stderr (the SDK load then refuses, so nothing runs)', async () => {
    const { code, stderr } = await runMain(['eval', './tasks'], {}, { judge: { mode: 'always', maxCallsPerRun: 5 } }, undefined);
    expect(code).toBe(2);
    expect(stderr).toMatch(/^warning: ignoring "judge" in .*\.harness\/settings\.json: the judge is configured only in ~\/\.harness\/settings\.json$/m);
  });
});

describe('the summary and start lines (D7; pins 17, 29)', () => {
  it('0 calls, only not-escalated rows', () => {
    const { summary, capWarning } = judgeSummaryLines(summaryOf({ byState: { ...summaryOf({}).byState, 'not-escalated': 2 } }));
    expect(summary).toBe('[harness] judge: 0/200 call(s), 0 note(s) added by the judge path, cost=$0.0000 (not included in cost= above)');
    expect(capWarning).toBeNull();
  });

  it('at the cap, with unknown costs and pending at end: non-zero unjudged states only, in the D7 order', () => {
    const byState = { ...summaryOf({}).byState, judged: 3, 'timed-out': 1, 'cap-reached': 2, 'queue-timed-out': 1 };
    const { summary, capWarning } = judgeSummaryLines(summaryOf({ cap: 4, calls: 4, byState, tightened: 2, costUsd: 0.0061, costUnknown: 1, pendingAtEnd: 1 }));
    expect(summary).toBe(
      '[harness] judge: 4/4 call(s), 2 note(s) added by the judge path, unjudged: 1 timed-out, 2 cap-reached, 1 queue-timed-out, 1 pending at end, cost=$0.0061 (not included in cost= above; 1 call(s) of unknown cost)',
    );
    expect(capWarning).toBe('the judge call cap (4) was reached; 2 tool result(s) ran on the heuristic only. Raise judge.maxCallsPerRun in ~/.harness/settings.json to judge more.');
  });

  it('pending at end appears exactly when pendingAtEnd > 0 (B-2)', () => {
    expect(judgeSummaryLines(summaryOf({ pendingAtEnd: 0 })).summary).not.toMatch(/pending at end/);
    expect(judgeSummaryLines(summaryOf({ pendingAtEnd: 2 })).summary).toMatch(/unjudged: 2 pending at end, /);
  });

  it('the start line derives its 60 s from JUDGE_TIMEOUT_MS', () => {
    expect(judgeStartLine({ mode: 'always', maxCallsPerRun: 9 })).toBe(
      '[harness] judge: on (always, cap 9): each tool result waits for one judge call, typically about 15 s and at most 60 s',
    );
  });
});

describe('a project judge key warns with the path neutralised (Task 2 deferral; pin 23)', () => {
  it('a cwd with control characters reaches stderr sanitised: no escape byte, the line still start-anchored', async () => {
    const hostile = join(dir(), 'evil\u001b[2J\u0007name');
    mkdirSync(join(hostile, '.harness'), { recursive: true });
    writeFileSync(join(hostile, '.harness', 'settings.json'), JSON.stringify({ judge: { mode: 'always', maxCallsPerRun: 5 } }));
    const sdk = fakeSdk('{"verdict":"pass"}');
    process.env.ANTHROPIC_API_KEY = 'dummy';
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
    vi.spyOn(process, 'cwd').mockReturnValue(hostile);
    await main(runArgs().argv, { userDir: dir(), importSdk: async () => ({ query: sdk.query }) });
    const stderr = err.join('');
    expect(stderr).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(stderr).toMatch(/^warning: ignoring "judge" in .*evil {0,3}\[2J {0,3}name.*settings\.json: the judge is configured only in ~\/\.harness\/settings\.json$/m);
  });
});
