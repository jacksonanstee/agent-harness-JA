import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ATTACHMENTS_SWITCH,
  AUTO_MEMORY_SWITCH,
  BACKGROUND_TASKS_SWITCH,
  BARE_MODE_SWITCH,
  buildChildEnv,
  buildChildSettings,
  buildToollessChildEnv,
  CHILD_ENV_NAME_POLICY,
  childConfigDir,
  childEnvNamePolicy,
  CRON_SWITCH,
  FORCED_CHILD_ENV,
} from './child-env.js';
import { isStrippedVendorName, KEPT_VENDOR_NAMES, VENDOR_NAME_NEEDLES } from './child-env-policy.js';

// The four features the harness switches off with "1": #250 (background tasks), #254 (scheduled tasks), #255 (attachments), and auto-memory.
const SWITCHES = [BACKGROUND_TASKS_SWITCH, CRON_SWITCH, ATTACHMENTS_SWITCH, AUTO_MEMORY_SWITCH] as const;
// The whole forced table: those four on, and the CLI's bare mode (#251) held off with "0".
const FORCED = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_DISABLE_CRON: '1',
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_SIMPLE: '0',
};
const BUILDERS = [
  ['buildChildEnv', buildChildEnv],
  ['buildToollessChildEnv', buildToollessChildEnv],
] as const;

describe('the forced table (#250, #254, #255, #251)', () => {
  it('is frozen and holds exactly the five entries, by their CLI names', () => {
    expect(BACKGROUND_TASKS_SWITCH).toBe('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS');
    expect(CRON_SWITCH).toBe('CLAUDE_CODE_DISABLE_CRON');
    expect(ATTACHMENTS_SWITCH).toBe('CLAUDE_CODE_DISABLE_ATTACHMENTS');
    expect(AUTO_MEMORY_SWITCH).toBe('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
    expect(BARE_MODE_SWITCH).toBe('CLAUDE_CODE_SIMPLE');
    expect(Object.isFrozen(FORCED_CHILD_ENV)).toBe(true);
    expect(FORCED_CHILD_ENV).toEqual(FORCED);
  });

  it('holds bare mode OFF: "0", never a value the CLI reads as on', () => {
    expect(FORCED_CHILD_ENV[BARE_MODE_SWITCH]).toBe('0');
    expect(['1', 'true', 'yes', 'on']).not.toContain(FORCED_CHILD_ENV[BARE_MODE_SWITCH]?.toLowerCase());
  });

  it('every forced name is a stripped vendor name, so no builder can inherit another spelling of it', () => {
    for (const name of Object.keys(FORCED_CHILD_ENV)) {
      expect(isStrippedVendorName(name), name).toBe(true);
      expect(KEPT_VENDOR_NAMES).not.toContain(name);
    }
  });
});

describe.each(BUILDERS)('%s: the forced table goes on top, whatever is inherited', (_label, build) => {
  it.each(SWITCHES)('forces %s on when the inherited environment does not name it', (name) => {
    expect(build({})[name]).toBe('1');
  });

  it.each(SWITCHES)('the harness value for %s wins over an inherited value, the empty string included, and over an unset entry', (name) => {
    for (const inherited of ['0', '', 'false', 'no', 'off', '1']) {
      expect(build({ [name]: inherited })[name]).toBe('1');
    }
    expect(build({ [name]: undefined })[name]).toBe('1');
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', '', '0'])('holds bare mode off over an inherited %j', (inherited) => {
    expect(build({ [BARE_MODE_SWITCH]: inherited })[BARE_MODE_SWITCH]).toBe('0');
  });

  // Every shipped forced name is stripped before the table is applied (pinned above), so with the
  // shipped table the order of the two steps cannot show. A table of the test's own shows it.
  it('a forced name the first step lets through is still the harness value: the table is applied last', () => {
    expect(build({ PATH: '/inherited', LANG: 'C' }, { PATH: '/forced' })).toEqual({ PATH: '/forced', LANG: 'C' });
    expect(build({ ANTHROPIC_BASE_URL: 'http://inherited' }, { ANTHROPIC_BASE_URL: 'http://forced' })).toEqual({ ANTHROPIC_BASE_URL: 'http://forced' });
  });

  it('with no table of its own a builder applies the shipped one', () => {
    expect(build({})).toEqual({ ...FORCED });
    expect(build({}, {})).toEqual({});
  });

  it('an inherited spelling of a forced name in another letter case does not survive beside the harness one', () => {
    const out = build({ claude_code_simple: '1', Claude_Code_Disable_Cron: '0', PATH: '/bin' });
    expect(out).toEqual({ PATH: '/bin', ...FORCED });
  });

  it('keeps the keep list with its values', () => {
    const kept = Object.fromEntries(KEPT_VENDOR_NAMES.map((name, i) => [name, `v${i}`]));
    expect(build(kept)).toEqual({ ...kept, ...FORCED });
  });

  it('drops a vendor name that is not kept: the parent session names, a model override, a made-up switch', () => {
    const out = build({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s',
      CLAUDE_CODE_MESSAGING_TOKEN: 't',
      CLAUDE_EFFORT: 'high',
      ANTHROPIC_MODEL: 'm',
      CLAUDE_MADE_UP_TOMORROW: '1',
    });
    expect(out).toEqual(FORCED);
  });

  it('is pure: a fresh object each call, the input untouched', () => {
    const inherited = Object.freeze({ PATH: '/bin', [BACKGROUND_TASKS_SWITCH]: '0', [BARE_MODE_SWITCH]: '1' });
    const first = build(inherited);
    expect(first).not.toBe(inherited);
    expect(first).not.toBe(build(inherited));
    expect(inherited).toEqual({ PATH: '/bin', [BACKGROUND_TASKS_SWITCH]: '0', [BARE_MODE_SWITCH]: '1' });
  });
});

describe('buildChildEnv: the primary session carries everything outside the vendor namespace', () => {
  it('keeps every inherited variable that is not a stripped vendor name, with its value', () => {
    const inherited = { PATH: '/usr/bin', HOME: '/home/u', NPM_TOKEN: 't', NODE_OPTIONS: '--max-old-space-size=64', EMPTY: '', ANTHROPIC_API_KEY: 'k' };
    expect(buildChildEnv(inherited)).toEqual({ ...inherited, ...FORCED });
  });
});

describe('buildToollessChildEnv (#251, #261): the judge and the adversary inherit an allowlist', () => {
  it('passes the operating system, locale, network and provider names and drops the rest', () => {
    const out = buildToollessChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LC_ALL: 'C',
      https_proxy: 'http://127.0.0.1:1',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      AWS_PROFILE: 'p',
      ANTHROPIC_API_KEY: 'k',
      NPM_TOKEN: 't',
      GITHUB_TOKEN: 'g',
      NODE_OPTIONS: '--require ./x.js',
      EDITOR: 'vi',
    });
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/home/u', LC_ALL: 'C', https_proxy: 'http://127.0.0.1:1', NODE_EXTRA_CA_CERTS: '/ca.pem', AWS_PROFILE: 'p', ANTHROPIC_API_KEY: 'k', ...FORCED });
  });

  it('is never wider than the primary environment: every name it passes, the primary passes too', () => {
    const inherited = { PATH: '/bin', LC_ALL: 'C', AWS_PROFILE: 'p', NPM_TOKEN: 't', CLAUDE_X: '1', ANTHROPIC_BASE_URL: 'u', CLAUDE_CONFIG_DIR: '/cfg' };
    const primary = buildChildEnv(inherited);
    for (const [name, value] of Object.entries(buildToollessChildEnv(inherited))) expect(primary[name], name).toBe(value);
  });
});

