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
    expect(s.judge).toEqual({ mode: 'always', maxCallsPerRun: 7 });
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
    expect(withUserAlways.judge).toEqual({ mode: 'always', maxCallsPerRun: 3 });
    expect(withUserAlways.warnings).toEqual([projectWarning(project)]);
    const withUserNone = composeSecurity({ userDir: layer({}), projectDir: project });
    expect(withUserNone.judge).toBeNull();
    expect(withUserNone.warnings).toEqual([projectWarning(project)]);
  });

  it('a project `off` block cannot turn a user `always` off', () => {
    const s = composeSecurity({
      userDir: layer({ judge: { mode: 'always', maxCallsPerRun: 4 } }),
      projectDir: layer({ judge: { mode: 'off' } }),
    });
    expect(s.judge).toEqual({ mode: 'always', maxCallsPerRun: 4 });
  });
});
