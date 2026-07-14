import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { INIT_FILES, INIT_TARGET_PATHS } from './init-templates.js';
import { USAGE } from './shared.js';

export interface InitArgs {
  command: 'init';
  dir: string;
}

export type InitParseResult =
  | { ok: true; value: InitArgs }
  | { ok: false; error: string };

export function parseInitArgs(argv: string[]): InitParseResult {
  let dir: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      return { ok: false, error: `Unknown flag '${arg}'. ${USAGE}` };
    }
    if (dir !== null) {
      return { ok: false, error: `Unexpected extra argument '${arg}'. ${USAGE}` };
    }
    dir = arg;
  }
  return { ok: true, value: { command: 'init', dir: dir ?? '.' } };
}

/**
 * The command the printed next-steps must use. Pre-publish there is no bin on
 * PATH, so a hardcoded `agent-harness-ja` would be `command not found` on the
 * success path; render the actual script invocation relative to the scaffold
 * instead. A true bin-shim invocation (basename with no script extension)
 * keeps the short form.
 */
export function renderInvocation(cliPath: string | undefined, targetDir: string): string {
  if (cliPath === undefined) return 'agent-harness-ja';
  const name = basename(cliPath);
  if (!/\.(js|mjs|cjs)$/.test(name)) return 'agent-harness-ja';
  const rel = relative(resolve(targetDir), resolve(cliPath));
  // A long `../../..` climb reads worse than the absolute path it encodes.
  const climbs = rel.split(sep).filter((part) => part === '..').length;
  if (rel === '' || climbs > 3) return `node ${resolve(cliPath)}`;
  return `node ${rel}`;
}

export interface InitStreams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface InitOptions {
  /** Injected for tests; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injected for tests; defaults to process.argv[1]. */
  cliPath?: string;
}

function buildOutput(dir: string, invocation: string, keyIsSet: boolean): string {
  const label = dir.endsWith(sep) ? dir.slice(0, -sep.length) : dir;
  const tree = INIT_TARGET_PATHS.map((p) => `  ${p}`).join('\n');
  const keyStep = keyIsSet
    ? '  2. ANTHROPIC_API_KEY is already set in this shell. Skip this step.'
    : '  2. export ANTHROPIC_API_KEY=sk-ant-...\n' +
      '     Get a key at https://console.anthropic.com/settings/keys';
  return (
    `Scaffolded ${label}/\n${tree}\n\n` +
    `Next steps (run these from inside ${label}/):\n\n` +
    `  1. cd ${label}\n` +
    `${keyStep}\n` +
    `  3. ${invocation} run "Using only the getting-started skill, say which two tools this project's policy denies."\n` +
    `  4. ${invocation} eval .\n` +
    '     Expect: 1/1 pass, 1 turn, a few cents at most.\n\n' +
    'Trust note (R-10): hello-harness.oracle.mjs is in-process code the eval\n' +
    'CLI executes with no gate. Read it before running eval; README.md has\n' +
    'the full caveat.\n\n' +
    'Run telemetry lands in .harness/telemetry.db; eval scorecards in\n' +
    '.harness/eval/ (both gitignored).\n'
  );
}

/**
 * Scaffolds the starter. Fail-closed: every target path is checked before
 * anything is written; any collision refuses the whole operation (exit 2,
 * the repo-wide "refused, nothing produced" class) with zero writes. An
 * unexpected fs failure mid-write propagates to main()'s catch-all (exit 1).
 */
export function runInit(
  args: InitArgs,
  streams: InitStreams = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  options: InitOptions = {},
): number {
  const env = options.env ?? process.env;
  const cliPath = options.cliPath ?? process.argv[1];
  const dir = args.dir;

  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    streams.stderr(`init: ${dir} exists and is not a directory.\n`);
    return 2;
  }

  const collisions = INIT_TARGET_PATHS.filter((rel) => existsSync(join(dir, rel)));
  if (collisions.length > 0) {
    streams.stderr(
      `init: refusing to overwrite existing files in ${dir}:\n` +
        collisions.map((rel) => `  ${rel}`).join('\n') +
        '\nNothing was written. Scaffold into a fresh directory instead:\n' +
        '  agent-harness-ja init <new-dir>\n',
    );
    return 2;
  }

  for (const file of INIT_FILES) {
    const target = join(dir, ...file.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }

  streams.stdout(
    buildOutput(dir, renderInvocation(cliPath, dir), Boolean(env.ANTHROPIC_API_KEY)),
  );
  return 0;
}
