import type { ScorecardEnvelope } from '../scorecard/index.js';
import type { RedteamMeta, RedteamRow, RedteamScorecard, RedteamTotals } from './runner.js';

/** Non-volatile meta kept in the committed baseline (design §Baseline artifact). */
export interface BaselineMeta {
  corpusSize: number;
  armLabel: string;
}

export type BaselineScorecard = ScorecardEnvelope<BaselineMeta, RedteamRow, RedteamTotals>;

/**
 * THE normalization (design CG9 — exactly one implementation): strips the two
 * volatile meta fields (createdAt, harnessVersion); everything else is kept
 * verbatim. Row fields are contractually deterministic (design GM2) —
 * volatility is only ever permitted in meta, where this function strips it.
 */
export function normalizeForBaseline(scorecard: RedteamScorecard): BaselineScorecard {
  return {
    schemaVersion: scorecard.schemaVersion,
    producer: scorecard.producer,
    meta: { corpusSize: scorecard.meta.corpusSize, armLabel: scorecard.meta.armLabel },
    rows: [...scorecard.rows],
    totals: { ...scorecard.totals },
  };
}

/** GM2 tripwire: adding a field to RedteamMeta is a compile error here until
 *  it is explicitly classified — kept (add to BaselineMeta) or volatile (add
 *  to this dropped-fields union). */
type DroppedMetaField = 'createdAt' | 'harnessVersion';
type UnclassifiedMetaField = Exclude<keyof RedteamMeta, keyof BaselineMeta | DroppedMetaField>;
const _metaExhaustive: UnclassifiedMetaField extends never
  ? true
  : ['unclassified RedteamMeta field', UnclassifiedMetaField] = true;
void _metaExhaustive;
