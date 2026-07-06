#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { createHookRuntime } from './hooks/index.js';
import { createMemoryStore, DEFAULT_DB_PATH, openMemoryDatabase } from './memory/index.js';
import { route } from './router/index.js';
import { createSession } from './session/index.js';
import type { QueryFn } from './session/index.js';
import { load as loadSkills } from './skills/index.js';

export interface RunArgs {
  command: 'run';
  prompt: string;
  skillsDir: string;
  dbPath: string;
  maxTurns: number;
}

export type ParseResult =
  | { ok: true; value: RunArgs }
  | { ok: false; error: string };

// Keep in lockstep with CONTROL_CHARS in src/session/session.ts (and the
// hooks/router/skills copies). Model output and warnings reach the user's
// terminal; strip control chars so tool-poisoned text can't smuggle ANSI/OSC
// escape sequences (newline/tab kept for readability).
const TERMINAL_UNSAFE = /[\x00-\x08\x0B-\x1F\x7F-\x9F\u2028\u2029]/g;

export function sanitizeForTerminal(text: string): string {
  return text.replace(TERMINAL_UNSAFE, ' ');
}

const USAGE =
  'Usage: agent-harness-ja run "<prompt>" [--skills-dir <dir>] [--db <path>] [--max-turns <n>]';

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

export async function main(argv: string[]): Promise<number> {
  const parsed = parseRunArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
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

  const session = createSession(
    {
      query,
      hooks: createHookRuntime(),
      memory: createMemoryStore(openMemoryDatabase({ path: dbPath })),
      loadSkills,
      route,
    },
    {
      skillsDir,
      maxTurns,
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
