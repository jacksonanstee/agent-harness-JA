import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../cli.js';
import type { QueryFn, QueryOptions, SdkHookCallback, SdkMessage } from '../session/index.js';
import { createTelemetryStore, openTelemetryDatabase } from '../telemetry/index.js';
import { fakeSpawnChild, promptHookFirst } from '../../test/prompt-hook.js';
import { spawnChildProcess } from '../session/child-process.js';
import { redact } from '../security/index.js';
import { fatalErrorLine, redactedErrorMessage } from './shared.js';

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
  const code = await main(argv, { userDir, importSdk: async () => ({ query: query === undefined ? query : promptHookFirst(query) }), spawnChild: fakeSpawnChild });
  return { code, stdout: out.join(''), stderr: err.join(''), userDir };
}

/** `main` over the fake exactly as given: nothing calls the session's prompt hook for it (#251). */
async function runMainRaw(argv: string[], query: QueryFn) {
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
  vi.spyOn(process, 'cwd').mockReturnValue(dir());
  const code = await main(argv, { userDir: dir(), importSdk: async () => ({ query }), spawnChild: fakeSpawnChild });
  return { code, stdout: out.join(''), stderr: err.join('') };
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
        handlerIndex: 3, // self-protection (#188), tool-name deny (#230), argument deny (#225, #250), then permissions
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
    expect(stderr).toMatch(
      /^warning: claude code settings: the "user" source is inherited, so the operator's ~\/\.claude settings, hooks and plugins apply to this run \(ADR-0040\)$/m,
    );
    expect(stderr).toMatch(
      /^warning: claude code settings: the "project" or "local" source is inherited, so the working directory's \.claude files and CLAUDE\.md apply to this run as trusted input \(ADR-0040\)$/m,
    );
  });

  it('prints the start line once, listing the members in canonical order whatever the file order', async () => {
    const sdk = fakeSdk();
    const { stderr } = await runMain(runArgs().argv, { sdk: { settingSources: ['local', 'user'] } }, sdk.query);
    expect(stderr).toMatch(
      /^\[harness\] claude code settings: inherited \(user, local\); their permission rules, hooks, plugins, MCP servers and CLAUDE\.md files apply to this run$/m,
    );
    expect(stderr.match(/^\[harness\] claude code settings: inherited/gm)).toHaveLength(1);
  });

  it('the opt-in in the PROJECT file only: isolated, the project warning printed', async () => {
    const sdk = fakeSdk();
    const { code, stderr } = await runMain(runArgs().argv, undefined, sdk.query, { sdk: { settingSources: ['user', 'project', 'local'] } });
    expect(code).toBe(0);
    expect(sdk.primary[0]).toMatchObject({ settingSources: [], strictMcpConfig: true });
    expect(stderr).toMatch(
      /^warning: ignoring "sdk" in .*settings\.json: Claude Code settings sources are configured only in ~\/\.harness\/settings\.json$/m,
    );
    expect(stderr).not.toMatch(/^\[harness\] claude code settings: inherited/m);
  });

  it('the default prints no sdk warning', async () => {
    const sdk = fakeSdk();
    const { stderr } = await runMain(runArgs().argv, undefined, sdk.query);
    expect(stderr).not.toContain('claude code settings');
    expect(stderr).not.toContain('ignoring "sdk"');
    expect(stderr).not.toMatch(/^\[harness\] claude code settings: inherited/m);
  });

  it('a malformed USER sdk value exits 2 with the settings line and never starts the SDK', async () => {
    const sdk = fakeSdk();
    const { code, stderr, userDir } = await runMain(runArgs().argv, { sdk: { settingSources: ['x'] } }, sdk.query);
    expect(code).toBe(2);
    expect(stderr).toMatch(
      new RegExp(
        `^${escapeRegExp(join(userDir, '.harness', 'settings.json'))}: ${escapeRegExp('sdk.settingSources must be an array of distinct values from "user", "project", "local"')}$`,
        'm',
      ),
    );
    expect(sdk.primary).toHaveLength(0);
  });
});

