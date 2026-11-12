import { describe, expect, it } from 'vitest';

import { BACKGROUND_TASKS_SWITCH, buildChildEnv, buildChildSettings, FORCED_CHILD_ENV } from './child-env.js';

describe('buildChildEnv (#250): the environment the primary session hands the bundled CLI', () => {
  it('forces the background-tasks switch on when the inherited environment does not name it', () => {
    expect(buildChildEnv({})[BACKGROUND_TASKS_SWITCH]).toBe('1');
  });

  // The harness value wins over whatever the operator's environment holds, including values the CLI reads as "off".
  it.each(['0', '', 'false', 'no', '1', 'true'])('overrides an inherited value of %j', (inherited) => {
    expect(buildChildEnv({ [BACKGROUND_TASKS_SWITCH]: inherited })[BACKGROUND_TASKS_SWITCH]).toBe('1');
  });

  it('overrides an inherited key that is present but undefined', () => {
    expect(buildChildEnv({ [BACKGROUND_TASKS_SWITCH]: undefined })[BACKGROUND_TASKS_SWITCH]).toBe('1');
  });

  // The SDK's `env` REPLACES the child environment (sdk.d.ts, Options.env), so every inherited variable must be carried.
  it('keeps every inherited variable with its value', () => {
    const inherited = { PATH: '/usr/bin:/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/cfg', EMPTY: '' };
    expect(buildChildEnv(inherited)).toEqual({ ...inherited, [BACKGROUND_TASKS_SWITCH]: '1' });
  });

  it('returns a fresh object and leaves its input unchanged', () => {
    const inherited = Object.freeze({ PATH: '/bin', [BACKGROUND_TASKS_SWITCH]: '0' });
    const first = buildChildEnv(inherited);
    expect(first).not.toBe(inherited);
    expect(first).not.toBe(buildChildEnv(inherited));
    expect(inherited).toEqual({ PATH: '/bin', [BACKGROUND_TASKS_SWITCH]: '0' });
  });

  it('the forced table is frozen and holds exactly the one switch, by its CLI name', () => {
    expect(BACKGROUND_TASKS_SWITCH).toBe('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS');
    expect(Object.isFrozen(FORCED_CHILD_ENV)).toBe(true);
    expect(FORCED_CHILD_ENV).toEqual({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
  });
});

describe('buildChildSettings (#250): the flag-settings layer that repeats the forced table', () => {
  it('is an env block holding exactly the forced table', () => {
    expect(buildChildSettings()).toEqual({ env: { [BACKGROUND_TASKS_SWITCH]: '1' } });
    expect(buildChildSettings().env).toEqual({ ...FORCED_CHILD_ENV });
  });

  it('returns fresh, unfrozen objects each call (the SDK is handed its own copy)', () => {
    const a = buildChildSettings();
    expect(a).not.toBe(buildChildSettings());
    expect(a.env).not.toBe(FORCED_CHILD_ENV);
    expect(a.env).not.toBe(buildChildSettings().env);
    expect(Object.isFrozen(a.env)).toBe(false);
  });
});
