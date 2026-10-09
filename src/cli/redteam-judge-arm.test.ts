import { describe, expect, it } from 'vitest';

import type { RedteamJudgeRow, RedteamJudgeScorecard } from '../eval/index.js';

import { judgeArmOutcome, judgeArmState, remedyLine } from './redteam-judge-arm.js';

// ---- Issue #96 pin 24: the second pure table ----------------------------------
describe('judgeArmOutcome (issue #96 pin 24, S-28)', () => {
  const GATE_EXITS = [0, 1, 2] as const;

  it('skipped and failed are exit 2 whatever the gate exit; complete and partial return the gate exit; the line is JUDGE_ARM=<state>', () => {
    for (const gateExit of GATE_EXITS) {
      expect(judgeArmOutcome({ gateExit, state: 'skipped' }), `skipped/${gateExit}`).toEqual({ exitCode: 2, armLine: 'JUDGE_ARM=skipped' });
      expect(judgeArmOutcome({ gateExit, state: 'failed' }), `failed/${gateExit}`).toEqual({ exitCode: 2, armLine: 'JUDGE_ARM=failed' });
      expect(judgeArmOutcome({ gateExit, state: 'complete' }), `complete/${gateExit}`).toEqual({ exitCode: gateExit, armLine: 'JUDGE_ARM=complete' });
      expect(judgeArmOutcome({ gateExit, state: 'partial' }), `partial/${gateExit}`).toEqual({ exitCode: gateExit, armLine: 'JUDGE_ARM=partial' });
    }
  });
});

describe('judgeArmState and remedyLine (code-lens C-7: the nothing-judged branch the compiled-in corpus never reaches)', () => {
  const t = (stoppedEarly: boolean, attempted: number, judged: number, refused = 0): RedteamJudgeScorecard['totals'] =>
    ({ stoppedEarly, attempted, judged, refused }) as RedteamJudgeScorecard['totals'];

  it('stopped early -> failed; nothing attempted or all judged -> complete; some judged -> partial; attempted but none judged -> failed', () => {
    expect(judgeArmState(t(true, 3, 0))).toBe('failed');
    expect(judgeArmState(t(false, 0, 0))).toBe('complete');
    expect(judgeArmState(t(false, 4, 4))).toBe('complete');
    expect(judgeArmState(t(false, 4, 1))).toBe('partial');
    expect(judgeArmState(t(false, 2, 0))).toBe('failed');
  });

  it('a refusal is ANSWERED (#152 D11, T7): judged + refused === attempted is complete, refusals alone are complete, none answered is failed, some is partial', () => {
    expect(judgeArmState(t(false, 4, 3, 1))).toBe('complete');
    expect(judgeArmState(t(false, 4, 0, 4))).toBe('complete');
    expect(judgeArmState(t(false, 4, 0, 0))).toBe('failed');
    expect(judgeArmState(t(false, 4, 1, 1))).toBe('partial');
    expect(judgeArmState(t(false, 4, 0, 1))).toBe('partial');
  });

  it('the nothing-judged remedy (not an early stop) lists all four kinds with counts and the remedy tail, exactly; complete and skipped print none', () => {
    const rows = [{ status: 'call-failed' }, { status: 'timed-out' }] as RedteamJudgeRow[];
    const card = { totals: t(false, 2, 0), rows } as RedteamJudgeScorecard;
    expect(remedyLine('failed', card)).toBe(
      'judged 0/2; call-failed 1, timed-out 1, unparseable 0, unknown-enum 0; nothing was answered; check the key, the endpoint and the model id, then re-run',
    );
    expect(remedyLine('complete', card)).toBeNull();
    expect(remedyLine('skipped', card)).toBeNull();
  });

  it('the partial remedy appends `; refused R` before the partial clause only when R > 0, so its figures reconcile with attempted (#152, T7b)', () => {
    const withRefusal = {
      totals: t(false, 3, 1, 1),
      rows: [{ status: 'judged' }, { status: 'call-failed' }, { status: 'refused' }] as RedteamJudgeRow[],
    } as RedteamJudgeScorecard;
    expect(remedyLine('partial', withRefusal)).toBe(
      'judged 1/3; call-failed 1, timed-out 0, unparseable 0, unknown-enum 0; refused 1; the figures above are partial; re-run to complete',
    );
    const without = {
      totals: t(false, 2, 1, 0),
      rows: [{ status: 'judged' }, { status: 'call-failed' }] as RedteamJudgeRow[],
    } as RedteamJudgeScorecard;
    expect(remedyLine('partial', without)).toBe(
      'judged 1/2; call-failed 1, timed-out 0, unparseable 0, unknown-enum 0; the figures above are partial; re-run to complete',
    );
  });
});
