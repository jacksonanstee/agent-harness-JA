import {
  aggregateJudgeSamples,
  answeredCalls,
  CORPUS,
  formatJudgeSampleSummary,
  runRedteamJudge,
  toRedteamJudgeMarkdown,
} from '../eval/index.js';
import type { HoldoutCase, JudgeStatus, RedteamJudgeScorecard } from '../eval/index.js';
import { scan } from '../security/index.js';
import type { JudgeCall } from '../security/index.js';
import { buildJudge } from '../session/index.js';
import type { QueryFn } from '../session/index.js';
import { loadSdkQuery, readPackageVersion, sanitizeForTerminal, SDK_PACKAGE, writeScorecard } from './shared.js';
// Type-only, so erased at compile time: no runtime cycle with redteam-command.ts.
import type { GateExit, RedteamArgs, RedteamCommandDeps } from './redteam-command.js';

// Issue #150: the redteam judge arm (issue #96 PR-A, ADR-0036 D4; `--samples`,
// issue #148), moved out of redteam-command.ts unchanged. Precedent for the
// split: run-judge.ts. `runJudgeArm` is the one entry point the command calls.

export type JudgeArmState = 'complete' | 'partial' | 'failed' | 'skipped';

export interface JudgeArmOutcome {
  exitCode: GateExit;
  armLine: string;
}

/**
 * The judge arm's pure exit table (issue #96, ADR-0036 D4; S-28), printed
 * as its own machine-readable `JUDGE_ARM=<state>` line after the gate line.
 * `skipped` (the heuristic arm exited 2, so nothing ran) and `failed` (a bad
 * key, a dead endpoint, a lost scorecard: measured nothing) are exit 2,
 * because "measured nothing" is infrastructure, not a gate state;
 * `complete` and `partial` return the gate's own exit, since the arm is
 * report-only and never gates. Four states keep didn't-run, ran-clean and
 * ran-found distinguishable.
 */
export function judgeArmOutcome(opts: { gateExit: GateExit; state: JudgeArmState }): JudgeArmOutcome {
  const armLine = `JUDGE_ARM=${opts.state}`;
  if (opts.state === 'skipped' || opts.state === 'failed') return { exitCode: 2, armLine };
  return { exitCode: opts.gateExit, armLine };
}

/** State over ATTEMPTED calls (rows the scanner escalated): a lost or
 *  stopped run measured nothing; a mixed run is still worth writing down.
 *  A refusal is ANSWERED (issue #152 D11): `complete` when judged plus
 *  refused equals attempted, `failed` when nothing was answered.
 *  Exported for its unit pins: the compiled-in corpus holds far more
 *  non-block cases than the early-stop threshold, so a CLI run always trips
 *  the early stop before the nothing-judged branch (code-lens C-7). */
export function judgeArmState(totals: RedteamJudgeScorecard['totals']): JudgeArmState {
  if (totals.stoppedEarly) return 'failed';
  const answered = answeredCalls(totals);
  if (totals.attempted === 0 || answered === totals.attempted) return 'complete';
  if (answered === 0) return 'failed';
  return 'partial';
}

/** A status the remedy line reports as a failure: everything that is neither answered nor the heuristic's own block. */
type FailureStatus = Exclude<JudgeStatus, 'judged' | 'not-escalated' | 'refused'>;

/**
 * The failure kinds in the fixed report order, as a presence record (the
 * `store.ts` EVENT_TYPE_PRESENCE idiom; #152 review M3): a new `JudgeStatus`
 * that is not answered must be added here or the record stops compiling, so
 * the remedy line can never silently omit a kind. `Object.keys` keeps the
 * insertion order, which is the report order.
 */
const FAILURE_STATUS_PRESENCE: Record<FailureStatus, true> = {
  'call-failed': true,
  'timed-out': true,
  unparseable: true,
  'unknown-enum': true,
};
const FAILURE_STATUSES = Object.keys(FAILURE_STATUS_PRESENCE) as readonly FailureStatus[];

