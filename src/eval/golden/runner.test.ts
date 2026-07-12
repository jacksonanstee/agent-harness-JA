import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RedactResult } from '../../security/index.js';
import type { Session, SessionResult } from '../../session/index.js';
import { createGoldenRunner, EvalUsageError } from './runner.js';
import type { GoldenRunnerDeps, TaskSessionConfig } from './runner.js';
import type { LoadOracleFn } from './oracle.js';
import type {
  ChallengeCategory,
  ChallengeErrorKind,
  ChallengeFinding,
  ChallengeStatus,
  Verifier,
} from '../verifier/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = (name: string) => join(here, '__fixtures__', name);

// No-op redactor: the identity fake used everywhere a test doesn't care
// about redaction behavior specifically (redactSecrets is a required dep).
const identityRedact = (text: string): RedactResult => ({ redacted: text, findings: [] });

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

// Writes one minimal *.task.md per id into dir (phase-2 fixtures: oracle
// pass/fail is controlled by the injected loadOracle fake below, not by
// real sibling .oracle.mjs files, so no oracle files are needed on disk).
function writeTasks(dir: string, ids: string[]): void {
  for (const id of ids) {
    writeFileSync(
      join(dir, `${id}.task.md`),
      ['---', `id: ${id}`, 'maxTurns: 1', '---', '', `Reply for ${id}.`, ''].join('\n'),
    );
  }
}

// A loadOracle fake keyed by the sibling oracle path's basename (== task id,
// since writeTasks names files `${id}.task.md`), so oracle pass/fail is
// controllable per task id without touching resultText content.
function oracleFor(passIds: Set<string>): LoadOracleFn {
  return (path: string) => {
    const id = basename(path).replace(/\.oracle\.mjs$/, '');
    return Promise.resolve(() => ({ pass: passIds.has(id) }));
  };
}

// The fake verifier factory pinned in the task-6 brief: `script` maps taskId
// to the finding it should produce; `calls` records `${taskId}:${redactedResultText}`
// for every invocation, in call order.
interface FakeVerifierScriptEntry {
  status: ChallengeStatus;
  category?: ChallengeCategory | null;
  errorKind?: ChallengeErrorKind | null;
  costUsd?: number | null;
}

function fakeVerifier(
  script: Record<string, FakeVerifierScriptEntry>,
): Verifier & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    adversaryModelId: 'fake-adversary',
    async challenge({ taskId, redactedResultText }) {
      calls.push(`${taskId}:${redactedResultText}`);
      const s: FakeVerifierScriptEntry = script[taskId] ?? { status: 'agreed' };
      const finding: ChallengeFinding = {
        taskId,
        status: s.status,
        category: s.category ?? null,
        errorKind: s.errorKind ?? null,
      };
      return { finding, costUsd: s.costUsd === undefined ? 0.01 : s.costUsd };
    },
  };
}

describe('createGoldenRunner run-level errors (exit-2 class)', () => {
  const deps = {
    createTaskSession: fakeSessionFactory(fakeResult()),
    redactSecrets: (t: string) => identityRedact(t),
    now: fakeNow(),
  };

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
      redactSecrets: (t: string) => identityRedact(t),
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
      redactSecrets: (t: string) => identityRedact(t),
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
      total: 3,
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

  it('treats a non-finite session costUsd (Infinity) as unpriced, never summed (differential-review nit N2)', async () => {
    // A hostile/misbehaving SDK result reporting costUsd: Infinity must not
    // poison totalCostUsd (Infinity + anything = Infinity) or pass through
    // as a real price — it falls into the existing unpriced accounting,
    // same as an explicit costUsd: null.
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult({ costUsd: Infinity })),
      redactSecrets: (t: string) => identityRedact(t),
      now: fakeNow(),
    });
    const scorecard = await runner.run(fixtures('run'));

    const alpha = scorecard.rows.find((r) => r.id === 'alpha');
    expect(alpha?.volatile.costUsd).toBeNull();
    expect(scorecard.totals.totalCostUsd).toBe(0);
    expect(scorecard.totals.unpricedTasks).toBe(3);
  });

  it('threads task config into the session factory', async () => {
    const calls: TaskSessionConfig[] = [];
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult(), calls),
      redactSecrets: (t: string) => identityRedact(t),
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
      redactSecrets: (t: string) => identityRedact(t),
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
      redactSecrets: (t: string) => identityRedact(t),
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
      redactSecrets: (t: string) => identityRedact(t),
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
      redactSecrets: (t: string) => identityRedact(t),
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
      redactSecrets: (t: string) => identityRedact(t),
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
      redactSecrets: (t: string) => identityRedact(t),
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
      redactSecrets: (t: string) => identityRedact(t),
      now: fakeNow(),
    });
    await runner.run(fixtures('run'), { onProgress: (l) => lines.push(l) });
    expect(lines[0]).toMatch(/discovered 3 tasks/);
    expect(lines[1]).toMatch(/^\[1\/3\] alpha … pass/);
    expect(lines[2]).toMatch(/^\[2\/3\] beta … fail \(oracle-fail\)/);
    expect(lines[3]).toMatch(/^\[3\/3\] broken\.task\.md … fail \(task-parse\)/);
  });
});

