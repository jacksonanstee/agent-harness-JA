import { CORPUS, REDTEAM_ARM_LABEL, runRedteam, toRedteamMarkdown } from '../eval/index.js';
import type { RedteamScorecard } from '../eval/index.js';
import { scan } from '../security/index.js';
import { EVAL_OUT_DIR, readPackageVersion, sanitizeForTerminal, USAGE, writeScorecard } from './shared.js';

export interface RedteamArgs {
  command: 'redteam';
  out: string;
}

/**
 * Local ParseResult-shaped return: redteam-command.ts must not import from
 * ../cli.js (that would be a real import cycle, since cli.ts imports this
 * module for CliArgs/parseArgs/runRedteamCommand).
 */
type RedteamParseResult =
  | { ok: true; value: RedteamArgs }
  | { ok: false; error: string };

/** No positionals; `--out` overrides the shared scorecard directory. */
export function parseRedteamArgs(argv: string[]): RedteamParseResult {
  let out = EVAL_OUT_DIR;
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
    } else {
      return { ok: false, error: `Unexpected argument '${arg}'. ${USAGE}` };
    }
  }
  return { ok: true, value: { command: 'redteam', out } };
}

/**
 * Gate is `totals.falseBlockCount`, not overall pass/fail: a keyless redteam
 * run over the corpus is expected to have `missed`/`false-flag` rows today
 * (S-1's known-missed cases), and those must not fail the CLI gate — only a
 * regression that blocks a real user (a false-block) does (decision log CG11).
 */
export function redteamExitCode(scorecard: RedteamScorecard): number {
  return scorecard.totals.falseBlockCount > 0 ? 1 : 0;
}

/**
 * Keyless: the corpus is compiled in and the security-on scanner is pure,
 * in-process code — no repo code executes, so there is no R-10 warning here
 * (unlike eval's oracle execution). Runs ONLY the security-on arm; the
 * security-off arm is a guaranteed-zero null-scanner baseline the renderer
 * already labels at render time (decision log CG11) — running and storing it
 * here would be a stored tautology. JSON is written before anything reaches
 * stdout, mirroring eval's exit-2 contract (ADR-0017 decision #4).
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

  return redteamExitCode(scorecard);
}
