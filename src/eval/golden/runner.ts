import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TaskDescriptor } from '../../router/index.js';
import type { RedactResult } from '../../security/index.js';
import type { Session, SessionResult } from '../../session/index.js';
import { cleanForScorecard, computeByFailureKind } from '../scorecard/index.js';
import type {
  GoldenFailureKind,
  GoldenRow,
  GoldenScorecard,
  GoldenTotals,
  TaskDirMeta,
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
  /** Null = no skills (see GoldenTask.skillsDir). */
  skillsDir: string | null;
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
  return {
    costUsd: null,
    numTurns: null,
    durationMs: null,
    resultSubtype: null,
    refusalSource: null,
    refusalFallbackModel: null,
  };
}

/** A non-finite cost (NaN/Infinity, from an untrusted SDK or adversary
 *  payload) is treated as unknown rather than summed — it falls into the
 *  existing unpriced accounting instead of poisoning a total (differential-
 *  review nit N2). */
function finiteCostOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The `meta.taskDir` pair for the scorecard (issues #62 and #64, ADR-0030).
 *
 * Contract: `taskDir` is populated only when the task directory is at or
 * under the working directory the run was invoked from. Any other invocation
 * stores null, with `taskDirForm: 'suppressed'` as the in-row signal
 * ADR-0027 decision 3 requires of a transform that may not apply. The field
 * semantics, and why null rather than a degraded value, live on the
 * `TaskDirMeta` type in scorecard-shape.ts.
 *
 * Why `relative()` and never `os.homedir()`: all three issue #59 designs
 * died keying on `$HOME`, an ambient value that is unrecorded in the
 * artefact and silently wrong under a different environment (ADR-0027
 * decision 3, and the R-17 residual). The only ambient value consulted here
 * is the caller's `cwd`, which cannot be well-formed but WRONG the way
 * `$HOME` can: it is the directory the run was actually invoked from, so
 * the transform cannot degrade into a no-op that reports success.
 *
 * Why suppress every walk-up: when `cwd` is not at or above `root`,
 * `relative()` walks UP to the common ancestor and back down, so the result
 * can spell out intervening absolute segments in a file whose purpose is to
 * be shared:
 *
 *     relative('/tmp/scratch', '/Users/<name>/clients/acme/tasks')
 *       -> '../../Users/<name>/clients/acme/tasks'
 *
 * Even the bounded sibling shape (`../tasks`, stored here until issue #64)
 * reveals the directory's own name, which is routinely a client or project
 * name, and no documented workflow produces it — so ALL `..`-leading forms
 * suppress, and ADR-0030 records the supersession of #62's sibling
 * behaviour.
 *
 * The classifier is a segment check, not a prefix check: a directory
 * literally named `..foo` under cwd is a legal name and stays populated.
 * Suppression is the fall-through rather than a positive match, so any
 * shape not positively recognised as at-or-under-cwd fails safe by removing
 * information instead of disclosing it. `isAbsolute(rel)` covers the
 * Windows cross-drive case, where `relative()` has no relative form and
 * returns an absolute path (reasoned, not executed: no Windows CI).
 *
 * `cwd` is a parameter rather than a direct `process.cwd()` read, following
 * the injected-seam style used throughout this codebase. It is what lets the
 * `root === cwd` boundary be tested at all: reaching it through `run()` would
 * require a `process.chdir`, which is unavailable in a worker thread and is
 * shared mutable state besides.
 */
export function portableTaskDir(root: string, cwd: string): TaskDirMeta {
  const rel = relative(cwd, root);
  // `relative(x, x)` is the empty string. An empty path is not a path, and it
  // would read as a missing field rather than as "the working directory".
  if (rel === '') return { taskDir: '.', taskDirForm: 'relative' };
  if (!isAbsolute(rel) && rel.split(sep)[0] !== '..') {
    return { taskDir: rel, taskDirForm: 'relative' };
  }
  return { taskDir: null, taskDirForm: 'suppressed' };
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

/** A per-entry challenge outcome: the finding to record plus its known cost
 *  (null when unknown/unpriced), before totals are folded in by the caller. */
interface ChallengeOutcome {
  finding: ChallengeFinding;
  costUsd: number | null;
}

/**
 * Redacts one row's resultText, then calls the verifier — both stages
 * guarded, both failure modes collapsing to the same `verifier-error`
 * contract so a throw from either can never escape phase 2 (review3 HIGH:
 * `Verifier` is a plain interface with no non-throwing contract; ADR-0020
 * §4's "adversary failure can never alter the authoritative result" floor
 * applies to a call that throws, not only one that resolves with an error
 * shape). Only called for entries whose `resultText` is non-null — the
 * caller handles the `no-output` case itself.
 */
async function challengeOutput(
  entry: ScoredRow,
  deps: ChallengePhaseDeps,
): Promise<ChallengeOutcome> {
  const taskId = entry.row.id;
  let redacted: RedactResult;
  try {
    redacted = deps.redactSecrets(entry.resultText as string);
  } catch {
    return {
      finding: { taskId, status: 'verifier-error', category: null, errorKind: 'redaction-failed' },
      costUsd: null,
    };
  }
  try {
    return await deps.verifier.challenge({
      taskId,
      taskPrompt: entry.prompt ?? '',
      redactedResultText: redacted.redacted,
    });
  } catch {
    return {
      finding: { taskId, status: 'verifier-error', category: null, errorKind: 'call-failed' },
      costUsd: null,
    };
  }
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
  const total = eligible.filter((s) => s.resultText !== null).length;
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

    const { finding, costUsd } = await challengeOutput(entry, deps);
    findings.push(finding);
    onProgress?.(`[challenge ${i}/${total}] ${taskId} … ${finding.status}`);
    const pricedCost = finiteCostOrNull(costUsd);
    if (pricedCost === null) {
      if (finding.status !== 'no-output' && finding.errorKind !== 'redaction-failed') {
        unpricedChallenges += 1;
      }
    } else {
      totalCostUsd += pricedCost;
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
      costUsd: finiteCostOrNull(result.costUsd),
      numTurns: result.numTurns,
      durationMs: now() - startedAt,
      resultSubtype: result.resultSubtype,
      // Already cleaned and bounded at capture (session layer).
      refusalSource: result.refusal?.source ?? null,
      refusalFallbackModel: result.refusal?.fallbackModel ?? null,
    };

    try {
      const verdict = validateVerdict(await oracle(result));
      // Raw output is retained only when phase 2 can ever consume it — a
      // plain oracle-only run (no --challenge) must not hold raw resultText
      // in memory it never retained before (review3 MEDIUM). runChallengePhase
      // is the only reader of these two fields (grep-verified) and it only
      // runs when deps.verifier is defined, so this gate has no other effect.
      const retain = verdict.pass && deps.verifier !== undefined;
      return {
        row: {
          id: task.id,
          pass: verdict.pass,
          failureKind: verdict.pass ? null : 'oracle-fail',
          reason: verdict.reason === undefined ? null : clean(verdict.reason),
          volatile,
        },
        model: result.modelChoice.model,
        resultText: retain ? result.resultText : null,
        prompt: retain ? task.prompt : null,
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
      // Captured ONCE, here, and used for both the resolve below and the
      // `meta.taskDir` write at the end of the run. Reading `process.cwd()`
      // again at write time would let the two operands disagree: oracles are
      // dynamically imported and execute in-process on the main thread, where
      // `process.chdir` is available, so a hostile task pack could move the
      // working directory between the two reads and put the absolute path
      // back into the field with `isAbsolute()` still false (review finding,
      // 2026-07-31). Reachable only with the arbitrary-code-execution
      // primitive that security-model R-10 already accepts, but the one-line
      // capture removes the window rather than reasoning about it.
      const invocationCwd = process.cwd();
      const root = resolve(invocationCwd, taskDir);
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
        meta: {
          createdAt,
          harnessVersion,
          ...portableTaskDir(root, invocationCwd),
          models: [...models].sort(),
        },
        rows: sorted,
        totals: computeTotals(sorted),
        ...(verification !== undefined && { verification }),
      };
    },
  };
}
