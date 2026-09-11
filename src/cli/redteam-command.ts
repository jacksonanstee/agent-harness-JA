import { renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  BaselineError,
  CORPUS,
  classifyDrift,
  HoldoutError,
  loadBaseline,
  loadHoldout,
  normalizeForBaseline,
  REDTEAM_ARM_LABEL,
  refuseAncestorSymlinks,
  refuseSymlink,
  renderDriftReport,
  runRedteam,
  runRedteamJudge,
  toCanonicalJson,
  toRedteamJudgeMarkdown,
  toRedteamMarkdown,
  totalsMismatchDetail,
} from '../eval/index.js';
import type {
  BaselineScorecard,
  DriftFinding,
  HoldoutCase,
  JudgeStatus,
  RedteamJudgeScorecard,
} from '../eval/index.js';
import { scan } from '../security/index.js';
import type { JudgeCall } from '../security/index.js';
import { buildJudge } from '../session/index.js';
import type { QueryFn } from '../session/index.js';
import {
  EVAL_OUT_DIR,
  JUDGE_MODEL_IDS,
  readPackageVersion,
  sanitizeForTerminal,
  USAGE,
  writeScorecard,
} from './shared.js';

/** Default location of the committed baseline (design §Update mechanics),
 *  beside `EVAL_OUT_DIR` — both are CLI-owned path constants. */
export const DEFAULT_BASELINE_PATH = 'eval/redteam/baseline.json';

/**
 * The judge arm's default model (issue #96, ADR-0036 D3): the same literal
 * as `src/router/table.ts` (ADR-0016 names it), deliberately NOT obtained
 * through `route()` (ADR-0016 decision 6: the router is never used for the
 * judge). The CLI is the only place this literal lives; a pin asserts it is
 * present in the router table so a tier bump cannot retire it silently
 * (S-18). `--judge-model` overrides it for the second measurement run.
 */
export const JUDGE_MODEL = 'claude-haiku-4-5';

export interface RedteamArgs {
  command: 'redteam';
  out: string;
  updateBaseline: boolean;
  baselinePath: string;
  /** `--judge`: run the keyed, report-only judge arm after the heuristic gate. */
  judge: boolean;
  /** `--judge-model <id>`: a router-table model id. Default `JUDGE_MODEL`. */
  judgeModel: string;
  /** `--holdout <path>`: the private held-out slice, or null for the corpus only. */
  holdoutPath: string | null;
}

/**
 * Local ParseResult-shaped return: redteam-command.ts must not import from
 * ../cli.js (that would be a real import cycle, since cli.ts imports this
 * module for CliArgs/parseArgs/runRedteamCommand).
 */
type RedteamParseResult =
  | { ok: true; value: RedteamArgs }
  | { ok: false; error: string };

/**
 * `--out <dir>`, `--update-baseline`, `--baseline <path>`, `--judge`,
 * `--judge-model <id>`, `--holdout <path>`; no positionals. The cross-flag
 * rules run after the loop so flag order never matters: `--judge-model` and
 * `--holdout` each require `--judge`; `--judge` cannot ride with
 * `--update-baseline` (the update path stays keyless and pure); and
 * `--judge-model` must be a router-table id (the rejection names the valid
 * ids, the same list the usage text renders).
 */
export function parseRedteamArgs(argv: string[]): RedteamParseResult {
  let out = EVAL_OUT_DIR;
  let updateBaseline = false;
  let baselinePath = DEFAULT_BASELINE_PATH;
  let judge = false;
  let judgeModel: string | null = null;
  let holdoutPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, error: `Missing value for --out. ${USAGE}` };
      }
      out = value;
      i += 1;
    } else if (arg === '--update-baseline') {
      updateBaseline = true;
    } else if (arg === '--baseline') {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, error: `Missing value for --baseline. ${USAGE}` };
      }
      baselinePath = value;
      i += 1;
    } else if (arg === '--judge') {
      judge = true;
    } else if (arg === '--judge-model') {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, error: `Missing value for --judge-model. ${USAGE}` };
      }
      judgeModel = value;
      i += 1;
    } else if (arg === '--holdout') {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, error: `Missing value for --holdout. ${USAGE}` };
      }
      holdoutPath = value;
      i += 1;
    } else {
      return { ok: false, error: `Unexpected argument '${arg}'. ${USAGE}` };
    }
  }
  if (judgeModel !== null && !judge) {
    return { ok: false, error: `--judge-model requires --judge. ${USAGE}` };
  }
  if (holdoutPath !== null && !judge) {
    return { ok: false, error: `--holdout requires --judge. ${USAGE}` };
  }
  if (judge && updateBaseline) {
    return {
      ok: false,
      error: `--judge cannot be combined with --update-baseline (the baseline update stays keyless and heuristic-only). ${USAGE}`,
    };
  }
  if (judgeModel !== null && !JUDGE_MODEL_IDS.includes(judgeModel)) {
    // The supplied value is not echoed: it is operator argv, but the valid
    // list says everything the operator needs.
    return {
      ok: false,
      error: `--judge-model must be a router-table model id (${JUDGE_MODEL_IDS.join('|')}). ${USAGE}`,
    };
  }
  return {
    ok: true,
    value: {
      command: 'redteam',
      out,
      updateBaseline,
      baselinePath,
      judge,
      judgeModel: judgeModel ?? JUDGE_MODEL,
      holdoutPath,
    },
  };
}

