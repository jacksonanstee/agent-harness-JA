#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CORPUS,
  createGoldenRunner,
  EvalUsageError,
  runRedteam,
  toCanonicalJson,
  toMarkdown,
  toRedteamMarkdown,
} from './eval/index.js';
import type { RedteamScorecard, TaskSessionConfig } from './eval/index.js';
import { createHookRuntime } from './hooks/index.js';
import type { HookEventRecord } from './hooks/index.js';
import { createMemoryStore, DEFAULT_DB_PATH } from './memory/index.js';
import { route } from './router/index.js';
import { createSession } from './session/index.js';
import type { QueryFn } from './session/index.js';
import {
  createPermissionEvaluator,
  createSandbox,
  mergeLayers,
  mergeSandboxLayers,
  parsePermissionSettings,
  parseSandboxSettings,
  PermissionSettingsError,
  permissionHook,
  redact,
  sandboxHook,
  SandboxSettingsError,
  scan,
  SHELL_RUNNER_BINARIES,
} from './security/index.js';
import type { EvaluatorOptions, SandboxConfig } from './security/index.js';
import { loadJsonSettings } from './internal/settings.js';
import { load as loadSkills } from './skills/index.js';
import {
  createTelemetryStore,
  openTelemetryDatabase,
  TELEMETRY_EVENT_TYPES,
} from './telemetry/index.js';
import type { TelemetryEventInput, TelemetryEventType, TelemetryFilter } from './telemetry/index.js';

export interface RunArgs {
  command: 'run';
  prompt: string;
  skillsDir: string;
  dbPath: string;
  maxTurns: number;
}

export interface TelemetryExportArgs {
  command: 'telemetry-export';
  dbPath: string;
  /** Output file; null writes JSONL to stdout. */
  out: string | null;
  sessionId: string | null;
  type: TelemetryEventType | null;
}

export interface EvalArgs {
  command: 'eval';
  taskDir: string;
}

export interface RedteamArgs {
  command: 'redteam';
  out: string;
}

export type CliArgs = RunArgs | TelemetryExportArgs | EvalArgs | RedteamArgs;

export type ParseResult =
  | { ok: true; value: CliArgs }
  | { ok: false; error: string };

// Deliberately separate from src/internal/sanitize.ts: model output and
// warnings reach the user's terminal, where newline/tab are kept for
// readability while ANSI/OSC escape introducers and C1 controls are stripped.
const TERMINAL_UNSAFE = /[\x00-\x08\x0B-\x1F\x7F-\x9F\u2028\u2029]/g;

export function sanitizeForTerminal(text: string): string {
  return text.replace(TERMINAL_UNSAFE, ' ');
}

/** Path-prefixed settings failures from the composition root's combined loader. */
export class SettingsLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsLoadError';
  }
}

export interface SecurityComposition {
  permissions: EvaluatorOptions;
  sandbox: SandboxConfig;
  /** Startup notices for the operator (prompter gaps, risky allowlists). */
  warnings: string[];
}

export interface ComposeSecurityDeps {
  readFile: (path: string) => string;
  userDir: string;
  projectDir: string;
}

/**
 * Loads and merges both security settings layers. Each file is read ONCE and
 * its parsed doc feeds both key-parsers (permissions ADR-0014, sandbox
 * ADR-0015). Module parse errors are re-tagged SettingsLoadError so the
 * shared loader path-prefixes them and main() has one failure type to map to
 * exit 2. Extracted from main() so the composition logic is unit-testable
 * without an SDK or API key.
 */
