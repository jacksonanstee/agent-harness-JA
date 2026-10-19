import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { main, parseArgs } from '../cli.js';
import { parseSkillsArgs, runSkillsLint } from './skills-command.js';
import { runInit } from './init-command.js';
import { USAGE } from './shared.js';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skills-cmd-'));
  made.push(dir);
  return dir;
}

function skill(name: string, body = '# Body\n'): string {
  return `---\nname: ${name}\ndescription: A skill called ${name}.\nversion: 1.0.0\n---\n${body}`;
}

function run(dir: string): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runSkillsLint({ command: 'skills-lint', dir }, { stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
  return { code, out: out.join(''), err: err.join('') };
}

describe('parseSkillsArgs', () => {
  it('parses `skills lint <dir>`', () => {
    expect(parseSkillsArgs(['lint', 'skills'])).toEqual({ ok: true, value: { command: 'skills-lint', dir: 'skills' } });
  });

  it('is reachable through parseArgs', () => {
    expect(parseArgs(['skills', 'lint', 'd'])).toEqual({ ok: true, value: { command: 'skills-lint', dir: 'd' } });
  });

  it.each([
    [[], "Unknown skills subcommand ''"],
    [['nope', 'd'], "Unknown skills subcommand 'nope'"],
    [['lint'], 'skills lint requires a directory'],
    [['lint', 'a', 'b'], "Unexpected argument 'b'"],
    [['lint', '--fix'], "Unexpected argument '--fix'"],
  ])('rejects %j', (argv, message) => {
    const result = parseSkillsArgs(argv);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain(message);
    expect(result.error).toContain(USAGE);
  });

  it('documents the subcommand in USAGE', () => {
    expect(USAGE).toContain('agent-harness-ja skills lint <dir>');
  });
});

describe('runSkillsLint', () => {
  it('exit 0 and a summary line for a clean pack', () => {
    const root = tmp();
    writeFileSync(join(root, 'a.md'), skill('alpha'));
    const result = run(root);
    expect(result).toEqual({ code: 0, out: 'skills lint: 1 skill checked, no findings\n', err: '' });
  });

  it('exit 1 with one quoted line per finding and a count', () => {
    const root = tmp();
    writeFileSync(join(root, 'a.md'), skill('same', 'See [x](gone.md).\n'));
    writeFileSync(join(root, 'b.md'), skill('same'));
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    expect(result.out.split('\n')).toEqual([
      '"a.md": duplicate-name: duplicate skill name \'same\'; also defined in b.md',
      '"a.md": dangling-reference: relative reference "gone.md" does not resolve to a file inside the skills directory',
      '"b.md": duplicate-name: duplicate skill name \'same\'; also defined in a.md',
      'skills lint: 3 findings in 2 files',
      '',
    ]);
  });

  it('keeps a hostile file name on one line: control characters are escaped, not obeyed', () => {
    const root = tmp();
    writeFileSync(join(root, 'evil\nFORGED.md'), '---\nname: Bad\ndescription: x\nversion: 1.0.0\n---\nb\n');
    const result = run(root);
    expect(result.code).toBe(1);
    const lines = result.out.split('\n');
    expect(lines.filter((l) => l.startsWith('"'))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('FORGED'))).toBe(false);
    expect(lines[0]).toContain('schema');
  });

  it('strips invisible characters from a file name so two look-alike names stay distinguishable', () => {
    const root = tmp();
    writeFileSync(join(root, 'a\u200Bb.md'), 'no frontmatter\n');
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.out).not.toContain('\u200B');
    expect(result.out.startsWith('"ab.md": ')).toBe(true);
  });

  it('exit 2 on a missing directory, naming it on stderr', () => {
    const result = run(join(tmp(), 'nope'));
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/^skills lint: cannot read /);
  });

  it('exit 2 on a symlinked root, as `run` refuses it', () => {
    const real = tmp();
    writeFileSync(join(real, 'a.md'), skill('alpha'));
    const link = join(tmp(), 'skills');
    symlinkSync(real, link);
    const result = run(link);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/refusing to lint skills: .*is a symlink/);
  });

  it('exits through main(): 2 for a usage error, 0 for a clean pack, 1 for findings', async () => {
    const clean = tmp();
    writeFileSync(join(clean, 'a.md'), skill('alpha'));
    const dirty = tmp();
    writeFileSync(join(dirty, 'a.md'), 'no frontmatter\n');
    const write = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await main(['skills', 'lint'])).toBe(2);
      expect(await main(['skills', 'lint', clean])).toBe(0);
      expect(await main(['skills', 'lint', dirty])).toBe(1);
    } finally {
      process.stdout.write = write;
      process.stderr.write = errWrite;
    }
  });
});

describe('shipped scaffolds lint clean', () => {
  it('the `init` scaffold skills directory has no findings', () => {
    const target = join(tmp(), 'proj');
    mkdirSync(target);
    const code = runInit({ command: 'init', dir: target }, { stdout: () => undefined, stderr: () => undefined }, {
      env: {},
      cliPath: undefined,
    });
    expect(code).toBe(0);
    const result = run(join(target, 'skills'));
    expect(result.out).toBe('skills lint: 1 skill checked, no findings\n');
    expect(result.code).toBe(0);
  });
});