describe('CHILD_ENV_NAME_POLICY: what the settings-env scan refuses in a settings file', () => {
  it.each([...Object.keys(FORCED), 'claude_code_simple', 'CLAUDECODE', 'CLAUDE_CODE_MESSAGING_SOCKET', 'ANTHROPIC_MODEL', 'CLAUDE_MADE_UP_TOMORROW', '_CLAUDE_CODE_X', '_ANTHROPIC_X'])('refuses %s: a vendor name', (name) => {
    expect(CHILD_ENV_NAME_POLICY.refuses(name)).toBe(true);
  });

  // Owner ruling 13/11/2026: the keep list is for the inherited environment only. A file may not set the
  // endpoint, a credential, a provider or the config directory either.
  it.each(KEPT_VENDOR_NAMES)('refuses %s too: a kept name is still a vendor name, and no file may set one', (name) => {
    expect(CHILD_ENV_NAME_POLICY.refuses(name)).toBe(true);
    expect(CHILD_ENV_NAME_POLICY.refuses(name.toLowerCase())).toBe(true);
    // ...while the inherited environment keeps it.
    expect(buildChildEnv({ [name]: 'operator' })[name]).toBe('operator');
  });

  it.each(['PATH', 'NODE_OPTIONS', 'AWS_REGION', 'DISABLE_TELEMETRY', 'MY_CLAUDE_FLAG', '__CLAUDE_X'])('does not refuse %s: outside the vendor namespace', (name) => {
    expect(CHILD_ENV_NAME_POLICY.refuses(name)).toBe(false);
  });

  it('its needles cover the vendor namespace and every forced name, and it is frozen', () => {
    expect(Object.isFrozen(CHILD_ENV_NAME_POLICY)).toBe(true);
    for (const needle of VENDOR_NAME_NEEDLES) expect(CHILD_ENV_NAME_POLICY.needles).toContain(needle);
    for (const name of Object.keys(FORCED)) expect(CHILD_ENV_NAME_POLICY.needles.some((needle) => name.includes(needle)), name).toBe(true);
  });
});

