import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../cli.js';
import type { QueryFn, QueryOptions, SdkHookCallback, SdkMessage } from '../session/index.js';
import { createTelemetryStore, openTelemetryDatabase } from '../telemetry/index.js';

// Issue #140, ADR-0040 D1; spec 6a.2 (default case). The dir, runMain and
// runArgs helpers are trimmed copies of those in run-judge.test.ts (this file
// writes the user settings file only for the grant case). `main` is driven with
// CliSeams (user dir, SDK importer); the real SDK is never loaded.

const tmp: string[] = [];
const saved = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'run-isolation-'));
  tmp.push(d);
  return d;
}

function fakeSdk(preToolCalls: { tool: string; input: unknown }[] = []) {
  const primary: QueryOptions[] = [];
  const outputs: unknown[] = [];
  const query: QueryFn = (args) => {
    if (args.options !== undefined) primary.push(args.options);
    return (async function* () {
      for (const call of preToolCalls) {
        for (const matcher of args.options?.hooks?.PreToolUse ?? []) {
          for (const cb of matcher.hooks as unknown as SdkHookCallback[]) {
            outputs.push(
              await cb(
                { hook_event_name: 'PreToolUse', tool_name: call.tool, tool_input: call.input, tool_use_id: 'toolu_1' },
                'toolu_1',
                { signal: new AbortController().signal },
              ),
            );
          }
        }
      }
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1' } as SdkMessage;
      yield { type: 'result', subtype: 'success', result: 'done', session_id: 'sdk-1', num_turns: 1, total_cost_usd: 0.01 } as SdkMessage;
    })();
  };
  return { query, primary, outputs };
}

async function runMain(argv: string[], userSettings: unknown, query: QueryFn | undefined, projectSettings?: unknown) {
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
  const projectDir = dir();
  if (projectSettings !== undefined) {
    mkdirSync(join(projectDir, '.harness'));
    writeFileSync(join(projectDir, '.harness', 'settings.json'), JSON.stringify(projectSettings));
  }
  vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
  const userDir = dir();
  if (userSettings !== undefined) {
    mkdirSync(join(userDir, '.harness'));
    writeFileSync(join(userDir, '.harness', 'settings.json'), JSON.stringify(userSettings));
  }
  const code = await main(argv, { userDir, importSdk: async () => ({ query }) });
  return { code, stdout: out.join(''), stderr: err.join(''), userDir };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function runArgs(): { argv: string[]; db: string } {
  const db = join(dir(), 'telemetry.db');
  return { argv: ['run', 'hi', '--db', db, '--skills-dir', dir()], db };
}

describe('the run path is isolated by default (#140, ADR-0040 D1; spec 6a.2, default case)', () => {
  it('main run with no settings files passes settingSources [] and strictMcpConfig true to the primary query', async () => {
    const sdk = fakeSdk();
    const { code } = await runMain(runArgs().argv, undefined, sdk.query);
    expect(code).toBe(0);
    expect(sdk.primary).toHaveLength(1);
    expect(sdk.primary[0]).toMatchObject({ settingSources: [], strictMcpConfig: true });
  });

  // Spec 6a.3 (b) at the composition root (preflight ruling 12): the unit pins prove the session
  // and the adapter each work; this proves they compose, keylessly, down to the stored row.
  it('main run with a user-layer Bash allow (and sandbox.commands) returns the allow and stores one granted-by-rule row', async () => {
    const sdk = fakeSdk([{ tool: 'Bash', input: { command: 'git status' } }]);
    const { argv, db } = runArgs();
    const user = {
      permissions: { rules: [{ tool: 'Bash', match: 'git *', decision: 'allow' }] },
      sandbox: { commands: { allow: ['git'] } },
    };
    const { code } = await runMain(argv, user, sdk.query);
    expect(code).toBe(0);
    expect(sdk.outputs).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          // Deliberate pin: re-typed, not imported, so a changed literal fails here.
          permissionDecisionReason: 'allowed by a harness pre-tool hook grant (ADR-0014)',
        },
      },
    ]);
    const handle = openTelemetryDatabase({ path: db });
    try {
      const store = createTelemetryStore(handle);
      const rows = store.query({ type: 'hook-event' }).filter((e) => (e.payload as { kind: string }).kind === 'granted-by-rule');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toEqual({
        kind: 'granted-by-rule',
        event: 'pre-tool',
        tool: 'Bash',
        reason: 'permission: allow Bash [rule 0, user]',
        handlerIndex: 0,
      });
    } finally {
      handle.close();
    }
  });
});

describe('the sdk.settingSources opt-in on the run path (#140, ADR-0040 D2; spec 6a.2)', () => {
  it('the user opt-in reaches the primary query and lifts strictMcpConfig', async () => {
    const sdk = fakeSdk();
    const { code, stderr } = await runMain(runArgs().argv, { sdk: { settingSources: ['local', 'user'] } }, sdk.query);
    expect(code).toBe(0);
    expect(sdk.primary[0]).toMatchObject({ settingSources: ['local', 'user'], strictMcpConfig: false });
    expect(stderr).toContain('claude code settings: the "user" source is inherited');
  });

  it('the opt-in in the PROJECT file only: isolated, the project warning printed', async () => {
    const sdk = fakeSdk();
    const { code, stderr } = await runMain(runArgs().argv, undefined, sdk.query, { sdk: { settingSources: ['user', 'project', 'local'] } });
    expect(code).toBe(0);
    expect(sdk.primary[0]).toMatchObject({ settingSources: [], strictMcpConfig: true });
    expect(stderr).toMatch(
      /^warning: ignoring "sdk" in .*settings\.json: Claude Code settings sources are configured only in ~\/\.harness\/settings\.json$/m,
    );
  });

  it('the default prints no sdk warning', async () => {
    const sdk = fakeSdk();
    const { stderr } = await runMain(runArgs().argv, undefined, sdk.query);
    expect(stderr).not.toContain('claude code settings');
    expect(stderr).not.toContain('ignoring "sdk"');
  });

  it('a malformed USER sdk value exits 2 with the settings line and never starts the SDK', async () => {
    const sdk = fakeSdk();
    const { code, stderr, userDir } = await runMain(runArgs().argv, { sdk: { settingSources: ['x'] } }, sdk.query);
    expect(code).toBe(2);
    expect(stderr).toMatch(
      new RegExp(
        `^${escapeRegExp(join(userDir, '.harness', 'settings.json'))}: ${escapeRegExp('sdk.settingSources must be an array of distinct values from "user", "project", "local"')}`,
        'm',
      ),
    );
    expect(sdk.primary).toHaveLength(0);
  });
});
