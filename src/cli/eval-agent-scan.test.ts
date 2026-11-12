import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../cli.js';

// #229 (ADR-0046, architecture review H1): eval runs the agent-file scan once,
// up front, so a refused file is exit 2 with no scorecard and no SDK load, as
// on `run`, rather than one session-error row per task and exit 0.

const bases: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

async function evalWithUserAgent(extra: string): Promise<{ code: number; stderr: string; sdkLoaded: boolean; base: string }> {
  const base = mkdtempSync(join(tmpdir(), 'eval-agent-scan-'));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(home, '.claude', 'agents', 'evil.md'), `---\nname: helper\ndescription: x\n${extra}---\nbody\n`);
  mkdirSync(join(home, '.harness'));
  writeFileSync(join(home, '.harness', 'settings.json'), JSON.stringify({ sdk: { settingSources: ['user'] } }));
  mkdirSync(join(base, 'tasks'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vi.stubEnv('ANTHROPIC_API_KEY', 'unused');
  vi.spyOn(process, 'cwd').mockReturnValue(base);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  let sdkLoaded = false;
  const code = await main(['eval', join(base, 'tasks')], {
    userDir: home,
    evalOutDir: join(base, 'eval-out'),
    importSdk: async () => {
      sdkLoaded = true;
      return { query: () => (async function* () {})() };
    },
  });
  return { code, stderr: err.join(''), sdkLoaded, base };
}

describe('eval pre-flights the agent-file scan (#229)', () => {
  it('a refused user agent file: exit 2, the refusal named, the SDK never loaded, no scorecard', async () => {
    const { code, stderr, sdkLoaded, base } = await evalWithUserAgent('isolation: remote\n');
    expect(code).toBe(2);
    expect(stderr).toMatch(/^refusing to run: agent definition refused: user:evil\.md \(isolation\)\. /m);
    expect(sdkLoaded).toBe(false);
    expect(existsSync(join(base, 'eval-out'))).toBe(false);
  });

  it('a clean one passes the pre-flight (it gets as far as loading the SDK)', async () => {
    const { stderr, sdkLoaded } = await evalWithUserAgent('tools: Read\n');
    expect(stderr).not.toMatch(/refusing to run/);
    expect(sdkLoaded).toBe(true);
  });
});

describe('eval pre-flights the settings-env scan (#250)', () => {
  async function evalWithUserSettings(settings: unknown): Promise<{ code: number; stderr: string; sdkLoaded: boolean; base: string }> {
    const base = mkdtempSync(join(tmpdir(), 'eval-settings-env-'));
    bases.push(base);
    const home = join(base, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings));
    mkdirSync(join(home, '.harness'));
    writeFileSync(join(home, '.harness', 'settings.json'), JSON.stringify({ sdk: { settingSources: ['user'] } }));
    mkdirSync(join(base, 'tasks'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'unused');
    vi.spyOn(process, 'cwd').mockReturnValue(base);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    });
    let sdkLoaded = false;
    const code = await main(['eval', join(base, 'tasks')], {
      userDir: home,
      evalOutDir: join(base, 'eval-out'),
      importSdk: async () => {
        sdkLoaded = true;
        return { query: () => (async function* () {})() };
      },
    });
    return { code, stderr: err.join(''), sdkLoaded, base };
  }

  it('a user settings file whose env names the forced variable: exit 2, the refusal named, the SDK never loaded, no scorecard', async () => {
    const { code, stderr, sdkLoaded, base } = await evalWithUserSettings({ env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '' } });
    expect(code).toBe(2);
    expect(stderr).toMatch(/^refusing to run: settings env refused: user:.*settings\.json \(env\)\. /m);
    expect(sdkLoaded).toBe(false);
    expect(existsSync(join(base, 'eval-out'))).toBe(false);
  });

  it('a clean one passes the pre-flight (it gets as far as loading the SDK)', async () => {
    const { stderr, sdkLoaded } = await evalWithUserSettings({ env: { FOO: '1' } });
    expect(stderr).not.toMatch(/refusing to run/);
    expect(sdkLoaded).toBe(true);
  });
});
