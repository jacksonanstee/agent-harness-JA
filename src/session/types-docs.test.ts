import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { JudgeSessionState, JudgeSummary, SessionJudge, SessionResult } from './types.js';

// Issue #96 PR-B1 (spec D10, U-9): the public doc comments a package
// consumer's editor shows must say what the code now does (lesson 2026-09-09:
// fixing the seam is not fixing the comment the consumer reads).
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'types.ts'), 'utf8');

describe('session public doc comments (U-9)', () => {
  it('no comment still says nothing is withheld or defers withholding to B2; the two comments name the setting and ADR-0039 (#145 B2a, W18)', () => {
    expect(source).not.toMatch(/withholding is PR-B2's decision/);
    expect(source).not.toMatch(/withholding is #96/);
    expect(source).not.toMatch(/nothing is withheld/i);
    expect(source.match(/judge\.withhold: 'block'/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toMatch(/ADR-0039/);
  });

  it('the isolation-keys comment no longer says the session passes none of them and names ADR-0040 (#140)', () => {
    expect(source).not.toMatch(/the session passes none of them today/);
    expect(source).toMatch(/ADR-0040/);
  });

  it('the QueryFn alias and the abortController key both state the consumer contract', () => {
    expect(source).toMatch(/must honour `options\.abortController`/);
    expect(source).toMatch(/A consumer-supplied `QueryFn` must honour it/);
  });

  it('the outputAnnotations doc comment names judge-refused beside the other four judge-path ids (#152, T11)', () => {
    const at = source.indexOf('outputAnnotations: OutputAnnotation[];');
    expect(at).toBeGreaterThan(0);
    const before = source.slice(0, at);
    const comment = before.slice(before.lastIndexOf('/**'));
    for (const id of ['judge-ask', 'judge-block', 'judge-oversized', 'judge-redacted', 'judge-refused']) {
      expect(comment, id).toContain(`\`${id}\``);
    }
  });

  it('the judge types are in the public closure (compile-time; npm run typecheck is the gate)', () => {
    const state: JudgeSessionState = 'queue-timed-out';
    const refused: JudgeSessionState = 'refused';
    expect(refused).toBe('refused');
    const judge: SessionJudge = { call: async () => ({ ok: true, verdict: 'pass', costUsd: null }), maxCallsPerRun: 1 };
    const pick = (r: SessionResult): JudgeSummary | null => r.judge;
    expect([state, typeof judge.call, typeof pick]).toEqual(['queue-timed-out', 'function', 'function']);
  });
});