describe('the agent-definition scan on the run path (#229, ADR-0046)', () => {
  const agentFile = (root: string, rel: string, extra: string): void => {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, `---\nname: helper\ndescription: helps\n${extra}---\nbody\n`);
  };

  async function runWithUserAgent(settingSources: string[], extra: string, calls: { tool: string; input: unknown }[] = []) {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const sdk = fakeSdk(calls);
    const userDir = dir();
    agentFile(userDir, join('.claude', 'agents', 'evil.md'), extra);
    mkdirSync(join(userDir, '.harness'));
    writeFileSync(join(userDir, '.harness', 'settings.json'), JSON.stringify({ sdk: { settingSources } }));
    process.env.ANTHROPIC_API_KEY = 'dummy';
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
    vi.spyOn(process, 'cwd').mockReturnValue(dir());
    try {
      const code = await main(runArgs().argv, { userDir, importSdk: async () => ({ query: promptHookFirst(sdk.query) }), spawnChild: fakeSpawnChild });
      return { code, sdk, stderr: err.join('') };
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it('a user agent file setting isolation: remote refuses the run, exit 2, and the SDK is never called', async () => {
    const { code, sdk, stderr } = await runWithUserAgent(['user'], 'isolation: remote\n');
    expect(code).toBe(2);
    expect(sdk.primary).toEqual([]);
    expect(stderr).toMatch(/^refusing to run: agent definition refused: user:evil\.md \(isolation\)\. /m);
  });

  it('the same file is not read when the user source is not inherited (only the managed directory is)', async () => {
    const { code, sdk } = await runWithUserAgent(['local'], 'isolation: remote\n');
    expect(code).toBe(0);
    expect(sdk.primary).toHaveLength(1);
  });

  // #250: a settings file the CLI would load whose env block names a forced child variable would undo the switch.
  async function runWithSettingsEnv(settingSources: string[], place: 'user' | 'global', settings: unknown) {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const sdk = fakeSdk([]);
    const userDir = dir();
    mkdirSync(join(userDir, '.claude'), { recursive: true });
    writeFileSync(place === 'user' ? join(userDir, '.claude', 'settings.json') : join(userDir, '.claude.json'), JSON.stringify(settings));
    mkdirSync(join(userDir, '.harness'));
    writeFileSync(join(userDir, '.harness', 'settings.json'), JSON.stringify({ sdk: { settingSources } }));
    process.env.ANTHROPIC_API_KEY = 'dummy';
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
    vi.spyOn(process, 'cwd').mockReturnValue(dir());
    try {
      const code = await main(runArgs().argv, { userDir, importSdk: async () => ({ query: promptHookFirst(sdk.query) }), spawnChild: fakeSpawnChild });
      return { code, sdk, stderr: err.join('') };
    } finally {
      vi.unstubAllEnvs();
    }
  }
  const undo = { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: 'SENTINEL-VALUE' } };

  it('a user settings file whose env names the forced variable refuses the run, exit 2, the SDK never called, no value echoed (#250)', async () => {
    const { code, sdk, stderr } = await runWithSettingsEnv(['user'], 'user', undo);
    expect(code).toBe(2);
    expect(sdk.primary).toEqual([]);
    expect(stderr).toMatch(/^refusing to run: settings env refused: user:.*settings\.json \(env\)\. /m);
    expect(stderr).not.toContain('SENTINEL-VALUE');
  });

  // #254, #255: the gate keys off the forced table, so the two new switches are refused the same way.
  it.each(['CLAUDE_CODE_DISABLE_CRON', 'CLAUDE_CODE_DISABLE_ATTACHMENTS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'])(
    'a user settings file whose env sets %s to "" refuses the run under sdk.settingSources [user], the SDK never called',
    async (name) => {
      const { code, sdk, stderr } = await runWithSettingsEnv(['user'], 'user', { env: { [name]: '' } });
      expect(code).toBe(2);
      expect(sdk.primary).toEqual([]);
      expect(stderr).toMatch(/^refusing to run: settings env refused: user:.*settings\.json \(env\)\. /m);
    },
  );

  // #251: the gate refuses every vendor name the harness strips, not only the ones it forces. The CLI's
  // bare-mode switch ran no harness hook when the user settings file or the global config file set it.
  it.each(['CLAUDE_CODE_SIMPLE', 'claude_code_simple', 'CLAUDECODE', 'CLAUDE_CODE_MESSAGING_SOCKET', 'ANTHROPIC_MODEL', 'CLAUDE_MADE_UP_TOMORROW'])(
    'a user settings file whose env sets %s refuses the run under sdk.settingSources [user], the SDK never called, no value echoed (#251)',
    async (name) => {
      const { code, sdk, stderr } = await runWithSettingsEnv(['user'], 'user', { env: { [name]: 'SENTINEL-VALUE' } });
      expect(code).toBe(2);
      expect(sdk.primary).toEqual([]);
      expect(stderr).toMatch(/^refusing to run: settings env refused: user:.*settings\.json \(env\)\. /m);
      expect(stderr).not.toContain('SENTINEL-VALUE');
      expect(stderr).toContain('#251');
    },
  );

  it('the global config file whose env sets the bare-mode switch refuses the run under the default isolation (#251)', async () => {
    const { code, sdk, stderr } = await runWithSettingsEnv([], 'global', { env: { CLAUDE_CODE_SIMPLE: '1' } });
    expect(code).toBe(2);
    expect(sdk.primary).toEqual([]);
    expect(stderr).toMatch(/^refusing to run: settings env refused: global:.*\.claude\.json \(env\)\. /m);
  });

  // Owner ruling 13/11/2026: a file may set no vendor name, the kept ones included (a file's block moved the
  // endpoint, added a header and moved the config directory; observed).
  it.each(['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', '_CLAUDE_CODE_X'])(
    'a user settings file whose env sets %s refuses the run too: the keep list is for the inherited environment only',
    async (name) => {
      const { code, sdk, stderr } = await runWithSettingsEnv(['user'], 'user', { env: { [name]: 'SENTINEL-VALUE' } });
      expect(code).toBe(2);
      expect(sdk.primary).toEqual([]);
      expect(stderr).toMatch(/^refusing to run: settings env refused: user:.*settings\.json \(env\)\. /m);
      expect(stderr).not.toContain('SENTINEL-VALUE');
    },
  );

  it.each(['AWS_REGION', 'DISABLE_TELEMETRY', 'MY_CLAUDE_FLAG'])('a user settings file whose env sets %s, a name outside the vendor namespace, runs (#251 control)', async (name) => {
    const { code, sdk, stderr } = await runWithSettingsEnv(['user'], 'user', { env: { [name]: 'x' } });
    expect(code).toBe(0);
    expect(sdk.primary).toHaveLength(1);
    expect(stderr).not.toMatch(/refusing to run/);
  });

  // #251: the canary. A CLI that begins the turn without calling the session's prompt hook has its hooks off.
  it('a CLI that sends its init message without having run the prompt hook stops the run: exit 2, a fixed line on stderr, no summary line', async () => {
    const sdk = fakeSdk([]);
    // The SDK started the CLI through the session's spawn function, and the CLI never called the prompt hook.
    const query: QueryFn = (args) => (args.options?.spawnClaudeCodeProcess?.({ command: 'fake', args: [], env: {}, signal: new AbortController().signal }), sdk.query(args));
    const { code, stdout, stderr } = await runMainRaw(runArgs().argv, query);
    expect(code).toBe(2);
    expect(sdk.primary).toHaveLength(1);
    expect(sdk.primary[0]?.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(stderr).toMatch(/^run stopped: hook canary missed: The bundled CLI began the turn without running the harness's prompt hook/m);
    expect(stderr).toContain('#251');
    expect(stderr).not.toMatch(/init check did not run/);
    expect(stdout).not.toMatch(/\[harness\] model=/);
  });

  // #251: with no process held the harness could not kill a CLI whose hooks were off, so the run does not go ahead.
  it('a query function that never calls the spawn function stops the run: exit 2, its own fixed line, even though the prompt hook ran', async () => {
    const sdk = fakeSdk([]);
    const query: QueryFn = (args) =>
      (async function* () {
        for (const matcher of args.options?.hooks?.UserPromptSubmit ?? []) {
          for (const cb of matcher.hooks) await cb({ hook_event_name: 'UserPromptSubmit', prompt: args.prompt }, undefined, { signal: new AbortController().signal });
        }
        yield* sdk.query(args);
      })();
    const { code, stdout, stderr } = await runMainRaw(runArgs().argv, query);
    expect(code).toBe(2);
    expect(stderr).toMatch(/^run stopped: child not owned: The bundled CLI was not started through the harness's spawn function/m);
    expect(stderr).not.toMatch(/hook canary missed/);
    expect(stdout).not.toMatch(/\[harness\] model=/);
  });

  // Round 3: a settings file that moves the CLI's memory directory is refused the same way.
  it('a user settings file that sets autoMemoryDirectory refuses the run under sdk.settingSources [user], no value echoed', async () => {
    const { code, sdk, stderr } = await runWithSettingsEnv(['user'], 'user', { autoMemoryDirectory: '/SENTINEL-DIR' });
    expect(code).toBe(2);
    expect(sdk.primary).toEqual([]);
    expect(stderr).toMatch(/^refusing to run: settings env refused: user:.*settings\.json \(setting\)\. /m);
    expect(stderr).not.toContain('SENTINEL-DIR');
  });

  it('that file is not read when the user source is not inherited', async () => {
    const { code, sdk } = await runWithSettingsEnv([], 'user', { autoMemoryDirectory: '/SENTINEL-DIR' });
    expect(code).toBe(0);
    expect(sdk.primary).toHaveLength(1);
  });

  it('the same user file is not read when the user source is not inherited (#250)', async () => {
    const { code, sdk } = await runWithSettingsEnv([], 'user', undo);
    expect(code).toBe(0);
    expect(sdk.primary).toHaveLength(1);
  });

  it('the global config file is read whatever the sources say, and refuses under the default isolation (#250)', async () => {
    const { code, sdk, stderr } = await runWithSettingsEnv([], 'global', undo);
    expect(code).toBe(2);
    expect(sdk.primary).toEqual([]);
    expect(stderr).toMatch(/^refusing to run: settings env refused: global:.*\.claude\.json \(env\)\. /m);
  });

  it('a user settings file with an env block naming other variables runs (#250 control)', async () => {
    const { code, sdk, stderr } = await runWithSettingsEnv(['user'], 'user', { env: { FOO: '1' } });
    expect(code).toBe(0);
    expect(sdk.primary).toHaveLength(1);
    expect(stderr).not.toMatch(/refusing to run/);
  });

  it('a clean user agent file runs, and an Agent call naming it is not refused by the gate', async () => {
    const calls = [
      { tool: 'Agent', input: { subagent_type: 'helper', prompt: 'p' } },
      { tool: 'Agent', input: { subagent_type: 'evil', prompt: 'p' } },
    ];
    const { code, sdk } = await runWithUserAgent(['user'], 'tools: Read\n', calls);
    expect(code).toBe(0);
    expect(sdk.primary).toHaveLength(1);
    // The scanned file is named `helper` (frontmatter), so `helper` passes the gate and the stem `evil` does not.
    expect(sdk.outputs[0]).not.toMatchObject({ hookSpecificOutput: { permissionDecisionReason: expect.stringMatching(/^unscanned agent deny/) as unknown } });
    expect(sdk.outputs[1]).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/^unscanned agent deny/) as unknown } });
  });

  it('an Agent call naming an unscanned agent is refused through the composed run stack', async () => {
    const sdk = fakeSdk([{ tool: 'Agent', input: { subagent_type: 'plugin:spy', prompt: 'p' } }]);
    const { code } = await runMain(runArgs().argv, undefined, sdk.query);
    expect(code).toBe(0);
    expect(sdk.outputs).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringMatching(/^unscanned agent deny: /) as unknown,
        },
      },
    ]);
  });
});

