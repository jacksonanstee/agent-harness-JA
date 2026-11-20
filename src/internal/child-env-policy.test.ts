import { describe, expect, it } from 'vitest';

import {
  isKeptVendorName,
  isStrippedVendorName,
  isToollessAllowedName,
  isVendorName,
  KEPT_VENDOR_NAMES,
  onlyToollessAllowedNames,
  TOOLLESS_ALLOWED_NAMES,
  TOOLLESS_ALLOWED_PREFIXES,
  VENDOR_NAME_NEEDLES,
  withoutStrippedVendorNames,
} from './child-env-policy.js';

// Issue #251 and the allowlist item of #261. The stripped set is a predicate, so these tests name
// only variables the harness itself forces or keeps, plus made-up names in the namespace.

/** What a shell started by the vendor's CLI hands its children (issue #251, a lead: named, not run). */
const PARENT_SESSION_NAMES = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_EFFORT'];

describe('isVendorName: the vendor namespace', () => {
  it.each(['CLAUDE_CODE_SIMPLE', 'CLAUDE_X', 'CLAUDE_', 'ANTHROPIC_API_KEY', 'ANTHROPIC_', 'CLAUDECODE', ...PARENT_SESSION_NAMES])('%s is in it', (name) => {
    expect(isVendorName(name)).toBe(true);
  });

  // The binary reads names with one leading underscore too (found by the security review of #251).
  it.each(['_CLAUDE_CODE_ASSUME_X', '_ANTHROPIC_X', '_claude_code_x', '_CLAUDE_'])('%s is in it: one leading underscore', (name) => {
    expect(isVendorName(name)).toBe(true);
    expect(isStrippedVendorName(name)).toBe(true);
  });

  it.each(['claude_code_simple', 'Claude_Code_Simple', 'anthropic_model', 'claudecode', 'ClaudeCode'])('%s is in it: names compare without regard to case', (name) => {
    expect(isVendorName(name)).toBe(true);
  });

  it.each(['PATH', 'HOME', 'CLAUDE', 'ANTHROPIC', 'CLAUDECODE_X', 'XCLAUDE_CODE_SIMPLE', 'MY_CLAUDE_KEY', 'AWS_REGION', 'DISABLE_TELEMETRY', '', ' CLAUDE_X', '__CLAUDE_X', '_CLAUDE', '_CLAUDECODE', 'X_CLAUDE_Y'])('%j is outside it', (name) => {
    expect(isVendorName(name)).toBe(false);
  });

  it('every vendor name holds a needle, so a text without one names none (the scan relies on this)', () => {
    expect([...VENDOR_NAME_NEEDLES].sort()).toEqual(['ANTHROPIC_', 'CLAUDECODE', 'CLAUDE_']);
    for (const name of ['CLAUDE_A', 'claude_a', 'ANTHROPIC_B', 'CLAUDECODE', '_CLAUDE_A', '_ANTHROPIC_B', ...KEPT_VENDOR_NAMES]) {
      expect(VENDOR_NAME_NEEDLES.some((needle) => name.toUpperCase().includes(needle)), name).toBe(true);
    }
  });
});

describe('the keep list: credentials, endpoint, providers, the config directory and the traffic opt-out', () => {
  it('is exactly these twenty names, frozen', () => {
    expect(Object.isFrozen(KEPT_VENDOR_NAMES)).toBe(true);
    expect([...KEPT_VENDOR_NAMES].sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_BEDROCK_BASE_URL',
        'ANTHROPIC_CUSTOM_HEADERS',
        'ANTHROPIC_FOUNDRY_API_KEY',
        'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
        'ANTHROPIC_FOUNDRY_BASE_URL',
        'ANTHROPIC_FOUNDRY_RESOURCE',
        'ANTHROPIC_VERTEX_BASE_URL',
        'ANTHROPIC_VERTEX_PROJECT_ID',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
        'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
        'CLAUDE_CODE_SKIP_VERTEX_AUTH',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_FOUNDRY',
        'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CONFIG_DIR',
      ].sort(),
    );
  });

  it('every kept name is a vendor name, upper case, listed once', () => {
    for (const name of KEPT_VENDOR_NAMES) {
      expect(isVendorName(name), name).toBe(true);
      expect(name).toBe(name.toUpperCase());
    }
    expect(new Set(KEPT_VENDOR_NAMES).size).toBe(KEPT_VENDOR_NAMES.length);
  });

  it.each(KEPT_VENDOR_NAMES)('%s is kept, in any letter case, and so not stripped', (name) => {
    expect(isKeptVendorName(name)).toBe(true);
    expect(isKeptVendorName(name.toLowerCase())).toBe(true);
    expect(isStrippedVendorName(name)).toBe(false);
    expect(isStrippedVendorName(name.toLowerCase())).toBe(false);
  });

  it.each(['CLAUDE_CODE_SIMPLE', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY_2', 'XANTHROPIC_API_KEY', 'PATH', ...PARENT_SESSION_NAMES])('%s is not kept', (name) => {
    expect(isKeptVendorName(name)).toBe(false);
  });
});

describe('isStrippedVendorName: a vendor name that is not kept', () => {
  it.each(['CLAUDE_CODE_SIMPLE', 'claude_code_simple', 'CLAUDE_CODE_DISABLE_CRON', 'ANTHROPIC_MODEL', 'CLAUDE_MADE_UP_TOMORROW', ...PARENT_SESSION_NAMES])('%s is stripped', (name) => {
    expect(isStrippedVendorName(name)).toBe(true);
  });

  it.each(['PATH', 'AWS_REGION', 'DISABLE_TELEMETRY', 'CLAUDE'])('%s is outside the namespace, so not stripped', (name) => {
    expect(isStrippedVendorName(name)).toBe(false);
  });
});

