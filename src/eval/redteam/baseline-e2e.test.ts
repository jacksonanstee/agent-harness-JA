import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { scan } from '../../security/index.js';
import { toCanonicalJson } from '../scorecard/index.js';
import { classifyDrift, loadBaseline, normalizeForBaseline, renderDriftReport } from './baseline.js';
import { CORPUS } from './corpus.js';
import { runRedteam } from './runner.js';
import { REDTEAM_ARM_LABEL } from './types.js';

// CI runs `npm test` before the redteam gate step, so on drift THIS test is
// the first failure surface — its assertion messages must be the same
// classified report the CLI prints, never a raw multi-KB JSON diff.
describe('committed baseline (eval/redteam/baseline.json)', () => {
  const fresh = normalizeForBaseline(
    runRedteam(CORPUS, scan, { armLabel: REDTEAM_ARM_LABEL, now: () => 0 }),
  );
  // Hardcoded rather than imported from cli/redteam-command.ts: the eval
  // layer is lint-barred from importing cli. cli.test.ts pins the CLI default
  // to this same path.
  const { raw, parsed } = loadBaseline('eval/redteam/baseline.json');

  it('matches the live run (classified report on failure)', () => {
    const findings = classifyDrift(parsed, fresh);
    expect(findings, renderDriftReport(findings)).toEqual([]);
  });

  it('is byte-canonical (regenerate with --update-baseline on failure)', () => {
    expect(raw === toCanonicalJson(fresh), 'baseline file is not canonical — regenerate with --update-baseline').toBe(true);
  });

  it('is the file git has, unmangled by line endings', () => {
    expect(readFileSync('eval/redteam/baseline.json', 'utf8')).not.toContain('\r\n');
  });
});
