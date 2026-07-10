import { describe, expect, it } from 'vitest';
import { scan } from '../../security/index.js';
import { CORPUS, runRedteam } from './index.js';

/**
 * Non-gating drift diagnostic (ADR-0018 decision 8; decision log CG7).
 *
 * Re-derives each corpus case's CURRENT live `scan()` verdict and prints any
 * drift from its recorded `expected` value. A verdict flip can be the
 * legitimate result of a deliberate rule-confidence change made in the same
 * commit (the recalibration policy) — it is diagnostic evidence for the
 * maintainer-as-adjudicator, never an assertion. This file's only
 * failing-capable expectations are trivially-true corpus invariants
 * (non-empty, scannable). There is deliberately NO hardcoded detection-rate
 * threshold anywhere in this file — that would silently re-become the
 * per-PR gate S1 removed (decision log UA2).
 */
describe('red-team drift diagnostic (non-gating)', () => {
  it('prints live-vs-expected drift and the measured detection rate, without asserting on either', () => {
    const scorecard = runRedteam(CORPUS, scan, { armLabel: 'security-on (live, drift check)', now: () => 0 });

    for (const row of scorecard.rows) {
      if (row.verdict !== row.expected) {
        console.info(
          `drift: ${row.id} (${row.category}) expected=${row.expected} live=${row.verdict}`,
        );
      }
    }

    const { detected, malicious } = scorecard.totals;
    console.info(`detection ${detected}/${malicious}`);

    // Trivially-true invariant: the corpus produced a scanned row for every
    // case. NOT a detection-rate assertion — see file header.
    expect(scorecard.rows.length).toBe(CORPUS.length);
    expect(malicious).toBeGreaterThan(0);
  });
});
