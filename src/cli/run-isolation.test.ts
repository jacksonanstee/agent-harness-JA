import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../cli.js';
import type { QueryFn, QueryOptions, SdkMessage } from '../session/index.js';

// Issue #140, ADR-0040 D1; spec 6a.2 (default case). The dir, runMain and
// runArgs helpers are trimmed copies of those in run-judge.test.ts (this file
// needs no settings files, so `dir` takes no settings). `main` is driven with
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

function fakeSdk() {
  const primary: QueryOptions[] = [];
  const query: QueryFn = (args) => {
    if (args.options !== undefined) primary.push(args.options);
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1' } as SdkMessage;
      yield { type: 'result', subtype: 'success', result: 'done', session_id: 'sdk-1', num_turns: 1, total_cost_usd: 0.01 } as SdkMessage;
    })();
  };
  return { query, primary };
}

async function runMain(argv: string[], userSettings: unknown, projectSettings: unknown, query: QueryFn | undefined) {
  void userSettings;
  void projectSettings;
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
  vi.spyOn(process, 'cwd').mockReturnValue(dir());
  const userDir = dir();
  const code = await main(argv, { userDir, importSdk: async () => ({ query }) });
  return { code, stdout: out.join(''), stderr: err.join(''), userDir };
}

function runArgs(): { argv: string[]; db: string } {
  const db = join(dir(), 'telemetry.db');
  return { argv: ['run', 'hi', '--db', db, '--skills-dir', dir()], db };
}

describe('the run path is isolated by default (#140, ADR-0040 D1; spec 6a.2, default case)', () => {
  it('main run with no settings files passes settingSources [] and strictMcpConfig true to the primary query', async () => {
    const sdk = fakeSdk();
    const { code } = await runMain(runArgs().argv, undefined, undefined, sdk.query);
    expect(code).toBe(0);
    expect(sdk.primary).toHaveLength(1);
    expect(sdk.primary[0]).toMatchObject({ settingSources: [], strictMcpConfig: true });
  });
});
