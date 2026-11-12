import { describe, expect, it } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import { SettingsEnvRefused } from '../security/index.js';
import type { SettingSource, SettingsEnvRefusal } from '../security/index.js';
import { createSession } from './session.js';
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
