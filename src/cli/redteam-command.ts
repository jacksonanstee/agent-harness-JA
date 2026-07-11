import { renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  BaselineError,
  CORPUS,
  classifyDrift,
  loadBaseline,
  normalizeForBaseline,
  REDTEAM_ARM_LABEL,
  refuseSymlink,
  renderDriftReport,
  runRedteam,
  toCanonicalJson,
  toRedteamMarkdown,
  totalsMismatchDetail,
} from '../eval/index.js';
import type { BaselineScorecard, DriftFinding, RedteamScorecard } from '../eval/index.js';
import { scan } from '../security/index.js';
import { EVAL_OUT_DIR, readPackageVersion, sanitizeForTerminal, USAGE, writeScorecard } from './shared.js';

/** Default location of the committed baseline (design §Update mechanics),
 *  beside `EVAL_OUT_DIR` — both are CLI-owned path constants. */
export const DEFAULT_BASELINE_PATH = 'eval/redteam/baseline.json';

export interface RedteamArgs {
  command: 'redteam';
  out: string;
  updateBaseline: boolean;
  baselinePath: string;
}

/**
 * Local ParseResult-shaped return: redteam-command.ts must not import from
 * ../cli.js (that would be a real import cycle, since cli.ts imports this
 * module for CliArgs/parseArgs/runRedteamCommand).
 */
type RedteamParseResult =
  | { ok: true; value: RedteamArgs }
  | { ok: false; error: string };

/** `--out <dir>`, `--update-baseline`, `--baseline <path>`; no positionals. */
export function parseRedteamArgs(argv: string[]): RedteamParseResult {
  let out = EVAL_OUT_DIR;
  let updateBaseline = false;
  let baselinePath = DEFAULT_BASELINE_PATH;
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
    } else {
      return { ok: false, error: `Unexpected argument '${arg}'. ${USAGE}` };
    }
  }
  return { ok: true, value: { command: 'redteam', out, updateBaseline, baselinePath } };
}

/**
 * Gate is `totals.falseBlockCount`, not overall pass/fail: a keyless redteam
 * run over the corpus is expected to have `missed`/`false-flag` rows today
 * (S-1's known-missed cases), and those must not fail the CLI gate — only a
 * regression that blocks a real user (a false-block) does (decision log CG11).
 * Superseded as the *combined* gate by `gateOutcome` (E-3), but kept as its
 * own export: `src/cli.ts` still re-exports it and `src/cli.test.ts` exercises
 * it directly as a standalone false-block predicate.
 */
export function redteamExitCode(scorecard: RedteamScorecard): number {
  return scorecard.totals.falseBlockCount > 0 ? 1 : 0;
}

export interface GateOutcome {
  exitCode: 0 | 1 | 2;
  gateLine: string | null;
}

/**
 * Pure precedence table (design §Output contract / §Exit codes): the ONE
 * place the four `GATE_FAILURE=` values and their exit codes are decided.
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

// Pinned verbatim (Global Constraints — tests assert these literally).
const NON_CANONICAL_MESSAGE = 'baseline file is not canonical — regenerate with --update-baseline';
const REMEDY_MESSAGE =
  'Baseline drift detected. Run `npm run redteam -- --update-baseline`, review the diff, ' +
  'and commit eval/redteam/baseline.json. (The gate fails on improvements too — see docs/decisions/0019.)';

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
function runCompare(args: RedteamArgs, freshNorm: BaselineScorecard, internalDetail: string | null): number {
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
 * state CI would reject anyway. Otherwise it always succeeds: exit 0, no
 * `GATE_FAILURE=` line (it is not a gate run). The diff against whatever
 * baseline previously existed is printed as an informational courtesy only.
 */
function runUpdate(args: RedteamArgs, freshNorm: BaselineScorecard, internalDetail: string | null): number {
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
    refuseSymlink(dirname(args.baselinePath), 'directory');
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
  rmSync(tmpPath, { force: true });
  writeFileSync(tmpPath, toCanonicalJson(freshNorm), { flag: 'wx' });
  renameSync(tmpPath, args.baselinePath);
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
 * Keyless: the corpus is compiled in and the security-on scanner is pure,
 * in-process code — no repo code executes, so there is no R-10 warning here
 * (unlike eval's oracle execution). Runs ONLY the security-on arm; the
 * security-off arm is a guaranteed-zero null-scanner baseline the renderer
 * already labels at render time (decision log CG11). JSON is written before
 * anything reaches stdout, mirroring eval's exit-2 contract (ADR-0017
 * decision #4). E-3: compare-by-default against a committed baseline
 * (§Gate rule), or `--update-baseline` to rewrite it.
 */
export function runRedteamCommand(args: RedteamArgs): number {
  const scorecard = runRedteam(CORPUS, scan, {
    armLabel: REDTEAM_ARM_LABEL,
    harnessVersion: readPackageVersion(),
  });

  const written = writeScorecard(scorecard, args.out);
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