describe('adversarial verification (E-4 phase 2)', () => {
  it('runs the challenge phase only after every oracle has scored (case 1: two-phase ordering)', async () => {
    const order: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'golden-phase2-order-'));
    writeTasks(dir, ['t1', 't2']);
    const sessionFactory = (): Session => ({
      run: () => {
        order.push('session');
        return Promise.resolve(fakeResult());
      },
    });
    const verifier: Verifier = {
      adversaryModelId: 'fake-adversary',
      async challenge({ taskId }) {
        order.push(`challenge:${taskId}`);
        return {
          finding: { taskId, status: 'agreed', category: null, errorKind: null },
          costUsd: 0.01,
        };
      },
    };
    const runner = createGoldenRunner({
      createTaskSession: sessionFactory,
      redactSecrets: (t: string) => identityRedact(t),
      loadOracle: oracleFor(new Set(['t1', 't2'])),
      verifier,
      now: fakeNow(),
    });
    await runner.run(dir);
    // Both session runs (phase 1) precede both challenge calls (phase 2) —
    // not just "eventually happens", but a hard ordering guarantee.
    expect(order).toEqual(['session', 'session', 'challenge:t1', 'challenge:t2']);
  });

  it('challenges only oracle-pass rows (case 2: pass, oracle-fail, pass → 2 calls)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-phase2-passonly-'));
    writeTasks(dir, ['a1', 'b2', 'c3']);
    const verifier = fakeVerifier({});
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      redactSecrets: (t: string) => identityRedact(t),
      loadOracle: oracleFor(new Set(['a1', 'c3'])), // b2 oracle-fails
      verifier,
      now: fakeNow(),
    });
    const scorecard = await runner.run(dir);
    expect(verifier.calls).toHaveLength(2);
    expect(scorecard.verification?.findings.map((f) => f.taskId)).toEqual(['a1', 'c3']);
  });

  it('a pass row with resultText: null becomes a no-output finding, zero calls (case 3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-phase2-nooutput-'));
    writeTasks(dir, ['solo']);
    const verifier = fakeVerifier({});
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult({ resultText: null })),
      redactSecrets: (t: string) => identityRedact(t),
      loadOracle: oracleFor(new Set(['solo'])),
      verifier,
      now: fakeNow(),
    });
    const scorecard = await runner.run(dir);
    expect(verifier.calls).toHaveLength(0);
    expect(scorecard.verification?.findings).toEqual([
      { taskId: 'solo', status: 'no-output', category: null, errorKind: null },
    ]);
  });

  it('a redactSecrets throw becomes verifier-error/redaction-failed, no call (case 4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-phase2-redactthrow-'));
    writeTasks(dir, ['solo']);
    const verifier = fakeVerifier({});
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      redactSecrets: () => {
        throw new Error('redactor exploded');
      },
      loadOracle: oracleFor(new Set(['solo'])),
      verifier,
      now: fakeNow(),
    });
    const scorecard = await runner.run(dir);
    expect(verifier.calls).toHaveLength(0);
    expect(scorecard.verification?.findings).toEqual([
      { taskId: 'solo', status: 'verifier-error', category: null, errorKind: 'redaction-failed' },
    ]);
  });

  it('sends the REDACTED text to the adversary, never the raw resultText (case 5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-phase2-redacted-payload-'));
    writeTasks(dir, ['solo']);
    const verifier = fakeVerifier({});
    const rawText = 'alpha and beta';
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult({ resultText: rawText })),
      redactSecrets: (t) => ({ redacted: `REDACTED:${t}`, findings: [] }),
      loadOracle: oracleFor(new Set(['solo'])),
      verifier,
      now: fakeNow(),
    });
    await runner.run(dir);
    expect(verifier.calls[0]?.endsWith(`REDACTED:${rawText}`)).toBe(true);
  });

  it('orders findings by taskId and computes totals/costs correctly (case 6)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-phase2-totals-'));
    // Filenames sort f1 < f2 < f3 (phase-1 processing order), but their ids
    // sort alpha < mike < zeta — the challenge phase must reorder by
    // row.id, not carry over the phase-1 file-processing order.
    const taskBody = (id: string) =>
      ['---', `id: ${id}`, 'maxTurns: 1', '---', '', 'Reply.', ''].join('\n');
    writeFileSync(join(dir, 'f1.task.md'), taskBody('zeta'));
    writeFileSync(join(dir, 'f2.task.md'), taskBody('alpha'));
    writeFileSync(join(dir, 'f3.task.md'), taskBody('mike'));
    const verifier = fakeVerifier({
      zeta: { status: 'agreed', costUsd: 0.01 },
      alpha: { status: 'challenged', category: 'incorrect', costUsd: 0.02 },
      mike: { status: 'verifier-error', errorKind: 'call-failed', costUsd: null },
    });
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      redactSecrets: (t: string) => identityRedact(t),
      // All three pass regardless of file/id naming — this case tests
      // ordering and totals, not pass/fail branching.
      loadOracle: () => Promise.resolve(() => ({ pass: true })),
      verifier,
      now: fakeNow(),
    });
    const scorecard = await runner.run(dir);
    const verification = scorecard.verification;
    expect(verification?.findings.map((f) => f.taskId)).toEqual(['alpha', 'mike', 'zeta']);
    expect(verification?.totals).toEqual({ agreed: 1, challenged: 1, verifierErrors: 1, noOutput: 0 });
    expect(verification?.totalCostUsd).toBeCloseTo(0.03);
    // mike's call was attempted (status !== 'no-output', errorKind !== 'redaction-failed')
    // and returned costUsd: null — the one attempted-but-unpriced case.
    expect(verification?.unpricedChallenges).toBe(1);
    expect(verification?.adversaryModelId).toBe('fake-adversary');
  });

  it('treats a non-finite adversary costUsd (NaN) as unpriced, never summed (differential-review nit N2)', async () => {
    // A hostile Verifier returning costUsd: NaN must not poison
    // totalCostUsd (NaN + anything = NaN) — it counts as unpriced instead,
    // same as an explicit costUsd: null.
    const dir = mkdtempSync(join(tmpdir(), 'golden-phase2-nan-cost-'));
    writeTasks(dir, ['solo']);
    const verifier = fakeVerifier({ solo: { status: 'agreed', costUsd: NaN } });
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      redactSecrets: (t: string) => identityRedact(t),
      loadOracle: oracleFor(new Set(['solo'])),
      verifier,
      now: fakeNow(),
    });
    const scorecard = await runner.run(dir);
    expect(scorecard.verification?.totalCostUsd).toBe(0);
    expect(scorecard.verification?.unpricedChallenges).toBe(1);
  });

  it('omits the verification key entirely when no verifier dep is supplied (case 7)', async () => {
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      redactSecrets: (t: string) => identityRedact(t),
      now: fakeNow(),
    });
    const scorecard = await runner.run(fixtures('run'));
    expect(scorecard.verification).toBeUndefined();
    expect('verification' in scorecard).toBe(false);
  });

  it(
    'no-verifier run retains no raw output: rows never carry resultText/prompt, ' +
      'and behavior is byte-for-byte the pre-E-4 shape (case 7b, review3 MEDIUM)',
    async () => {
      // Retention gating (runner.ts scoreTask: `retain = verdict.pass &&
      // deps.verifier !== undefined`) is intentionally module-internal:
      // ScoredRow.resultText/prompt are read nowhere except
      // runChallengePhase, which itself never runs without deps.verifier
      // (grep-verified — see the comment at the gate). There is therefore no
      // black-box surface a public-API test could observe the gate through
      // beyond what's asserted here: (a) GoldenRow never carries the raw
      // fields at all (the row type has no such fields — a structural
      // guarantee, checked at runtime too so a future field-add can't
      // silently reintroduce the leak) and (b) a no-verifier run's rows/
      // totals are identical to a run before E-4 ever retained anything.
      const runner = createGoldenRunner({
        createTaskSession: fakeSessionFactory(fakeResult()),
        redactSecrets: (t: string) => identityRedact(t),
        now: fakeNow(),
        harnessVersion: '0.1.0-test',
      });
      const scorecard = await runner.run(fixtures('run'));
      for (const row of scorecard.rows) {
        expect('resultText' in row).toBe(false);
        expect('prompt' in row).toBe(false);
      }
      expect(scorecard.verification).toBeUndefined();
      // Same totals shape as the pre-E-4 'scores pass/fail/parse-fail rows'
      // test above — the retention gate must not perturb ordinary runs.
      expect(scorecard.totals).toEqual({
        total: 3,
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
    },
  );

  it('DIFFERENTIAL INVARIANCE: verifier presence never changes rows/totals (case 8, arbiter condition 2)', async () => {
    // Each call to buildDeps() mints a FRESH clock and FRESH session fake —
    // a shared mutable counter across both runs would carry state into run
    // 2 and diverge the timestamps, failing this test for the wrong reason.
    const buildDeps = (withVerifier: boolean): GoldenRunnerDeps => {
      const base: GoldenRunnerDeps = {
        createTaskSession: fakeSessionFactory(fakeResult()),
        redactSecrets: (t: string) => identityRedact(t),
        now: fakeNow(),
      };
      return withVerifier ? { ...base, verifier: fakeVerifier({}) } : base;
    };
    const without = await createGoldenRunner(buildDeps(false)).run(fixtures('run'));
    const withV = await createGoldenRunner(buildDeps(true)).run(fixtures('run'));

    expect(withV.rows).toEqual(without.rows);
    expect(withV.totals).toEqual(without.totals);
    expect(withV.totals.failed).toBe(without.totals.failed); // exit-derivation equality
    expect(Object.keys(withV).sort()).toEqual([...Object.keys(without), 'verification'].sort());
    expect(without.verification).toBeUndefined();
    expect(withV.verification).toBeDefined();
  });

  it('a verifier.challenge() throw becomes verifier-error/call-failed and the run completes (case 10, review3 HIGH)', async () => {
    // A hostile/buggy Verifier implementation that throws instead of
    // resolving must not escape run() — Verifier is a plain interface with
    // no non-throwing contract, and ADR-0020's "adversary failure can never
    // alter the authoritative result" floor must hold even here: rows,
    // totals, and the rest of the scorecard must still be produced.
    const dir = mkdtempSync(join(tmpdir(), 'golden-phase2-throw-'));
    writeTasks(dir, ['a1', 'b2']);
    const verifier: Verifier = {
      adversaryModelId: 'fake-adversary',
      async challenge({ taskId }) {
        if (taskId === 'a1') throw new Error('adversary exploded');
        return {
          finding: { taskId, status: 'agreed', category: null, errorKind: null },
          costUsd: 0.01,
        };
      },
    };
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      redactSecrets: (t: string) => identityRedact(t),
      loadOracle: oracleFor(new Set(['a1', 'b2'])),
      verifier,
      now: fakeNow(),
    });
    const scorecard = await runner.run(dir);
    expect(scorecard.verification?.findings).toEqual([
      { taskId: 'a1', status: 'verifier-error', category: null, errorKind: 'call-failed' },
      { taskId: 'b2', status: 'agreed', category: null, errorKind: null },
    ]);
    // The throw is confined to the challenge phase — oracle rows/totals are
    // untouched (report-only floor holds for a hostile Verifier too).
    expect(scorecard.rows.every((r) => r.pass)).toBe(true);
    expect(scorecard.totals.failed).toBe(0);
    expect(scorecard.verification?.totals).toEqual({
      agreed: 1, challenged: 0, verifierErrors: 1, noOutput: 0,
    });
    // Unpriced: the throw path has no costUsd, and it's not a
    // redaction-failed/no-output finding, so it counts as an unpriced
    // attempted call (same branch a call-failed timeout already uses).
    expect(scorecard.verification?.unpricedChallenges).toBe(1);
  });

  it('emits phase-boundary progress lines: warning(N), N=0 variant, one [challenge i/N] per call (case 9)', async () => {
    // N > 0: warning + one indexed line per adversary-eligible task.
    const dirN = mkdtempSync(join(tmpdir(), 'golden-phase2-progress-'));
    writeTasks(dirN, ['a1', 'b2']);
    const verifierN = fakeVerifier({
      a1: { status: 'agreed' },
      b2: { status: 'challenged', category: 'incorrect' },
    });
    const linesN: string[] = [];
    const runnerN = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      redactSecrets: (t: string) => identityRedact(t),
      loadOracle: oracleFor(new Set(['a1', 'b2'])),
      verifier: verifierN,
      now: fakeNow(),
    });
    await runnerN.run(dirN, { onProgress: (l) => linesN.push(l) });
    expect(linesN).toContain(
      'warning: --challenge adds 2 adversary call(s) (one per passed task with output)',
    );
    expect(linesN).toContain('[challenge 1/2] a1 … agreed');
    expect(linesN).toContain('[challenge 2/2] b2 … challenged');

    // N = 0: every pass row is no-output, so no adversary calls are made and
    // no [challenge i/N] lines appear.
    const dirZero = mkdtempSync(join(tmpdir(), 'golden-phase2-progress-zero-'));
    writeTasks(dirZero, ['a1', 'b2']);
    const verifierZero = fakeVerifier({});
    const linesZero: string[] = [];
    const runnerZero = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult({ resultText: null })),
      redactSecrets: (t: string) => identityRedact(t),
      loadOracle: oracleFor(new Set(['a1', 'b2'])),
      verifier: verifierZero,
      now: fakeNow(),
    });
    await runnerZero.run(dirZero, { onProgress: (l) => linesZero.push(l) });
    expect(linesZero).toContain(
      '--challenge: no adversary calls needed (0 passed tasks with output)',
    );
    expect(linesZero.some((l) => l.startsWith('[challenge'))).toBe(false);
    expect(verifierZero.calls).toHaveLength(0);
  });
});
