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
  it('no comment still says withholding is #96; withholding is named as B2', () => {
    expect(source).not.toMatch(/withholding is #96/);
    expect(source.match(/withholding is PR-B2's decision/g)?.length).toBe(2);
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
