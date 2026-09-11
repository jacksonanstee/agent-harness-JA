import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_ROUTING_TABLE, TASK_SENSITIVITIES, TASK_SHAPES } from '../router/index.js';
import { TELEMETRY_EVENT_TYPES } from '../telemetry/index.js';

import { readPackageVersion, USAGE, writeScorecard } from './shared.js';

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
      `       agent-harness-ja redteam [--out <dir>] [--update-baseline] [--baseline <path>] [--judge] [--judge-model <${TABLE_MODEL_IDS.join('|')}>] [--holdout <path>]`,
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

describe('readPackageVersion', () => {
  it('pins to the version in the repo package.json (catches ../package.json depth mistakes)', () => {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version: string };
    expect(readPackageVersion()).toBe(parsed.version);
  });
});
