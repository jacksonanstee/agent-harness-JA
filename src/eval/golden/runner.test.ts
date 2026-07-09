import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Session, SessionResult } from '../../session/index.js';
import { createGoldenRunner, EvalUsageError } from './runner.js';
import type { TaskSessionConfig } from './runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = (name: string) => join(here, '__fixtures__', name);

function fakeResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    resultText: 'alpha and beta',
    resultSubtype: 'success',
    sessionId: 's-1',
    modelChoice: { model: 'claude-sonnet-4-6', rule_id: 'r1', reason: 'test' },
    usage: null,
    costUsd: 0.01,
    numTurns: 2,
    denied: [],
    memoryEntryId: null,
    skillErrors: [],
    ...overrides,
  };
}

function fakeSessionFactory(
  results: SessionResult | ((config: TaskSessionConfig) => SessionResult),
  calls: TaskSessionConfig[] = [],
) {
  return (config: TaskSessionConfig): Session => {
    calls.push(config);
    return {
      run: () =>
        Promise.resolve(typeof results === 'function' ? results(config) : results),
    };
  };
}

// A deterministic fake clock: each call advances 100ms.
function fakeNow(): () => number {
  let t = 1_750_000_000_000;
  return () => (t += 100);
}

describe('createGoldenRunner run-level errors (exit-2 class)', () => {
  const deps = { createTaskSession: fakeSessionFactory(fakeResult()), now: fakeNow() };

  it('throws EvalUsageError for a missing task dir', async () => {
    const runner = createGoldenRunner(deps);
    await expect(runner.run(fixtures('nope'))).rejects.toThrow(EvalUsageError);
  });

  it('throws EvalUsageError when the dir has zero *.task.md files', async () => {
    const runner = createGoldenRunner(deps);
    await expect(runner.run(fixtures('empty'))).rejects.toThrow(/no \*\.task\.md/);
  });

  it('throws EvalUsageError on duplicate ids across files — before any session runs', async () => {
    const calls: TaskSessionConfig[] = [];
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult(), calls),
      now: fakeNow(),
    });
    await expect(runner.run(fixtures('dup'))).rejects.toThrow(/duplicate task id/);
    expect(calls).toHaveLength(0); // no spend before the dup check
  });
});

