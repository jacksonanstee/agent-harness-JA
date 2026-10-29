#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import {
  apiKeyMissingMessage,
  composeSecurity,
  hookRecordToTelemetryInput,
  loadSdkQuery,
  parseSafeInt,
  parseUsd,
  registerSecurityHooks,
  sanitizeDiagnostic,
  sanitizeForTerminal,
  SettingsLoadError,
  USAGE,
  WARNING_PREFIX,
} from './cli/shared.js';
import { DEFAULT_MAX_TURNS } from './internal/limits.js';
import { escapeJsonText } from './internal/sanitize.js';
import { GuardedReadError, refuseSymlink } from './internal/guarded-read.js';
import { formatUsd } from './internal/money.js';
import { installSigintHandler } from './cli/interrupt.js';
import { judgeStartLine, judgeSummaryLines, runJudgeDeps } from './cli/run-judge.js';
import { sdkStartLine } from './cli/run-sdk.js';
import type { CliSeams, SecurityComposition } from './cli/shared.js';
import { parseEvalArgs, runEval } from './cli/eval-command.js';
import type { EvalArgs } from './cli/eval-command.js';
import { parseInitArgs, runInit } from './cli/init-command.js';
import type { InitArgs } from './cli/init-command.js';
import { parsePermissionsArgs, runPermissionsList } from './cli/permissions-command.js';
import type { PermissionsListArgs } from './cli/permissions-command.js';
import { parseTelemetryCostArgs, runTelemetryCost } from './cli/telemetry-cost-command.js';
import type { TelemetryCostArgs } from './cli/telemetry-cost-command.js';
import { parseSkillsArgs, runSkillsLint } from './cli/skills-command.js';
import type { SkillsLintArgs } from './cli/skills-command.js';
import { parseRedteamArgs, runRedteamCommand } from './cli/redteam-command.js';
import type { RedteamArgs } from './cli/redteam-command.js';
import { createHookRuntime } from './hooks/index.js';
import { createMemoryStore, DEFAULT_DB_PATH } from './memory/index.js';
import { route, TASK_SENSITIVITIES, TASK_SHAPES } from './router/index.js';
import type { TaskDescriptor, TaskSensitivity, TaskShape } from './router/index.js';
import { createSession, DEFAULT_DESCRIPTOR } from './session/index.js';
import type { CliDeniedToolCall, SessionRefusal, SessionResult } from './session/index.js';
import {
  redact,
  scan,
  buildProtectedRoots,
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
  /** `--expected-output-tokens`: CLI-only guess for the cost estimate (#192); key absent when not given. */
  outputGuess?: number;
  /** `--max-budget-usd` (#187); key absent when not given, so user settings, then the session default, apply. */
  maxBudgetUsd?: number;
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

export type CliArgs = RunArgs | TelemetryExportArgs | TelemetryCostArgs | EvalArgs | RedteamArgs | InitArgs | PermissionsListArgs | SkillsLintArgs;

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
  if (argv[0] === 'permissions') {
    return parsePermissionsArgs(argv.slice(1));
  }
  if (argv[0] === 'skills') {
    return parseSkillsArgs(argv.slice(1));
  }
  return parseRunArgs(argv);
}

