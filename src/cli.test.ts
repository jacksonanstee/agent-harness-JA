import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { composeSecurity, hookRecordToTelemetryInput, main, parseArgs, parseEvalArgs, parseRunArgs, refuseSymlinkedDir, sanitizeForTerminal, scorecardFilename, SettingsLoadError, writeScorecard } from './cli.js';
import { EvalUsageError } from './eval/index.js';
import type { GoldenScorecard } from './eval/index.js';
import type { HookEventRecord } from './hooks/index.js';
import { DEFAULT_DB_PATH } from './memory/index.js';
import { createTelemetryStore, openTelemetryDatabase } from './telemetry/index.js';
import type { TelemetryEvent } from './telemetry/index.js';

describe('parseRunArgs', () => {
  it('parses a bare run command with defaults', () => {
    const parsed = parseRunArgs(['run', 'say hello']);
    expect(parsed).toEqual({
      ok: true,
      value: {
        command: 'run',
        prompt: 'say hello',
        skillsDir: './skills',
        dbPath: DEFAULT_DB_PATH,
        maxTurns: 10,
      },
    });
  });

  it('parses all flags', () => {
    const parsed = parseRunArgs([
      'run',
      'hi',
      '--skills-dir',
      '/tmp/skills',
      '--db',
      '/tmp/mem.db',
      '--max-turns',
      '3',
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.command === 'run') {
      expect(parsed.value.skillsDir).toBe('/tmp/skills');
      expect(parsed.value.dbPath).toBe('/tmp/mem.db');
      expect(parsed.value.maxTurns).toBe(3);
    }
  });

  it('rejects an unknown command', () => {
    const parsed = parseRunArgs(['serve']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Unknown command 'serve'");
  });

  it('rejects a missing prompt', () => {
    expect(parseRunArgs(['run']).ok).toBe(false);
    expect(parseRunArgs(['run', '  ']).ok).toBe(false);
  });

  it('rejects a flag with no value', () => {
    const parsed = parseRunArgs(['run', 'hi', '--db']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('--db');
  });

  it('rejects unknown flags and extra positionals', () => {
    expect(parseRunArgs(['run', 'hi', '--verbose']).ok).toBe(false);
    expect(parseRunArgs(['run', 'hi', 'there']).ok).toBe(false);
  });

  it('rejects a non-positive --max-turns', () => {
    expect(parseRunArgs(['run', 'hi', '--max-turns', '0']).ok).toBe(false);
    expect(parseRunArgs(['run', 'hi', '--max-turns', 'abc']).ok).toBe(false);
    expect(parseRunArgs(['run', 'hi', '--max-turns', '5abc']).ok).toBe(false);
  });
});

describe('sanitizeForTerminal', () => {
  it('strips ANSI/OSC escape introducers and C1 controls, keeps newlines and tabs', () => {
    expect(sanitizeForTerminal('a\u001b[31mred\u0007b')).toBe('a [31mred b');
    expect(sanitizeForTerminal('line1\nline2\tend')).toBe('line1\nline2\tend');
    expect(sanitizeForTerminal('overwrite\rspoof')).toBe('overwrite spoof'); // CR enables line-rewrite spoofing
  });
});

describe('parseArgs (telemetry export)', () => {
  it('parses telemetry export with defaults', () => {
    const parsed = parseArgs(['telemetry', 'export']);
    expect(parsed).toEqual({
      ok: true,
      value: {
        command: 'telemetry-export',
        dbPath: DEFAULT_DB_PATH,
        out: null,
        sessionId: null,
        type: null,
      },
    });
  });

  it('parses all export flags', () => {
    const parsed = parseArgs([
      'telemetry',
      'export',
      '--db',
      '/tmp/t.db',
      '--out',
      '/tmp/out.jsonl',
      '--session',
      's1',
      '--type',
      'turn-cost',
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.command === 'telemetry-export') {
      expect(parsed.value.dbPath).toBe('/tmp/t.db');
      expect(parsed.value.out).toBe('/tmp/out.jsonl');
      expect(parsed.value.sessionId).toBe('s1');
      expect(parsed.value.type).toBe('turn-cost');
    }
  });

  it('rejects an invalid --type, unknown subcommand, and unknown flags', () => {
    expect(parseArgs(['telemetry', 'export', '--type', 'bogus']).ok).toBe(false);
    expect(parseArgs(['telemetry', 'import']).ok).toBe(false);
    expect(parseArgs(['telemetry']).ok).toBe(false);
    expect(parseArgs(['telemetry', 'export', '--verbose']).ok).toBe(false);
    expect(parseArgs(['telemetry', 'export', '--db']).ok).toBe(false);
    expect(parseArgs(['telemetry', 'export', 'extra']).ok).toBe(false);
  });

  it('still routes run through the union', () => {
    const parsed = parseArgs(['run', 'hi']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.command).toBe('run');
  });
});

describe('hookRecordToTelemetryInput', () => {
  const ids = { sessionId: 'harness-1', turnId: 'turn-1' };

  it('maps all three HookEventRecord kinds', () => {
    const denied: HookEventRecord = {
      kind: 'denied-by-hook',
      event: 'pre-tool',
      handlerIndex: 2,
      tool: 'Bash',
      reason: 'blocked',
    };
    const errored: HookEventRecord = {
      kind: 'hook-error',
      event: 'post-tool',
      handlerIndex: 0,
      reason: 'observer broke',
    };
    const fired: HookEventRecord = { kind: 'hook-fired', event: 'stop', handlersFired: 3 };

    expect(hookRecordToTelemetryInput(denied, ids)).toEqual({
      type: 'hook-event',
      sessionId: 'harness-1',
      turnId: 'turn-1',
      payload: { kind: 'denied-by-hook', event: 'pre-tool', tool: 'Bash', reason: 'blocked', handlerIndex: 2 },
    });
    expect(hookRecordToTelemetryInput(errored, ids)).toEqual({
      type: 'hook-event',
      sessionId: 'harness-1',
      turnId: 'turn-1',
      payload: { kind: 'hook-error', event: 'post-tool', reason: 'observer broke', handlerIndex: 0 },
    });
    expect(hookRecordToTelemetryInput(fired, ids)).toEqual({
      type: 'hook-event',
      sessionId: 'harness-1',
      turnId: 'turn-1',
      payload: { kind: 'hook-fired', event: 'stop', handlersFired: 3 },
    });
  });
});

describe('main (telemetry export)', () => {
  let tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
    vi.restoreAllMocks();
  });

  function seededDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-'));
    tmpDirs.push(dir);
    const path = join(dir, 'telemetry.db');
    const db = openTelemetryDatabase({ path });
    const store = createTelemetryStore(db);
    store.record({
      type: 'hook-event',
      sessionId: 's1',
      turnId: 't1',
      ts: 100,
      payload: { kind: 'hook-fired', event: 'session-start', handlersFired: 0 },
    });
    store.record({
      type: 'tool-trace',
      sessionId: 's2',
      turnId: 't2',
      ts: 200,
      payload: { tool: 'Read', phase: 'post-tool', resultSummary: 'x' },
    });
    db.close();
    return path;
  }

  it('writes JSONL to stdout by default', async () => {
    const path = seededDb();
    const chunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        chunks.push(String(chunk));
        return true;
      });
    const code = await main(['telemetry', 'export', '--db', path]);
    spy.mockRestore();
    expect(code).toBe(0);
    const lines = chunks.join('').trim().split('\n');
    expect(lines).toHaveLength(2);
    const events = lines.map((l) => JSON.parse(l) as TelemetryEvent);
    expect(events.map((e) => e.type)).toEqual(['hook-event', 'tool-trace']);
  });

  it('filters by --session and --type and writes to --out', async () => {
    const path = seededDb();
    const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-out-'));
    tmpDirs.push(dir);
    const out = join(dir, 'events.jsonl');
    const code = await main(['telemetry', 'export', '--db', path, '--session', 's2', '--out', out]);
    expect(code).toBe(0);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? '{}') as TelemetryEvent).sessionId).toBe('s2');

    const code2 = await main(['telemetry', 'export', '--db', path, '--type', 'hook-event', '--out', out]);
    expect(code2).toBe(0);
    const lines2 = readFileSync(out, 'utf8').trim().split('\n');
    expect(lines2).toHaveLength(1);
    expect((JSON.parse(lines2[0] ?? '{}') as TelemetryEvent).type).toBe('hook-event');
  });

  it('does not require ANTHROPIC_API_KEY', async () => {
    const path = seededDb();
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['telemetry', 'export', '--db', path])).toBe(0);
    } finally {
      spy.mockRestore();
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('main (pre-SDK paths)', () => {
  it('returns 2 on invalid arguments without touching the environment', async () => {
    expect(await main(['bogus'])).toBe(2);
  });

  it('returns 2 when ANTHROPIC_API_KEY is unset', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await main(['run', 'hello'])).toBe(2);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('returns 2 for eval when ANTHROPIC_API_KEY is unset', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await main(['eval'])).toBe(2);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  // The symlinked-.harness refusal cannot be driven through main() here:
  // lstatSync('.harness') resolves relative to the OS-level cwd, and
  // process.chdir() throws ERR_WORKER_UNSUPPORTED_OPERATION under vitest's
  // threads pool. The branch is covered directly by the refuseSymlinkedDir
  // unit tests above; runEval calls it verbatim.
  it('returns 2 for eval when project settings are malformed (SettingsLoadError)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-cwd-'));
    mkdirSync(join(dir, '.harness'));
    writeFileSync(join(dir, '.harness', 'settings.json'), '{ not json');
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // composeSecurity derives the project layer from process.cwd() and reads
    // the resulting absolute path, so spying cwd() suffices — no chdir needed.
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      expect(await main(['eval', './tasks'])).toBe(2);
    } finally {
      cwdSpy.mockRestore();
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe('composeSecurity', () => {
  const settingsPath = (dir: string): string => join(dir, '.harness', 'settings.json');

  const filesystem = (files: Record<string, string>) => (path: string): string => {
    const body = files[path];
    if (body === undefined) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return body;
  };

  it('reads each settings file once and parses both keys from the same doc', () => {
    const readPaths: string[] = [];
    const files = filesystem({
      [settingsPath('/home/u')]: JSON.stringify({
        permissions: { rules: [{ tool: 'Bash', decision: 'deny' }] },
        sandbox: { paths: { allow: ['/safe'] } },
      }),
    });
    const result = composeSecurity({
      readFile: (p) => {
        readPaths.push(p);
        return files(p);
      },
      userDir: '/home/u',
      projectDir: '/proj',
    });
    expect(readPaths.filter((p) => p === settingsPath('/home/u'))).toHaveLength(1);
    expect(result.permissions.rules).toHaveLength(1);
    expect(result.sandbox.paths?.allow).toEqual(['/safe']);
    expect(result.warnings).toEqual([]);
  });

  it('malformed permissions OR sandbox keys throw a path-prefixed SettingsLoadError', () => {
    const badPermissions = filesystem({
      [settingsPath('/proj')]: JSON.stringify({ permissions: { rules: 'nope' } }),
    });
    expect(() =>
      composeSecurity({ readFile: badPermissions, userDir: '/home/u', projectDir: '/proj' }),
    ).toThrowError(SettingsLoadError);
    expect(() =>
      composeSecurity({ readFile: badPermissions, userDir: '/home/u', projectDir: '/proj' }),
    ).toThrow(new RegExp(settingsPath('/proj').replace(/[/.]/g, '\\$&')));

    const badSandbox = filesystem({
      [settingsPath('/home/u')]: JSON.stringify({ sandbox: { paths: 'nope' } }),
    });
    expect(() =>
      composeSecurity({ readFile: badSandbox, userDir: '/home/u', projectDir: '/proj' }),
    ).toThrow(/sandbox\.paths/);

    const badJson = filesystem({ [settingsPath('/home/u')]: '{oops' });
    expect(() =>
      composeSecurity({ readFile: badJson, userDir: '/home/u', projectDir: '/proj' }),
    ).toThrow(/not valid JSON/);
  });

  it('missing files everywhere → open posture, no warnings', () => {
    const result = composeSecurity({
      readFile: filesystem({}),
      userDir: '/home/u',
      projectDir: '/proj',
    });
    expect(result.permissions.rules).toEqual([]);
    expect(result.sandbox).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('warns on ask-without-prompter and shell-runner allowlist entries', () => {
    const result = composeSecurity({
      readFile: filesystem({
        [settingsPath('/proj')]: JSON.stringify({
          permissions: { rules: [{ tool: 'Bash', decision: 'ask' }] },
          sandbox: { commands: { allow: ['git', 'bash'] } },
        }),
      }),
      userDir: '/home/u',
      projectDir: '/proj',
    });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('ask');
    expect(result.warnings[1]).toContain('bash');
    expect(result.warnings[1]).toContain('always denied');
  });

  it('merges layers with S-3/S-4 semantics: sticky deny + sandbox intersection', () => {
    const result = composeSecurity({
      readFile: filesystem({
        [settingsPath('/home/u')]: JSON.stringify({
          permissions: { rules: [{ tool: 'Bash', decision: 'deny' }] },
          sandbox: { paths: { allow: ['/a', '/b'] } },
        }),
        [settingsPath('/proj')]: JSON.stringify({
          permissions: { rules: [{ tool: 'Bash', decision: 'allow' }] },
          sandbox: { paths: { allow: ['/b', '/c'] } },
        }),
      }),
      userDir: '/home/u',
      projectDir: '/proj',
    });
    expect(result.sandbox.paths?.allow).toEqual(['/b']);
    const rules = result.permissions.rules ?? [];
    expect(rules.map((r) => r.layer)).toEqual(['user', 'project']);
  });
});

describe('parseEvalArgs', () => {
  it('defaults taskDir to ./eval/golden (README quick-start contract)', () => {
    const result = parseEvalArgs([]);
    expect(result).toEqual({ ok: true, value: { command: 'eval', taskDir: './eval/golden' } });
  });

  it('accepts a positional task directory', () => {
    const result = parseEvalArgs(['./my-tasks']);
    expect(result).toEqual({ ok: true, value: { command: 'eval', taskDir: './my-tasks' } });
  });

  it('rejects unknown flags (no --max-tasks in v1)', () => {
    const result = parseEvalArgs(['--max-tasks', '5']);
    expect(result.ok).toBe(false);
  });

  it('rejects extra positional arguments', () => {
    const result = parseEvalArgs(['a', 'b']);
    expect(result.ok).toBe(false);
  });

  it('is reachable through parseArgs', () => {
    const result = parseArgs(['eval', './tasks']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.command).toBe('eval');
  });
});

describe('scorecardFilename', () => {
  it('is filesystem-safe: no colons, second precision, Z-suffixed', () => {
    // 2026-07-09T03:12:45.678Z (epoch re-derived from the ISO string; the
    // brief's literal 1783307565678 actually decodes to 2026-07-06, not
    // 2026-07-09 — see task-9-report.md for the verification command).
    expect(scorecardFilename(1783566765678)).toBe('scorecard-2026-07-09T03-12-45Z.json');
  });
});

describe('writeScorecard', () => {
  const scorecard: GoldenScorecard = {
    schemaVersion: 1,
    producer: 'golden',
    meta: {
      createdAt: '2026-07-09T03:12:45.000Z',
      harnessVersion: '0.1.0-test',
      taskDir: '/tmp/tasks',
      models: [],
    },
    rows: [],
    totals: {
      total: 0,
      passed: 0,
      failed: 0,
      byFailureKind: {
        'task-parse': 0,
        'oracle-load': 0,
        'session-error': 0,
        'oracle-error': 0,
        'oracle-fail': 0,
      },
      passRate: 0,
      totalCostUsd: 0,
      unpricedTasks: 0,
    },
  };

  it('creates the dir and writes canonical JSON at the timestamped path', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'eval-write-')), 'eval');
    const result = writeScorecard(scorecard, out, 1783566765678);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(join(out, 'scorecard-2026-07-09T03-12-45Z.json'));
    expect(readFileSync(result.path, 'utf8')).toContain('"schemaVersion"');
  });

  it('maps a non-symlink obstacle (regular file at the out dir) to a message, never a throw', () => {
    // The exit-2 contract says "no scorecard produced ⇒ exit 2" for EVERY
    // write failure, not just symlink refusals (E-1 differential review, F-3).
    const out = join(mkdtempSync(join(tmpdir(), 'eval-write-')), 'eval');
    writeFileSync(out, 'a regular file where the dir should be');
    const result = writeScorecard(scorecard, out);
    expect(result.ok).toBe(false);
  });

  it('maps a symlinked out dir to a message (attacker-directed write)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-write-'));
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const result = writeScorecard(scorecard, join(dir, 'link'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/symlink/);
  });
});

describe('refuseSymlinkedDir', () => {
  it('passes a real directory and a missing path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-out-'));
    expect(() => refuseSymlinkedDir(dir)).not.toThrow();
    expect(() => refuseSymlinkedDir(join(dir, 'missing'))).not.toThrow();
  });

  it('refuses a symlinked directory (attacker-directed write)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-out-'));
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(() => refuseSymlinkedDir(join(dir, 'link'))).toThrow(EvalUsageError);
  });
});
