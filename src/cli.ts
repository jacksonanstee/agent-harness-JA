#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createHookRuntime } from './hooks/index.js';
import type { HookEventRecord } from './hooks/index.js';
import { createMemoryStore, DEFAULT_DB_PATH } from './memory/index.js';
import { route } from './router/index.js';
import { createSession } from './session/index.js';
import type { QueryFn } from './session/index.js';
import { redact, scan } from './security/index.js';
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

export type CliArgs = RunArgs | TelemetryExportArgs;

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

const USAGE =
  'Usage: agent-harness-ja run "<prompt>" [--skills-dir <dir>] [--db <path>] [--max-turns <n>]\n' +
  '       agent-harness-ja telemetry export [--db <path>] [--out <file>] [--session <id>] [--type <t>]';

export function parseArgs(argv: string[]): ParseResult {
  if (argv[0] === 'telemetry') {
    return parseTelemetryArgs(argv.slice(1));
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

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  if (parsed.value.command === 'telemetry-export') {
    return runTelemetryExport(parsed.value);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      'ANTHROPIC_API_KEY is not set. Export it before running the harness.\n',
    );
    return 2;
  }

  const { prompt, skillsDir, dbPath, maxTurns } = parsed.value;

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
