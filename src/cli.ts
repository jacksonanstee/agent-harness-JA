#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import {
  composeSecurity,
  hookRecordToTelemetryInput,
  sanitizeForTerminal,
  SettingsLoadError,
  USAGE,
} from './cli/shared.js';
import { escapeJsonText } from './internal/sanitize.js';
import { GuardedReadError, refuseSymlink } from './internal/guarded-read.js';
import type { SecurityComposition } from './cli/shared.js';
import { parseEvalArgs, runEval } from './cli/eval-command.js';
import type { EvalArgs } from './cli/eval-command.js';
import { parseInitArgs, runInit } from './cli/init-command.js';
import type { InitArgs } from './cli/init-command.js';
import { parseRedteamArgs, runRedteamCommand } from './cli/redteam-command.js';
import type { RedteamArgs } from './cli/redteam-command.js';
import { createHookRuntime } from './hooks/index.js';
import { createMemoryStore, DEFAULT_DB_PATH } from './memory/index.js';
import { route, TASK_SENSITIVITIES, TASK_SHAPES } from './router/index.js';
import type { TaskDescriptor, TaskSensitivity, TaskShape } from './router/index.js';
import { createSession, DEFAULT_DESCRIPTOR } from './session/index.js';
import type { QueryFn, SessionRefusal } from './session/index.js';
import {
  createPermissionEvaluator,
  createSandbox,
  permissionHook,
  redact,
  sandboxHook,
  scan,
} from './security/index.js';
import { load as loadSkills } from './skills/index.js';
import {
  createTelemetryStore,
  hasHomeShapedStrings,
  openTelemetryDatabase,
  parseScrubPrefix,
  scrubEvent,
  TELEMETRY_EVENT_TYPES,
} from './telemetry/index.js';
import type { TelemetryEventType, TelemetryFilter } from './telemetry/index.js';

// Pure-move re-exports (E-3 CG8, extended E-4 T8): API-compat only now —
// src/cli.test.ts still imports these from './cli.js', but full behavior
// coverage for parseEvalArgs/parseRedteamArgs moved to their own command
// test files; only reachability through parseArgs is pinned here.
export {
  refuseSymlinkedDir,
  sanitizeForTerminal,
  scorecardFilename,
  writeScorecard,
} from './cli/shared.js';
export { composeSecurity, hookRecordToTelemetryInput, SettingsLoadError } from './cli/shared.js';
export { parseEvalArgs } from './cli/eval-command.js';
export { parseRedteamArgs } from './cli/redteam-command.js';
export type { RedteamArgs } from './cli/redteam-command.js';

export interface RunArgs {
  command: 'run';
  prompt: string;
  skillsDir: string;
  dbPath: string;
  maxTurns: number;
  /** DEFAULT_DESCRIPTOR plus any --shape/--sensitivity/--expected-tokens overrides (issue #88). */
  descriptor: TaskDescriptor;
}

export interface TelemetryExportArgs {
  command: 'telemetry-export';
  dbPath: string;
  /** Output file; null writes JSONL to stdout. */
  out: string | null;
  sessionId: string | null;
  type: TelemetryEventType | null;
  /**
   * Validated `--scrub-prefix` values in argument order (marker ordinals are
   * 1-based positions in this array). Empty means no scrub: the default
   * export body is byte-identical to what it was before the flag existed.
   */
  scrubPrefixes: string[];
}

export type CliArgs = RunArgs | TelemetryExportArgs | EvalArgs | RedteamArgs | InitArgs;

