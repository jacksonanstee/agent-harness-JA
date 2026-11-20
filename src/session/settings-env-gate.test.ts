import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import { SettingsEnvRefused } from '../security/index.js';
import type { SettingSource, SettingsEnvRefusal } from '../security/index.js';
import { createLiveSession as createSession } from '../../test/prompt-hook.js';
import { settingsEnvScanFor } from './settings-env-gate.js';
import type { QueryFn, SdkMessage, SessionDeps } from './types.js';

const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sdk-1' };
const RESULT: SdkMessage = { type: 'result', subtype: 'success', result: 'ok', session_id: 'sdk-1', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };

function deps(scan: SessionDeps['scanSettingsEnv']): { deps: SessionDeps; calls: number[] } {
  const calls: number[] = [];
  const query: QueryFn = () => {
    calls.push(1);
    return (async function* () {
      yield INIT;
      yield RESULT;
    })();
  };
  return {
    calls,
    deps: {
      query,
      hooks: createHookRuntime(),
      memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
      loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
      route,
      scanAgents: () => ({ admittedNames: new Set<string>(), refusals: [], filesScanned: 0 }),
      ...(scan === undefined ? {} : { scanSettingsEnv: scan }),
    },
  };
}

describe('the session refuses to start when a loadable settings file names a forced variable (#250)', () => {
  const refusal: SettingsEnvRefusal = { source: 'user', path: '/cfg/settings.json', reason: 'env' };

  it('throws SettingsEnvRefused before the SDK is called', async () => {
    const d = deps(() => [refusal]);
    await expect(createSession(d.deps, { skillsDir: null }).run('p')).rejects.toThrow(SettingsEnvRefused);
    expect(d.calls).toEqual([]);
  });

  it('runs when the scan is clean, and hands the scan the configured sources', async () => {
    const seen: (readonly SettingSource[])[] = [];
    const d = deps((sources) => (seen.push(sources), []));
    await createSession(d.deps, { skillsDir: null, settingSources: ['user', 'local'] }).run('p');
    await createSession(d.deps, { skillsDir: null }).run('p');
    expect(d.calls).toHaveLength(2);
    expect(seen).toEqual([['user', 'local'], []]);
  });

  it('scans on every run, so a file planted between two runs is seen', async () => {
    let planted = false;
    const d = deps(() => (planted ? [refusal] : []));
    const session = createSession(d.deps, { skillsDir: null });
    await session.run('p');
    planted = true;
    await expect(session.run('p')).rejects.toThrow(SettingsEnvRefused);
    expect(d.calls).toHaveLength(1);
  });
});

// #251: the real scan, as the session builds it, refuses by the child-env policy and not by a list.
describe('settingsEnvScanFor: the gate\'s own scan uses the child-env policy (#251)', () => {
  const home = (): string => mkdtempSync(join(tmpdir(), 'senv-gate-'));
  const under = (dir: string, refusals: readonly SettingsEnvRefusal[]) => refusals.filter((r) => r.path.startsWith(dir)).map((r) => `${r.source}:${r.path.slice(dir.length + 1)}:${r.reason}`);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_CRON', 'ANTHROPIC_MODEL', 'CLAUDE_MADE_UP_TOMORROW'])('the global config file naming %s is refused under no sources', (name) => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const dir = home();
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ env: { [name]: '1' } }));
    expect(under(dir, settingsEnvScanFor(dir)([]))).toEqual(['global:.claude.json:env']);
  });

  it('a user settings file naming the bare-mode switch is refused under the user source and not read without it', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const dir = home();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_SIMPLE: '1' } }));
    expect(under(dir, settingsEnvScanFor(dir)(['user']))).toEqual(['user:.claude/settings.json:env']);
    expect(under(dir, settingsEnvScanFor(dir)([]))).toEqual([]);
  });

  it.each(['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', '_CLAUDE_CODE_X'])('a file may not set %s either: the keep list is for the inherited environment only', (name) => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const dir = home();
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ env: { [name]: 'x' } }));
    expect(under(dir, settingsEnvScanFor(dir)([]))).toEqual(['global:.claude.json:env']);
  });

  it('a name outside the vendor namespace passes', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const dir = home();
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ env: { PATH: '/bin', AWS_REGION: 'r', DISABLE_TELEMETRY: '1' } }));
    expect(under(dir, settingsEnvScanFor(dir)([]))).toEqual([]);
  });

  // The gate scans the directory the CHILD is handed (`childConfigDir`), not its own reading of the
  // environment. The two differ on Windows, where another letter case is the same variable.
  it('on Windows a config directory spelt in another letter case is the one scanned', () => {
    const saved = process.env['CLAUDE_CONFIG_DIR'];
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    delete process.env['CLAUDE_CONFIG_DIR'];
    const dir = home();
    const cfg = home();
    vi.stubEnv('Claude_Config_Dir', cfg);
    writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ env: { CLAUDE_CODE_SIMPLE: '1' } }));
    try {
      expect(under(cfg, settingsEnvScanFor(dir)([]))).toEqual([]);
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      expect(under(cfg, settingsEnvScanFor(dir)([]))).toEqual(['global:.claude.json:env']);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (saved !== undefined) process.env['CLAUDE_CONFIG_DIR'] = saved;
    }
  });

  it('with CLAUDE_CONFIG_DIR set, the global config file under home is scanned as well as the one under the config directory', () => {
    const dir = home();
    const cfg = home();
    vi.stubEnv('CLAUDE_CONFIG_DIR', cfg);
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ env: { CLAUDE_CODE_SIMPLE: '1' } }));
    expect(under(dir, settingsEnvScanFor(dir)([]))).toEqual(['global:.claude.json:env']);
    writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ env: { CLAUDE_CODE_SIMPLE: '1' } }));
    expect(under(cfg, settingsEnvScanFor(dir)([]))).toEqual(['global:.claude.json:env']);
  });
});
