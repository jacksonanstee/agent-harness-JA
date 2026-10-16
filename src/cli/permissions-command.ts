import { homedir } from 'node:os';
import { join } from 'node:path';

import type { LayeredRule, SettingsLayer } from '../security/index.js';
import { composeSecurity, sanitizeDiagnostic, sanitizeForTerminal, SettingsLoadError, USAGE, WARNING_PREFIX } from './shared.js';

export interface PermissionsListArgs {
  command: 'permissions-list';
}

export type PermissionsParseResult =
  | { ok: true; value: PermissionsListArgs }
  | { ok: false; error: string };

/**
 * `permissions list`: a read-only diagnostic that prints the rule table the
 * next `run` would enforce (issue #74). No flags, one subcommand; anything
 * else is a usage error, the same exit class as every other parser.
 */
export function parsePermissionsArgs(argv: string[]): PermissionsParseResult {
  const [subcommand, ...rest] = argv;
  if (subcommand !== 'list') {
    return { ok: false, error: `Unknown permissions subcommand '${subcommand ?? ''}'. ${USAGE}` };
  }
  if (rest.length > 0) {
    return { ok: false, error: `Unexpected argument '${rest[0] ?? ''}'. ${USAGE}` };
  }
  return { ok: true, value: { command: 'permissions-list' } };
}

export interface PermissionsStreams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface PermissionsOptions {
  /** The user settings layer's home; defaults to `os.homedir()` (the CliSeams.userDir seam). */
  userDir?: string;
  /** The project layer's root; defaults to `process.cwd()`. */
  projectDir?: string;
  /** Test seam, passed straight to `composeSecurity`; omitted, the guarded reader is used. */
  readFile?: (path: string) => string;
}

const LAYERS: readonly SettingsLayer[] = ['user', 'project'];

/**
 * Every settings-derived string (tool, match, path) is attacker-influenceable
 * in a cloned repo, so it goes through the diagnostic sanitiser (C0/C1, bidi,
 * default-ignorables) and is then JSON-quoted: the quoting turns a surviving
 * LF or TAB into a visible escape, so a hostile glob can neither start a fake
 * table row nor hide trailing whitespace. A table, not prose, so the stricter
 * stderr sanitiser applies on stdout too (ADR-0031 decision 5 lets the glob
 * appear on this ephemeral surface; it does not exempt it from sanitising).
 */
function quote(value: string): string {
  return JSON.stringify(sanitizeDiagnostic(value));
}

/**
 * A stderr line must stay ONE line: `sanitizeDiagnostic` keeps LF and TAB, and
 * the warning and error texts embed settings paths (a cwd can be named with an
 * LF), so a raw LF would start an unprefixed forged line. Escape them visibly.
 */
function oneLine(text: string): string {
  return sanitizeDiagnostic(text).replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

function ruleLine(rule: LayeredRule, index: number): string {
  const match = rule.match === undefined ? '' : ` match=${quote(rule.match)}`;
  // `[rule N, layer]` is byte-for-byte the recovery key the evaluator prints
  // in a deny reason (src/security/permissions/evaluate.ts describeRule), with
  // N the 0-based position inside that layer's own settings file.
  return `  [rule ${index}, ${rule.layer}] ${rule.decision} tool=${quote(rule.tool)}${match}`;
}

function layerSection(layer: SettingsLayer, path: string, rules: readonly LayeredRule[]): string[] {
  const own = rules.filter((rule) => rule.layer === layer);
  return [
    `${layer} layer (${quote(path)})`,
    ...(own.length === 0 ? ['  (no rules)'] : own.map((rule, index) => ruleLine(rule, index))),
  ];
}

/**
 * Loads settings exactly as `run` does (`composeSecurity`: same guarded
 * reader, validation, layers and warnings) and prints the resolved rule
 * table. No evaluation, no writes, no telemetry. A malformed layer exits 2
 * with the loader's own message, as `run` does; a missing file is an empty
 * layer. An unexpected error propagates to main()'s catch-all.
 */
export function runPermissionsList(
  _args: PermissionsListArgs,
  streams: PermissionsStreams = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  options: PermissionsOptions = {},
): number {
  const userDir = options.userDir ?? homedir();
  const projectDir = options.projectDir ?? process.cwd();
  let security;
  try {
    security = composeSecurity({
      userDir,
      projectDir,
      ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    });
  } catch (error: unknown) {
    if (error instanceof SettingsLoadError) {
      streams.stderr(`${oneLine(error.message)}\n`);
      return 2;
    }
    throw error;
  }
  for (const warning of security.warnings) {
    streams.stderr(`${WARNING_PREFIX}${oneLine(warning)}\n`);
  }

  const rules = security.permissions.rules ?? [];
  const paths: Record<SettingsLayer, string> = {
    user: join(userDir, '.harness', 'settings.json'),
    project: join(projectDir, '.harness', 'settings.json'),
  };
  const configured = security.permissions.defaultDecision;
  const lines = [
    ...LAYERS.flatMap((layer) => layerSection(layer, paths[layer], rules)),
    configured === undefined
      ? 'defaultDecision: allow (built-in default; no settings file sets it)'
      : `defaultDecision: ${configured}`,
  ];
  // Redundant by construction (every embedded string is already quoted and
  // sanitised, the literals are clean); kept as a last-line guard, and no test
  // can bind it.
  streams.stdout(sanitizeForTerminal(`${lines.join('\n')}\n`));
  return 0;
}