export function composeSecurity(deps: ComposeSecurityDeps): SecurityComposition {
  const layers = [
    join(deps.userDir, '.harness', 'settings.json'),
    join(deps.projectDir, '.harness', 'settings.json'),
  ].map((path) =>
    loadJsonSettings(
      path,
      deps.readFile,
      (doc) => {
        try {
          return {
            permissions: parsePermissionSettings(doc),
            sandbox: parseSandboxSettings(doc),
          };
        } catch (error: unknown) {
          if (
            error instanceof PermissionSettingsError ||
            error instanceof SandboxSettingsError
          ) {
            throw new SettingsLoadError(error.message);
          }
          throw error;
        }
      },
      { permissions: { rules: [] }, sandbox: {} },
      SettingsLoadError,
    ),
  );
  const [user, project] = layers as [(typeof layers)[0], (typeof layers)[0]];
  const permissions = mergeLayers(user.permissions, project.permissions);
  const sandbox = mergeSandboxLayers(user.sandbox, project.sandbox);

  const warnings: string[] = [];
  // No prompter is wired yet (no interactive mode), so every 'ask' resolves
  // to deny — fail closed, but tell the settings author (ADR-0014 §4).
  if (
    (permissions.rules ?? []).some((r) => r.decision === 'ask') ||
    permissions.defaultDecision === 'ask'
  ) {
    warnings.push(
      "settings contain 'ask' permissions but no prompter is configured; 'ask' will deny (ADR-0014 §4)",
    );
  }
  // Shell runners are DENIED by the sandbox regardless of the allowlist
  // (SHELL_RUNNER_BINARIES blocklist); surface the conflict at startup.
  const blocked = (sandbox.commands?.allow ?? []).filter((entry) =>
    SHELL_RUNNER_BINARIES.includes(entry),
  );
  if (blocked.length > 0) {
    warnings.push(
      `sandbox command allowlist includes ${blocked.join(', ')} — shell runners defeat first-token enforcement and are always denied (ADR-0015 §3)`,
    );
  }
  return { permissions, sandbox, warnings };
}

/** Default scorecard output directory, shared by eval and redteam (both are
 *  scorecard producers writing through the same `writeScorecard` helper). */
const EVAL_OUT_DIR = join('.harness', 'eval');

const USAGE =
  'Usage: agent-harness-ja run "<prompt>" [--skills-dir <dir>] [--db <path>] [--max-turns <n>]\n' +
  '       agent-harness-ja eval [taskDir]\n' +
  '       agent-harness-ja redteam [--out <dir>]\n' +
  '       agent-harness-ja telemetry export [--db <path>] [--out <file>] [--session <id>] [--type <t>]';

export function parseArgs(argv: string[]): ParseResult {
  if (argv[0] === 'telemetry') {
    return parseTelemetryArgs(argv.slice(1));
  }
  if (argv[0] === 'eval') {
    return parseEvalArgs(argv.slice(1));
  }
  if (argv[0] === 'redteam') {
    return parseRedteamArgs(argv.slice(1));
  }
  return parseRunArgs(argv);
}

export function parseEvalArgs(argv: string[]): ParseResult {
  let taskDir = './eval/golden';
  let positionalSeen = false;
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      return { ok: false, error: `Unknown flag '${arg}'. ${USAGE}` };
    }
    if (positionalSeen) {
      return { ok: false, error: `Unexpected extra argument '${arg}'. ${USAGE}` };
    }
    taskDir = arg;
    positionalSeen = true;
  }
  return { ok: true, value: { command: 'eval', taskDir } };
}

/** No positionals; `--out` overrides the shared scorecard directory. */
export function parseRedteamArgs(argv: string[]): ParseResult {
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

function parseTelemetryArgs(argv: string[]): ParseResult {
  const [subcommand, ...rest] = argv;
  if (subcommand !== 'export') {
    return { ok: false, error: `Unknown telemetry subcommand '${subcommand ?? ''}'. ${USAGE}` };
  }

  let dbPath = DEFAULT_DB_PATH;
  let out: string | null = null;
  let sessionId: string | null = null;
  let type: TelemetryEventType | null = null;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (arg === '--db' || arg === '--out' || arg === '--session' || arg === '--type') {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: `Missing value for ${arg}. ${USAGE}` };
      }
      if (arg === '--db') dbPath = value;
      if (arg === '--out') out = value;
      if (arg === '--session') sessionId = value;
      if (arg === '--type') {
        if (!(TELEMETRY_EVENT_TYPES as readonly string[]).includes(value)) {
          return {
            ok: false,
            error: `--type must be one of ${TELEMETRY_EVENT_TYPES.join('|')}. ${USAGE}`,
          };
        }
        type = value as TelemetryEventType;
      }
      i += 1;
    } else {
      return { ok: false, error: `Unexpected argument '${arg}'. ${USAGE}` };
    }
  }

  return { ok: true, value: { command: 'telemetry-export', dbPath, out, sessionId, type } };
}