const REMEDY_TAIL = 'check the key, the endpoint and the model id, then re-run';

/**
 * The remedy line beside `JUDGE_ARM=partial` and `JUDGE_ARM=failed` (U-4):
 * `partial` lists all four failure kinds with their counts, then `refused R`
 * when any call was refused (issue #152), so the figures reconcile with
 * `attempted`; the early stop lists only the kinds that occurred. `complete`
 * prints none (a write failure prints `writeScorecard`'s message instead,
 * before this is reached). The `failed` branches never carry a refusal: a
 * refusal is answered, so `judgeArmState` never reads `failed` with one.
 * Exported for the same reason as `judgeArmState`.
 */
export function remedyLine(state: JudgeArmState, card: RedteamJudgeScorecard): string | null {
  if (state !== 'partial' && state !== 'failed') return null;
  const { totals, rows } = card;
  const count = (status: JudgeStatus): number => rows.filter((r) => r.status === status).length;
  const kinds = FAILURE_STATUSES.map((status) => [status, count(status)] as const);
  const allKinds = kinds.map(([status, n]) => `${status} ${n}`).join(', ');
  if (state === 'partial') {
    const refused = count('refused');
    const refusedClause = refused > 0 ? `; refused ${refused}` : '';
    return `judged ${totals.judged}/${totals.attempted}; ${allKinds}${refusedClause}; the figures above are partial; re-run to complete`;
  }
  if (totals.stoppedEarly) {
    const seen = kinds.filter(([, n]) => n > 0).map(([status, n]) => `${status} ${n}`).join(', ');
    return `judge stopped after ${totals.attempted} consecutive failures with nothing answered (${seen}); ${REMEDY_TAIL}`;
  }
  // Every attempted call failed, but too few were attempted to trip the
  // early stop: nothing was measured.
  return `judged 0/${totals.attempted}; ${allKinds}; nothing was answered; ${REMEDY_TAIL}`;
}

/**
 * The judge, from the seam or from the SDK. Any failure to obtain one is
 * reported on stderr and read as `null` (the arm then measures nothing).
 */
