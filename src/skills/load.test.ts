import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { load, scanMarkdownFiles, validate } from './load.js';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '__fixtures__');
const valid = (name: string): string => join(FIXTURES, 'valid', name);
const invalid = (name: string): string => join(FIXTURES, 'invalid', name);

function expectError(file: string): { kind: string; field?: string; message: string; file: string } {
  const result = validate(file);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  return result.error;
}

describe('skills: validate — valid files', () => {
  it('round-trips every frontmatter field from a full skill', () => {
    const result = validate(valid('full.md'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const skill = result.value;
    expect(skill.name).toBe('full-skill');
    expect(skill.version).toBe('2.1.3');
    expect(skill.description.length).toBeGreaterThan(0);
    expect(skill.trigger?.keywords).toEqual(['example', 'demo']);
    expect(skill.trigger?.conditions).toEqual([]);
    expect(skill.requires?.tools).toEqual(['Read', 'Bash']);
    expect(skill.metadata?.author).toBe('jackson');
    expect(skill.metadata?.tags).toEqual(['example']);
  });

  it('returns a trimmed markdown body that excludes the frontmatter', () => {
    const result = validate(valid('full.md'));
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.body).toMatch(/^#/);
    expect(result.value.body).not.toContain('---\nname:');
    expect(result.value.body).toBe(result.value.body.trim());
  });

  it('returns an absolute source path', () => {
    const result = validate(valid('minimal.md'));
    if (!result.ok) throw new Error('expected ok');
    expect(isAbsolute(result.value.path)).toBe(true);
    expect(result.value.path.endsWith('minimal.md')).toBe(true);
  });

  it('accepts a minimal skill and leaves optional fields undefined', () => {
    const result = validate(valid('minimal.md'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.name).toBe('minimal-skill');
    expect(result.value.trigger).toBeUndefined();
    expect(result.value.requires).toBeUndefined();
    expect(result.value.metadata).toBeUndefined();
  });
});

describe('skills: validate — invalid files produce structured errors', () => {
  it('missing name → schema error naming /name', () => {
    const error = expectError(invalid('missing-name.md'));
    expect(error.kind).toBe('schema');
    expect(error.field).toBe('/name');
    expect(error.file.endsWith('missing-name.md')).toBe(true);
  });

  it('non-semver version → schema error naming /version', () => {
    const error = expectError(invalid('bad-version.md'));
    expect(error.kind).toBe('schema');
    expect(error.field).toBe('/version');
  });

  it('unknown frontmatter key (typo) → schema error pointing at the typo, not the shadowed field', () => {
    const error = expectError(invalid('unknown-field.md'));
    expect(error.kind).toBe('schema');
    expect(error.field).toBe('/naem');
    expect(error.message).toMatch(/additional propert/i);
  });

  it('unknown key nested in a sub-object → schema error (nested additionalProperties gate)', () => {
    const error = expectError(invalid('nested-unknown-field.md'));
    expect(error.kind).toBe('schema');
    expect(error.field).toBe('/trigger/keywrods');
  });

  it('wrong type for trigger.keywords → schema error naming the nested field', () => {
    const error = expectError(invalid('wrong-type.md'));
    expect(error.kind).toBe('schema');
    expect(error.field).toBe('/trigger/keywords');
  });

  it('broken YAML → parse error', () => {
    const error = expectError(invalid('broken-yaml.md'));
    expect(error.kind).toBe('parse');
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('refuses a `---js` fence without executing its body (RCE guard)', () => {
    (globalThis as Record<string, unknown>).__SKILL_RCE_FIRED = false;
    const error = expectError(invalid('js-engine-rce.md'));
    expect((globalThis as Record<string, unknown>).__SKILL_RCE_FIRED).toBe(false);
    expect(error.kind).toBe('parse');
    expect(error.message).toMatch(/non-YAML|must be YAML/i);
  });

  it('markdown with no frontmatter → schema error naming /name', () => {
    const error = expectError(invalid('no-frontmatter.md'));
    expect(error.kind).toBe('schema');
    expect(error.field).toBe('/name');
  });

  it('nonexistent file → read error', () => {
    const error = expectError(join(FIXTURES, 'does-not-exist.md'));
    expect(error.kind).toBe('read');
  });

  it('throws TypeError on empty or non-string file argument (programmer error)', () => {
    expect(() => validate('')).toThrow(TypeError);
    expect(() => validate(42 as unknown as string)).toThrow(TypeError);
  });
});

describe('skills: load', () => {
  it('recursively loads all valid skills, ignores non-md files, sorted by path', () => {
    const result = load(join(FIXTURES, 'valid'));
    expect(result.errors).toEqual([]);
    expect(result.skills.map((s) => s.name)).toEqual([
      'full-skill',
      'minimal-skill',
      'nested-skill',
    ]);
    const paths = result.skills.map((s) => s.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths.some((p) => p.includes(join('nested', 'deep')))).toBe(true);
  });

  it('collects one structured error per invalid file, loads nothing', () => {
    const result = load(join(FIXTURES, 'invalid'));
    expect(result.skills).toEqual([]);
    expect(result.errors).toHaveLength(8);
    for (const error of result.errors) {
      expect(isAbsolute(error.file)).toBe(true);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it('partial failure is non-fatal: mixed dir yields the valid skill AND the error', () => {
    const result = load(join(FIXTURES, 'mixed'));
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.name).toBe('good-skill');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.file.endsWith('bad.md')).toBe(true);
    expect(result.errors[0]?.field).toBe('/version');
  });

  it('path that is a file, not a directory → single read error', () => {
    const result = load(valid('minimal.md'));
    expect(result.skills).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe('read');
    expect(result.errors[0]?.message).toMatch(/not a directory/);
  });

  it('missing directory → empty skills plus a single read error', () => {
    const result = load(join(FIXTURES, 'no-such-dir'));
    expect(result.skills).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe('read');
  });

  describe('empty directory', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'skills-empty-'));
    afterAll(() => rmSync(emptyDir, { recursive: true, force: true }));

    it('returns no skills and no errors', () => {
      expect(load(emptyDir)).toEqual({ skills: [], errors: [] });
    });
  });

  it('throws TypeError on empty or non-string dir argument (programmer error)', () => {
    expect(() => load('')).toThrow(TypeError);
    expect(() => load(null as unknown as string)).toThrow(TypeError);
  });

  describe('walk order (issue #9 item 1: pin the intended order, doc-by-test)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-order-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('a directory sorts among its siblings by its own bare name, not by full path', () => {
      // 'sub' (dir) sorts ordinally before 'sub.md' (file) at this level
      // ("sub" < "sub.md"), so the walk descends into sub/ — emitting
      // sub/nested.md — before it reaches the sibling file sub.md. A
      // full-path sort would instead put 'sub.md' first ('.' < '/' beats
      // 'sub.md' against 'sub/nested.md'). This pins the walk's actual,
      // intended order (see the doc comment on `walk` in load.ts); it is
      // documentation-by-test, not a behavior change.
      writeFileSync(
        join(dir, 'sub.md'),
        '---\nname: sub-file\ndescription: fine\nversion: 1.0.0\n---\nok\n',
      );
      mkdirSync(join(dir, 'sub'));
      writeFileSync(
        join(dir, 'sub', 'nested.md'),
        '---\nname: nested-skill\ndescription: fine\nversion: 1.0.0\n---\nok\n',
      );
      const result = load(dir);
      expect(result.errors).toEqual([]);
      expect(result.skills.map((s) => s.name)).toEqual(['nested-skill', 'sub-file']);
    });
  });

  describe('hardening (3-agent review findings)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skills-hardening-'));
    const permRoot = join(tmp, 'permroot');
    const lockedDir = join(permRoot, 'locked');

    afterAll(() => {
      chmodSync(lockedDir, 0o755);
      rmSync(tmp, { recursive: true, force: true });
    });

    it('unreadable subdirectory mid-scan → read error, not a crash', () => {
      mkdirSync(lockedDir, { recursive: true });
      writeFileSync(join(lockedDir, 'inner.md'), '---\nname: x\n---\n');
      chmodSync(lockedDir, 0o000);
      const result = load(permRoot);
      expect(result.skills).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.kind).toBe('read');
    });

    it('symlinked directory escaping the skills root → files refused, not loaded', () => {
      const outside = join(tmp, 'outside');
      const skillsDir = join(tmp, 'pack');
      mkdirSync(outside, { recursive: true });
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(outside, 'secret.md'),
        '---\nname: secret-skill\ndescription: exfiltrated\nversion: 1.0.0\n---\nSECRET BODY\n',
      );
      writeFileSync(
        join(skillsDir, 'legit.md'),
        '---\nname: legit-skill\ndescription: fine\nversion: 1.0.0\n---\nok\n',
      );
      symlinkSync(outside, join(skillsDir, 'evil'), 'dir');
      const result = load(skillsDir);
      expect(result.skills.map((s) => s.name)).toEqual(['legit-skill']);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toMatch(/outside the skills directory/);
      expect(JSON.stringify(result.skills)).not.toContain('SECRET BODY');
    });

    it('symlink resolving to the skills root itself → refused (boundary of the containment check)', () => {
      const skillsDir = join(tmp, 'self-pack');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, 'ok.md'),
        '---\nname: ok-skill\ndescription: fine\nversion: 1.0.0\n---\nok\n',
      );
      symlinkSync(skillsDir, join(skillsDir, 'self'), 'dir');
      const result = load(skillsDir);
      expect(result.skills.map((s) => s.name)).toEqual(['ok-skill']);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toMatch(/outside the skills directory/);
    });

    it('symlink cycle inside the skills root → terminates, loads each skill once', () => {
      const skillsDir = join(tmp, 'cycle-pack');
      const sub = join(skillsDir, 'sub');
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        join(sub, 'one.md'),
        '---\nname: one-skill\ndescription: fine\nversion: 1.0.0\n---\nok\n',
      );
      symlinkSync(sub, join(sub, 'loop'), 'dir');
      const result = load(skillsDir);
      expect(result.skills.map((s) => s.name)).toEqual(['one-skill']);
      expect(result.errors).toEqual([]);
    });

    it('diamond symlinks (issue #9 item 2): two in-root symlinks to the same real directory dedupe once, with a diagnostic', () => {
      const skillsDir = join(tmp, 'diamond-pack');
      // Ordinal sort visits 'aaa-link' first (a symlink — loads the real
      // directory's skill), then 'mmm-real' (the literal directory itself —
      // already visited, but not reached via a symlink, so it dedupes
      // silently, same as today), then 'zzz-link' (a second symlink to the
      // same real directory — already visited AND reached via a symlink,
      // so it gets the one non-fatal diagnostic). This differs from the
      // cycle test above, where the revisited real path is an ancestor on
      // the current walk stack (self-loop) and stays silent.
      const real = join(skillsDir, 'mmm-real');
      mkdirSync(real, { recursive: true });
      writeFileSync(
        join(real, 'one.md'),
        '---\nname: diamond-skill\ndescription: fine\nversion: 1.0.0\n---\nok\n',
      );
      symlinkSync(real, join(skillsDir, 'aaa-link'), 'dir');
      symlinkSync(real, join(skillsDir, 'zzz-link'), 'dir');
      const result = load(skillsDir);
      expect(result.skills.map((s) => s.name)).toEqual(['diamond-skill']);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.kind).toBe('read');
      expect(result.errors[0]?.file.endsWith('zzz-link')).toBe(true);
      expect(result.errors[0]?.message).toMatch(/already reachable via a different symlink/);
    });

    it('directory nesting past the depth cap → read error naming the cap, shallow skills still load', () => {
      const skillsDir = join(tmp, 'deep-pack');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, 'shallow.md'),
        '---\nname: shallow-skill\ndescription: fine\nversion: 1.0.0\n---\nok\n',
      );
      // 65 nested levels puts the deepest directory past MAX_SCAN_DEPTH (64).
      const deep = join(skillsDir, ...Array.from({ length: 65 }, (_, i) => `d${i}`));
      mkdirSync(deep, { recursive: true });
      const result = load(skillsDir);
      expect(result.skills.map((s) => s.name)).toEqual(['shallow-skill']);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toMatch(/maximum directory depth of 64/);
    });

    it('file above the size cap → read error naming the cap', () => {
      const big = join(tmp, 'big.md');
      writeFileSync(big, `---\nname: big\n---\n${'x'.repeat(1_000_001)}`);
      const result = validate(big);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.kind).toBe('read');
      expect(result.error.message).toMatch(/exceeds 1000000 bytes/);
    });

    it('handles a near-cap file of dashes in linear time (no ReDoS in fence guard)', () => {
      const dashes = join(tmp, 'dashes.md');
      writeFileSync(dashes, '-'.repeat(999_999));
      const start = process.hrtime.bigint();
      const result = validate(dashes);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      expect(result.ok).toBe(false);
      // Was ~14 min with the `---+` regex; linear regex resolves in single-digit ms.
      expect(elapsedMs).toBeLessThan(1000);
    });

    it('strips ANSI/control bytes from attacker-influenced error messages', () => {
      const hostile = join(tmp, 'hostile.md');
      writeFileSync(hostile, '---\nname: "\u001b[31mSPOOFED\u001b[0m unclosed\n---\nbody\n');
      const result = validate(hostile);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.kind).toBe('parse');
      expect(result.error.message).not.toContain('\u001b');
      expect(result.error.message).not.toContain('\n');
    });
  });

  describe('partial-EACCES success (issue #9 item 3)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skills-partial-'));
    const locked = join(tmp, 'locked');

    afterAll(() => {
      chmodSync(locked, 0o755);
      rmSync(tmp, { recursive: true, force: true });
    });

    it('an unreadable subdirectory does not block skills outside it from loading', () => {
      writeFileSync(
        join(tmp, 'readable.md'),
        '---\nname: readable-skill\ndescription: fine\nversion: 1.0.0\n---\nok\n',
      );
      mkdirSync(locked, { recursive: true });
      writeFileSync(
        join(locked, 'inner.md'),
        '---\nname: hidden-skill\ndescription: fine\nversion: 1.0.0\n---\nok\n',
      );
      chmodSync(locked, 0o000);
      expect(() => load(tmp)).not.toThrow();
      const result = load(tmp);
      expect(result.skills.map((s) => s.name)).toEqual(['readable-skill']);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.kind).toBe('read');
      expect(result.errors[0]?.file.endsWith('locked')).toBe(true);
    });
  });

  describe('entry-count cap (issue #9 item 4)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skills-entry-cap-'));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    it('stops the walk once more than the cap has been visited, keeping the entries already found (one diagnostic)', () => {
      for (let i = 0; i < 10; i += 1) {
        writeFileSync(
          join(tmp, `skill-${i}.md`),
          `---\nname: skill-${i}\ndescription: fine\nversion: 1.0.0\n---\nok\n`,
        );
      }
      // Exercise the cap via the injected limit (default MAX_SCAN_ENTRIES is
      // 10_000 in production) rather than generating a 10_001-entry tree.
      const { files, errors } = scanMarkdownFiles(tmp, realpathSync(tmp), 5);
      expect(files).toHaveLength(5);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.kind).toBe('read');
      expect(errors[0]?.message).toMatch(/maximum entry count of 5/);
    });

    it('does not throw and still returns whatever was found before the cap, via load()', () => {
      expect(() => load(tmp)).not.toThrow();
    });
  });
});