export function parseRunArgs(argv: string[]): ParseResult {
  const [command, ...rest] = argv;
  if (command !== 'run') {
    return { ok: false, error: `Unknown command '${command ?? ''}'. ${USAGE}` };
  }

  let prompt: string | null = null;
  let skillsDir = './skills';
  let dbPath = DEFAULT_DB_PATH;
  let maxTurns = 10;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (arg === '--skills-dir' || arg === '--db' || arg === '--max-turns') {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: `Missing value for ${arg}. ${USAGE}` };
      }
      if (arg === '--skills-dir') skillsDir = value;
      if (arg === '--db') dbPath = value;
      if (arg === '--max-turns') {
        const parsed = /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
        if (!Number.isInteger(parsed) || parsed < 1) {
          return { ok: false, error: `--max-turns must be a positive integer. ${USAGE}` };
        }
        maxTurns = parsed;
      }
      i += 1;
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `Unknown flag '${arg}'. ${USAGE}` };
    } else if (prompt === null) {
      prompt = arg;
    } else {
      return { ok: false, error: `Unexpected extra argument '${arg}'. ${USAGE}` };
    }
  }

  if (prompt === null || prompt.trim() === '') {
    return { ok: false, error: `A non-empty prompt is required. ${USAGE}` };
  }

  return { ok: true, value: { command: 'run', prompt, skillsDir, dbPath, maxTurns } };
}

/**
 * Maps a hook runtime record onto telemetry's structural hook-event payload.
 * Lives here (the composition root) so hooks and telemetry stay import-free
 * peers (ADR-0011).
 */
export function hookRecordToTelemetryInput(
  record: HookEventRecord,
  ids: { sessionId: string; turnId: string },
): TelemetryEventInput {
  const base = { type: 'hook-event' as const, sessionId: ids.sessionId, turnId: ids.turnId };
  if (record.kind === 'denied-by-hook') {
    return {
      ...base,
      payload: {
        kind: record.kind,
        event: record.event,
        tool: record.tool,
        reason: record.reason,
        handlerIndex: record.handlerIndex,
      },
    };
  }
  if (record.kind === 'hook-error') {
    return {
      ...base,
      payload: {
        kind: record.kind,
        event: record.event,
        reason: record.reason,
        handlerIndex: record.handlerIndex,
      },
    };
  }
  return {
    ...base,
    payload: { kind: record.kind, event: record.event, handlersFired: record.handlersFired },
  };
}

/** Filesystem-safe scorecard timestamp (spec: arbiter condition 2 — no colons). */
export function scorecardFilename(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `scorecard-${stamp}.json`;
}

/**
 * A malicious repo must not redirect the scorecard write (spec decision #21):
 * refuse a symlink at the output-dir path. Missing is fine (we mkdir it).
 */