describe('createGoldenRunner rows', () => {
  it('scores pass/fail/parse-fail rows and keeps going (per-task isolation)', async () => {
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      now: fakeNow(),
      harnessVersion: '0.1.0-test',
    });
    const scorecard = await runner.run(fixtures('run'));

    expect(scorecard.schemaVersion).toBe(1);
    expect(scorecard.rows.map((r) => r.id)).toEqual(['alpha', 'beta', 'broken.task.md']);

    const alpha = scorecard.rows[0];
    expect(alpha?.pass).toBe(true);
    expect(alpha?.failureKind).toBeNull();
    expect(alpha?.volatile.costUsd).toBe(0.01);
    expect(alpha?.volatile.durationMs).not.toBeNull();

    const beta = scorecard.rows[1];
    expect(beta?.pass).toBe(false);
    expect(beta?.failureKind).toBe('oracle-fail');
    expect(beta?.reason).toBe('beta always fails');

    const broken = scorecard.rows[2];
    expect(broken?.pass).toBe(false);
    expect(broken?.failureKind).toBe('task-parse');
    expect(broken?.volatile.costUsd).toBeNull();

    expect(scorecard.totals).toEqual({
      tasks: 3,
      passed: 1,
      failed: 2,
      byFailureKind: {
        'task-parse': 1,
        'oracle-load': 0,
        'session-error': 0,
        'oracle-error': 0,
        'oracle-fail': 1,
      },
      passRate: 1 / 3,
      totalCostUsd: 0.02,
      unpricedTasks: 1,
    });
    expect(scorecard.meta.harnessVersion).toBe('0.1.0-test');
    expect(scorecard.meta.models).toEqual(['claude-sonnet-4-6']);
  });

  it('threads task config into the session factory', async () => {
    const calls: TaskSessionConfig[] = [];
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult(), calls),
      now: fakeNow(),
    });
    await runner.run(fixtures('run'));
    expect(calls[0]?.maxTurns).toBe(2); // alpha's frontmatter
    expect(calls[1]?.maxTurns).toBe(10); // beta defaults
    expect(calls[0]?.skillsDir).toBe(join(fixtures('run'), 'skills'));
  });

  it('turns a session throw into a session-error row and keeps going', async () => {
    const runner = createGoldenRunner({
      createTaskSession: () => ({
        run: () => Promise.reject(new Error('SDK exploded')),
      }),
      now: fakeNow(),
    });
    const scorecard = await runner.run(fixtures('run'));
    const alpha = scorecard.rows.find((r) => r.id === 'alpha');
    expect(alpha?.failureKind).toBe('session-error');
    expect(alpha?.reason).toContain('SDK exploded');
    expect(scorecard.rows).toHaveLength(3);
  });

  it('turns an oracle throw into an oracle-error row', async () => {
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      loadOracle: () => Promise.resolve(() => {
        throw new Error('oracle bug');
      }),
      now: fakeNow(),
    });
    const scorecard = await runner.run(fixtures('run'));
    const alpha = scorecard.rows.find((r) => r.id === 'alpha');
    expect(alpha?.failureKind).toBe('oracle-error');
    expect(alpha?.reason).toContain('oracle bug');
    // The session ran (and its cost is counted in totalCostUsd) even though
    // the oracle threw, so the model it used must still surface in meta.
    expect(scorecard.meta.models).toEqual(['claude-sonnet-4-6']);
  });

  it('turns a truthy-but-not-boolean verdict into an oracle-error row', async () => {
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      loadOracle: () =>
        Promise.resolve((() => ({ pass: 1 })) as unknown as () => { pass: boolean }),
      now: fakeNow(),
    });
    const scorecard = await runner.run(fixtures('run'));
    const alpha = scorecard.rows.find((r) => r.id === 'alpha');
    expect(alpha?.failureKind).toBe('oracle-error');
  });

  it('turns an unloadable oracle into an oracle-load row WITHOUT running a session', async () => {
    const calls: TaskSessionConfig[] = [];
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult(), calls),
      loadOracle: () => Promise.reject(new Error('no such oracle')),
      now: fakeNow(),
    });
    const scorecard = await runner.run(fixtures('run'));
    expect(scorecard.rows.find((r) => r.id === 'alpha')?.failureKind).toBe('oracle-load');
    expect(calls).toHaveLength(0); // oracle load precedes spend
  });

  it('redacts reasons through the injected redactor', async () => {
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      loadOracle: () =>
        Promise.resolve(() => ({ pass: false, reason: 'leaked sk-secret' })),
      redactSecrets: (t) => ({ redacted: t.replace('sk-secret', '[REDACTED]'), findings: [] }),
      now: fakeNow(),
    });
    const scorecard = await runner.run(fixtures('run'));
    const alpha = scorecard.rows.find((r) => r.id === 'alpha');
    expect(alpha?.reason).toBe('leaked [REDACTED]');
  });

  it('strips bidi controls from a failed-parse row id (hostile filename)', async () => {
    // A failed parse keys the row by the file's basename, which a hostile
    // repo can lace with an RLO; the id flows to progress lines, the
    // markdown table, and the JSON artifact. Stripping happens at parse
    // time, before the uniqueness check (E-1 differential review, F-1).
    const dir = mkdtempSync(join(tmpdir(), 'golden-bidi-'));
    writeFileSync(
      join(dir, 'payroll\u202Edm.task.md'),
      ['---', 'maxTurns: 2', '---', '', 'Reply with pong.', ''].join('\n'),
    );
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      now: fakeNow(),
    });
    const scorecard = await runner.run(dir);
    const row = scorecard.rows[0];
    expect(row?.failureKind).toBe('task-parse');
    expect(row?.id).toContain('payroll');
    expect(row?.id).not.toContain('\u202E');
  });

  it('fails loudly, pre-spend, when two bidi-distinct hostile filenames alias to one id', async () => {
    // RLO and LRM both strip to a space: if cleaning ran AFTER the
    // uniqueness check, these two files would silently share a row id in
    // the final scorecard. Cleaning at parse time turns that into the
    // duplicate-id run-level error instead.
    const dir = mkdtempSync(join(tmpdir(), 'golden-bidi-dup-'));
    const broken = ['---', 'maxTurns: 2', '---', '', 'Reply with pong.', ''].join('\n');
    writeFileSync(join(dir, 'a\u202E.task.md'), broken);
    writeFileSync(join(dir, 'a\u200E.task.md'), broken);
    const calls: TaskSessionConfig[] = [];
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult(), calls),
      now: fakeNow(),
    });
    await expect(runner.run(dir)).rejects.toThrow(/duplicate task id/);
    expect(calls).toHaveLength(0);
  });

  it('never redacts a schema-valid id, even one shaped like a secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-secret-id-'));
    const id = `sk-${'a'.repeat(48)}`; // matches the openai-legacy-key rule shape
    writeFileSync(
      join(dir, 'secret-shaped.task.md'),
      ['---', `id: ${id}`, '---', '', 'Reply with pong.', ''].join('\n'),
    );
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      loadOracle: () => Promise.reject(new Error('no such oracle')),
      redactSecrets: (t) => ({ redacted: t.replace(/sk-[a-z0-9]+/g, '[REDACTED]'), findings: [] }),
      now: fakeNow(),
    });
    const scorecard = await runner.run(dir);
    expect(scorecard.rows[0]?.failureKind).toBe('oracle-load');
    expect(scorecard.rows[0]?.id).toBe(id);
  });

  it('emits progress lines: discovery first, then one per task', async () => {
    const lines: string[] = [];
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      now: fakeNow(),
    });
    await runner.run(fixtures('run'), { onProgress: (l) => lines.push(l) });
    expect(lines[0]).toMatch(/discovered 3 tasks/);
    expect(lines[1]).toMatch(/^\[1\/3\] alpha … pass/);
    expect(lines[2]).toMatch(/^\[2\/3\] beta … fail \(oracle-fail\)/);
    expect(lines[3]).toMatch(/^\[3\/3\] broken\.task\.md … fail \(task-parse\)/);
  });
});
