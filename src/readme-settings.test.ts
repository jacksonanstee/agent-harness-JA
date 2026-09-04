import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeSecurity } from './cli/shared.js';
import { INIT_SETTINGS_JSON } from './cli/init-templates.js';
import {
  createPermissionEvaluator,
  createSandbox,
  parsePermissionSettings,
  parseSandboxSettings,
  PermissionDenied,
  permissionHook,
} from './security/index.js';

// README's `## Settings` section is operator-facing prose about the security
// settings files. Prose has no tests of its own, so this file loads the
// section's fenced JSON examples through the REAL composition (two temp
// dirs, real `.harness/settings.json` files, the guarded reader) and asserts
// the outcomes the prose promises, and it pins the strings the prose quotes
// verbatim against the code that produces them (issue #100).

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(resolve(here, '..', 'README.md'), 'utf8');

function settingsSection(): string {
  const start = readme.indexOf('\n## Settings\n');
  if (start === -1) throw new Error('README.md has no `## Settings` section');
  const rest = readme.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

function fencedJson(section: string): string[] {
  return [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1] ?? '');
}

/** Writes `doc` as `<dir>/.harness/settings.json` in a fresh temp dir and returns the dir. */
function layerDir(label: string, doc: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), `readme-settings-${label}-`));
  if (doc !== undefined) {
    mkdirSync(join(dir, '.harness'));
    writeFileSync(join(dir, '.harness', 'settings.json'), doc);
  }
  return dir;
}

function compose(userDoc: string | undefined, projectDoc: string | undefined) {
  return composeSecurity({
    userDir: layerDir('user', userDoc),
    projectDir: layerDir('project', projectDoc),
  });
}

/** Read lazily inside each test so a missing section is eleven red tests, not a collection failure. */
function loaded(): { section: string; blocks: string[]; userDoc: string; projectDoc: string } {
  const section = settingsSection();
  const blocks = fencedJson(section);
  return { section, blocks, userDoc: blocks[0] ?? '{}', projectDoc: blocks[1] ?? '{}' };
}

describe('README `## Settings`: the examples load through the real composition', () => {

  it('has exactly two fenced JSON examples: the user file, then the project file', () => {
    const { blocks } = loaded();
    expect(blocks).toHaveLength(2);
  });

  it('both examples parse under BOTH real parsers (the init-templates precedent)', () => {
    const { blocks } = loaded();
    for (const doc of blocks) {
      const parsed: unknown = JSON.parse(doc);
      expect(() => parsePermissionSettings(parsed)).not.toThrow();
      expect(() => parseSandboxSettings(parsed)).not.toThrow();
    }
  });

  it('the project example is the file `init` scaffolds, so README and the scaffold agree', () => {
    const { projectDoc } = loaded();
    expect(JSON.parse(projectDoc)).toEqual(JSON.parse(INIT_SETTINGS_JSON));
  });

  it('composes with no startup warnings', () => {
    const { userDoc, projectDoc } = loaded();
    expect(compose(userDoc, projectDoc).warnings).toEqual([]);
  });

  it('a project deny rule tightens: WebFetch is denied by the project layer', () => {
    const { userDoc, projectDoc } = loaded();
    const evaluate = createPermissionEvaluator(compose(userDoc, projectDoc).permissions).evaluate;
    const result = evaluate('WebFetch', { url: 'https://example.invalid' });
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('project');
  });

  it('a user allow rule allows, and a `match` prefix-glob is a prefix (space included)', () => {
    const { userDoc, projectDoc } = loaded();
    const evaluate = createPermissionEvaluator(compose(userDoc, projectDoc).permissions).evaluate;
    expect(evaluate('Read', { file_path: '/repo/README.md' }).decision).toBe('allow');
    expect(evaluate('Bash', { command: 'git status' }).decision).toBe('allow');
    expect(evaluate('Bash', { command: 'gitk' }).decision).toBe('deny');
    expect(evaluate('Bash', { command: 'rm -rf /' }).decision).toBe('deny');
  });

  it('a tool no rule names gets the user default deny, because the project example omits defaultDecision', () => {
    const { userDoc, projectDoc } = loaded();
    const evaluate = createPermissionEvaluator(compose(userDoc, projectDoc).permissions).evaluate;
    const result = evaluate('Edit', { file_path: '/repo/x.ts' });
    expect(result.decision).toBe('deny');
    expect(result.layer).toBeNull();
    expect(result.reason).toBe('permission: default deny (no matching rule)');
  });

  it('R-8, as the section states it: a project defaultDecision overrides the user default', () => {
    const { section, userDoc, projectDoc } = loaded();
    const widened = JSON.stringify({
      ...(JSON.parse(projectDoc) as { permissions: object }),
      permissions: {
        ...(JSON.parse(projectDoc) as { permissions: object }).permissions,
        defaultDecision: 'allow',
      },
    });
    const evaluate = createPermissionEvaluator(compose(userDoc, widened).permissions).evaluate;
    expect(evaluate('Edit', { file_path: '/repo/x.ts' }).decision).toBe('allow');
    expect(section).toContain('project overrides user');
  });

  it('sticky deny, as the section states it: a user deny survives a project allow of the same tool', () => {
    const { section } = loaded();
    const user = JSON.stringify({ permissions: { rules: [{ tool: 'Bash', decision: 'deny' }] } });
    const project = JSON.stringify({
      permissions: { rules: [{ tool: 'Bash', match: 'git *', decision: 'allow' }] },
    });
    const result = createPermissionEvaluator(compose(user, project).permissions).evaluate('Bash', {
      command: 'git status',
    });
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('user');
    expect(section).toContain('never loosen');
  });

  it('the sandbox example turns on the commands dimension only; paths stays off and allows everything', () => {
    const { userDoc, projectDoc } = loaded();
    const sandbox = createSandbox(compose(userDoc, projectDoc).sandbox);
    expect(sandbox.commandsEnabled).toBe(true);
    expect(sandbox.allowCommand('git status')).toBe(true);
    expect(sandbox.allowCommand('rm -rf /')).toBe(false);
    expect(sandbox.allowCommand('bash -c ls')).toBe(false);
    expect(sandbox.pathsEnabled).toBe(false);
    expect(sandbox.allowPath('/etc/passwd')).toBe(true);
  });

  it('quotes the ask-without-prompter warning verbatim, and the denial suffix the hook emits', async () => {
    const { section } = loaded();
    const asking = JSON.stringify({ permissions: { rules: [{ tool: 'Bash', decision: 'ask' }] } });
    const composed = compose(asking, undefined);
    expect(composed.warnings).toHaveLength(1);
    const [warning] = composed.warnings;
    expect(warning).toBeDefined();
    // The prose-to-code pin: the README carries the string the code produces.
    expect(section).toContain(warning ?? '');

    const hook = permissionHook(createPermissionEvaluator(composed.permissions));
    let thrown: unknown;
    try {
      await hook({ tool: 'Bash', args: { command: 'ls' } });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const suffix = "'ask' with no prompter configured";
    expect((thrown as Error).message).toContain(suffix);
    expect(section).toContain(suffix);
  });
});