export function refuseSymlinkedDir(path: string): void {
  let isSymlink: boolean;
  try {
    isSymlink = lstatSync(path).isSymbolicLink();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (isSymlink) {
    throw new EvalUsageError(`refusing to write scorecards: ${path} is a symlink`);
  }
}

/**
 * Write the canonical scorecard under outDir. Every failure maps to a message,
 * never a throw: a failed write means no scorecard was produced, which the
 * caller must surface as exit 2 (ADR-0017 decision #4) — bubbling to the
 * generic exit-1 handler would report it on the code reserved for "ran, at
 * least one row failed". Not just symlink refusals: ENOTDIR (a regular file
 * committed at the output path), EACCES, and ENOSPC all end here too.
 *
 * Generic over any scorecard envelope (golden, redteam, ...): the same
 * constraint `toCanonicalJson` requires, so every scorecard producer writes
 * through this one helper instead of duplicating it.
 */
export function writeScorecard<T extends { rows: ReadonlyArray<{ id: string }> }>(
  scorecard: T,
  outDir: string,
  nowMs: number = Date.now(),
): { ok: true; path: string } | { ok: false; message: string } {
  try {
    mkdirSync(outDir, { recursive: true });
    // Re-checks only the leaf path (outDir); it narrows the TOCTOU window
    // opened by mkdir but does not close it — an in-process oracle can write
    // anywhere regardless (security-model R-10).
    refuseSymlinkedDir(outDir);
    const path = join(outDir, scorecardFilename(nowMs));
    writeFileSync(path, toCanonicalJson(scorecard));
    return { ok: true, path };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}

function runTelemetryExport(args: TelemetryExportArgs): number {
  const db = openTelemetryDatabase({ path: args.dbPath });
  try {
    const store = createTelemetryStore(db);
    const filter: TelemetryFilter = {};
    if (args.sessionId !== null) filter.sessionId = args.sessionId;
    if (args.type !== null) filter.type = args.type;
    const events = store.query(filter);
    // Stored payload strings are sanitized on write and JSON.stringify escapes
    // any remaining control characters, but stdout still gets a terminal
    // sanitize pass — defense in depth against future schema drift.
    const lines = events.map((event) => JSON.stringify(event)).join('\n');
    const body = events.length > 0 ? `${lines}\n` : '';
    if (args.out !== null) {
      writeFileSync(args.out, body);
    } else {
      process.stdout.write(sanitizeForTerminal(body));
    }
    return 0;
  } finally {
    db.close();
  }
}

async function runEval(args: EvalArgs): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('ANTHROPIC_API_KEY is not set. Export it before running eval.\n');
    return 2;
  }

  let security: SecurityComposition;
  try {
    security = composeSecurity({
      readFile: (p) => readFileSync(p, 'utf8'),
      userDir: homedir(),
      projectDir: process.cwd(),
    });
  } catch (error: unknown) {
    if (error instanceof SettingsLoadError) {
      process.stderr.write(`${sanitizeForTerminal(error.message)}\n`);
      return 2;
    }
    throw error;
  }
  for (const warning of security.warnings) {
    process.stderr.write(`warning: ${sanitizeForTerminal(warning)}\n`);
  }

  // Pre-flight, before any spend: the write path must be trustworthy.
  try {
    refuseSymlinkedDir('.harness');
    refuseSymlinkedDir(EVAL_OUT_DIR);
  } catch (error: unknown) {
    if (error instanceof EvalUsageError) {
      process.stderr.write(`${sanitizeForTerminal(error.message)}\n`);
      return 2;
    }
    throw error;
  }

  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as { query: unknown };
  if (typeof sdk.query !== 'function') {
    process.stderr.write(
      'The installed @anthropic-ai/claude-agent-sdk does not export query(); check the SDK version.\n',
    );
    return 2;
  }
  const query = sdk.query as QueryFn;

  // Oracle execution is arbitrary in-process code from the task directory
  // (docs/security-model.md R-10) — say so before the first import.
  process.stderr.write(
    'warning: golden-eval oracles are arbitrary code from the task directory, executed in-process — only run eval on repos you trust (security-model R-10)\n',
  );

  // In-memory DB per eval run: never contaminates the operator's real
  // .harness/telemetry.db (spec decision #15).
  const db = openTelemetryDatabase({ path: ':memory:' });
  try {
    const telemetry = createTelemetryStore(db);
    const memory = createMemoryStore(db);

    const createTaskSession = (config: TaskSessionConfig) => {
      const sessionId = randomUUID();
      const turnId = randomUUID();
      const hooks = createHookRuntime({
        onEvent: (record) => {
          const result = telemetry.record(
            hookRecordToTelemetryInput(record, { sessionId, turnId }),
          );
          if (!result.ok) {
            process.stderr.write(
              `warning: telemetry hook-event record failed: ${sanitizeForTerminal(result.error.message)}\n`,
            );
          }
        },
      });
      hooks.register('pre-tool', permissionHook(createPermissionEvaluator(security.permissions)));
      hooks.register('pre-tool', sandboxHook(createSandbox(security.sandbox)));
      return createSession(
        {
          query,
          hooks,
          memory,
          loadSkills,
          route,
          telemetry,
          scanInjection: (text) => scan(text),
          redactSecrets: (text) => redact(text),
        },
        {
          skillsDir: config.skillsDir,
          maxTurns: config.maxTurns,
          ...(config.descriptor !== undefined && { descriptor: config.descriptor }),
          generateId: () => sessionId,
          turnId,
          // No onText: eval's stdout is the scorecard, nothing else.
          onWarning: (message) =>
            process.stderr.write(`warning: ${sanitizeForTerminal(message)}\n`),
        },
      );
    };

    const runner = createGoldenRunner({
      createTaskSession,
      redactSecrets: (text) => redact(text),
      harnessVersion: readPackageVersion(),
    });

    let scorecard;
    try {
      scorecard = await runner.run(args.taskDir, {
        onProgress: (line) => process.stderr.write(`${sanitizeForTerminal(line)}\n`),
      });
    } catch (error: unknown) {
      if (error instanceof EvalUsageError) {
        process.stderr.write(`${sanitizeForTerminal(error.message)}\n`);
        return 2;
      }
      throw error;
    }

    // Write the JSON scorecard BEFORE anything hits stdout: a symlink planted
    // between the pre-flight check and here must still honor the exit-2
    // contract (ADR-0017 decision #4 — exit 2 means no scorecard produced).
    // Once the markdown below reaches stdout that contract can no longer be
    // kept, so writeScorecard maps every failure to a message, none bubble.
    const written = writeScorecard(scorecard, EVAL_OUT_DIR);
    if (!written.ok) {
      process.stderr.write(`${sanitizeForTerminal(written.message)}\n`);
      return 2;
    }
    process.stderr.write(`scorecard written to ${written.path}\n`);

    process.stdout.write(sanitizeForTerminal(toMarkdown(scorecard)));

    return scorecard.totals.failed === 0 ? 0 : 1;
  } finally {
    db.close();
  }
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
function runRedteamCommand(args: RedteamArgs): number {
  const scorecard = runRedteam(CORPUS, scan, {
    armLabel: 'security-on',
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

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  if (parsed.value.command === 'telemetry-export') {
    return runTelemetryExport(parsed.value);
  }

  if (parsed.value.command === 'eval') {
    return runEval(parsed.value);
  }

  if (parsed.value.command === 'redteam') {
    return runRedteamCommand(parsed.value);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      'ANTHROPIC_API_KEY is not set. Export it before running the harness.\n',
    );
    return 2;
  }

  const { prompt, skillsDir, dbPath, maxTurns } = parsed.value;

  // Security settings composition (permissions ADR-0014, sandbox ADR-0015).
  // A present-but-malformed file aborts the run before any tool executes —
  // fail loud, never fail open.
  let security: SecurityComposition;
  try {
    security = composeSecurity({
      readFile: (p) => readFileSync(p, 'utf8'),
      userDir: homedir(),
      projectDir: process.cwd(),
    });
  } catch (error: unknown) {
    if (error instanceof SettingsLoadError) {
      process.stderr.write(`${sanitizeForTerminal(error.message)}\n`);
      return 2;
    }
    throw error;
  }
  for (const warning of security.warnings) {
    process.stderr.write(`warning: ${sanitizeForTerminal(warning)}\n`);
  }

  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as { query: unknown };
  if (typeof sdk.query !== 'function') {
    process.stderr.write(
      'The installed @anthropic-ai/claude-agent-sdk does not export query(); check the SDK version.\n',
    );
    return 2;
  }
  const query = sdk.query as QueryFn;

  // One shared connection: openTelemetryDatabase runs the migration runner,
  // which owns the shared-DB schema (memory's DDL is migration 001).
  const db = openTelemetryDatabase({ path: dbPath });
  const telemetry = createTelemetryStore(db);

  // Pre-generated correlation ids: hook events fire before the SDK reports
  // its session id, so every telemetry writer keys on the harness-side ids.
  const harnessSessionId = randomUUID();
  const turnId = randomUUID();
  const hooks = createHookRuntime({
    onEvent: (record) => {
      const result = telemetry.record(
        hookRecordToTelemetryInput(record, { sessionId: harnessSessionId, turnId }),
      );
      if (!result.ok) {
        process.stderr.write(
          `warning: telemetry hook-event record failed: ${sanitizeForTerminal(result.error.message)}\n`,
        );
      }
    },
  });
  // Permissions first, sandbox as the backstop: deny outcome is identical
  // (runtime denies on first throw), but rule-attributed permission reasons
  // are more actionable, so they get first say (ADR-0015 §4).
  hooks.register('pre-tool', permissionHook(createPermissionEvaluator(security.permissions)));
  hooks.register('pre-tool', sandboxHook(createSandbox(security.sandbox)));

  const session = createSession(
    {
      query,
      hooks,
      memory: createMemoryStore(db),
      loadSkills,
      route,
      telemetry,
      scanInjection: (text) => scan(text),
      redactSecrets: (text) => redact(text),
    },
    {
      skillsDir,
      maxTurns,
      generateId: () => harnessSessionId,
      turnId,
      onText: (text) => process.stdout.write(`${sanitizeForTerminal(text)}\n`),
      onWarning: (message) => process.stderr.write(`warning: ${sanitizeForTerminal(message)}\n`),
    },
  );

  const result = await session.run(prompt);

  const cost = result.costUsd === null ? 'n/a' : `$${result.costUsd.toFixed(4)}`;
  process.stdout.write(
    `\n[harness] model=${result.modelChoice.model} (rule=${result.modelChoice.rule_id}) ` +
      `turns=${result.numTurns ?? 'n/a'} cost=${cost} ` +
      `denied=${result.denied.length} memory=${sanitizeForTerminal(result.memoryEntryId ?? 'none')}\n`,
  );

  return result.resultSubtype === 'success' ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`error: ${message}\n`);
      process.exit(1);
    },
  );
}
