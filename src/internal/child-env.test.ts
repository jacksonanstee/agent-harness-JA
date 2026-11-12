import { describe, expect, it } from 'vitest';

import { ATTACHMENTS_SWITCH, AUTO_MEMORY_SWITCH, BACKGROUND_TASKS_SWITCH, buildChildEnv, buildChildSettings, CRON_SWITCH, FORCED_CHILD_ENV } from './child-env.js';

// Every switch the harness forces: #250 (background tasks), #254 (scheduled tasks), #255 (attachments), and auto-memory.
const SWITCHES = [BACKGROUND_TASKS_SWITCH, CRON_SWITCH, ATTACHMENTS_SWITCH, AUTO_MEMORY_SWITCH] as const;
const ALL_ON = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_DISABLE_CRON: '1',
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
};

describe('buildChildEnv (#250, #254, #255): the environment the harness hands every bundled-CLI child', () => {
  it.each(SWITCHES)('forces %s on when the inherited environment does not name it', (name) => {
    expect(buildChildEnv({})[name]).toBe('1');
  });

  // The harness value wins over whatever the operator's environment holds, including values the CLI reads as "off".
  describe.each(SWITCHES)('%s', (name) => {
    it.each(['0', '', 'false', 'no', '1', 'true'])('overrides an inherited value of %j', (inherited) => {
      expect(buildChildEnv({ [name]: inherited })[name]).toBe('1');
    });

    it('overrides an inherited key that is present but undefined', () => {
      expect(buildChildEnv({ [name]: undefined })[name]).toBe('1');
    });
  });

  // The SDK's `env` REPLACES the child environment (sdk.d.ts, Options.env), so every inherited variable must be carried.
  it('keeps every inherited variable with its value', () => {
    const inherited = { PATH: '/usr/bin:/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/cfg', EMPTY: '' };
    expect(buildChildEnv(inherited)).toEqual({ ...inherited, ...ALL_ON });
  });

  it('returns a fresh object and leaves its input unchanged', () => {
    const inherited = Object.freeze({ PATH: '/bin', [BACKGROUND_TASKS_SWITCH]: '0', [CRON_SWITCH]: '0', [ATTACHMENTS_SWITCH]: '' });
    const first = buildChildEnv(inherited);
    expect(first).not.toBe(inherited);
    expect(first).not.toBe(buildChildEnv(inherited));
    expect(inherited).toEqual({ PATH: '/bin', [BACKGROUND_TASKS_SWITCH]: '0', [CRON_SWITCH]: '0', [ATTACHMENTS_SWITCH]: '' });
  });

  it('the forced table is frozen and holds exactly the four switches, by their CLI names', () => {
    expect(BACKGROUND_TASKS_SWITCH).toBe('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS');
    expect(CRON_SWITCH).toBe('CLAUDE_CODE_DISABLE_CRON');
    expect(ATTACHMENTS_SWITCH).toBe('CLAUDE_CODE_DISABLE_ATTACHMENTS');
    expect(AUTO_MEMORY_SWITCH).toBe('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
    expect(Object.isFrozen(FORCED_CHILD_ENV)).toBe(true);
    expect(FORCED_CHILD_ENV).toEqual(ALL_ON);
  });
});

describe('buildChildSettings (#250, #254, #255): the flag-settings layer that repeats the forced table', () => {
  it('is an env block holding exactly the forced table', () => {
    expect(buildChildSettings()).toEqual({ env: ALL_ON });
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