function parseTelemetryArgs(argv: string[]): ParseResult {
  // Hand-written if-ladder on purpose, not a parser library: 5 flags, all
  // value flags in one branch. Revisit at 10 flags in one parser, where the
  // ladder stops fitting a screen. Integers go through parseSafeInt (#128).
  const [subcommand, ...rest] = argv;
  if (subcommand === 'cost') return parseTelemetryCostArgs(rest);
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
  // Hand-written if-ladder on purpose, not a parser library: 8 flags, all
  // value flags in one branch, plus the prompt positional. Revisit at 10 flags
  // in one parser. Integers go through parseSafeInt (#128), floors per flag;
  // the dollar cap through parseUsd (#187).
  const [command, ...rest] = argv;
  if (command !== 'run') {
    return { ok: false, error: `Unknown command '${command ?? ''}'. ${USAGE}` };
  }

  let prompt: string | null = null;
  let skillsDir = './skills';
  let dbPath = DEFAULT_DB_PATH;
  let maxTurns: number = DEFAULT_MAX_TURNS;
  // Descriptor defaults are the session's own fallback values, imported
  // rather than hand-copied, so the flagless route cannot drift (issue #88).
  let shape = DEFAULT_DESCRIPTOR.shape;
  let sensitivity = DEFAULT_DESCRIPTOR.sensitivity;
  let expectedTokens = DEFAULT_DESCRIPTOR.expected_tokens;
  let outputGuess: number | undefined;
  let maxBudgetUsd: number | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (
      arg === '--skills-dir' ||
      arg === '--db' ||
      arg === '--max-turns' ||
      arg === '--shape' ||
      arg === '--sensitivity' ||
      arg === '--expected-tokens' ||
      arg === '--expected-output-tokens' ||
      arg === '--max-budget-usd'
    ) {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: `Missing value for ${arg}. ${USAGE}` };
      }
      if (arg === '--skills-dir') skillsDir = value;
      if (arg === '--db') dbPath = value;
      if (arg === '--max-turns') {
        const parsed = parseSafeInt(value);
        if (parsed === undefined || parsed < 1) {
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
        const parsed = parseSafeInt(value);
        if (parsed === undefined) {
          return { ok: false, error: `--expected-tokens must be a non-negative integer. ${USAGE}` };
        }
        expectedTokens = parsed;
      }
      if (arg === '--expected-output-tokens') {
        const parsed = parseSafeInt(value);
        if (parsed === undefined) {
          return { ok: false, error: `--expected-output-tokens must be a non-negative integer. ${USAGE}` };
        }
        outputGuess = parsed;
      }
      if (arg === '--max-budget-usd') {
        const parsed = parseUsd(value);
        if (parsed === undefined) {
          return { ok: false, error: `--max-budget-usd must be a number of US dollars greater than 0, such as 2.50. ${USAGE}` };
        }
        maxBudgetUsd = parsed;
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
      ...(outputGuess === undefined ? {} : { outputGuess }),
      ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
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
        process.stderr.write(`error: ${sanitizeDiagnostic(message)}\n`);
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

/**
 * The `run` summary line (stdout). Pure so the field order is testable.
 * `cli-denied` sits right after `denied` on purpose (issue #209): `denied` is
 * the harness's own pre-tool denials, `cli-denied` the Claude Code CLI's own
 * refusals read from the result's `permission_denials`, and an operator
 * reading `denied=0` alone would take a CLI-blocked run for an unblocked one.
 */
export function formatRunSummaryLine(
  result: Pick<SessionResult, 'modelChoice' | 'refusal' | 'numTurns' | 'costUsd' | 'denied' | 'cliDenied' | 'memoryEntryId'>,
): string {
  const cost = result.costUsd === null ? 'n/a' : formatUsd(result.costUsd);
  return (
    `\n[harness] model=${formatModelClaim(result.modelChoice.model, result.refusal)} ` +
    `(rule=${result.modelChoice.rule_id}) ` +
    `turns=${result.numTurns ?? 'n/a'} cost=${cost} ` +
    `denied=${result.denied.length} cli-denied=${result.cliDenied.length} ` +
    `memory=${sanitizeForTerminal(result.memoryEntryId ?? 'none')}\n`
  );
}

/**
 * The stderr line naming why a run ended without success (issue #187, D4 and
 * D7), or null for success or no result. A budget stop names the cap and the
 * SDK's own cost figure, which can exceed the cap: the SDK checks it after
 * each turn, and prices some models above list (#212).
 */
export function formatStopLine(result: Pick<SessionResult, 'resultSubtype' | 'costUsd' | 'maxBudgetUsd'>): string | null {
  if (result.resultSubtype === null || result.resultSubtype === 'success') return null;
  if (result.resultSubtype === 'error_max_budget_usd') {
    const cost = result.costUsd === null ? 'n/a' : formatUsd(result.costUsd);
    return (
      `[harness] budget: run stopped at the ${formatUsd(result.maxBudgetUsd)} cap after the turn that crossed it ` +
      `(SDK-reported cost ${cost}; the cap is checked after each turn, ADR-0041)`
    );
  }
  return `[harness] stopped: the run ended without success (result=${formatTokenField(result.resultSubtype)})`;
}

/** The `run` start line naming a cap taken from the flag or the settings file (issue #187). */
export function formatBudgetStartLine(maxBudgetUsd: number, source: '--max-budget-usd' | '~/.harness/settings.json'): string {
  return `[harness] budget: cap ${formatUsd(maxBudgetUsd)} per run (from ${source})`;
}

/**
 * The `run` line for a Ctrl-C (issue #187 D5); exit 130 is the shell's code
 * for SIGINT. When the run rejected, the CLI has no cost to print; the
 * turn-cost row may still hold one (an error result can precede the abort).
 */
export function formatInterruptedLine(costUsd: number | null): string {
  const cost = costUsd === null ? 'cost unknown' : `cost ${formatUsd(costUsd)}`;
  return `[harness] interrupted: the run was stopped; its turn-cost row is recorded (${cost})`;
}
const EXIT_INTERRUPTED = 130;

/**
 * One stderr warning when the Claude Code CLI refused tool calls (issue #209),
 * or null when it refused none. Names the tools (deduplicated, first-seen
 * order, each QUOTED so a tool named `denied=5` cannot read like a run-line
 * field) and never a tool input or id: the parse already dropped the input,
 * and the names go through the same diagnostic sanitiser as every other
 * warning. Pure for the same reason as `formatRefusalLine`.
 */
export function formatCliDeniedWarning(cliDenied: readonly CliDeniedToolCall[]): string | null {
  if (cliDenied.length === 0) return null;
  const tools = [...new Set(cliDenied.map((call) => call.tool))].map(formatTokenField).join(', ');
  return (
    `${WARNING_PREFIX}${sanitizeDiagnostic(
      `${cliDenied.length} tool call(s) refused by the Claude Code CLI's own permission check ` +
        `(not this harness's hooks; with inherited settings, the operator's own hooks may count here; see ADR-0040): ${tools}`,
    )}`
  );
}

export async function main(argv: string[], seams: CliSeams = {}): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    // Parse errors echo the offending argv verbatim (e.g. an attacker-named
    // entry pulled in by a glob); sanitize before it reaches the terminal,
    // same as every command's own output sinks.
    process.stderr.write(`${sanitizeDiagnostic(parsed.error)}\n`);
    return 2;
  }

  if (parsed.value.command === 'telemetry-export') {
    return runTelemetryExport(parsed.value);
  }

  if (parsed.value.command === 'telemetry-cost') {
    return runTelemetryCost(parsed.value, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  }

  if (parsed.value.command === 'eval') {
    return runEval(parsed.value, seams);
  }

  if (parsed.value.command === 'redteam') {
    // Async since issue #96 (`--judge` awaits the judge arm); `main` already
    // awaits `runEval` the same way.
    return await runRedteamCommand(parsed.value);
  }

  if (parsed.value.command === 'init') {
    return runInit(parsed.value);
  }

  if (parsed.value.command === 'permissions-list') {
    return runPermissionsList(parsed.value, undefined, { userDir: seams.userDir ?? homedir() });
  }

  if (parsed.value.command === 'skills-lint') {
    return runSkillsLint(parsed.value);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(apiKeyMissingMessage());
    return 2;
  }

  const { prompt, skillsDir, dbPath, maxTurns, descriptor, outputGuess, maxBudgetUsd: flagBudget } = parsed.value;

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
      process.stderr.write(`refusing to load skills: ${sanitizeDiagnostic(error.message)}\n`);
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
      userDir: seams.userDir ?? homedir(),
      projectDir: process.cwd(),
    });
  } catch (error: unknown) {
    if (error instanceof SettingsLoadError) {
      process.stderr.write(`${sanitizeDiagnostic(error.message)}\n`);
      return 2;
    }
    throw error;
  }
  for (const warning of security.warnings) {
    process.stderr.write(`${WARNING_PREFIX}${sanitizeDiagnostic(warning)}\n`);
  }

  const query = await loadSdkQuery(seams.importSdk);
  if (query === null) return 2;
  if (security.judge !== null) process.stderr.write(`${judgeStartLine(security.judge)}\n`);
  const sdkLine = sdkStartLine(security.sdk.settingSources);
  if (sdkLine !== null) process.stderr.write(`${sdkLine}\n`);

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
          `${WARNING_PREFIX}telemetry hook-event record failed: ${sanitizeDiagnostic(result.error.message)}\n`,
        );
      }
    },
  });
  // Order (self-protection, permissions, then sandbox) lives in
  // registerSecurityHooks. #188: the run's own state is protected.
  const protectedRoots = buildProtectedRoots({
    userDir: seams.userDir ?? homedir(),
    projectDir: process.cwd(),
    skillsDir,
    dbPath,
  });
  registerSecurityHooks(hooks, security, protectedRoots);

  // #187 D3: flag > user settings > the session's default. Only absence
  // falls through: both sources are already validated by isBudgetUsd.
  const maxBudgetUsd = flagBudget ?? security.budget.maxUsd ?? undefined;
  // Security fold (#187): a cap from the flag or the settings file is named
  // in every `run` transcript (eval applies the settings cap silently).
  if (maxBudgetUsd !== undefined) {
    const source = flagBudget !== undefined ? '--max-budget-usd' : '~/.harness/settings.json';
    process.stderr.write(`${formatBudgetStartLine(maxBudgetUsd, source)}\n`);
  }
  const interrupt = new AbortController();

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
      ...runJudgeDeps(security.judge, query),
    },
    {
      settingSources: security.sdk.settingSources,
      skillsDir,
      maxTurns,
      descriptor,
      ...(outputGuess === undefined ? {} : { outputGuess }),
      ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
      signal: interrupt.signal,
      generateId: () => harnessSessionId,
      turnId,
      onText: (text) => process.stdout.write(`${sanitizeForTerminal(text)}\n`),
      onWarning: (message) => process.stderr.write(`${WARNING_PREFIX}${sanitizeDiagnostic(message)}\n`),
    },
  );

  // #187 D5: the first Ctrl-C aborts the run (stop hook and turn-cost row
  // still written); a second one kills the process (installSigintHandler).
  const uninstallInterrupt = (seams.onInterrupt ?? installSigintHandler)(() => interrupt.abort());
  let result: SessionResult;
  try {
    result = await session.run(prompt);
  } catch (error: unknown) {
    if (!interrupt.signal.aborted) throw error;
    process.stderr.write(`${formatInterruptedLine(null)}\n`);
    return EXIT_INTERRUPTED;
  } finally {
    uninstallInterrupt();
  }

  process.stdout.write(formatRunSummaryLine(result));
  const stopLine = formatStopLine(result);
  if (stopLine !== null) process.stderr.write(`${stopLine}\n`);
  // The interrupt raced the end of the stream: the run returned, but it was
  // still the operator's Ctrl-C, so the exit says so (review fold).
  const interruptedLine = result.interrupted ? formatInterruptedLine(result.costUsd) : null;

  const cliDeniedWarning = formatCliDeniedWarning(result.cliDenied);
  if (cliDeniedWarning !== null) process.stderr.write(`${cliDeniedWarning}\n`);

  // ADR-0025: a refusal must never read as an empty success. This can fire
  // alongside exit 0, when a fallback swap produced a genuine answer.
  const refusalLine = formatRefusalLine(result.refusal, result.stopReason);
  if (refusalLine !== null) process.stderr.write(`${refusalLine}\n`);

  // Issue #84 (D5/U-5) and #145 B2a (spec D5): a one-line summary of the model-facing
  // controls, and a WARNING line whenever a rewrite did not land clean or a failed
  // call's output could only be annotated (never rewritten). Counts only — no secret
  // bytes. `rewrite(s) applied` counts the redaction pass only; an applied withhold
  // is counted once, under its own word (r2 N3b). The problem clause stays kind-blind.
  const appliedRewrites = result.outputRewrites.filter((r) => r.outcome === 'applied' && r.kind !== 'withhold').length;
  const appliedWithholds = result.outputRewrites.filter((r) => r.kind === 'withhold' && r.outcome === 'applied').length;
  const problemRewrites = result.outputRewrites.filter(
    (r) =>
      r.outcome === 'leaked' ||
      r.outcome === 'unobserved' ||
      r.outcome === 'unrewritten' ||
      r.outcome === 'failed-closed',
  ).length;
  const failureAnnotations = result.outputAnnotations.filter((a) => a.phase === 'post-tool-failure').length;
  process.stderr.write(
    `[harness] model-facing: ${appliedRewrites} rewrite(s) applied, ` +
      `${result.outputAnnotations.length} injection note(s)` +
      `${appliedWithholds > 0 ? `, ${appliedWithholds} withhold(s) applied` : ''}\n`,
  );
  if (problemRewrites > 0 || failureAnnotations > 0) {
    process.stderr.write(
      `${WARNING_PREFIX}model-facing enforcement incomplete: ${problemRewrites} rewrite(s) ` +
        `leaked/unobserved/unrewritten/failed-closed, ${failureAnnotations} failed-call result(s) ` +
        `annotated but NOT rewritten (no rewrite channel on a failed call, #84)\n`,
    );
  }

  // Issue #96 PR-B1 (spec D7): the judge's own line, after the model-facing one; its spend is not in cost= above.
  if (result.judge !== null) {
    const lines = judgeSummaryLines(result.judge);
    process.stderr.write(`${lines.summary}\n`);
    if (lines.capWarning !== null) process.stderr.write(`${WARNING_PREFIX}${lines.capWarning}\n`);
  }

  if (interruptedLine !== null) {
    process.stderr.write(`${interruptedLine}\n`);
    return EXIT_INTERRUPTED;
  }
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
      process.stderr.write(`error: ${sanitizeDiagnostic(message)}\n`);
      process.exit(1);
    },
  );
}
