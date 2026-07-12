import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TaskDescriptor } from '../../router/index.js';
import type { RedactResult } from '../../security/index.js';
import type { Session, SessionResult } from '../../session/index.js';
import { cleanForScorecard, computeByFailureKind } from '../scorecard/index.js';
import type {
  GoldenFailureKind,
  GoldenRow,
  GoldenScorecard,
  GoldenTotals,
  VerificationSection,
} from './scorecard-shape.js';
import { GOLDEN_FAILURE_KINDS } from './scorecard-shape.js';
import type { LoadOracleFn } from './oracle.js';
import { loadOracle as defaultLoadOracle, validateVerdict } from './oracle.js';
import type { TaskParseResult } from './task.js';
import { parseTaskFile } from './task.js';
import type { ChallengeFinding, Verifier } from '../verifier/index.js';

/** Run-level usage/config errors (spec: arbiter condition 1) — CLI exit 2. */
export class EvalUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalUsageError';
  }
}

export interface TaskSessionConfig {
  skillsDir: string;
  descriptor?: TaskDescriptor;
  maxTurns: number;
}

export interface GoldenRunnerDeps {
  /** Composition root wires the real createSession; tests inject fakes. */
  createTaskSession: (config: TaskSessionConfig) => Session;
  /** Every string entering a scorecard row passes through this (spec decision #1). */
  redactSecrets: (text: string) => RedactResult;
  /** Injectable for error-path tests; defaults to the real dynamic import. */
  loadOracle?: LoadOracleFn;
  /** Injected clock (epoch ms) for deterministic tests. */
  now?: () => number;
  harnessVersion?: string;
  /** Presence enables phase 2 (E-4): challenge oracle-pass rows with output. */
  verifier?: Verifier;
}

export interface RunOptions {
  /** Per-task progress hook (the CLI writes these to stderr). */
  onProgress?: (line: string) => void;
}

