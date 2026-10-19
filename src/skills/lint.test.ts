import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_SKILL_PROMPT_CHARS } from '../internal/limits.js';
import { SKILL_NONCE_BYTES, skillSection } from '../internal/skill-section.js';
import { lintSkills, SkillsLintRootError } from './lint.js';
import type { LintFinding } from './lint.js';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  made.push(dir);
  return dir;
}

function skill(name: string, body = '# Body\n', extra = ''): string {
  return `---\nname: ${name}\ndescription: A skill called ${name}.\nversion: 1.0.0\n${extra}---\n${body}`;
}

/** Writes `files` (relative path -> content) under a fresh temp pack. */
function pack(files: Record<string, string>): string {
  const root = tmp('lint-pack');
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function rules(findings: readonly LintFinding[]): string[] {
  return findings.map((f) => `${f.file}|${f.rule}`);
}

describe('skills lint: clean pack (GOOD)', () => {
  it('reports no findings for a valid pack with a resolving reference', () => {
    const root = pack({
      'a.md': skill('alpha', 'See [b](./b.md) and [site](https://example.com/x) and [top](#top).\n'),
      'b.md': skill('beta'),
    });
    const report = lintSkills(root);
    expect(report.findings).toEqual([]);
    expect(report.skillsChecked).toBe(2);
  });
});

describe('skills lint: loader errors are reused', () => {
  it('reports a schema error with the loader message and field', () => {
    const root = pack({ 'bad.md': '---\nname: Bad Name\ndescription: x\nversion: 1.0.0\n---\nbody\n' });
    const { findings } = lintSkills(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'bad.md', rule: 'schema', field: '/name' });
    expect(findings[0]?.message).toContain('must match pattern');
  });

  it('reports a parse error for a non-YAML fence', () => {
    const root = pack({ 'js.md': '---js\n1\n---\nbody\n' });
    const { findings } = lintSkills(root);
    expect(findings).toEqual([
      expect.objectContaining({
        file: 'js.md',
        rule: 'parse',
        message: 'frontmatter must be YAML; non-YAML fence language is refused',
      }),
    ]);
  });
});

describe('skills lint: duplicate-name', () => {
  it('GOOD: distinct names are clean', () => {
    const root = pack({ 'a.md': skill('one'), 'sub/b.md': skill('two') });
    expect(lintSkills(root).findings).toEqual([]);
  });

  it('BAD: flags every file sharing a name and names the others', () => {
    const root = pack({ 'a.md': skill('same'), 'sub/b.md': skill('same'), 'c.md': skill('other') });
    const { findings } = lintSkills(root);
    expect(rules(findings)).toEqual(['a.md|duplicate-name', 'sub/b.md|duplicate-name']);
    expect(findings[0]?.message).toBe("duplicate skill name 'same'; also defined in sub/b.md");
    expect(findings[1]?.message).toBe("duplicate skill name 'same'; also defined in a.md");
  });
});

/** Body length that makes a skill() section cost exactly `cost` against the budget (section + 2). */
function bodyForCost(name: string, cost: number): string {
  const probe = skillSection({ name, description: `A skill called ${name}.`, body: '' }, '0'.repeat(SKILL_NONCE_BYTES * 2));
  // section = header + '\n\n' + body, so cost = header + 2 + body + 2.
  return 'x'.repeat(cost - probe.section.length - 4);
}

describe('skills lint: body-size (run boundary: section.length + 2 > budget)', () => {
  it('GOOD: a skill whose section plus separator is exactly the budget is not flagged', () => {
    const root = pack({ 'big.md': skill('big', bodyForCost('big', MAX_SKILL_PROMPT_CHARS)) });
    expect(lintSkills(root).findings).toEqual([]);
  });

  it('BAD: one character more is flagged, with the section cost in the message', () => {
    const root = pack({ 'big.md': skill('big', bodyForCost('big', MAX_SKILL_PROMPT_CHARS + 1)) });
    const { findings } = lintSkills(root);
    expect(rules(findings)).toEqual(['big.md|body-size']);
    expect(findings[0]?.message).toBe(
      `skill section is ${MAX_SKILL_PROMPT_CHARS + 1} characters including its 2-character separator; more than the ${MAX_SKILL_PROMPT_CHARS}-character skill prompt budget, so a run always drops this skill`,
    );
  });

  it('BAD: a body of exactly the budget in characters is flagged (the header and separator push it over)', () => {
    const root = pack({ 'big.md': skill('big', 'x'.repeat(MAX_SKILL_PROMPT_CHARS)) });
    expect(rules(lintSkills(root).findings)).toEqual(['big.md|body-size']);
  });
});

describe('skills lint: aggregate-budget', () => {
  it('GOOD: skills that together exactly fill the budget are clean', () => {
    const half = MAX_SKILL_PROMPT_CHARS / 2;
    const root = pack({
      'a.md': skill('alpha', bodyForCost('alpha', half)),
      'b.md': skill('beta', bodyForCost('beta', half)),
    });
    expect(lintSkills(root).findings).toEqual([]);
  });

  it('BAD: a skill that overflows the running total is flagged, and a later smaller one still fits', () => {
    const root = pack({
      'a.md': skill('alpha', bodyForCost('alpha', 150_000)),
      'b.md': skill('beta', bodyForCost('beta', 150_000)),
      'c.md': skill('gamma', 'tiny\n'),
    });
    const { findings } = lintSkills(root);
    expect(rules(findings)).toEqual(['b.md|aggregate-budget']);
    expect(findings[0]?.message).toBe(
      `skill section is 150000 characters including its 2-character separator; only ${MAX_SKILL_PROMPT_CHARS - 150_000} of the ${MAX_SKILL_PROMPT_CHARS}-character skill prompt budget are left after the earlier skills in load order, so a run drops this skill`,
    );
  });
});

