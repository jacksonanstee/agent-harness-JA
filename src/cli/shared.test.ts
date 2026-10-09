import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ROUTING_TABLE, TASK_SENSITIVITIES, TASK_SHAPES } from '../router/index.js';
import { TELEMETRY_EVENT_TYPES } from '../telemetry/index.js';

import { apiKeyMissingMessage, loadSdkQuery, readPackageVersion, SDK_PACKAGE, USAGE, writeScorecard } from './shared.js';

/** The router table's model ids, deduplicated in first-appearance order: the
 *  same derivation the `--judge-model` usage list must use (issue #96, U-6). */
const TABLE_MODEL_IDS = [...new Set(DEFAULT_ROUTING_TABLE.map((rule) => rule.model))];

describe('USAGE', () => {
  /**
   * Asserts the RENDERED substring rather than looping `toContain(type)` over
   * the array. The loop form is a floorless subset check: an empty
   * TELEMETRY_EVENT_TYPES runs the body zero times and passes vacuously. The
   * rendered form cannot — an empty array joins to `''` and the expected
   * substring becomes `--type <>`, which USAGE does not contain. It is also
   * strictly stronger: a partial enumeration or a reordering fails too.
   *
   * ANCHORED TO THE `telemetry export` LINE, not to USAGE as a whole. Against
   * the whole blob the assertion is position-independent: interpolating onto
   * the `run` line while reverting this one to the literal `<t>` advertises
   * `--type` on a command that does not take it, leaves the command that DOES
   * need it undiscoverable, and still passes (Task 6 review finding).
   *
   * What it CANNOT prove is that USAGE derives the list rather than
   * hand-copying it — no test can, since both produce the same bytes. What it
   * does buy is the drift catch: add a fifth event type and a hand-copied
   * USAGE goes RED here.
   */
  it('enumerates every valid --type value on the telemetry line, from the same source of truth the validator uses', () => {
    const telemetryLine = USAGE.split('\n').find((line) => line.includes('telemetry export'));
    expect(telemetryLine).toBeDefined();
    expect(telemetryLine).toContain(`--type <${TELEMETRY_EVENT_TYPES.join('|')}>`);
  });

  /**
   * Same pattern and same rationale as the --type pin above, anchored to the
   * `run` line: the rendered join catches an empty, partial, or reordered
   * enumeration, and anchoring to the one line that takes the flags keeps a
   * cross-line interpolation from passing (issue #88).
   */
  it('enumerates every valid --shape and --sensitivity value on the run line, from the arrays route() enforces', () => {
    const runLine = USAGE.split('\n').find((line) => line.includes(' run '));
    expect(runLine).toBeDefined();
    expect(runLine).toContain(`--shape <${TASK_SHAPES.join('|')}>`);
    expect(runLine).toContain(`--sensitivity <${TASK_SENSITIVITIES.join('|')}>`);
    expect(runLine).toContain('--expected-tokens <n>');
  });

  // The eval line is a hand-written literal (no array to derive from), so this
  // is a literal-substring pin and nothing more (issue #95).
  it('names --max-tasks on the eval line (literal pin; the eval line is not derived)', () => {
    const evalLine = USAGE.split('\n').find((line) => line.includes(' eval '));
    expect(evalLine).toBeDefined();
    expect(evalLine).toContain('[--max-tasks <n>]');
  });

  // Issue #96 PR-A, pins 21 and 32: the redteam line gains the judge arm's
  // three flags, and the `--judge-model` list is RENDERED from the router
  // table the same way --shape/--type are (an empty or reordered table fails
  // here; a hand-copied list goes red the day the table changes).
  it('the redteam line names --judge, --holdout and a --judge-model list derived from the router table', () => {
    const redteamLine = USAGE.split('\n').find((line) => line.includes(' redteam '));
    expect(redteamLine).toBeDefined();
    expect(TABLE_MODEL_IDS.length).toBeGreaterThan(1);
    expect(redteamLine).toBe(
      `       agent-harness-ja redteam [--out <dir>] [--update-baseline] [--baseline <path>] [--judge] [--judge-model <${TABLE_MODEL_IDS.join('|')}>] [--holdout <path>] [--samples <n>]`,
    );
  });
});