export type ParseResult =
  | { ok: true; value: CliArgs }
  | { ok: false; error: string };

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
  if (argv[0] === 'init') {
    return parseInitArgs(argv.slice(1));
  }
  return parseRunArgs(argv);
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
  const scrubPrefixes: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (
      arg === '--db' ||
      arg === '--out' ||
      arg === '--session' ||
      arg === '--type' ||
      arg === '--scrub-prefix'
    ) {
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
      if (arg === '--scrub-prefix') {
        const parsedPrefix = parseScrubPrefix(value);
        if (!parsedPrefix.ok) {
          return { ok: false, error: `${parsedPrefix.error}. ${USAGE}` };
        }
        scrubPrefixes.push(parsedPrefix.value);
      }
      i += 1;
    } else {
      return { ok: false, error: `Unexpected argument '${arg}'. ${USAGE}` };
    }
  }

  return {
    ok: true,
    value: { command: 'telemetry-export', dbPath, out, sessionId, type, scrubPrefixes },
  };
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
  // Descriptor defaults are the session's own fallback values, imported
  // rather than hand-copied, so the flagless route cannot drift (issue #88).
  let shape = DEFAULT_DESCRIPTOR.shape;
  let sensitivity = DEFAULT_DESCRIPTOR.sensitivity;
  let expectedTokens = DEFAULT_DESCRIPTOR.expected_tokens;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (
      arg === '--skills-dir' ||
      arg === '--db' ||
      arg === '--max-turns' ||
      arg === '--shape' ||
      arg === '--sensitivity' ||
      arg === '--expected-tokens'
    ) {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: `Missing value for ${arg}. ${USAGE}` };
      }
      if (arg === '--skills-dir') skillsDir = value;
      if (arg === '--db') dbPath = value;
      if (arg === '--max-turns') {
        // isSafeInteger, not isInteger: above 2^53 parseInt silently rewrites
        // the digits (code lens on 472b1eb), and a bound the operator never
        // typed is worse than a rejection.
        const parsed = /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          return { ok: false, error: `--max-turns must be a positive integer. ${USAGE}` };
        }
        maxTurns = parsed;
      }
      if (arg === '--shape') {
        if (!(TASK_SHAPES as readonly string[]).includes(value)) {
          return { ok: false, error: `--shape must be one of ${TASK_SHAPES.join('|')}. ${USAGE}` };
        }
        shape = value as TaskShape;
      }
      if (arg === '--sensitivity') {
        if (!(TASK_SENSITIVITIES as readonly string[]).includes(value)) {
          return {
            ok: false,
            error: `--sensitivity must be one of ${TASK_SENSITIVITIES.join('|')}. ${USAGE}`,
          };
        }
        sensitivity = value as TaskSensitivity;
      }
      if (arg === '--expected-tokens') {
        // 0 is valid: route() accepts any non-negative finite number and the
        // golden-task schema says minimum 0. This bound matches the layer the
        // value feeds, deliberately unlike --max-turns's >= 1.
        const parsed = /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          return { ok: false, error: `--expected-tokens must be a non-negative integer. ${USAGE}` };
        }
        expectedTokens = parsed;
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

  return {
    ok: true,
    value: {
      command: 'run',
      prompt,
      skillsDir,
      dbPath,
      maxTurns,
      descriptor: { shape, sensitivity, expected_tokens: expectedTokens },
    },
  };
}