async function obtainJudge(args: RedteamArgs, deps: RedteamCommandDeps): Promise<JudgeCall | null> {
  if (deps.judge !== undefined) return deps.judge;
  // The SDK is touched only here, only under `--judge`.
  let query: QueryFn | null;
  try {
    query = await loadSdkQuery(deps.importSdk);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${sanitizeForTerminal(`could not load ${SDK_PACKAGE} for --judge: ${detail}`)}\n`);
    return null;
  }
  return query === null ? null : buildJudge(query, args.judgeModel);
}

/**
 * Runs the judge arm after the heuristic gate (D4 steps 5 and 6): skipped
 * outright after a heuristic exit 2 (no SDK import, no call, no spend);
 * otherwise `runRedteamJudge` over the corpus then the holdout through the
 * shipped `createJudgedScanner`, one progress line per call on stderr, the
 * judge scorecard written under `--out` as `judge-scorecard-<stamp>.json`,
 * its markdown after the heuristic markdown, the remedy line, then the
 * `JUDGE_ARM=<state>` line whose exit `judgeArmOutcome` decides.
 */
export async function runJudgeArm(
  args: RedteamArgs,
  deps: RedteamCommandDeps,
  holdout: readonly HoldoutCase[],
  gateExit: GateExit,
  now: () => number,
): Promise<GateExit> {
  const finish = (state: JudgeArmState): GateExit => {
    const outcome = judgeArmOutcome({ gateExit, state });
    process.stdout.write(`${outcome.armLine}\n`);
    return outcome.exitCode;
  };
  if (gateExit === 2) return finish('skipped');

  const judge = await obtainJudge(args, deps);
  if (judge === null) return finish('failed');
  if (args.samples !== null) return finish(await runJudgeSamples(args, args.samples, judge, holdout, now));

  const card = await runRedteamJudge({
    corpus: CORPUS,
    holdout,
    scan,
    judge,
    judgeModel: args.judgeModel,
    harnessVersion: readPackageVersion(),
    now,
    // Ids are charset-pinned and statuses are enums, so the line carries no
    // case text (U-1); sanitised anyway, as every stderr line is.
    onProgress: (line) => process.stderr.write(`${sanitizeForTerminal(line)}\n`),
  });

  const written = writeScorecard(card, args.out, now(), 'judge-scorecard');
  if (!written.ok) {
    // G-8: a lost judge scorecard measured nothing; the `writeScorecard`
    // message is the remedy.
    process.stderr.write(`${sanitizeForTerminal(written.message)}\n`);
    return finish('failed');
  }
  process.stderr.write(`judge scorecard written to ${written.path}\n`);

  process.stdout.write(sanitizeForTerminal(toRedteamJudgeMarkdown(card)));
  const state = judgeArmState(card.totals);
  const remedy = remedyLine(state, card);
  if (remedy !== null) process.stdout.write(sanitizeForTerminal(`${remedy}\n`));
  return finish(state);
}

const STATE_RANK: Record<JudgeArmState, number> = { complete: 0, partial: 1, failed: 2, skipped: 3 };

/**
 * `--samples <n>` (issue #148): the judge arm n times over the same slices,
 * each sample's scorecard written as `judge-scorecard-s<k>-<stamp>.json`,
 * then ADR-0036 D8's gate read over the pooled samples against the n
 * REQUESTED, ending in the `JUDGE_GATE=` line, printed whenever this runs
 * (with no sample read it says `incomplete`; a judge that cannot be obtained
 * never reaches here: `JUDGE_ARM=failed`, exit 2, no gate line). Report-only like the arm (ADR-0036
 * D4): the gate line never changes the exit; the returned state is the worst
 * sample's. A sample that is not complete (a call unjudged, an early stop, a
 * lost scorecard) ends the run: the gate can no longer read `pass`, so the
 * rest would be spend for a verdict already fixed. Per-sample markdown is
 * not printed; each sample's scorecard is on disk.
 */
async function runJudgeSamples(
  args: RedteamArgs,
  samples: number,
  judge: JudgeCall,
  holdout: readonly HoldoutCase[],
  now: () => number,
): Promise<JudgeArmState> {
  const cards: RedteamJudgeScorecard[] = [];
  let state: JudgeArmState = 'complete';
  for (let k = 1; k <= samples; k += 1) {
    const card = await runRedteamJudge({
      corpus: CORPUS,
      holdout,
      scan,
      judge,
      judgeModel: args.judgeModel,
      harnessVersion: readPackageVersion(),
      now,
      onProgress: (line) => process.stderr.write(`${sanitizeForTerminal(`sample ${k}/${samples}: ${line}`)}\n`),
    });
    const written = writeScorecard(card, args.out, now(), `judge-scorecard-s${k}`);
    // Counted before the write: a lost file does not change what was measured,
    // and the gate below reads it against the n requested either way.
    cards.push(card);
    if (!written.ok) {
      process.stderr.write(`${sanitizeForTerminal(written.message)}\n`);
      state = 'failed';
      break;
    }
    process.stderr.write(`judge sample ${k}/${samples} written to ${written.path}\n`);
    const sampleState = judgeArmState(card.totals);
    if (STATE_RANK[sampleState] > STATE_RANK[state]) state = sampleState;
    const remedy = remedyLine(sampleState, card);
    if (remedy !== null) process.stdout.write(sanitizeForTerminal(`sample ${k}/${samples}: ${remedy}\n`));
    if (sampleState !== 'complete') break;
  }
  for (const line of formatJudgeSampleSummary(aggregateJudgeSamples(cards, samples))) {
    process.stdout.write(`${sanitizeForTerminal(line)}\n`);
  }
  return state;
}
