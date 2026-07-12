import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { createGoldenRunner, EvalUsageError, toMarkdown } from '../eval/index.js';
import type { TaskSessionConfig } from '../eval/index.js';
import { createHookRuntime } from '../hooks/index.js';
import { createMemoryStore } from '../memory/index.js';
import { route } from '../router/index.js';
import { createSession } from '../session/index.js';
import type { QueryFn } from '../session/index.js';
import {
  createPermissionEvaluator,
  createSandbox,
  permissionHook,
  redact,
  sandboxHook,
  scan,
} from '../security/index.js';
import { load as loadSkills } from '../skills/index.js';
import { createTelemetryStore, openTelemetryDatabase } from '../telemetry/index.js';
import {
  composeSecurity,
  EVAL_OUT_DIR,
  hookRecordToTelemetryInput,
  readPackageVersion,
  refuseSymlinkedDir,
  sanitizeForTerminal,
  SettingsLoadError,
  USAGE,
  writeScorecard,
} from './shared.js';
import type { SecurityComposition } from './shared.js';

export interface EvalArgs {
  command: 'eval';
  taskDir: string;
}

/**
 * Local ParseResult-shaped return: eval-command.ts must not import from
 * ../cli.js (that would be a real import cycle, since cli.ts imports this
 * module for EvalArgs/parseEvalArgs/runEval).
 */
type EvalParseResult =
  | { ok: true; value: EvalArgs }
  | { ok: false; error: string };

export function parseEvalArgs(argv: string[]): EvalParseResult {
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

export async function runEval(args: EvalArgs): Promise<number> {
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