function runTelemetryExport(args: TelemetryExportArgs): number {
  const db = openTelemetryDatabase({ path: args.dbPath });
  try {
    const store = createTelemetryStore(db);
    const filter: TelemetryFilter = {};
    if (args.sessionId !== null) filter.sessionId = args.sessionId;
    if (args.type !== null) filter.type = args.type;
    const events = store.query(filter);
    // JSON.stringify escapes C0 controls and lone surrogates and NOTHING ELSE:
    // U+007F, the whole C1 block, U+2028/U+2029 and every bidi/invisible
    // character reach the output RAW (swept, internal/sanitize.test.ts).
    // `sessionId`/`turnId` are REFUSED on the write path since issue #51, so
    // they no longer arrive here verbatim through `record()`. This escape is
    // still load-bearing, for the residual that fix left: rows written by a
    // binary older than #51, or by another writer straight into the shared
    // SQLite file, which is what rowToEvent's "never trust a shared DB file
    // blindly" validation exists for. Do not read the #51 gate as making this
    // redundant, and do not "fix" the residual by sanitizing ids on write:
    // ADR-0011 R-k records why refusal, not substitution, is correct for an
    // identity column.
    //
    // escapeJsonText
    // re-encodes each of those as a `\uXXXX` JSON escape: valid JSON that
    // parses back to the identical value, so the export stays lossless for
    // machine consumers while the file is safe to `cat`. Lossless holds for
    // the DEFAULT export only: `--scrub-prefix` is the one opt-in LOSSY
    // transform, applied to the events before this stringify pass and
    // signalled per emitted row (ADR-0031 decision 7).
    //
    // Applied ONCE to the whole body so the two sinks are byte-identical. The
    // previous stdout-only `sanitizeForTerminal` pass was both insufficient
    // (bidi passed straight through) and lossy (it substituted a space, so the
    // stdout copy of a row parsed to a DIFFERENT value than the --out copy).
    // It is not kept as a second pass: JSON_TEXT_UNSAFE is derived from
    // TERMINAL_UNSAFE, so it is a superset by construction and the pass would
    // be a no-op. The containment test enforces that instead.
    const scrubbing = args.scrubPrefixes.length > 0;
    let lines: string;
    if (scrubbing) {
      let scrubbedRows;
      try {
        scrubbedRows = events.map((event, index) => {
          try {
            return scrubEvent(event, args.scrubPrefixes);
          } catch (error: unknown) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(
              `--scrub-prefix refused row ${index + 1} of ${events.length}: ${reason}`,
              { cause: error },
            );
          }
        });
      } catch (error: unknown) {
        // A hostile row (depth bomb, key-collision plant) refuses the WHOLE
        // scrubbed export, loudly, with the row's position so the operator can
        // filter it out via --session/--type — the rowToEvent precedent: never
        // emit a partial artefact. The message carries no untrusted bytes by
        // construction; sanitize anyway, this is a terminal sink.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`error: ${sanitizeForTerminal(message)}\n`);
        return 1;
      }
      lines = scrubbedRows.map((row) => JSON.stringify(row)).join('\n');
      if (scrubbedRows.some((row) => hasHomeShapedStrings(row))) {
        // Survivor nudge: the scrub ran but home-shaped paths remain (wrong or
        // misspelt prefix, case variant, NFC/NFD mismatch). Observe-only,
        // stderr, no row data echoed; stdout/--out bytes are untouched.
        process.stderr.write(
          'note: home-directory-shaped paths remain after --scrub-prefix; ' +
            'the prefix must match the stored bytes exactly (case and unicode form included).\n',
        );
      }
    } else {
      lines = events.map((event) => JSON.stringify(event)).join('\n');
      if (events.some((event) => hasHomeShapedStrings(event))) {
        // One static stderr line, echoing no row data; stdout/--out bytes are
        // untouched, so forgetting the flag stays visible without becoming a
        // silent transform (design E v2, finding 16). Runs on RAW event values:
        // review executed the serialised form and JSON's backslash-doubling
        // made the Windows arm unmatchable here.
        process.stderr.write(
          'note: this export contains home-directory-shaped paths in cleartext; ' +
            're-run with --scrub-prefix <path> to replace a prefix in the export copy.\n',
        );
      }
    }
    const body = escapeJsonText(events.length > 0 ? `${lines}\n` : '');
    if (args.out !== null) {
      writeFileSync(args.out, body);
    } else {
      process.stdout.write(body);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Renders a vendor-supplied token as a QUOTED, escaped field value.
 *
 * The `key=value ` shape of the two `[harness]` lines is space-delimited, and
 * these tokens are cleaned but may still contain spaces, so an unquoted value
 * can forge sibling fields: a category of
 * `benign fallback=none` made `grep -o 'fallback=[^ ]*'` report `none` while a
 * different model had actually answered (verify-pass finding). JSON.stringify
 * gives quoting plus escaping of embedded quotes in one step, so a value can no
 * longer end a field it does not own.
 */
function formatTokenField(value: string): string {
  return JSON.stringify(sanitizeForTerminal(value));
}

/**
 * The stdout summary line states the routed model as fact. Under a fallback
 * swap that claim is false, and the correction used to live only on stderr, so
 * `run > out.txt` captured a file whose single model claim was wrong with no
 * trace of the swap (ADR-0025 decision 4). Annotating the claim keeps the
 * correction on the same stream as the claim.
 */
export function formatModelClaim(routedModel: string, refusal: SessionRefusal | null): string {
  if (refusal === null || refusal.fallbackModel === null) return routedModel;
  return `${routedModel} (answered by ${formatTokenField(refusal.fallbackModel)})`;
}

/**
 * Operator-facing refusal report (ADR-0025), or null when there was no refusal.
 * Pure so it is testable: the `run` path itself cannot execute under vitest
 * because it loads the real SDK.
 *
 * Every vendor-influenced field goes through `formatTokenField` (sanitize plus
 * quote). `source` is the one deliberate exception: it is a harness-owned
 * literal union, never vendor input, so it is emitted bare. A fourth field must
 * be assumed vendor-influenced and quoted unless it is likewise harness-owned.
 */
export function formatRefusalLine(
  refusal: SessionRefusal | null,
  stopReason: string | null,
): string | null {
  if (refusal === null) return null;
  const category = formatTokenField(refusal.category ?? 'unknown');
  const fallback =
    refusal.fallbackModel === null
      ? '"none"'
      : `${formatTokenField(refusal.fallbackModel)} (ANSWERED THIS TURN, not the routed model)`;
  return (
    `[harness] refusal: source=${refusal.source} category=${category} ` +
    `fallback=${fallback} stop_reason=${formatTokenField(stopReason ?? 'n/a')}`
  );
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    // Parse errors echo the offending argv verbatim (e.g. an attacker-named
    // entry pulled in by a glob); sanitize before it reaches the terminal,
    // same as every command's own output sinks.
    process.stderr.write(`${sanitizeForTerminal(parsed.error)}\n`);
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

  if (parsed.value.command === 'init') {
    return runInit(parsed.value);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      'ANTHROPIC_API_KEY is not set.\n\n' +
        'Export it, then re-run:\n' +
        '  export ANTHROPIC_API_KEY=sk-ant-...\n\n' +
        'Get a key at https://console.anthropic.com/settings/keys\n',
    );
    return 2;
  }

  const { prompt, skillsDir, dbPath, maxTurns, descriptor } = parsed.value;

  // A malicious clone can commit its skills directory as a symlink whose
  // target escapes the project; load() realpaths the root and scans the
  // target, injecting skill-shaped files into the system prompt at
  // system-prompt authority (issue #92, ADR-0006). Refuse a symlink AT the
  // named directory, before the SDK is reached. This is deliberately narrower
  // than the eval path's containSkillsDir (ADR-0017): on the run path the
  // OPERATOR chooses the directory and may legitimately point it outside cwd
  // (`--skills-dir /abs/dir`, whose ancestors like macOS /tmp are OS-owned
  // symlinks), so containment against cwd would reject a valid choice, and the
  // repo-committable component the default `./skills` exposes is the leaf. A
  // non-symlink error (unreadable) is NOT made fatal here: load() already
  // treats a directory it cannot stat as a non-fatal empty load, and lstat
  // failing means load() cannot follow a symlink silently either, so the gap
  // does not reopen.
  try {
    refuseSymlink(resolve(skillsDir), 'skills directory');
  } catch (error: unknown) {
    if (error instanceof GuardedReadError && error.refusal === 'symlink') {
      process.stderr.write(`refusing to load skills: ${sanitizeForTerminal(error.message)}\n`);
      return 2;
    }
    if (!(error instanceof GuardedReadError)) throw error;
  }

  // Security settings composition (permissions ADR-0014, sandbox ADR-0015).
  // A present-but-malformed file aborts the run before any tool executes —
  // fail loud, never fail open.
  let security: SecurityComposition;
  try {
    security = composeSecurity({
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
        hookRecordToTelemetryInput(record, { sessionId: harnessSessionId, turnId }, { redactSecrets: redact }),
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
      descriptor,
      generateId: () => harnessSessionId,
      turnId,
      onText: (text) => process.stdout.write(`${sanitizeForTerminal(text)}\n`),
      onWarning: (message) => process.stderr.write(`warning: ${sanitizeForTerminal(message)}\n`),
    },
  );

  const result = await session.run(prompt);

  const cost = result.costUsd === null ? 'n/a' : `$${result.costUsd.toFixed(4)}`;
  process.stdout.write(
    `\n[harness] model=${formatModelClaim(result.modelChoice.model, result.refusal)} ` +
      `(rule=${result.modelChoice.rule_id}) ` +
      `turns=${result.numTurns ?? 'n/a'} cost=${cost} ` +
      `denied=${result.denied.length} memory=${sanitizeForTerminal(result.memoryEntryId ?? 'none')}\n`,
  );

  // ADR-0025: a refusal must never read as an empty success. This can fire
  // alongside exit 0, when a fallback swap produced a genuine answer.
  const refusalLine = formatRefusalLine(result.refusal, result.stopReason);
  if (refusalLine !== null) process.stderr.write(`${refusalLine}\n`);

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