type GateExit = 0 | 1 | 2;

export interface GateOutcome {
  exitCode: GateExit;
  gateLine: string | null;
}

/**
 * Pure precedence table (design §Output contract / §Exit codes): the ONE
 * place the four `GATE_FAILURE=` values and their exit codes are decided
 * for the HEURISTIC gate; the judge arm's exit is decided in
 * `judgeArmOutcome`, a second pure table beside this one (issue #96, S-28).
 * `internalDetail` outranks everything (a producer/differ bug is infra, not
 * a gate failure `--update-baseline` could ever fix); false-block is an
 * absolute, baseline-independent gate; drift (semantic or non-canonical
 * bytes) is the remaining exit-1 cause. No short-circuit in the caller — all
 * three signals are always computed and passed in together.
 */
export function gateOutcome(opts: {
  falseBlockCount: number;
  internalDetail: string | null;
  driftFindings: readonly DriftFinding[];
  nonCanonical: boolean;
}): GateOutcome {
  if (opts.internalDetail !== null) return { exitCode: 2, gateLine: 'GATE_FAILURE=internal' };
  const falseBlock = opts.falseBlockCount > 0;
  const drift = opts.driftFindings.length > 0 || opts.nonCanonical;
  if (falseBlock && drift) return { exitCode: 1, gateLine: 'GATE_FAILURE=false-block+drift' };
  if (falseBlock) return { exitCode: 1, gateLine: 'GATE_FAILURE=false-block' };
  if (drift) return { exitCode: 1, gateLine: 'GATE_FAILURE=drift' };
  return { exitCode: 0, gateLine: 'GATE_FAILURE=none' };
}

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

/**
 * Test seam (issue #96, S-9). A supplied `judge` bypasses the SDK import
 * entirely (the `composeSecurity` `readFile?` precedent); `importSdk`
 * defaults to the dynamic import and is never invoked without `--judge`,
 * so the keyless CI arm cannot grow an SDK import by accident; `now` feeds
 * the heuristic run, the judge run and both scorecard stamps. Production
 * passes nothing.
 */
export interface RedteamCommandDeps {
  judge?: JudgeCall;
  importSdk?: () => Promise<{ query: unknown }>;
  now?: () => number;
}

// Pinned verbatim (Global Constraints — tests assert these literally).
const NON_CANONICAL_MESSAGE = 'baseline file is not canonical — regenerate with --update-baseline';
const REMEDY_MESSAGE =
  'Baseline drift detected. Run `npm run redteam -- --update-baseline`, review the diff, ' +
  'and commit eval/redteam/baseline.json. (The gate fails on improvements too — see docs/decisions/0019.)';

/** U-15: `--judge` is the one keyed path of an otherwise keyless command. */
const KEY_MESSAGE =
  'ANTHROPIC_API_KEY is not set (required for --judge; the red-team gate itself runs without it).\n\n' +
  'Export it, then re-run:\n' +
  '  export ANTHROPIC_API_KEY=sk-ant-...\n\n' +
  'Get a key at https://console.anthropic.com/settings/keys\n';

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/** The `eval-command.ts` dynamic-import shape: the SDK is touched only here, only under `--judge`. */
const defaultImportSdk = (): Promise<{ query: unknown }> =>
  import(SDK_PACKAGE) as Promise<{ query: unknown }>;

function newCaseOnlySummary(findings: readonly DriftFinding[]): string {
  const n = findings.length;
  return (
    `This failure is expected: you added ${n} case(s) not yet in the baseline. ` +
    'No existing behaviour changed — update the baseline to record them.'
  );
}

