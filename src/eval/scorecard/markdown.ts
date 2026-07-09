import type { Scorecard, ScorecardRow } from './types.js';
import { FAILURE_KINDS } from './types.js';

/** Table cells stay one short line; full detail lives only in the JSON. */
const MAX_CELL_LENGTH = 120;

function escapeCell(text: string): string {
  const oneLine = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return oneLine.length > MAX_CELL_LENGTH
    ? `${oneLine.slice(0, MAX_CELL_LENGTH)}…`
    : oneLine;
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

function rowLine(row: ScorecardRow): string {
  const result = row.pass ? 'pass' : 'FAIL';
  const kind = row.failureKind ?? '—';
  const reason = row.reason === null ? '—' : escapeCell(row.reason);
  const cost = row.volatile.costUsd === null ? 'n/a' : money(row.volatile.costUsd);
  const turns = row.volatile.numTurns === null ? 'n/a' : String(row.volatile.numTurns);
  const duration =
    row.volatile.durationMs === null
      ? 'n/a'
      : `${(row.volatile.durationMs / 1000).toFixed(1)}s`;
  return `| ${escapeCell(row.id)} | ${result} | ${kind} | ${reason} | ${cost} | ${turns} | ${duration} |`;
}

/** Totals first (spec decision #20), then the per-task table. */
export function toMarkdown(scorecard: Scorecard): string {
  const { totals, meta } = scorecard;
  const pct = (totals.passRate * 100).toFixed(1);
  const cost =
    totals.unpricedTasks === 0
      ? money(totals.totalCostUsd)
      : `≥ ${money(totals.totalCostUsd)} (${totals.unpricedTasks} task${
          totals.unpricedTasks === 1 ? '' : 's'
        } unpriced)`;
  const lines = [
    '# Golden eval scorecard',
    '',
    `- **Tasks:** ${totals.tasks} — ${totals.passed} passed / ${totals.failed} failed (pass rate ${pct}%)`,
    `- **Cost:** ${cost}`,
    `- **Created:** ${meta.createdAt} · harness v${meta.harnessVersion}`,
  ];
  const kinds = FAILURE_KINDS.filter((kind) => totals.byFailureKind[kind] > 0)
    .map((kind) => `${kind}: ${totals.byFailureKind[kind]}`)
    .join(', ');
  if (kinds !== '') lines.push(`- **Failures by kind:** ${kinds}`);
  lines.push(
    '',
    '| task | result | failure kind | reason | cost | turns | duration |',
    '|------|--------|--------------|--------|------|-------|----------|',
    ...scorecard.rows.map(rowLine),
    '',
  );
  return lines.join('\n');
}
