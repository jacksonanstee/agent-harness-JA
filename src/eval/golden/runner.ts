import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TaskDescriptor } from '../../router/index.js';
import type { RedactResult } from '../../security/index.js';
import type { Session, SessionResult } from '../../session/index.js';
import type {
  FailureKind,
  Scorecard,
  ScorecardRow,
  ScorecardTotals,
} from '../scorecard/index.js';
import { cleanForScorecard, FAILURE_KINDS } from '../scorecard/index.js';
import type { LoadOracleFn } from './oracle.js';
import { loadOracle as defaultLoadOracle, validateVerdict } from './oracle.js';
import type { TaskParseResult } from './task.js';
import { parseTaskFile } from './task.js';

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
  redactSecrets?: (text: string) => RedactResult;
  /** Injectable for error-path tests; defaults to the real dynamic import. */
  loadOracle?: LoadOracleFn;
  /** Injected clock (epoch ms) for deterministic tests. */
  now?: () => number;
  harnessVersion?: string;
}

export interface RunOptions {
  /** Per-task progress hook (the CLI writes these to stderr). */
  onProgress?: (line: string) => void;
}

export interface GoldenRunner {
  run(taskDir: string, opts?: RunOptions): Promise<Scorecard>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function emptyVolatile(): ScorecardRow['volatile'] {
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

function computeTotals(rows: ScorecardRow[]): ScorecardTotals {
  const byFailureKind = Object.fromEntries(
    FAILURE_KINDS.map((kind) => [kind, rows.filter((r) => r.failureKind === kind).length]),
  ) as Record<FailureKind, number>;
  const passed = rows.filter((r) => r.pass).length;
  const priced = rows.filter((r) => r.volatile.costUsd !== null);
  return {
    tasks: rows.length,
    passed,
    failed: rows.length - passed,
    byFailureKind,
    passRate: passed / rows.length,
    totalCostUsd: priced.reduce((sum, r) => sum + (r.volatile.costUsd ?? 0), 0),
    unpricedTasks: rows.length - priced.length,
  };
}

/** A scored row, paired with the model that produced it (null if no session ran/succeeded). */
interface ScoredRow {
  row: ScorecardRow;
  model: string | null;
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
  const failRow = (id: string, kind: FailureKind, reason: string): ScorecardRow => ({
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
    if (!parse.ok) return { row: failRow(parse.rowId, 'task-parse', parse.message), model: null };
    const task = parse.value;

    // Oracle load precedes the session run: a broken oracle must not spend.
    let oracle;
    try {
      oracle = await loadOracle(task.oraclePath);
    } catch (cause: unknown) {
      return { row: failRow(task.id, 'oracle-load', errorMessage(cause)), model: null };
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
      };
    } catch (cause: unknown) {
      const row = failRow(task.id, 'oracle-error', errorMessage(cause));
      // The session ran (its cost is already in `volatile`/totalCostUsd)
      // even though the oracle threw — keep the model it used so
      // meta.models and totalCostUsd stay consistent.
      return { row: { ...row, volatile }, model: result.modelChoice.model };
    }
  };

  return {
    async run(taskDir: string, opts: RunOptions = {}): Promise<Scorecard> {
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

      const rows: ScorecardRow[] = [];
      const models = new Set<string>();
      const createdAt = new Date(now()).toISOString();
      for (const [index, parse] of parses.entries()) {
        const { row, model } = await scoreTask(parse);
        rows.push(row);
        if (model !== null) models.add(model);
        const cost =
          row.volatile.costUsd === null ? '' : ` ($${row.volatile.costUsd.toFixed(4)})`;
        const outcome = row.pass ? `pass${cost}` : `fail (${row.failureKind ?? 'unknown'})${cost}`;
        opts.onProgress?.(`[${index + 1}/${parses.length}] ${row.id} … ${outcome}`);
      }

      const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        schemaVersion: 1,
        meta: { createdAt, harnessVersion, taskDir: root, models: [...models].sort() },
        rows: sorted,
        totals: computeTotals(sorted),
      };
    },
  };
}
