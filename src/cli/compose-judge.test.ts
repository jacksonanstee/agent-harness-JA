import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { composeSecurity, SettingsLoadError } from './shared.js';

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function layer(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'compose-judge-'));
  created.push(dir);
  if (doc !== undefined) {
    mkdirSync(join(dir, '.harness'));
    writeFileSync(join(dir, '.harness', 'settings.json'), typeof doc === 'string' ? doc : JSON.stringify(doc));
  }
  return dir;
}

const projectWarning = (projectDir: string): string =>
  `ignoring "judge" in ${join(projectDir, '.harness', 'settings.json')}: the judge is configured only in ~/.harness/settings.json`;

describe('composeSecurity: the judge key, user layer only (spec D1, pins 1 and 2)', () => {
  it('a user `always` block reaches the composition', () => {
    const s = composeSecurity({ userDir: layer({ judge: { mode: 'always', maxCallsPerRun: 7 } }), projectDir: layer(undefined) });
    expect(s.judge).toEqual({ mode: 'always', maxCallsPerRun: 7, withhold: 'off' });
    expect(s.warnings).toEqual([]);
  });

  it('no judge anywhere is judge null and no warning', () => {
    const s = composeSecurity({ userDir: layer({}), projectDir: layer({}) });
    expect(s.judge).toBeNull();
    expect(s.warnings).toEqual([]);
  });

  it('a malformed USER block is a SettingsLoadError naming the user path (exit 2 at the CLI)', () => {
    const user = layer({ judge: { mode: 'always' } });
    expect(() => composeSecurity({ userDir: user, projectDir: layer(undefined) })).toThrowError(SettingsLoadError);
    expect(() => composeSecurity({ userDir: user, projectDir: layer(undefined) })).toThrow(
      `${join(user, '.harness', 'settings.json')}: judge.maxCallsPerRun is required`,
    );
  });

  it.each([
    ['a valid project block', { judge: { mode: 'always', maxCallsPerRun: 999 } }],
    ['a malformed project block (never parsed, never exit 2)', { judge: { mode: 'suspicious', bogus: 1 } }],
    ['a non-object project block', { judge: 'always' }],
  ])('%s: not parsed, exactly one warning naming the project path, the user setting stands', (_name, projectDoc) => {
    const project = layer(projectDoc);
    const withUserAlways = composeSecurity({ userDir: layer({ judge: { mode: 'always', maxCallsPerRun: 3 } }), projectDir: project });
    expect(withUserAlways.judge).toEqual({ mode: 'always', maxCallsPerRun: 3, withhold: 'off' });
    expect(withUserAlways.warnings).toEqual([projectWarning(project)]);
    const withUserNone = composeSecurity({ userDir: layer({}), projectDir: project });
    expect(withUserNone.judge).toBeNull();
    expect(withUserNone.warnings).toEqual([projectWarning(project)]);
  });

  it('a project judge.withhold is ignored with the existing one warning, whatever the user layer says (#145 B2a, W12b, a pin)', () => {
    const project = layer({ judge: { mode: 'always', maxCallsPerRun: 9, withhold: 'block' } });
    const s = composeSecurity({ userDir: layer({ judge: { mode: 'always', maxCallsPerRun: 3 } }), projectDir: project });
    expect(s.judge).toEqual({ mode: 'always', maxCallsPerRun: 3, withhold: 'off' });
    expect(s.warnings).toEqual([projectWarning(project)]);
  });

  it('a project judge.withhold block cannot switch withholding on over a user off (#145 B2a, W12b)', () => {
    const project = layer({ judge: { mode: 'always', maxCallsPerRun: 9, withhold: 'block' } });
    const s = composeSecurity({ userDir: layer({ judge: { mode: 'always', maxCallsPerRun: 3, withhold: 'off' } }), projectDir: project });
    expect(s.judge).toEqual({ mode: 'always', maxCallsPerRun: 3, withhold: 'off' });
  });

  it('a project `off` block cannot turn a user `always` off', () => {
    const s = composeSecurity({
      userDir: layer({ judge: { mode: 'always', maxCallsPerRun: 4 } }),
      projectDir: layer({ judge: { mode: 'off' } }),
    });
    expect(s.judge).toEqual({ mode: 'always', maxCallsPerRun: 4, withhold: 'off' });
  });
});

describe('composeSecurity: grantPolicy (#140, D-8)', () => {
  const policyFor = (sandbox: unknown) =>
    composeSecurity({ userDir: layer(sandbox === undefined ? {} : { sandbox }), projectDir: layer(undefined) }).grantPolicy;

  it('no sandbox commands: Bash is ungrantable', () => {
    expect([...policyFor(undefined).ungrantableTools]).toEqual(['Bash']);
    expect([...policyFor({ paths: { allow: ['/x'] } }).ungrantableTools]).toEqual(['Bash']);
  });
  it('a non-empty commands list: Bash is grantable', () => {
    expect([...policyFor({ commands: { allow: ['git'] } }).ungrantableTools]).toEqual([]);
  });
  it('an empty commands list does not count as configured: Bash is ungrantable', () => {
    expect([...policyFor({ commands: { allow: [] } }).ungrantableTools]).toEqual(['Bash']);
  });

  const policyBoth = (user: unknown, project: unknown) =>
    composeSecurity({
      userDir: layer(user === undefined ? {} : { sandbox: user }),
      projectDir: layer(project === undefined ? {} : { sandbox: project }),
    }).grantPolicy;

  it('project-only sandbox commands do not make Bash grantable (a cloned repo cannot unlock the grant)', () => {
    expect([...policyBoth(undefined, { commands: { allow: ['curl'] } }).ungrantableTools]).toEqual(['Bash']);
  });
  it('user commands present: Bash is grantable, with or without a project list (the gate is the merged list)', () => {
    expect([...policyBoth({ commands: { allow: ['git'] } }, undefined).ungrantableTools]).toEqual([]);
    expect([...policyBoth({ commands: { allow: ['git'] } }, { commands: { allow: ['git', 'ls'] } }).ungrantableTools]).toEqual([]);
  });
});