// #251, owner ruling 20/11/2026. The session puts the last bytes of the CLI's stderr on the error it rejects with,
// as the CLI wrote them. A library caller gets that error as it is; the command line redacts before it prints.
describe('a run error is redacted before the command line prints it (#251)', () => {
  const SECRET = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';

  it('a CLI child that prints a secret to stderr and exits non-zero: main rejects with the tail on the message, the secret redacted', async () => {
    const child = spawnChildProcess({ command: process.execPath, args: ['-e', `process.stderr.write('fatal: key ${SECRET} rejected\\n', () => process.exit(2))`], env: {}, signal: new AbortController().signal });
    const exit = new Promise((resolve) => child.once('exit', resolve));
    const query: QueryFn = (args) => {
      args.options?.spawnClaudeCodeProcess?.({ command: 'fake', args: [], env: {}, signal: new AbortController().signal });
      return (async function* () {
        for (const matcher of args.options?.hooks?.UserPromptSubmit ?? []) {
          for (const cb of matcher.hooks) await cb({ hook_event_name: 'UserPromptSubmit', prompt: args.prompt }, undefined, { signal: new AbortController().signal });
        }
        yield { type: 'system', subtype: 'init', session_id: 'sdk-1' } as never;
        await exit;
        throw new Error('Claude Code process exited with code 2');
      })();
    };
    process.env.ANTHROPIC_API_KEY = 'dummy';
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => (out.push(String(c)), true));
    vi.spyOn(process, 'cwd').mockReturnValue(dir());
    const run = main(runArgs().argv, { userDir: dir(), importSdk: async () => ({ query }), spawnChild: () => child });
    await expect(run).rejects.toThrow('Claude Code process exited with code 2. stderr: fatal: key [REDACTED:');
    await expect(run).rejects.not.toThrow(SECRET);
    expect(out.join('')).not.toContain(SECRET);
  });

  it.each([
    ['a zero-width space', '\u200b'],
    ['a soft hyphen', '\u00ad'],
    ['an ANSI reset', '\u001b[0m'],
  ])('a secret split by %s is redacted at both sinks: the error `run` rethrows and the line the entry point prints', async (_name, splitter) => {
    const split = `${SECRET.slice(0, 8)}${splitter}${SECRET.slice(8)}`;
    const line = fatalErrorLine(new Error(`exited 9. stderr: credential ${split} rejected`), redact);
    expect(line).toBe('error: exited 9. stderr: credential [REDACTED:aws-access-key-id] rejected');
    const query: QueryFn = () => {
      throw new Error(`Claude Code process exited with code 9. stderr: credential ${split} rejected`);
    };
    process.env.ANTHROPIC_API_KEY = 'dummy';
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'cwd').mockReturnValue(dir());
    const run = main(runArgs().argv, { userDir: dir(), importSdk: async () => ({ query }), spawnChild: fakeSpawnChild });
    await expect(run).rejects.toThrow('Claude Code process exited with code 9. stderr: credential [REDACTED:aws-access-key-id] rejected');
    await expect(run).rejects.not.toThrow(SECRET.slice(8));
  });

  it('fatalErrorLine: the line the entry point prints for any error that escapes a command is redacted and has no control characters', () => {
    const line = fatalErrorLine(new Error(`exited. stderr: key ${SECRET}\u001b[31m rejected`), redact);
    expect(line).toMatch(/^error: exited\. stderr: key \[REDACTED:/);
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain('\u001b');
    expect(fatalErrorLine(`a thrown string with ${SECRET}`, redact)).not.toContain(SECRET);
    expect(fatalErrorLine(new Error('plain'), redact)).toBe('error: plain');
    // Whatever the redactor hands back is still cleared for the terminal.
    expect(fatalErrorLine(new Error('x'), () => ({ redacted: 'a\u001b[31mb\u202ec', findings: [] }))).not.toMatch(/[\u001b\u202e]/);
  });

  it('redactedErrorMessage: a redactor that throws, or returns no string, gives the fixed sentinel and never the raw text', () => {
    const error = new Error(`stderr: ${SECRET}`);
    expect(
      redactedErrorMessage(error, () => {
        throw new Error('redactor broke');
      }),
    ).toBe('[REDACTION FAILED]');
    expect(redactedErrorMessage(error, () => ({ redacted: undefined }) as never)).toBe('[REDACTION FAILED]');
    expect(redactedErrorMessage(error, (text) => ({ redacted: text.replace(SECRET, 'X'), findings: [] }) as never)).toBe('stderr: X');
  });
});
