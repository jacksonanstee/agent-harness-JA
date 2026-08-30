import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MESSAGE_ECHO_MAX } from '../../internal/settings.js';
import { createPermissionEvaluator } from './evaluate.js';
import {
  loadSettingsFile,
  MAX_RULES,
  mergeLayers,
  parsePermissionSettings,
  PermissionSettingsError,
} from './settings.js';

describe('parsePermissionSettings', () => {
  it('parses a valid settings document', () => {
    const parsed = parsePermissionSettings({
      permissions: {
        defaultDecision: 'ask',
        rules: [
          { tool: 'Bash', decision: 'deny' },
          { tool: 'Write', match: '/etc/*', decision: 'deny' },
        ],
      },
    });
    expect(parsed.defaultDecision).toBe('ask');
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.rules[1]).toEqual({ tool: 'Write', match: '/etc/*', decision: 'deny' });
  });

  it('returns an empty layer when the permissions key is absent', () => {
    expect(parsePermissionSettings({})).toEqual({ rules: [] });
    expect(parsePermissionSettings({ otherKey: 1 })).toEqual({ rules: [] });
  });

  it('rejects an unknown key inside permissions, naming the key and the known set (ADR-0034)', () => {
    // Was pinned as "ignored" until issue #85: a typo of a hardening key
    // (defaultDecison) produced the open posture with no signal. Root-level
    // siblings stay ignored (the test above); INSIDE the dimension is policy.
    const doc = { permissions: { rules: [], futureKnob: true } };
    expect(() => parsePermissionSettings(doc)).toThrowError(PermissionSettingsError);
    expect(() => parsePermissionSettings(doc)).toThrow(/permissions.*unknown key 'futureKnob'/);
    expect(() => parsePermissionSettings(doc)).toThrow(/defaultDecision, rules/);
  });

  it('rejects an unknown key inside a rule entry: a typo of match would widen an allow rule', () => {
    // { tool: 'Bash', decision: 'allow', matchh: 'git *' } used to parse as a
    // blanket Bash allow, the exact widening the parser exists to refuse.
    const doc = { permissions: { rules: [{ tool: 'Bash', decision: 'allow', matchh: 'git *' }] } };
    expect(() => parsePermissionSettings(doc)).toThrowError(PermissionSettingsError);
    expect(() => parsePermissionSettings(doc)).toThrow(/rules\[0\].*unknown key 'matchh'/);
    expect(() => parsePermissionSettings(doc)).toThrow(/tool, match, decision/);
  });

  it('bounds the echoed key name: the key is attacker-authored bytes bound for stderr', () => {
    const longKey = 'k'.repeat(500);
    let message = '';
    try {
      parsePermissionSettings({ permissions: { rules: [], [longKey]: 1 } });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/unknown key/);
    expect(message).not.toContain(longKey);
    expect(message).toContain(`'${'k'.repeat(MESSAGE_ECHO_MAX)}…'`);
  });

  it.each([
    ['non-object root', 'nope'],
    ['non-object permissions', { permissions: 'nope' }],
    ['non-array rules', { permissions: { rules: {} } }],
    ['bad decision string', { permissions: { rules: [{ tool: 'Bash', decision: 'block' }] } }],
    ['missing tool', { permissions: { rules: [{ decision: 'deny' }] } }],
    ['non-string match', { permissions: { rules: [{ tool: 'Bash', match: 7, decision: 'deny' }] } }],
    ['empty tool', { permissions: { rules: [{ tool: '', decision: 'deny' }] } }],
    ['bad defaultDecision', { permissions: { defaultDecision: 'yes', rules: [] } }],
  ])('throws PermissionSettingsError on %s', (_name, doc) => {
    expect(() => parsePermissionSettings(doc)).toThrowError(PermissionSettingsError);
  });
});

