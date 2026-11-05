import { describe, expect, it } from 'vitest';

import { unknownKeyMessage } from '../internal/settings.js';
import { hasSdkKey, parseSdkAllowedMcpServers, parseSdkSettings, SdkSettingsError } from './sdk-settings.js';

// Deliberate pin: re-typed, not imported, so a changed literal fails here.
const SDK_SOURCES_MESSAGE = 'sdk.settingSources must be an array of distinct values from "user", "project", "local"';

describe('parseSdkSettings (#140, ADR-0040 D2)', () => {
  it('absent sdk, sdk {}, and settingSources [] all resolve [] (isolated)', () => {
    expect(parseSdkSettings({})).toEqual([]);
    expect(parseSdkSettings({ sdk: {} })).toEqual([]);
    expect(parseSdkSettings({ sdk: { settingSources: [] } })).toEqual([]);
  });

  it('returns the distinct members as a fresh array, order as written', () => {
    const input = ['local', 'user'];
    const out = parseSdkSettings({ sdk: { settingSources: input } });
    expect(out).toEqual(['local', 'user']);
    expect(out).not.toBe(input);
  });

  it.each([
    ['a non-object root', 'nope', 'settings root must be a JSON object'],
    ['a null sdk', { sdk: null }, 'sdk must be an object'],
    ['an array sdk', { sdk: [] }, 'sdk must be an object'],
    ['an unknown key', { sdk: { settingSource: [] } }, unknownKeyMessage('sdk', 'settingSource', ['settingSources', 'allowedMcpServers'])],
    ['a null list', { sdk: { settingSources: null } }, SDK_SOURCES_MESSAGE],
    ['a string list', { sdk: { settingSources: 'user' } }, SDK_SOURCES_MESSAGE],
    ['a non-string member', { sdk: { settingSources: [1] } }, SDK_SOURCES_MESSAGE],
    ['an unknown literal', { sdk: { settingSources: ['MARKER-x9'] } }, SDK_SOURCES_MESSAGE],
    ['a duplicate', { sdk: { settingSources: ['user', 'user'] } }, SDK_SOURCES_MESSAGE],
    ['the SDK-internal literals', { sdk: { settingSources: ['managed'] } }, SDK_SOURCES_MESSAGE],
  ])('refuses %s with the fixed message and never echoes the value', (_name, doc, message) => {
    expect(() => parseSdkSettings(doc)).toThrowError(SdkSettingsError);
    // Exact message equality (not substring): a message that appends or echoes the value after the fixed text must fail.
    let caught: unknown;
    try {
      parseSdkSettings(doc);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SdkSettingsError);
    expect((caught as Error).message).toBe(message);
    expect((caught as Error).message).not.toContain('MARKER-x9');
  });

  it('hasSdkKey detects an OWN key whatever its value, and nothing else', () => {
    expect(hasSdkKey({ sdk: null })).toBe(true);
    expect(hasSdkKey({})).toBe(false);
    expect(hasSdkKey(Object.create({ sdk: {} }))).toBe(false);
  });
});

// Deliberate pin: re-typed, not imported.
const SDK_MCP_MESSAGE =
  'sdk.allowedMcpServers must be an array of distinct MCP server names (letters, digits, "-" and single "_", 1-64 characters)';

describe('parseSdkAllowedMcpServers (#225, ADR-0045): MCP servers the operator allows, USER layer only', () => {
  it('absent sdk, sdk {}, and allowedMcpServers [] all resolve [] (no MCP tool allowed)', () => {
    expect(parseSdkAllowedMcpServers({})).toEqual([]);
    expect(parseSdkAllowedMcpServers({ sdk: {} })).toEqual([]);
    expect(parseSdkAllowedMcpServers({ sdk: { allowedMcpServers: [] } })).toEqual([]);
    expect(parseSdkAllowedMcpServers({ sdk: { settingSources: ['user'] } })).toEqual([]);
  });

  it('returns the distinct names as a fresh array, order as written', () => {
    const input = ['github', 'my-server_2'];
    const out = parseSdkAllowedMcpServers({ sdk: { allowedMcpServers: input } });
    expect(out).toEqual(['github', 'my-server_2']);
    expect(out).not.toBe(input);
  });

  it.each([
    ['a null list', { sdk: { allowedMcpServers: null } }],
    ['a string list', { sdk: { allowedMcpServers: 'github' } }],
    ['a non-string member', { sdk: { allowedMcpServers: [1] } }],
    ['an empty name', { sdk: { allowedMcpServers: [''] } }],
    ['a name with a double underscore (ambiguous with the tool segment)', { sdk: { allowedMcpServers: ['a__b'] } }],
    ['a name with a leading underscore', { sdk: { allowedMcpServers: ['_a'] } }],
    ['a name with a trailing underscore', { sdk: { allowedMcpServers: ['a_'] } }],
    ['a name with a space', { sdk: { allowedMcpServers: ['my server'] } }],
    ['a name with a slash', { sdk: { allowedMcpServers: ['a/b'] } }],
    ['a 65-character name', { sdk: { allowedMcpServers: ['a'.repeat(65)] } }],
    ['a duplicate', { sdk: { allowedMcpServers: ['github', 'github'] } }],
  ])('refuses %s with the fixed message and never echoes the value', (_name, doc) => {
    let caught: unknown;
    try {
      parseSdkAllowedMcpServers(doc);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SdkSettingsError);
    expect((caught as Error).message).toBe(SDK_MCP_MESSAGE);
  });

  it('accepts a 64-character name and a one-character name (the bounds)', () => {
    expect(parseSdkAllowedMcpServers({ sdk: { allowedMcpServers: ['a'.repeat(64), 'x'] } })).toEqual(['a'.repeat(64), 'x']);
  });

  it('parseSdkSettings still accepts a document that also carries allowedMcpServers', () => {
    expect(parseSdkSettings({ sdk: { settingSources: ['user'], allowedMcpServers: ['github'] } })).toEqual(['user']);
  });
});
