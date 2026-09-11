import { escapeCell } from '../scorecard/index.js';
import type { ModeTotals, RedteamJudgeRow, RedteamJudgeScorecard, Slice } from './judge-runner.js';
import { CATEGORIES } from './types.js';
import type { Category } from './types.js';

// Renders the judge scorecard (issue #96 PR-A, ADR-0036 D6 "Markdown", U-7).
// Report-only: the first line says so, nothing here is a gate, the bare word
// FAIL never renders (the red-team house rule, CG11/UA9), and the rows carry
// no case text to leak. `byMode` is not stored on the scorecard; this
// renderer reads `bySlice` (YAGNI 1). Ends with exactly one newline so the
// machine-readable line the CLI prints after it starts at column 0 (U-3).

const money = (value: number): string => `$${value.toFixed(4)}`;

function costLine(totals: RedteamJudgeScorecard['totals']): string {
  if (totals.attempted === 0) return 'Judge cost: none (no calls attempted)';
  const unpriced = `${totals.costUnknown} call${totals.costUnknown === 1 ? '' : 's'} unpriced`;
  if (totals.costUsd === null) return `Judge cost: unknown (${unpriced})`;
  // Golden's floor form: unpriced calls were still made, so the sum is a floor.
  return totals.costUnknown === 0 ? `Judge cost: ${money(totals.costUsd)}` : `Judge cost: ≥ ${money(totals.costUsd)} (${unpriced})`;
}

function modeLine(slice: Slice, mode: 'always' | 'suspicious', m: ModeTotals): string {
  return (
    `- **${slice} / ${mode}:** detected ${m.detected}/${m.malicious} malicious; ` +
    `blocked ${m.blocked} / flagged-only ${m.flaggedOnly}; missed ${m.missed}; ` +
    `benign judged ${m.benignJudged}; false-blocks ${m.falseBlockCount}; false-flags ${m.falseFlagCount}`
  );
}

/** Per-category counts in the corpus's fixed taxonomy order, every category shown (zeros included: a zero is the finding). */
function categoryLine(label: string, counts: Record<Category, number>): string {
  return `- ${label}: ${CATEGORIES.map((c) => `${c}: ${counts[c]}`).join(', ')}`;
}

function rowLine(row: RedteamJudgeRow): string {
  const cells = [
    escapeCell(row.id),
    row.slice,
    row.category,
    row.expected,
    row.heuristic,
    row.judge ?? '-',
    row.composedAlways,
    row.composedSuspicious,
    row.status,
    escapeCell(row.reason),
  ];
  return `| ${cells.join(' | ')} |`;
}

/**
 * First line, legend, meta, the per-slice and per-mode lines, the cost
 * floor, the by-category split lines, then the table (totals first, the
 * house style).
 */
export function toRedteamJudgeMarkdown(scorecard: RedteamJudgeScorecard): string {
  const { totals, meta, rows } = scorecard;
  const lines = [
    '# Judge scorecard (report-only; not the gate)',
    '',
    '- **Legend:** `always` = every non-block heuristic result is escalated to the judge; `suspicious` = only results the heuristic marked suspicious are',
    '- **Legend:** `judgeOnly` = heuristic `pass`, judge escalated (the contextual reading); `confirmed` = heuristic `ask`, judge escalated to `block`',
    `- **Model:** ${meta.judgeModel} · Arm: ${meta.armLabel} · Corpus: ${meta.corpusSize} case${meta.corpusSize === 1 ? '' : 's'} · Holdout: ${meta.holdoutSize} case${meta.holdoutSize === 1 ? '' : 's'} · Created: ${meta.createdAt} · harness v${meta.harnessVersion}`,
    modeLine('corpus', 'always', totals.bySlice.corpus.always),
    modeLine('corpus', 'suspicious', totals.bySlice.corpus.suspicious),
    modeLine('holdout', 'always', totals.bySlice.holdout.always),
    modeLine('holdout', 'suspicious', totals.bySlice.holdout.suspicious),
    `- **Calls:** attempted ${totals.attempted}, judged ${totals.judged}, errors ${totals.judgeErrors}`,
    `- ${costLine(totals)}`,
    categoryLine('judgeOnly by category', totals.judgeOnlyByCategory),
    categoryLine('confirmed from ask by category', totals.confirmedFromAskByCategory),
    ...(totals.stoppedEarly
      ? [`- **Run stopped early:** ${totals.attempted} consecutive judge failures with nothing judged; the rows below are the calls attempted`]
      : []),
    '',
    '| id | slice | category | expected | heuristic | judge | always | suspicious | status | reason |',
    '|----|-------|----------|----------|-----------|-------|--------|------------|--------|--------|',
    ...rows.map(rowLine),
  ];
  return `${lines.join('\n')}\n`;
}
