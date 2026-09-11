export { runRedteam, REDTEAM_FAILURE_KINDS } from './runner.js';
export type {
  RedteamFailureKind,
  RedteamMeta,
  RedteamRow,
  RedteamScorecard,
  RedteamTotals,
} from './runner.js';
// The measured judge arm (issue #96, ADR-0036 D5/D6).
export { DEFAULT_EARLY_STOP_AFTER, runRedteamJudge } from './judge-runner.js';
export type {
  JudgeStatus,
  ModeTotals,
  RedteamJudgeDeps,
  RedteamJudgeMeta,
  RedteamJudgeRow,
  RedteamJudgeScorecard,
  RedteamJudgeTotals,
  Slice,
} from './judge-runner.js';
export { toRedteamJudgeMarkdown } from './judge-markdown.js';
export { HoldoutError, loadHoldout, MAX_HOLDOUT_BYTES, MAX_HOLDOUT_CASES } from './holdout.js';
export type { HoldoutCase } from './holdout.js';
export {
  BaselineError,
  classifyDrift,
  loadBaseline,
  MAX_BASELINE_BYTES,
  normalizeForBaseline,
  refuseAncestorSymlinks,
  refuseSymlink,
  renderDriftReport,
  totalsMismatchDetail,
} from './baseline.js';
export type { BaselineMeta, BaselineScorecard, DriftFinding, DriftKind } from './baseline.js';
export { toRedteamMarkdown } from './markdown.js';
export { CORPUS } from './corpus.js';
export { CATEGORIES, REDTEAM_ARM_LABEL } from './types.js';
export type { Category, CorpusCase } from './types.js';