describe('childEnvNamePolicy: the forced clause, for a forced name outside the vendor namespace', () => {
  const policy = childEnvNamePolicy({ HARNESS_FORCED_SWITCH: '1' });

  it('refuses the forced name in any letter case, though no vendor rule covers it', () => {
    expect(policy.refuses('HARNESS_FORCED_SWITCH')).toBe(true);
    expect(policy.refuses('harness_forced_switch')).toBe(true);
    expect(policy.refuses('HARNESS_FORCED_SWITCH_2')).toBe(false);
    expect(policy.refuses('PATH')).toBe(false);
  });

  it('still refuses the vendor namespace, and carries the forced name as a needle so the scan parses a file that names it', () => {
    expect(policy.refuses('CLAUDE_X')).toBe(true);
    expect(policy.needles).toContain('HARNESS_FORCED_SWITCH');
    for (const needle of VENDOR_NAME_NEEDLES) expect(policy.needles).toContain(needle);
  });

  it('a policy with no forced name refuses the vendor namespace alone', () => {
    const bare = childEnvNamePolicy({});
    expect(bare.refuses('CLAUDE_CODE_DISABLE_CRON')).toBe(true);
    expect(bare.refuses('HARNESS_FORCED_SWITCH')).toBe(false);
    expect([...bare.needles].sort()).toEqual([...VENDOR_NAME_NEEDLES].sort());
  });
});

describe('childConfigDir: the config directory the child is handed', () => {
  it('is the CLAUDE_CONFIG_DIR of the environment buildChildEnv builds, as written', () => {
    expect(childConfigDir({ CLAUDE_CONFIG_DIR: '/cfg' })).toBe('/cfg');
    expect(childConfigDir({ CLAUDE_CONFIG_DIR: '~/cfg' })).toBe('~/cfg');
    expect(childConfigDir({ CLAUDE_CONFIG_DIR: '' })).toBe('');
    expect(childConfigDir({})).toBeUndefined();
    expect(childConfigDir({ CLAUDE_CONFIG_DIR: '/cfg' })).toBe(buildChildEnv({ CLAUDE_CONFIG_DIR: '/cfg' })['CLAUDE_CONFIG_DIR']);
  });

  it('on Windows the name is found whatever its letter case; elsewhere only the exact name is the variable', () => {
    expect(childConfigDir({ Claude_Config_Dir: 'C:\\cfg' }, 'win32')).toBe('C:\\cfg');
    expect(childConfigDir({ claude_config_dir: 'C:\\cfg' }, 'win32')).toBe('C:\\cfg');
    expect(childConfigDir({ CLAUDE_CONFIG_DIR: 'C:\\exact', claude_config_dir: 'C:\\other' }, 'win32')).toBe('C:\\exact');
    expect(childConfigDir({ PATH: 'x' }, 'win32')).toBeUndefined();
    expect(childConfigDir({ Claude_Config_Dir: '/cfg' }, 'linux')).toBeUndefined();
    expect(childConfigDir({ Claude_Config_Dir: '/cfg' }, 'darwin')).toBeUndefined();
  });

  it('both builders hand the child the same directory, so the judge reads the config the primary session does', () => {
    expect(buildToollessChildEnv({ CLAUDE_CONFIG_DIR: '/cfg' })['CLAUDE_CONFIG_DIR']).toBe(childConfigDir({ CLAUDE_CONFIG_DIR: '/cfg' }));
  });

  // Both composition roots derive self-protection's config directory from the child's environment, not from process.env directly.
  it.each(['src/cli.ts', 'src/cli/eval-command.ts'])('%s hands the roots builder childConfigDir(process.env)', (file) => {
    expect(readFileSync(join(process.cwd(), file), 'utf8')).toContain('claudeConfigDir: childConfigDir(process.env)');
  });
});

describe('buildChildSettings (#250, #254, #255, #251): the flag-settings layer that repeats the forced table', () => {
  it('is an env block holding exactly the forced table', () => {
    expect(buildChildSettings()).toEqual({ env: FORCED });
    expect(buildChildSettings().env).toEqual({ ...FORCED_CHILD_ENV });
  });

  it('is a fresh object each call, never the frozen table itself', () => {
    const a = buildChildSettings();
    expect(a).not.toBe(buildChildSettings());
    expect(a.env).not.toBe(FORCED_CHILD_ENV);
    expect(a.env).not.toBe(buildChildSettings().env);
  });
});
