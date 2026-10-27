import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { composeSecurity, SDK_PROJECT_INHERIT_WARNING, SDK_USER_INHERIT_WARNING, SettingsLoadError } from './shared.js';

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function layer(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'compose-sdk-'));
  created.push(dir);
  if (doc !== undefined) {
    mkdirSync(join(dir, '.harness'));
    writeFileSync(join(dir, '.harness', 'settings.json'), JSON.stringify(doc));
  }
  return dir;
}

function compose(user: unknown, project: unknown) {
  const projectDir = layer(project);
  return { c: composeSecurity({ userDir: layer(user), projectDir }), projectPath: join(projectDir, '.harness', 'settings.json') };
}

describe('composeSecurity: the sdk key, user layer only (#140, ADR-0040 D2)', () => {
  it('no sdk anywhere: settingSources [] and no warning', () => {
    expect(compose({}, {}).c).toMatchObject({ sdk: { settingSources: [] }, warnings: [] });
  });

  it('a user opt-in reaches the composition with the two inherit warnings', () => {
    const { c } = compose({ sdk: { settingSources: ['user', 'project', 'local'] } }, {});
    expect(c.sdk.settingSources).toEqual(['user', 'project', 'local']);
    expect(c.warnings).toEqual([SDK_USER_INHERIT_WARNING, SDK_PROJECT_INHERIT_WARNING]);
  });

  it('user only warns once; local only warns the project line', () => {
    expect(compose({ sdk: { settingSources: ['user'] } }, {}).c.warnings).toEqual([SDK_USER_INHERIT_WARNING]);
    expect(compose({ sdk: { settingSources: ['local'] } }, {}).c.warnings).toEqual([SDK_PROJECT_INHERIT_WARNING]);
  });

  it('a PROJECT sdk key is ignored with one warning naming the project path, whatever the user layer says (D-2)', () => {
    const { c, projectPath } = compose({}, { sdk: { settingSources: ['user', 'project', 'local'] } });
    expect(c.sdk.settingSources).toEqual([]);
    expect(c.warnings).toEqual([
      `ignoring "sdk" in ${projectPath}: Claude Code settings sources are configured only in ~/.harness/settings.json`,
    ]);
  });

  it('a project sdk key never widens a user list', () => {
    const { c } = compose({ sdk: { settingSources: ['user'] } }, { sdk: { settingSources: ['user', 'project', 'local'] } });
    expect(c.sdk.settingSources).toEqual(['user']);
  });

  it('a MALFORMED project sdk key warns and never exits 2 (it is detected, not parsed)', () => {
    const { c } = compose({}, { sdk: { settingSources: 'MARKER-x9' } });
    expect(c.sdk.settingSources).toEqual([]);
    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]).not.toContain('MARKER-x9');
  });

  it('a malformed USER sdk key is a SettingsLoadError naming the user path', () => {
    const userDir = layer({ sdk: { settingSources: ['x'] } });
    expect(() => composeSecurity({ userDir, projectDir: layer(undefined) })).toThrowError(SettingsLoadError);
    expect(() => composeSecurity({ userDir, projectDir: layer(undefined) })).toThrow(
      `${join(userDir, '.harness', 'settings.json')}: sdk.settingSources must be an array`,
    );
  });
});