describe('skills lint: dangling-reference', () => {
  it('GOOD: resolving links, fragments, queries, URLs, mailto and absolute paths pass', () => {
    const root = pack({
      'a.md': skill(
        'alpha',
        [
          '[ok](notes/n.md) [frag](notes/n.md#sec) [q](notes/n.md?x=1) [ref][r]',
          '[web](http://x.test/a) [mail](mailto:a@b.test) [abs](/etc/hosts) [dot](#a)',
          '',
          '[r]: notes/n.md "title"',
          '',
        ].join('\n'),
      ),
      'notes/n.md': skill('notes-n'),
    });
    expect(lintSkills(root).findings).toEqual([]);
  });

  it('GOOD: links inside code fences and inline code are ignored', () => {
    const body = ['```', '[x](missing.md)', '```', '', 'and `[y](also-missing.md)` inline', ''].join('\n');
    const root = pack({ 'a.md': skill('alpha', body) });
    expect(lintSkills(root).findings).toEqual([]);
  });

  it('BAD: an inline link to a missing sibling is flagged with the reference', () => {
    const root = pack({ 'a.md': skill('alpha', 'See [gone](./gone.md).\n') });
    const { findings } = lintSkills(root);
    expect(rules(findings)).toEqual(['a.md|dangling-reference']);
    expect(findings[0]?.message).toBe('relative reference "./gone.md" does not resolve to a file inside the skills directory');
  });

  it('BAD: a reference-style definition to a missing file is flagged', () => {
    const root = pack({ 'a.md': skill('alpha', 'See [x][r].\n\n[r]: missing/file.txt\n') });
    expect(rules(lintSkills(root).findings)).toEqual(['a.md|dangling-reference']);
  });

  it('BAD: a reference that climbs out of the skills directory is flagged even if the target exists', () => {
    const outer = tmp('lint-outer');
    writeFileSync(join(outer, 'secret.txt'), 'x');
    const root = join(outer, 'pack');
    mkdirSync(root);
    writeFileSync(join(root, 'a.md'), skill('alpha', 'See [s](../secret.txt).\n'));
    expect(rules(lintSkills(root).findings)).toEqual(['a.md|dangling-reference']);
  });

  it('BAD: a reference to a directory is flagged (must be a file)', () => {
    const root = pack({ 'a.md': skill('alpha', 'See [d](sub).\n'), 'sub/b.md': skill('beta') });
    expect(rules(lintSkills(root).findings)).toEqual(['a.md|dangling-reference']);
  });

  it('BAD: an in-root symlink whose target escapes the root is flagged', () => {
    const outer = tmp('lint-outer');
    writeFileSync(join(outer, 'secret.txt'), 'x');
    const root = join(outer, 'pack');
    mkdirSync(root);
    writeFileSync(join(root, 'a.md'), skill('alpha', 'See [s](link.txt).\n'));
    symlinkSync(join(outer, 'secret.txt'), join(root, 'link.txt'));
    // The loader's own containment walk also reports the symlink itself.
    expect(rules(lintSkills(root).findings)).toEqual(['link.txt|read', 'a.md|dangling-reference']);
  });

  it('resolves relative to the referencing file, not the root', () => {
    const root = pack({
      'sub/a.md': skill('alpha', 'See [s](sib.md) and [up](../top.md).\n'),
      'sub/sib.md': skill('sib'),
      'top.md': skill('top'),
    });
    expect(lintSkills(root).findings).toEqual([]);
  });

  it('percent-decodes a reference and tolerates malformed escapes', () => {
    const root = pack({
      'a.md': skill('alpha', 'See [s](with%20space.md) and [bad](100%.md).\n'),
      'with space.md': skill('spaced'),
    });
    expect(rules(lintSkills(root).findings)).toEqual(['a.md|dangling-reference']);
  });
});

describe('skills lint: root handling (#114 parity with run)', () => {
  it('refuses a symlinked root, as the run wiring does', () => {
    const real = pack({ 'a.md': skill('alpha') });
    const holder = tmp('lint-link');
    const link = join(holder, 'skills');
    symlinkSync(real, link);
    expect(() => lintSkills(link)).toThrow(SkillsLintRootError);
    expect(() => lintSkills(link)).toThrow(/is a symlink/);
  });

  it('throws SkillsLintRootError for a missing directory and for a file', () => {
    const root = pack({ 'a.md': skill('alpha') });
    expect(() => lintSkills(join(root, 'nope'))).toThrow(SkillsLintRootError);
    expect(() => lintSkills(join(root, 'a.md'))).toThrow(/not a directory/);
  });

  it('reports a symlinked entry escaping the root through the loader containment', () => {
    const outer = tmp('lint-outer');
    writeFileSync(join(outer, 'x.md'), skill('escaped'));
    const root = join(outer, 'pack');
    mkdirSync(root);
    symlinkSync(join(outer, 'x.md'), join(root, 'x.md'));
    const { findings } = lintSkills(root);
    expect(findings).toEqual([
      expect.objectContaining({ file: 'x.md', rule: 'read', message: 'refusing to load: resolves outside the skills directory' }),
    ]);
  });

  it('rejects an empty dir argument', () => {
    expect(() => lintSkills('')).toThrow(TypeError);
  });
});

describe('skills lint: shipped content lints clean', () => {
  it('examples/repo-qa/skills has no findings', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const report = lintSkills(join(here, '..', '..', 'examples', 'repo-qa', 'skills'));
    expect(report.findings).toEqual([]);
    expect(report.skillsChecked).toBeGreaterThan(0);
  });
});
