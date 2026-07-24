// Named exports only (Week-4 fix of the E-3 review LOW; house rule since the
// E-4 verifier barrel): `export *` silently EXCLUDES any name two sub-barrels
// both export (ESM ambiguous-star semantics) — a collision would vanish from
// this barrel with no error anywhere. Named re-exports make a collision a
// compile error and this file the single audited public surface of the layer.
export {
  createGoldenRunner,
  DEFAULT_MAX_TURNS,
  EvalUsageError,
  GOLDEN_FAILURE_KINDS,
  loadOracle,
  parseTaskFile,
  toMarkdown,
  validateVerdict,
} from './golden/index.js';
export type {
  GoldenFailureKind,
  GoldenMeta,
  GoldenRow,
  GoldenRunner,
  GoldenRunnerDeps,
  GoldenScorecard,
  GoldenTask,
  GoldenTotals,
  LoadOracleFn,
  OracleFn,
  OracleVerdict,
  RowVolatile,
  RunOptions,
  TaskParseResult,
  TaskSessionConfig,
  VerificationSection,
} from './golden/index.js';
export {
  cleanForScorecard,
  computeByFailureKind,
  diffRows,
  escapeCell,
  MAX_REASON_LENGTH,
  stripBidi,
  toCanonicalJson,
  truncateWellFormed,
} from './scorecard/index.js';
export type {
  ChangedRow,
  Producer,
  RowDiff,
  ScorecardEnvelope,
  ScorecardRowCore,
  ScorecardTotalsCore,
} from './scorecard/index.js';
// Verifier surface (V15): the golden runner's own GoldenRunnerDeps.verifier
// field is typed against these, so consumers wiring a custom adversary need
// the full closure, including the enum types behind ChallengeFinding.
export {
  createVerifier,
  ADVERSARY_TIMEOUT_MS,
  CHALLENGE_CATEGORIES,
  MAX_ADVERSARY_RESPONSE_BYTES,
} from './verifier/index.js';
export type {
  AdversaryFn,
  AdversaryResult,
  ChallengeCategory,
  ChallengeErrorKind,
  ChallengeFinding,
  ChallengeInput,
  ChallengeStatus,
  Verifier,
} from './verifier/index.js';
export {
  BaselineError,
  CATEGORIES,
  classifyDrift,
  CORPUS,
  loadBaseline,
  MAX_BASELINE_BYTES,
  normalizeForBaseline,
  REDTEAM_ARM_LABEL,
  REDTEAM_FAILURE_KINDS,
  refuseAncestorSymlinks,
  refuseSymlink,
  renderDriftReport,
  runRedteam,
  toRedteamMarkdown,
  totalsMismatchDetail,
} from './redteam/index.js';
export type {
  BaselineMeta,
  BaselineScorecard,
  Category,
  CorpusCase,
  DriftFinding,
  DriftKind,
  RedteamFailureKind,
  RedteamMeta,
  RedteamRow,
  RedteamScorecard,
  RedteamTotals,
} from './redteam/index.js';
