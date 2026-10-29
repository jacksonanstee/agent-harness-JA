import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { CODE_EXECUTING_TOOLS } from '../internal/tool-targets.js';
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

describe('composeSecurity: grantPolicy (#140, D-8; #211 every code-executing tool)', () => {
  const policyFor = (sandbox: unknown) =>
    composeSecurity({ userDir: layer(sandbox === undefined ? {} : { sandbox }), projectDir: layer(undefined) }).grantPolicy;
  const ungrantable = (policy: { ungrantableTools: ReadonlySet<string> }) => [...policy.ungrantableTools].sort();
  const ALL = ['Bash', 'Monitor', 'REPL', 'Workflow'];

  it('no sandbox: every code-executing tool is ungrantable, and the set is CODE_EXECUTING_TOOLS (a future member is covered)', () => {
    expect(ungrantable(policyFor(undefined))).toEqual(ALL);
    expect(ungrantable(policyFor(undefined))).toEqual(Object.keys(CODE_EXECUTING_TOOLS).sort());
  });
  it('a user commands list makes Bash and Monitor grantable, nothing else', () => {
    expect(ungrantable(policyFor({ commands: { allow: ['git'] } }))).toEqual(['REPL', 'Workflow']);
  });
  it('a user paths list unlocks nothing: Workflow is withheld (paths checks where a script is, not what it runs)', () => {
    expect(ungrantable(policyFor({ paths: { allow: ['/x'] } }))).toEqual(ALL);
    expect(ungrantable(policyFor({ paths: { allow: ['/x'] }, commands: { allow: ['git'] } }))).toEqual(['REPL', 'Workflow']);
  });
  it('an empty commands list does not count as configured', () => {
    expect(ungrantable(policyFor({ commands: { allow: [] } }))).toEqual(ALL);
  });

  const policyBoth = (user: unknown, project: unknown) =>
    composeSecurity({
      userDir: layer(user === undefined ? {} : { sandbox: user }),
      projectDir: layer(project === undefined ? {} : { sandbox: project }),
    }).grantPolicy;

  it('project-only sandbox lists unlock nothing (a cloned repo cannot unlock the grant)', () => {
    expect(ungrantable(policyBoth(undefined, { commands: { allow: ['curl'] }, paths: { allow: ['.'] } }))).toEqual(ALL);
  });
  it('user commands present: Bash and Monitor are grantable, with or without a project list (the gate is the merged list)', () => {
    expect(ungrantable(policyBoth({ commands: { allow: ['git'] } }, undefined))).toEqual(['REPL', 'Workflow']);
    expect(ungrantable(policyBoth({ commands: { allow: ['git'] } }, { commands: { allow: ['git', 'ls'] } }))).toEqual(['REPL', 'Workflow']);
  });
});
