export { loadOracle, validateVerdict } from './oracle.js';
export type { LoadOracleFn, OracleFn, OracleVerdict } from './oracle.js';
export {
  createGoldenRunner,
  EvalUsageError,
} from './runner.js';
export type {
  GoldenRunner,
  GoldenRunnerDeps,
  RunOptions,
  TaskSessionConfig,
} from './runner.js';
export { DEFAULT_MAX_TURNS, parseTaskFile } from './task.js';
export { toMarkdown } from './markdown.js';
export type { GoldenTask, TaskParseResult } from './task.js';
export { GOLDEN_FAILURE_KINDS } from './scorecard-shape.js';
export type {
  GoldenFailureKind,
  GoldenMeta,
  GoldenRow,
  GoldenScorecard,
  GoldenTotals,
  RowVolatile,
  VerificationSection,
} from './scorecard-shape.js';
// Re-exported so a GoldenScorecard consumer can name a VerificationSection's
// finding shape without a deep import into ../verifier (review3 LOW L-4).
export type { ChallengeFinding } from '../verifier/index.js';
