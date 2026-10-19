import { lintSkills, SkillsLintRootError } from '../skills/index.js';
import type { LintFinding } from '../skills/index.js';
import { sanitizeDiagnostic, USAGE } from './shared.js';

export interface SkillsLintArgs {
  command: 'skills-lint';
  dir: string;
}

export type SkillsParseResult =
  | { ok: true; value: SkillsLintArgs }
  | { ok: false; error: string };

/**
 * `skills lint <dir>`: one subcommand, one required positional, no flags (a
 * `--` argument is a usage error, the same exit class as every other parser).
 */
export function parseSkillsArgs(argv: string[]): SkillsParseResult {
  const [subcommand, ...rest] = argv;
  if (subcommand !== 'lint') {
    return { ok: false, error: `Unknown skills subcommand '${subcommand ?? ''}'. ${USAGE}` };
  }
  const [dir, ...extra] = rest;
  if (dir !== undefined && dir.startsWith('--')) {
    return { ok: false, error: `Unexpected argument '${dir}'. ${USAGE}` };
  }
  if (dir === undefined) {
    return { ok: false, error: `skills lint requires a directory. ${USAGE}` };
  }
  if (extra.length > 0) {
    return { ok: false, error: `Unexpected argument '${extra[0] ?? ''}'. ${USAGE}` };
  }
  return { ok: true, value: { command: 'skills-lint', dir } };
}

export interface SkillsStreams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * Names and messages derive from attacker-influenced file names and
 * frontmatter, and the output is line-oriented, so every value is run through
 * the diagnostic sanitiser and the survivors LF and TAB are made visible: a
 * hostile name can neither start a forged finding line nor hide whitespace.
 */
function oneLine(text: string): string {
  return sanitizeDiagnostic(text).replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

function findingLine(finding: LintFinding): string {
  return `${JSON.stringify(oneLine(finding.file))}: ${finding.rule}: ${oneLine(finding.message)}`;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Read-only: lints a skills directory and prints one line per finding to
 * stdout (the report is the product). Exit 0 clean, 1 findings, 2 when the
 * directory cannot be linted at all (missing, not a directory, a symlink at
 * the root). An unexpected error propagates to main()'s catch-all.
 */
export function runSkillsLint(
  args: SkillsLintArgs,
  streams: SkillsStreams = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): number {
  let report;
  try {
    report = lintSkills(args.dir);
  } catch (error: unknown) {
    if (error instanceof SkillsLintRootError) {
      streams.stderr(`skills lint: ${oneLine(error.message)}\n`);
      return 2;
    }
    throw error;
  }
  const { findings, skillsChecked } = report;
  if (findings.length === 0) {
    streams.stdout(`skills lint: ${plural(skillsChecked, 'skill')} checked, no findings\n`);
    return 0;
  }
  const files = new Set(findings.map((f) => f.file)).size;
  streams.stdout(
    `${findings.map(findingLine).join('\n')}\nskills lint: ${plural(findings.length, 'finding')} in ${plural(files, 'file')}\n`,
  );
  return 1;
}