/**
 * Compare-by-default gate (design §Gate rule). `loadBaseline` throws
 * `BaselineError` for every load/validate failure (missing/oversized/
 * symlinked/malformed/schema-mismatched) — that maps to exit 2 with NO gate
 * line (the run never reached gate evaluation). Otherwise all checks run —
 * no short-circuit — and print one combined report before the pinned
 * `GATE_FAILURE=` line.
 */
function runCompare(args: RedteamArgs, freshNorm: BaselineScorecard, internalDetail: string | null): GateExit {
  let loaded: { raw: string; parsed: BaselineScorecard };
  try {
    loaded = loadBaseline(args.baselinePath);
  } catch (error: unknown) {
    if (error instanceof BaselineError) {
      process.stderr.write(`${sanitizeForTerminal(error.message)}\n`);
      return 2;
    }
    throw error;
  }

  const freshCanon = toCanonicalJson(freshNorm);
  let findings: DriftFinding[] = [];
  let nonCanonical = false;
  if (loaded.raw !== freshCanon) {
    if (toCanonicalJson(loaded.parsed) === freshCanon) {
      nonCanonical = true;
    } else {
      findings = classifyDrift(loaded.parsed, freshNorm);
    }
  }

  if (nonCanonical) {
    process.stdout.write(sanitizeForTerminal(`${NON_CANONICAL_MESSAGE}\n`));
  } else if (findings.length > 0) {
    process.stdout.write(sanitizeForTerminal(renderDriftReport(findings)));
    if (findings.every((f) => f.kind === 'new-case')) {
      process.stdout.write(sanitizeForTerminal(`${newCaseOnlySummary(findings)}\n`));
    }
  }

  const drift = nonCanonical || findings.length > 0;
  if (drift) {
    process.stdout.write(sanitizeForTerminal(`${REMEDY_MESSAGE}\n`));
  }

  const outcome = gateOutcome({
    falseBlockCount: freshNorm.totals.falseBlockCount,
    internalDetail,
    driftFindings: findings,
    nonCanonical,
  });
  process.stdout.write(`${outcome.gateLine}\n`);
  return outcome.exitCode;
}

/**
 * `--update-baseline` (design §Update mechanics): never compares — it
 * refuses on the same two baseline-independent signals a compare run would
 * fail on (false-block, totals backstop), so local can never bake in a
 * state CI would reject anyway. A successful update is exit 0 with NO
 * `GATE_FAILURE=` line (not a gate run); its REFUSAL paths DO print the line
 * (ADR-0019 decision 6 — the refusal is a gate-shaped outcome, kept
 * scriptable). The diff against whatever baseline previously existed is
 * printed as an informational courtesy only.
 */