describe('writeScorecard filename prefix (issue #96 pin 31)', () => {
  const dirs: string[] = [];
  const freshDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'write-scorecard-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });
  const NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
  const card = { rows: [] as { id: string }[] };

  it("default: 'scorecard-<stamp>.json' (the existing name, unchanged)", () => {
    const out = freshDir();
    const written = writeScorecard(card, out, NOW_MS);
    expect(written).toEqual({ ok: true, path: join(out, 'scorecard-2026-01-02T03-04-05Z.json') });
    expect(readdirSync(out)).toEqual(['scorecard-2026-01-02T03-04-05Z.json']);
  });

  it("with the prefix 'judge-scorecard': 'judge-scorecard-<stamp>.json', so two writes in one second cannot collide", () => {
    const out = freshDir();
    const heuristic = writeScorecard(card, out, NOW_MS);
    const judge = writeScorecard(card, out, NOW_MS, 'judge-scorecard');
    expect(heuristic).toEqual({ ok: true, path: join(out, 'scorecard-2026-01-02T03-04-05Z.json') });
    expect(judge).toEqual({ ok: true, path: join(out, 'judge-scorecard-2026-01-02T03-04-05Z.json') });
    expect(readdirSync(out).sort()).toEqual(['judge-scorecard-2026-01-02T03-04-05Z.json', 'scorecard-2026-01-02T03-04-05Z.json']);
  });
});

describe('writeScorecard never follows or replaces what is already at the name (issue #150)', () => {
  const NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
  const NAME = 'scorecard-2026-01-02T03-04-05Z.json';
  const card = { rows: [] as { id: string }[] };
  const dirs: string[] = [];
  const freshDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'write-scorecard-150-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a symlink planted at the exact name: ok false naming the path, target unchanged', () => {
    const out = freshDir();
    const target = join(freshDir(), 'victim.txt');
    writeFileSync(target, 'keep me');
    symlinkSync(target, join(out, NAME));
    const written = writeScorecard(card, out, NOW_MS);
    expect(written).toEqual({ ok: false, message: expect.stringContaining(join(out, NAME)) });
    expect(readFileSync(target, 'utf8')).toBe('keep me');
  });

  it('a dangling symlink at the name is refused too, and its target is not created', () => {
    const out = freshDir();
    const target = join(freshDir(), 'not-yet.txt');
    symlinkSync(target, join(out, NAME));
    expect(writeScorecard(card, out, NOW_MS).ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it('a regular file already at the name (a same-stamp re-run) is not overwritten', () => {
    const out = freshDir();
    writeFileSync(join(out, NAME), 'first run');
    const written = writeScorecard(card, out, NOW_MS);
    expect(written).toEqual({ ok: false, message: expect.stringContaining('refusing to overwrite') });
    expect(readFileSync(join(out, NAME), 'utf8')).toBe('first run');
  });

  it('the refusal message does not echo the existing file contents', () => {
    const out = freshDir();
    writeFileSync(join(out, NAME), 'SECRET-CONTENT');
    const written = writeScorecard(card, out, NOW_MS);
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.message).not.toContain('SECRET-CONTENT');
  });
});

describe('readPackageVersion', () => {
  it('pins to the version in the repo package.json (catches ../package.json depth mistakes)', () => {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version: string };
    expect(readPackageVersion()).toBe(parsed.version);
  });
});

// Architecture lens A-3: the key refusal and the SDK load-and-guard had a copy
// in each of cli.ts, eval-command.ts and redteam-command.ts, and only the
// redteam text was pinned. One helper each; every caller's text pinned here.
describe('apiKeyMissingMessage (architecture lens A-3)', () => {
  const tail =
    'Export it, then re-run:\n' +
    '  export ANTHROPIC_API_KEY=sk-ant-...\n\n' +
    'Get a key at https://console.anthropic.com/settings/keys\n';

  it('the run path: no reason clause', () => {
    expect(apiKeyMissingMessage()).toBe(`ANTHROPIC_API_KEY is not set.\n\n${tail}`);
  });

  it('eval and redteam --judge: the reason in parentheses before the full stop', () => {
    expect(apiKeyMissingMessage('required for eval')).toBe(`ANTHROPIC_API_KEY is not set (required for eval).\n\n${tail}`);
    expect(apiKeyMissingMessage('required for --judge; the red-team gate itself runs without it')).toBe(
      `ANTHROPIC_API_KEY is not set (required for --judge; the red-team gate itself runs without it).\n\n${tail}`,
    );
  });
});

describe('loadSdkQuery (architecture lens A-3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the one SDK package', () => {
    expect(SDK_PACKAGE).toBe('@anthropic-ai/claude-agent-sdk');
  });

  it('returns the module query() and writes nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const query = vi.fn();
    await expect(loadSdkQuery(() => Promise.resolve({ query }))).resolves.toBe(query);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('a module without query() is reported on stderr and read as null', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(loadSdkQuery(() => Promise.resolve({ query: 'not a function' }))).resolves.toBeNull();
    expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toEqual([
      'The installed @anthropic-ai/claude-agent-sdk does not export query(); check the SDK version.\n',
    ]);
  });

  it('an import rejection propagates: each caller keeps its own policy for it', async () => {
    await expect(loadSdkQuery(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});
