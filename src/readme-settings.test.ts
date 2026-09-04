import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
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
import { MAX_RULES } from './security/permissions/settings.js';
import { MAX_ALLOW_ENTRIES } from './security/sandbox/index.js';

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
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function layerDir(label: string, doc: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), `readme-settings-${label}-`));
  created.push(dir);
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

  it('a project deny rule tightens: WebFetch is denied by the project layer, with or without a user file', () => {
    const { userDoc, projectDoc } = loaded();
    const alone = createPermissionEvaluator(compose(undefined, projectDoc).permissions).evaluate;
    const result = alone('WebFetch', { url: 'https://example.invalid' });
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('project');
    const merged = createPermissionEvaluator(compose(userDoc, projectDoc).permissions).evaluate;
    expect(merged('WebFetch', { url: 'https://example.invalid' }).decision).toBe('deny');
  });

  it('a user allow rule allows, and a `match` prefix-glob is a prefix (space included)', () => {
    const { userDoc, projectDoc } = loaded();
    const evaluate = createPermissionEvaluator(compose(userDoc, projectDoc).permissions).evaluate;
    expect(evaluate('Read', { file_path: '/repo/README.md' }).decision).toBe('allow');
    expect(evaluate('Bash', { command: 'git status' }).decision).toBe('allow');
    expect(evaluate('Bash', { command: 'gitk' }).decision).toBe('deny');
    expect(evaluate('Bash', { command: 'rm -rf /' }).decision).toBe('deny');
    expect(evaluate('Glob', { pattern: '*.ts', path: '/repo' }).decision).toBe('allow');
    expect(evaluate('Grep', { pattern: 'TODO', path: '/repo' }).decision).toBe('allow');
  });

  it('`match` on a path-taking tool targets its path, not the JSON of its arguments (code lens M-1)', () => {
    const { section } = loaded();
    const user = JSON.stringify({
      permissions: {
        defaultDecision: 'deny',
        rules: [{ tool: 'Glob', match: '/repo/*', decision: 'allow' }],
      },
    });
    const evaluate = createPermissionEvaluator(compose(user, undefined).permissions).evaluate;
    expect(evaluate('Glob', { pattern: '*.ts', path: '/repo/src' }).decision).toBe('allow');
    expect(evaluate('Glob', { pattern: '*.ts', path: '/etc' }).decision).toBe('deny');
    expect(section).toContain('a Glob rule matches on its `path`');
  });

  it('the two caps the section states are the parsers\' own constants', () => {
    const { section } = loaded();
    expect(section).toContain(`more than ${MAX_RULES} rules or ${MAX_ALLOW_ENTRIES} allowlist entries`);
  });

  it('a tool the allows do not name is denied by the user wildcard deny RULE, which sticky deny protects', () => {
    const { userDoc, projectDoc } = loaded();
    const evaluate = createPermissionEvaluator(compose(userDoc, projectDoc).permissions).evaluate;
    const result = evaluate('Edit', { file_path: '/repo/x.ts' });
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('user');
  });

  it('a deny DEFAULT is not sticky: a project allow rule, or a project defaultDecision (R-8), beats it', () => {
    const { section } = loaded();
    const denyDefault = JSON.stringify({
      permissions: { defaultDecision: 'deny', rules: [{ tool: 'Read', decision: 'allow' }] },
    });
    const baseline = createPermissionEvaluator(compose(denyDefault, undefined).permissions).evaluate;
    expect(baseline('Write', { file_path: '/repo/x' }).decision).toBe('deny');
    const projectAllowRule = JSON.stringify({ permissions: { rules: [{ tool: '*', decision: 'allow' }] } });
    const projectDefault = JSON.stringify({ permissions: { defaultDecision: 'allow' } });
    for (const project of [projectAllowRule, projectDefault]) {
      const evaluate = createPermissionEvaluator(compose(denyDefault, project).permissions).evaluate;
      expect(evaluate('Write', { file_path: '/repo/x' }).decision).toBe('allow');
    }
    expect(section).toContain('project overrides user');
    expect(section).toContain('is not sticky');
  });

  it('the hardened example uses a wildcard deny RULE, so a hostile project file cannot re-enable a tool', () => {
    const { userDoc } = loaded();
    const attacks = [
      JSON.stringify({ permissions: { rules: [{ tool: '*', decision: 'allow' }] } }),
      JSON.stringify({ permissions: { rules: [{ tool: 'Write', decision: 'allow' }] } }),
      JSON.stringify({ permissions: { defaultDecision: 'allow' } }),
    ];
    for (const project of attacks) {
      const evaluate = createPermissionEvaluator(compose(userDoc, project).permissions).evaluate;
      const write = evaluate('Write', { file_path: '/repo/x' });
      expect(write.decision, project).toBe('deny');
      expect(write.layer, project).toBe('user');
      expect(evaluate('Read', { file_path: '/repo/x' }).decision, project).toBe('allow');
    }
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

  it('the sandbox example turns on both dimensions: commands to git, paths to the working directory', () => {
    const { section, userDoc, projectDoc } = loaded();
    const sandbox = createSandbox(compose(userDoc, projectDoc).sandbox);
    expect(sandbox.commandsEnabled).toBe(true);
    expect(sandbox.allowCommand('git status')).toBe(true);
    expect(sandbox.allowCommand('rm -rf /')).toBe(false);
    expect(sandbox.allowCommand('bash -c ls')).toBe(false);
    expect(sandbox.pathsEnabled).toBe(true);
    expect(sandbox.allowPath(resolve(process.cwd(), 'src'))).toBe(true);
    expect(sandbox.allowPath('/etc/passwd')).toBe(false);
    // The residual the section must state: an allowlisted program is trusted as a whole.
    expect(section).toContain('which program starts, not what it does');
  });

  it('the paths dimension, when on, is the boundary-safe prefix the section shows', () => {
    const { section } = loaded();
    const user = JSON.stringify({ sandbox: { paths: { allow: ['/allowed'] } } });
    const sandbox = createSandbox(compose(user, undefined).sandbox);
    expect(sandbox.pathsEnabled).toBe(true);
    expect(sandbox.allowPath('/allowed/x')).toBe(true);
    expect(sandbox.allowPath('/allowed-extra')).toBe(false);
    expect(section).toContain('`/allowed` covers `/allowed/x` and never `/allowed-extra`');
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
    expect((thrown as Error).message.endsWith(suffix)).toBe(true);
    expect(section).toContain(suffix);
  });
});