function runUpdate(args: RedteamArgs, freshNorm: BaselineScorecard, internalDetail: string | null): GateExit {
  if (internalDetail !== null || freshNorm.totals.falseBlockCount > 0) {
    process.stderr.write(
      internalDetail !== null
        ? `${sanitizeForTerminal(`refusing to update baseline: totals backstop mismatch: ${internalDetail}`)}\n`
        : 'refusing to update baseline: the fresh run has a false-block; --update-baseline never bakes one in\n',
    );
    const outcome = gateOutcome({
      falseBlockCount: freshNorm.totals.falseBlockCount,
      internalDetail,
      driftFindings: [],
      nonCanonical: false,
    });
    process.stdout.write(`${outcome.gateLine}\n`);
    return outcome.exitCode;
  }

  const tmpPath = `${args.baselinePath}.tmp`;
  try {
    refuseSymlink(args.baselinePath, 'file');
    // The tmp write target is as attacker-plantable as the baseline itself
    // (a cloned repo can commit `baseline.json.tmp` as a symlink), so it gets
    // the same refusal — and the `wx` write below holds even if this races.
    refuseSymlink(tmpPath, 'file');
    // Whole ancestor chain for relative (repo-internal) paths, parent-only
    // for operator-supplied absolute paths — same rule as the read side.
    refuseAncestorSymlinks(args.baselinePath);
  } catch (error: unknown) {
    if (error instanceof BaselineError) {
      process.stderr.write(`${sanitizeForTerminal(error.message)}\n`);
      return 2;
    }
    throw error;
  }

  const parentDir = dirname(args.baselinePath);
  let parentIsDir: boolean;
  try {
    parentIsDir = statSync(parentDir).isDirectory();
  } catch {
    parentIsDir = false;
  }
  if (!parentIsDir) {
    process.stderr.write(
      `${sanitizeForTerminal(`${parentDir} does not exist; run --update-baseline from the repo root (or pass --baseline <path> pointing at an existing directory)`)}\n`,
    );
    return 2;
  }

  let oldParsed: BaselineScorecard | null;
  try {
    oldParsed = loadBaseline(args.baselinePath).parsed;
  } catch (error: unknown) {
    if (!(error instanceof BaselineError)) throw error;
    oldParsed = null; // first write, or an unreadable prior baseline: nothing to diff against
  }

  // `rm` clears a leftover regular tmp from a crashed run (never follows a
  // symlink); `wx` (O_CREAT|O_EXCL) refuses anything that appears at tmpPath
  // after the checks above, so the write can never traverse a planted link.
  // Write failures are infrastructure, not gate state: exit 2 with the code
  // on stderr (Week-4 fix — they used to escape to the generic catch as a
  // gate-colliding exit 1 with no diagnostic).
  try {
    rmSync(tmpPath, { force: true });
    writeFileSync(tmpPath, toCanonicalJson(freshNorm), { flag: 'wx' });
    renameSync(tmpPath, args.baselinePath);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code ?? 'write error';
    process.stderr.write(
      `${sanitizeForTerminal(`failed to write baseline ${args.baselinePath} (${code})`)}\n`,
    );
    return 2;
  }
  process.stderr.write(`baseline written to ${args.baselinePath}\n`);

  if (oldParsed !== null) {
    const findings = classifyDrift(oldParsed, freshNorm);
    if (findings.length > 0) {
      process.stdout.write(sanitizeForTerminal(renderDriftReport(findings)));
    }
  }

  return 0;
}

/**
 * The heuristic arm, UNCHANGED by `--judge` (the differential pin): same
 * scorecard, markdown, compare/gate and `GATE_FAILURE=` line. JSON is
 * written before anything reaches stdout, mirroring eval's exit-2 contract
 * (ADR-0017 decision #4).
 */
function runHeuristicArm(args: RedteamArgs, now: () => number): GateExit {
  const scorecard = runRedteam(CORPUS, scan, {
    armLabel: REDTEAM_ARM_LABEL,
    harnessVersion: readPackageVersion(),
    now,
  });

  const written = writeScorecard(scorecard, args.out, now());
  if (!written.ok) {
    process.stderr.write(`${sanitizeForTerminal(written.message)}\n`);
    return 2;
  }
  process.stderr.write(`scorecard written to ${written.path}\n`);

  process.stdout.write(sanitizeForTerminal(toRedteamMarkdown(scorecard)));

  const freshNorm = normalizeForBaseline(scorecard);
  // Independent totals re-derivation (DEC-0016): can never actually mismatch
  // through the real runner (kept as a wiring backstop — see `gateOutcome`'s
  // own unit tests for the branch this guards).
  const internalDetail = totalsMismatchDetail(freshNorm);

  return args.updateBaseline
    ? runUpdate(args, freshNorm, internalDetail)
    : runCompare(args, freshNorm, internalDetail);
}

// ---- The judge arm (issue #96 PR-A, ADR-0036 D4) ----------------------------

/** State over ATTEMPTED calls (rows the scanner escalated): a lost or
 *  stopped run measured nothing; a mixed run is still worth writing down.
 *  Exported for its unit pins: the compiled-in corpus holds far more
 *  non-block cases than the early-stop threshold, so a CLI run always trips
 *  the early stop before the nothing-judged branch (code-lens C-7). */
export function judgeArmState(totals: RedteamJudgeScorecard['totals']): JudgeArmState {
  if (totals.stoppedEarly) return 'failed';
  if (totals.attempted === 0 || totals.judged === totals.attempted) return 'complete';
  if (totals.judged === 0) return 'failed';
  return 'partial';
}

/** The failure kinds in the fixed report order. */
const FAILURE_STATUSES: readonly Exclude<JudgeStatus, 'judged' | 'not-escalated'>[] = [
  'call-failed',
  'timed-out',
  'unparseable',
  'unknown-enum',
];

const REMEDY_TAIL = 'check the key, the endpoint and the model id, then re-run';

/**
 * The remedy line beside `JUDGE_ARM=partial` and `JUDGE_ARM=failed` (U-4):
 * `partial` lists all four failure kinds with their counts; the early stop
 * lists only the kinds that occurred. `complete` prints none (a write
 * failure prints `writeScorecard`'s message instead, before this is reached).
 * Exported for the same reason as `judgeArmState`.
 */
