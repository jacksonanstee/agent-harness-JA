import { escapeCell } from '../scorecard/index.js';
import { CATEGORIES } from './types.js';
import type { RedteamRow, RedteamScorecard } from './runner.js';

/** Row outcome label — deliberately distinct from golden's pass?'pass':'FAIL'
 *  (decision log CG11/UA9): the bare word FAIL must never render for a
 *  malicious/benign row, and only a false-block gets an alarming style. */
function rowOutcome(row: RedteamRow): string {
  if (row.category === 'benign') {
    if (row.failureKind === 'false-block') return '**BLOCKED**';
    if (row.failureKind === 'false-flag') return 'flagged';
    return 'ok';
  }
  return row.failureKind === 'missed' ? 'MISSED' : 'detected';
}

function rowLine(row: RedteamRow): string {
  return `| ${escapeCell(row.id)} | ${row.category} | ${row.verdict} | ${row.expected} | ${rowOutcome(row)} | ${escapeCell(row.reason)} |`;
}

/** Per-category counts in the corpus's fixed taxonomy order, zero counts omitted. */
function categoryCounts(rows: readonly RedteamRow[]): string {
  return CATEGORIES.map((cat) => [cat, rows.filter((r) => r.category === cat).length] as const)
    .filter(([, count]) => count > 0)
    .map(([cat, count]) => `${cat}: ${count}`)
    .join(', ');
}

/**
 * Gate-first summary, THEN the per-case table (golden's totals-first house
 * style, spec decision #20). The off-arm baseline is a guaranteed-zero
 * null-scanner control (decision log CG11/UA9): a scanner that never blocks
 * or flags detects zero malicious cases by construction, so it is computed
 * here at render time from `totals.malicious` — never read from a stored
 * field, because there is nothing to store.
 */
export function toRedteamMarkdown(scorecard: RedteamScorecard): string {
  const { totals, meta, rows } = scorecard;
  const gate = totals.falseBlockCount === 0 ? 'PASS' : 'FAIL';
  const detectionPct =
    totals.malicious === 0 ? '0.0' : ((totals.detected / totals.malicious) * 100).toFixed(1);
  const lines = [
    '# Red-team scorecard',
    '',
    `- **Gate: ${gate}** — false-blocks: ${totals.falseBlockCount}`,
    `- **Detection:** ${totals.detected}/${totals.malicious} malicious (${detectionPct}%) — blocked ${totals.blocked} / flagged-only ${totals.flaggedOnly}`,
    `- **Off-arm baseline:** 0/${totals.malicious} malicious detected (guaranteed-zero null-scanner control)`,
    `- **Corpus:** ${meta.corpusSize} case${meta.corpusSize === 1 ? '' : 's'} (${categoryCounts(rows)})`,
    `- **Arm:** ${meta.armLabel} · Created: ${meta.createdAt} · harness v${meta.harnessVersion}`,
    '',
    '| id | category | verdict | expected | outcome | reason |',
    '|----|----------|---------|----------|---------|--------|',
    ...rows.map(rowLine),
    '',
    '_Verdict deltas across arms (this scorecard vs. the off-arm control) will surface in the E-3 baseline diff._',
  ];
  return lines.join('\n');
}
