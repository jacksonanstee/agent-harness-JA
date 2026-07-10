export { toCanonicalJson } from './canonical.js';
export { computeByFailureKind } from './core.js';
export { diffRows } from './diff.js';
export type { ChangedRow, RowDiff } from './diff.js';
export type { Producer, ScorecardEnvelope, ScorecardRowCore, ScorecardTotalsCore } from './core.js';
export { cleanForScorecard, escapeCell, MAX_REASON_LENGTH, stripBidi, truncateWellFormed } from './sanitize.js';