export function remedyLine(state: JudgeArmState, card: RedteamJudgeScorecard): string | null {
  if (state !== 'partial' && state !== 'failed') return null;
  const { totals, rows } = card;
  const count = (status: JudgeStatus): number => rows.filter((r) => r.status === status).length;
  const kinds = FAILURE_STATUSES.map((status) => [status, count(status)] as const);
  const allKinds = kinds.map(([status, n]) => `${status} ${n}`).join(', ');
  if (state === 'partial') {
    return `judged ${totals.judged}/${totals.attempted}; ${allKinds}; the figures above are partial; re-run to complete`;
  }
  if (totals.stoppedEarly) {
    const seen = kinds.filter(([, n]) => n > 0).map(([status, n]) => `${status} ${n}`).join(', ');
    return `judge stopped after ${totals.attempted} consecutive failures with nothing judged (${seen}); ${REMEDY_TAIL}`;
  }
  // Every attempted call failed, but too few were attempted to trip the
  // early stop: nothing was measured.
  return `judged 0/${totals.attempted}; ${allKinds}; nothing was judged; ${REMEDY_TAIL}`;
}

/**
 * The judge, from the seam or from the SDK. Any failure to obtain one is
 * reported on stderr and read as `null` (the arm then measures nothing).
 */
async function obtainJudge(args: RedteamArgs, deps: RedteamCommandDeps): Promise<JudgeCall | null> {
  if (deps.judge !== undefined) return deps.judge;
  const importSdk = deps.importSdk ?? defaultImportSdk;
  let sdk: { query: unknown };
  try {
    sdk = await importSdk();
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${sanitizeForTerminal(`could not load ${SDK_PACKAGE} for --judge: ${detail}`)}\n`);
    return null;
  }
  if (typeof sdk.query !== 'function') {
    process.stderr.write(`The installed ${SDK_PACKAGE} does not export query(); check the SDK version.\n`);
    return null;
  }
  return buildJudge(sdk.query as QueryFn, args.judgeModel);
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
async function runJudgeArm(
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

/**
 * Keyless by default: the corpus is compiled in and the security-on scanner
 * is pure, in-process code: no repo code executes, so there is no R-10
 * warning here (unlike eval's oracle execution). That sentence is true of
 * the heuristic arm; `--judge` (issue #96, ADR-0036) is the exception: it
 * demands `ANTHROPIC_API_KEY` and spawns SDK subprocesses, one per judged
 * case, under the SDK's six isolation keys (no settings layers, no MCP, no
 * tools, no skills, a bare system prompt, no transcript). Runs ONLY the
 * security-on arm; the security-off arm is a guaranteed-zero null-scanner
 * baseline the renderer already labels at render time (decision log CG11).
 * E-3: compare-by-default against a committed baseline (§Gate rule), or
 * `--update-baseline` to rewrite it.
 *
 * Order under `--judge` (D4; S-4, S-8, U-21): every refusal the judge arm
 * ADDS comes before the key is demanded; the heuristic arm's own refusals
 * (a missing baseline, an unwritable output path) run inside that arm,
 * after the key check, unchanged. (1) The parse has already run. (2) The holdout loads
 * NOW, keyless, before any scorecard; a `HoldoutError` is stderr + exit 2
 * and nothing is written. (3) No key: the pinned message, exit 2, nothing
 * written. (4) The heuristic arm runs unchanged and its exit is remembered.
 * (5) A heuristic exit 2 skips the judge arm. (6) Otherwise the judge arm.
 */
export async function runRedteamCommand(args: RedteamArgs, deps: RedteamCommandDeps = {}): Promise<number> {
  const now = deps.now ?? Date.now;

  let holdout: HoldoutCase[] = [];
  if (args.judge && args.holdoutPath !== null) {
    try {
      holdout = loadHoldout(args.holdoutPath, scan);
    } catch (error: unknown) {
      if (error instanceof HoldoutError) {
        process.stderr.write(`${sanitizeForTerminal(error.message)}\n`);
        return 2;
      }
      throw error;
    }
  }
  if (args.judge && !process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(KEY_MESSAGE);
    return 2;
  }

  const gateExit = runHeuristicArm(args, now);
  if (!args.judge) return gateExit;
  return runJudgeArm(args, deps, holdout, gateExit, now);
}
