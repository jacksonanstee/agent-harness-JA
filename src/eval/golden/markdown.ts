import { formatUsd } from '../../internal/money.js';
import { escapeCell } from '../scorecard/index.js';
import { GOLDEN_FAILURE_KINDS } from './scorecard-shape.js';
import type { GoldenRow, GoldenScorecard } from './scorecard-shape.js';
import type { ChallengeFinding } from '../verifier/types.js';

function rowLine(row: GoldenRow): string {
  const result = row.pass ? 'pass' : 'FAIL';
  const kind = row.failureKind ?? '—';
  const reason = row.reason === null ? '—' : escapeCell(row.reason);
  // #213: the harness figure leads; the SDK's rides beside it, or marks a fallback.
  const { costUsd, pricedCostUsd } = row.volatile;
  const sdk = costUsd === null ? 'n/a' : formatUsd(costUsd);
  const cost =
    pricedCostUsd !== null ? `${formatUsd(pricedCostUsd)} (SDK ${sdk})` : costUsd === null ? 'n/a' : `${sdk} (SDK)`;
  const turns = row.volatile.numTurns === null ? 'n/a' : String(row.volatile.numTurns);
  const duration =
    row.volatile.durationMs === null
      ? 'n/a'
      : `${(row.volatile.durationMs / 1000).toFixed(1)}s`;
  return `| ${escapeCell(row.id)} | ${result} | ${kind} | ${reason} | ${cost} | ${turns} | ${duration} |`;
}

function verificationFindingLine(finding: ChallengeFinding): string {
  const detail =
    finding.status === 'challenged'
      ? (finding.category ?? '—')
      : finding.status === 'verifier-error'
        ? (finding.errorKind ?? '—')
        : '—';
  return `| ${escapeCell(finding.taskId)} | ${escapeCell(finding.status)} | ${escapeCell(detail)} |`;
}

/** Four states per spec §Scorecard shape (absent / zero-passed / all-agreed /
 *  mixed); the table lists non-agreed findings only. */
function verificationLines(scorecard: GoldenScorecard): string[] {
  const { verification, totals } = scorecard;
  if (verification === undefined) {
    return [
      'Adversarial challenge: not run — pass --challenge (adds a second model call per passed task)',
    ];
  }
  if (totals.passed === 0) {
    return ['Adversarial challenge (report-only): 0 passed tasks — nothing to challenge'];
  }
  const vt = verification.totals;
  const lines = [
    '## Adversarial challenge (report-only — never affects pass/fail or exit codes)',
    '',
    `Adversary: ${escapeCell(verification.adversaryModelId)} · challenged ${vt.challenged} / agreed ${vt.agreed} / errors ${vt.verifierErrors} / no-output ${vt.noOutput}, of ${totals.passed} passed tasks`,
    `Challenge cost: ${formatUsd(verification.totalCostUsd)} (${verification.unpricedChallenges} unpriced)`,
  ];
  const nonAgreed = verification.findings.filter((f) => f.status !== 'agreed');
  if (nonAgreed.length > 0) {
    lines.push(
      '',
      '| task | status | category / error |',
      '|---|---|---|',
      ...nonAgreed.map(verificationFindingLine),
    );
  }
  return lines;
}

/** Totals first (spec decision #20), then the per-task table. */
export function toMarkdown(scorecard: GoldenScorecard): string {
  const { totals, meta } = scorecard;
  const pct = (totals.passRate * 100).toFixed(1);
  const tasks = (n: number): string => `${n} task${n === 1 ? '' : 's'}`;
  const sdkCost =
    totals.unpricedTasks === 0
      ? formatUsd(totals.totalCostUsd)
      : `≥ ${formatUsd(totals.totalCostUsd)} (${tasks(totals.unpricedTasks)} unpriced)`;
  // #213: lead with the harness figure (ADR-0043). A row with neither figure is unknown;
  // counted from the rows, which agree with totals for any scorecard the runner produces.
  const unknown = scorecard.rows.filter((r) => (r.volatile.pricedCostUsd ?? r.volatile.costUsd) === null).length;
  const headline = unknown === 0 ? formatUsd(totals.totalPricedCostUsd) : `≥ ${formatUsd(totals.totalPricedCostUsd)} (${tasks(unknown)} unpriced)`;
  const fellBack = totals.sdkPricedTasks === 0 ? '' : `; ${tasks(totals.sdkPricedTasks)} at the SDK figure`;
  const cost = `${headline} at list prices (SDK figure ${sdkCost}${fellBack})`;
  const lines = [
    '# Golden eval scorecard',
    '',
    `- **Tasks:** ${totals.total} — ${totals.passed} passed / ${totals.failed} failed (pass rate ${pct}%)`,
    `- **Cost:** ${cost}`,
    `- **Created:** ${meta.createdAt} · harness v${meta.harnessVersion}`,
  ];
  const kinds = GOLDEN_FAILURE_KINDS.filter((kind) => totals.byFailureKind[kind] > 0)
    .map((kind) => `${kind}: ${totals.byFailureKind[kind]}`)
    .join(', ');
  if (kinds !== '') lines.push(`- **Failures by kind:** ${kinds}`);
  lines.push(
    '',
    '| task | result | failure kind | reason | cost | turns | duration |',
    '|------|--------|--------------|--------|------|-------|----------|',
    ...scorecard.rows.map(rowLine),
    '',
    ...verificationLines(scorecard),
  );
  return lines.join('\n');
}