describe('withoutStrippedVendorNames: what the primary session starts from', () => {
  const inherited = Object.freeze({
    PATH: '/bin',
    HOME: '/home/u',
    NPM_TOKEN: 't',
    AWS_PROFILE: 'p',
    UNSET: undefined,
    CLAUDE_CODE_SIMPLE: '1',
    claude_code_simple: '1',
    CLAUDECODE: '1',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s',
    ANTHROPIC_MODEL: 'm',
    ANTHROPIC_API_KEY: 'k',
    anthropic_base_url: 'http://127.0.0.1:1',
    CLAUDE_CONFIG_DIR: '/cfg',
  });

  it('drops every stripped vendor name and carries everything else with its value', () => {
    expect(withoutStrippedVendorNames(inherited)).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      NPM_TOKEN: 't',
      AWS_PROFILE: 'p',
      UNSET: undefined,
      ANTHROPIC_API_KEY: 'k',
      anthropic_base_url: 'http://127.0.0.1:1',
      CLAUDE_CONFIG_DIR: '/cfg',
    });
  });

  it('is pure: a fresh object each call, the input untouched', () => {
    const before = { ...inherited };
    const first = withoutStrippedVendorNames(inherited);
    expect(first).not.toBe(inherited);
    expect(first).not.toBe(withoutStrippedVendorNames(inherited));
    expect(inherited).toEqual(before);
  });

  it('an empty environment stays empty', () => {
    expect(withoutStrippedVendorNames({})).toEqual({});
  });
});

describe('the tool-less allowlist: what the judge and the adversary start from', () => {
  it('the lists are frozen, upper case, and hold no vendor name and no duplicate', () => {
    expect(Object.isFrozen(TOOLLESS_ALLOWED_NAMES)).toBe(true);
    expect(Object.isFrozen(TOOLLESS_ALLOWED_PREFIXES)).toBe(true);
    for (const name of [...TOOLLESS_ALLOWED_NAMES, ...TOOLLESS_ALLOWED_PREFIXES]) {
      expect(name).toBe(name.toUpperCase());
      expect(isVendorName(name), name).toBe(false);
    }
    expect(new Set(TOOLLESS_ALLOWED_NAMES).size).toBe(TOOLLESS_ALLOWED_NAMES.length);
    expect([...TOOLLESS_ALLOWED_PREFIXES].sort()).toEqual(['AWS_', 'AZURE_', 'LC_', 'VERTEX_REGION_']);
  });

  it.each([
    // POSIX basics
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
    // Windows basics, in the casing Windows uses
    'Path', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'USERNAME',
    // locale
    'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
    // proxies, both cases, and certificate authorities
    'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    // provider credentials outside the vendor namespace
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK',
    'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'CLOUD_ML_REGION', 'VERTEX_REGION_CLAUDE_5_SONNET', 'AZURE_CLIENT_ID',
    // the operator's traffic opt-outs (off-only switches)
    'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER', 'DO_NOT_TRACK',
    // the keep list
    ...KEPT_VENDOR_NAMES,
  ])('%s is allowed', (name) => {
    expect(isToollessAllowedName(name)).toBe(true);
  });

  it.each(['anthropic_api_key', 'Anthropic_Base_Url', 'claude_config_dir'])('allows the kept name %s in another letter case', (name) => {
    expect(isToollessAllowedName(name)).toBe(true);
    expect(onlyToollessAllowedNames({ [name]: 'v' })).toEqual({ [name]: 'v' });
  });

  it.each([
    'CLAUDE_CODE_SIMPLE', 'claude_code_simple', 'CLAUDECODE', 'CLAUDE_CODE_MESSAGING_SOCKET', 'ANTHROPIC_MODEL', '_CLAUDE_CODE_X',
    'NPM_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'BASH_ENV', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'EDITOR', 'PWD', 'OLDPWD',
    'PATH2', 'XPATH', 'HOME_DIR', 'GOOGLE_API_KEY', 'LC', 'AWS', '',
    // other unprefixed CLI switches are not opt-outs and are not passed
    'DISABLE_COST_WARNINGS', 'DISABLE_GROWTHBOOK', 'ENABLE_TELEMETRY',
    // a prefix is a prefix, not a substring
    'MY_AWS_KEY', 'XLC_ALL', 'NOT_AZURE_X', 'MY_VERTEX_REGION_X',
  ])('%j is not allowed', (name) => {
    expect(isToollessAllowedName(name)).toBe(false);
  });

  it('onlyToollessAllowedNames keeps the allowed names with their values and nothing else; pure', () => {
    const inherited = Object.freeze({
      PATH: '/bin',
      Path: 'C:\\Windows',
      https_proxy: 'http://127.0.0.1:1',
      LC_ALL: 'C',
      AWS_PROFILE: 'p',
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CONFIG_DIR: '/cfg',
      UNSET_HOME_LIKE: undefined,
      NPM_TOKEN: 't',
      NODE_OPTIONS: '--require ./x.js',
      CLAUDE_CODE_SIMPLE: '1',
      ANTHROPIC_MODEL: 'm',
    });
    const before = { ...inherited };
    const out = onlyToollessAllowedNames(inherited);
    expect(out).toEqual({ PATH: '/bin', Path: 'C:\\Windows', https_proxy: 'http://127.0.0.1:1', LC_ALL: 'C', AWS_PROFILE: 'p', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/cfg' });
    expect(out).not.toBe(inherited);
    expect(inherited).toEqual(before);
    expect(onlyToollessAllowedNames({})).toEqual({});
  });
});
