import { describe, expect, it } from 'vitest';

import { unknownKeyMessage } from '../internal/settings.js';
import { hasSdkKey, parseSdkSettings, SdkSettingsError } from './sdk-settings.js';

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
    ['an unknown key', { sdk: { settingSource: [] } }, unknownKeyMessage('sdk', 'settingSource', ['settingSources'])],
    ['a null list', { sdk: { settingSources: null } }, SDK_SOURCES_MESSAGE],
    ['a string list', { sdk: { settingSources: 'user' } }, SDK_SOURCES_MESSAGE],
    ['a non-string member', { sdk: { settingSources: [1] } }, SDK_SOURCES_MESSAGE],
    ['an unknown literal', { sdk: { settingSources: ['MARKER-x9'] } }, SDK_SOURCES_MESSAGE],
    ['a duplicate', { sdk: { settingSources: ['user', 'user'] } }, SDK_SOURCES_MESSAGE],
    ['the SDK-internal literals', { sdk: { settingSources: ['managed'] } }, SDK_SOURCES_MESSAGE],
  ])('refuses %s with the fixed message and never echoes the value', (_name, doc, message) => {
    expect(() => parseSdkSettings(doc)).toThrowError(SdkSettingsError);
    expect(() => parseSdkSettings(doc)).toThrow(message);
    try {
      parseSdkSettings(doc);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('MARKER-x9');
    }
  });

  it('hasSdkKey detects an OWN key whatever its value, and nothing else', () => {
    expect(hasSdkKey({ sdk: null })).toBe(true);
    expect(hasSdkKey({})).toBe(false);
    expect(hasSdkKey(Object.create({ sdk: {} }))).toBe(false);
  });
});