describe('parsePermissionSettings rule cap', () => {
  it('rejects a rules list over MAX_RULES (attacker-influenced project file)', () => {
    const rules = Array.from({ length: MAX_RULES + 1 }, () => ({
      tool: 'Bash',
      decision: 'deny',
    }));
    expect(() => parsePermissionSettings({ permissions: { rules } })).toThrowError(
      PermissionSettingsError,
    );
    expect(() =>
      parsePermissionSettings({ permissions: { rules: rules.slice(0, MAX_RULES) } }),
    ).not.toThrow();
  });
});

describe('loadSettingsFile', () => {
  const tmp: string[] = [];
  afterEach(() => {
    for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads through the guarded reader when no readFile is given: a symlinked file is refused', () => {
    // The public loader carries the envelope itself (ADR-0034 decision 5);
    // a library caller cannot end up with a plain read by omission.
    const dir = mkdtempSync(join(tmpdir(), 'perm-settings-'));
    tmp.push(dir);
    const real = join(dir, 'real.json');
    writeFileSync(real, '{}');
    const link = join(dir, 'settings.json');
    symlinkSync(real, link);
    expect(() => loadSettingsFile(link)).toThrowError(PermissionSettingsError);
    expect(() => loadSettingsFile(link)).toThrow(/symlink/);
    expect(loadSettingsFile(join(dir, 'missing.json'))).toEqual({ rules: [] });
  });

  it('returns an empty layer when the file is missing', () => {
    const missing = (): string => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    expect(loadSettingsFile('/nope/settings.json', missing)).toEqual({ rules: [] });
  });

  it('fails loud on malformed JSON', () => {
    expect(() => loadSettingsFile('/x/settings.json', () => '{oops')).toThrowError(
      PermissionSettingsError,
    );
  });

  it('fails loud on a valid-JSON but invalid-schema file', () => {
    expect(() =>
      loadSettingsFile('/x/settings.json', () => JSON.stringify({ permissions: { rules: 'x' } })),
    ).toThrowError(PermissionSettingsError);
  });

  it('propagates non-ENOENT filesystem errors', () => {
    const eacces = (): string => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    expect(() => loadSettingsFile('/x/settings.json', eacces)).toThrow('EACCES');
  });

  it('loads and parses a valid file', () => {
    const body = JSON.stringify({
      permissions: { rules: [{ tool: 'Bash', decision: 'ask' }] },
    });
    const parsed = loadSettingsFile('/x/settings.json', () => body);
    expect(parsed.rules).toEqual([{ tool: 'Bash', decision: 'ask' }]);
  });
});

describe('mergeLayers', () => {
  it('concatenates rules user-first and tags each with its layer', () => {
    const merged = mergeLayers(
      { rules: [{ tool: 'Bash', decision: 'deny' }] },
      { rules: [{ tool: 'Read', decision: 'allow' }] },
    );
    expect(merged.rules).toEqual([
      { tool: 'Bash', decision: 'deny', layer: 'user' },
      { tool: 'Read', decision: 'allow', layer: 'project' },
    ]);
  });

  it('project defaultDecision overrides user; user applies when project is silent', () => {
    expect(
      mergeLayers(
        { defaultDecision: 'deny', rules: [] },
        { defaultDecision: 'allow', rules: [] },
      ).defaultDecision,
    ).toBe('allow');
    expect(
      mergeLayers({ defaultDecision: 'deny', rules: [] }, { rules: [] }).defaultDecision,
    ).toBe('deny');
    expect(mergeLayers({ rules: [] }, { rules: [] }).defaultDecision).toBeUndefined();
  });

  it('end-to-end: user deny survives project allow through the evaluator', () => {
    const merged = mergeLayers(
      { rules: [{ tool: 'Bash', decision: 'deny' }] },
      { rules: [{ tool: 'Bash', decision: 'allow' }] },
    );
    const evaluator = createPermissionEvaluator(merged);
    const result = evaluator.evaluate('Bash', { command: 'ls' });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('user');
  });
});