export interface GoldenRunner {
  run(taskDir: string, opts?: RunOptions): Promise<GoldenScorecard>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function emptyVolatile(): GoldenRow['volatile'] {
  return { costUsd: null, numTurns: null, durationMs: null, resultSubtype: null };
}

function discoverTaskFiles(root: string): string[] {
  let entries;
  try {
    if (!statSync(root).isDirectory()) {
      throw new EvalUsageError(`not a directory: ${root}`);
    }
    entries = readdirSync(root, { withFileTypes: true });
  } catch (cause: unknown) {
    if (cause instanceof EvalUsageError) throw cause;
    throw new EvalUsageError(`cannot read task directory ${root}: ${errorMessage(cause)}`);
  }
  // Non-recursive in v1; ordinal sort for platform-independent row order.
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.task.md'))
    .map((e) => join(root, e.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (files.length === 0) {
    throw new EvalUsageError(`no *.task.md files found in ${root}`);
  }
  return files;
}

/** Duplicate row ids make the scorecard ambiguous — run-level, before any spend. */
function assertUniqueIds(parses: TaskParseResult[]): void {
  const seen = new Set<string>();
  for (const parse of parses) {
    const id = parse.ok ? parse.value.id : parse.rowId;
    if (seen.has(id)) {
      throw new EvalUsageError(`duplicate task id '${id}' across task files`);
    }
    seen.add(id);
  }
}

function computeTotals(rows: GoldenRow[]): GoldenTotals {
  const passed = rows.filter((r) => r.pass).length;
  const priced = rows.filter((r) => r.volatile.costUsd !== null);
  return {
    total: rows.length,
    passed,
    failed: rows.length - passed,
    byFailureKind: computeByFailureKind(rows, GOLDEN_FAILURE_KINDS),
    passRate: passed / rows.length,
    totalCostUsd: priced.reduce((sum, r) => sum + (r.volatile.costUsd ?? 0), 0),
    unpricedTasks: rows.length - priced.length,
  };
}

/**
 * A scored row, paired with the model that produced it (null if no session
 * ran/succeeded). `resultText`/`prompt` are retained in memory ONLY for the
 * phase-2 challenge — they are never copied onto `row` and must never reach
 * a scorecard; both are null on every path except an oracle-pass verdict.
 */
interface ScoredRow {
  row: GoldenRow;
  model: string | null;
  resultText: string | null;
  prompt: string | null;
}

/** Deps the challenge phase actually needs — a narrowed, non-optional slice. */
interface ChallengePhaseDeps {
  redactSecrets: (text: string) => RedactResult;
  verifier: Verifier;
}

/**
 * Phase 2 (E-4): challenge oracle-pass rows, ordered by row id, AFTER every
 * oracle has scored (phase 1's durationMs is already finalized — this phase
 * never touches the clock). `scored` entries with `pass !== true` are not
 * eligible; a `resultText === null` pass row is runner-constructed as
 * 'no-output' with no adversary call. Kept as a module-level function (not a
 * closure) so `run()` stays under 50 lines.
 */
async function runChallengePhase(
  scored: ScoredRow[],
  deps: ChallengePhaseDeps,
  onProgress?: (line: string) => void,
): Promise<VerificationSection> {
  const eligible = scored
    .filter((s) => s.row.pass === true)
    .sort((a, b) => (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  const withOutput = eligible.filter((s) => s.resultText !== null);
  const total = withOutput.length;
  onProgress?.(
    total > 0
      ? `warning: --challenge adds ${total} adversary call(s) (one per passed task with output)`
      : `--challenge: no adversary calls needed (0 passed tasks with output)`,
  );

  const findings: ChallengeFinding[] = [];
  let totalCostUsd = 0;
  let unpricedChallenges = 0;
  let i = 0;
  for (const entry of eligible) {
    const taskId = entry.row.id;
    if (entry.resultText === null) {
      findings.push({ taskId, status: 'no-output', category: null, errorKind: null });
      continue;
    }
    i += 1;

    let redacted: RedactResult;
    try {
      redacted = deps.redactSecrets(entry.resultText);
    } catch {
      const finding: ChallengeFinding = {
        taskId, status: 'verifier-error', category: null, errorKind: 'redaction-failed',
      };
      findings.push(finding);
      onProgress?.(`[challenge ${i}/${total}] ${taskId} … ${finding.status}`);
      continue;
    }

    const { finding, costUsd } = await deps.verifier.challenge({
      taskId,
      taskPrompt: entry.prompt ?? '',
      redactedResultText: redacted.redacted,
    });
    findings.push(finding);
    onProgress?.(`[challenge ${i}/${total}] ${taskId} … ${finding.status}`);
    if (costUsd === null) {
      if (finding.status !== 'no-output' && finding.errorKind !== 'redaction-failed') {
        unpricedChallenges += 1;
      }
    } else {
      totalCostUsd += costUsd;
    }
  }

  return {
    adversaryModelId: deps.verifier.adversaryModelId,
    findings,
    totals: {
      agreed: findings.filter((f) => f.status === 'agreed').length,
      challenged: findings.filter((f) => f.status === 'challenged').length,
      verifierErrors: findings.filter((f) => f.status === 'verifier-error').length,
      noOutput: findings.filter((f) => f.status === 'no-output').length,
    },
    totalCostUsd,
    unpricedChallenges,
  };
}

export function createGoldenRunner(deps: GoldenRunnerDeps): GoldenRunner {
  const loadOracle = deps.loadOracle ?? defaultLoadOracle;
  const now = deps.now ?? Date.now;
  const harnessVersion = deps.harnessVersion ?? '0.0.0-unknown';
  const clean = (text: string): string => cleanForScorecard(text, deps.redactSecrets);

  // id is NOT run through clean(): redacting a schema-valid id would corrupt
  // it, and every id reaching here is already safe — parse-failure ids are
  // bidi-stripped at parse time (before the uniqueness check), success-path
  // ids are regex-pinned by the schema.
  const failRow = (id: string, kind: GoldenFailureKind, reason: string): GoldenRow => ({
    id,
    pass: false,
    failureKind: kind,
    reason: clean(reason),
    volatile: emptyVolatile(),
  });

  // Sequential per-task execution with error isolation: any catchable failure
  // becomes a row with the right failureKind and the run continues. Each
  // outcome also carries the model choice (or null) so the caller can build
  // meta.models without re-deriving it from the rows.
  const scoreTask = async (parse: TaskParseResult): Promise<ScoredRow> => {
    if (!parse.ok) {
      return {
        row: failRow(parse.rowId, 'task-parse', parse.message),
        model: null,
        resultText: null,
        prompt: null,
      };
    }
    const task = parse.value;

    // Oracle load precedes the session run: a broken oracle must not spend.
    let oracle;
    try {
      oracle = await loadOracle(task.oraclePath);
    } catch (cause: unknown) {
      return {
        row: failRow(task.id, 'oracle-load', errorMessage(cause)),
        model: null,
        resultText: null,
        prompt: null,
      };
    }

    const startedAt = now();
    let result: SessionResult;
    try {
      const session = deps.createTaskSession({
        skillsDir: task.skillsDir,
        ...(task.descriptor !== undefined && { descriptor: task.descriptor }),
        maxTurns: task.maxTurns,
      });
      result = await session.run(task.prompt);
    } catch (cause: unknown) {
      const row = failRow(task.id, 'session-error', errorMessage(cause));
      return {
        row: { ...row, volatile: { ...row.volatile, durationMs: now() - startedAt } },
        model: null,
        resultText: null,
        prompt: null,
      };
    }
    const volatile = {
      costUsd: result.costUsd,
      numTurns: result.numTurns,
      durationMs: now() - startedAt,
      resultSubtype: result.resultSubtype,
    };

    try {
      const verdict = validateVerdict(await oracle(result));
      return {
        row: {
          id: task.id,
          pass: verdict.pass,
          failureKind: verdict.pass ? null : 'oracle-fail',
          reason: verdict.reason === undefined ? null : clean(verdict.reason),
          volatile,
        },
        model: result.modelChoice.model,
        resultText: verdict.pass ? result.resultText : null,
        prompt: verdict.pass ? task.prompt : null,
      };
    } catch (cause: unknown) {
      const row = failRow(task.id, 'oracle-error', errorMessage(cause));
      // The session ran (its cost is already in `volatile`/totalCostUsd)
      // even though the oracle threw — keep the model it used so
      // meta.models and totalCostUsd stay consistent.
      return {
        row: { ...row, volatile },
        model: result.modelChoice.model,
        resultText: null,
        prompt: null,
      };
    }
  };

  return {
    async run(taskDir: string, opts: RunOptions = {}): Promise<GoldenScorecard> {
      if (typeof taskDir !== 'string' || taskDir.length === 0) {
        throw new EvalUsageError('taskDir must be a non-empty string');
      }
      const root = resolve(taskDir);
      const files = discoverTaskFiles(root);
      const parses = files.map(parseTaskFile);
      assertUniqueIds(parses);
      opts.onProgress?.(
        `discovered ${parses.length} task${parses.length === 1 ? '' : 's'} in ${root}`,
      );

      // Phase 1: every oracle scores (durationMs finalized here — two-phase
      // is what makes the differential-invariance property hold) before
      // phase 2 (the challenge) is even considered.
      const scored: ScoredRow[] = [];
      const models = new Set<string>();
      const createdAt = new Date(now()).toISOString();
      for (const [index, parse] of parses.entries()) {
        const outcome = await scoreTask(parse);
        scored.push(outcome);
        if (outcome.model !== null) models.add(outcome.model);
        const { row } = outcome;
        const cost =
          row.volatile.costUsd === null ? '' : ` ($${row.volatile.costUsd.toFixed(4)})`;
        const label = row.pass ? `pass${cost}` : `fail (${row.failureKind ?? 'unknown'})${cost}`;
        opts.onProgress?.(`[${index + 1}/${parses.length}] ${row.id} … ${label}`);
      }

      const { redactSecrets } = deps;
      const verification =
        deps.verifier === undefined
          ? undefined
          : await runChallengePhase(
              scored,
              { redactSecrets, verifier: deps.verifier },
              opts.onProgress,
            );

      const rows = scored.map((s) => s.row);
      const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        schemaVersion: 1,
        producer: 'golden',
        meta: { createdAt, harnessVersion, taskDir: root, models: [...models].sort() },
        rows: sorted,
        totals: computeTotals(sorted),
        ...(verification !== undefined && { verification }),
      };
    },
  };
}
