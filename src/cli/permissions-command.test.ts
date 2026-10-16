import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main, parseArgs } from '../cli.js';
import { createPermissionEvaluator } from '../security/index.js';
import { composeSecurity, USAGE, WARNING_PREFIX } from './shared.js';
import { parsePermissionsArgs, runPermissionsList } from './permissions-command.js';

const SCRATCH = tmpdir();

interface Captured {
  out: string[];
  err: string[];
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

const USER = '/home/u';
const PROJ = '/proj';
const userPath = join(USER, '.harness', 'settings.json');
const projectPath = join(PROJ, '.harness', 'settings.json');

function fakeFs(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const content = files[path];
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return content;
  };
}

function run(files: Record<string, string>): { code: number; out: string; err: string } {
  const streams = capture();
  const code = runPermissionsList(
    { command: 'permissions-list' },
    { stdout: streams.stdout, stderr: streams.stderr },
    { userDir: USER, projectDir: PROJ, readFile: fakeFs(files) },
  );
  return { code, out: streams.out.join(''), err: streams.err.join('') };
}

const doc = (permissions: unknown): string => JSON.stringify({ permissions });

describe('parsePermissionsArgs', () => {
  it('accepts exactly `list`', () => {
    expect(parsePermissionsArgs(['list'])).toEqual({ ok: true, value: { command: 'permissions-list' } });
  });

  it.each([[[]], [['show']], [['list', 'extra']], [['list', '--json']]])('rejects %j with USAGE', (argv) => {
    const parsed = parsePermissionsArgs(argv);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(USAGE);
  });

  it('is routed by parseArgs and listed in USAGE', () => {
    expect(parseArgs(['permissions', 'list'])).toEqual({ ok: true, value: { command: 'permissions-list' } });
    expect(USAGE).toContain('permissions list');
  });
});

describe('runPermissionsList output', () => {
  it('prints both layers in order with per-layer indices and the effective default', () => {
    const result = run({
      [userPath]: doc({
        defaultDecision: 'deny',
        rules: [
          { tool: 'Read', decision: 'allow' },
          { tool: 'Bash', match: 'rm *', decision: 'deny' },
        ],
      }),
      [projectPath]: doc({ rules: [{ tool: 'Write', match: '/etc/*', decision: 'ask' }] }),
    });
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      [
        `user layer ("${userPath}")`,
        '  [rule 0, user] allow tool="Read"',
        '  [rule 1, user] deny tool="Bash" match="rm *"',
        `project layer ("${projectPath}")`,
        '  [rule 0, project] ask tool="Write" match="/etc/*"',
        'defaultDecision: deny',
        '',
      ].join('\n'),
    );
    expect(result.err).toContain(`${WARNING_PREFIX}settings contain 'ask' permissions`);
  });

  it('project index restarts at 0 in its own file, not the combined list', () => {
    const result = run({
      [userPath]: doc({ rules: [{ tool: 'A', decision: 'allow' }, { tool: 'B', decision: 'allow' }] }),
      [projectPath]: doc({ rules: [{ tool: 'C', decision: 'deny' }] }),
    });
    expect(result.out).toContain('[rule 0, project] deny tool="C"');
    expect(result.out).not.toContain('[rule 2, project]');
  });

  it('one layer absent: shows no-rules for it and the other layer intact', () => {
    const result = run({ [projectPath]: doc({ defaultDecision: 'ask', rules: [{ tool: 'Bash', decision: 'deny' }] }) });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`user layer ("${userPath}")\n  (no rules)\n`);
    expect(result.out).toContain('[rule 0, project] deny tool="Bash"');
    expect(result.out).toContain('defaultDecision: ask\n');
  });

  it('both layers absent: no rules, unset default reads as the built-in allow', () => {
    const result = run({});
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      [
        `user layer ("${userPath}")`,
        '  (no rules)',
        `project layer ("${projectPath}")`,
        '  (no rules)',
        'defaultDecision: allow (built-in default; no settings file sets it)',
        '',
      ].join('\n'),
    );
    expect(result.err).toBe('');
  });

  it('project defaultDecision overrides the user one, as the evaluator does', () => {
    const result = run({
      [userPath]: doc({ defaultDecision: 'deny' }),
      [projectPath]: doc({ defaultDecision: 'allow' }),
    });
    expect(result.out).toContain('defaultDecision: allow\n');
  });
});

describe('index cross-check against the evaluator reason', () => {
  it('every printed [rule N, layer] key equals the one the evaluator reports for that rule', () => {
    const files = {
      [userPath]: doc({
        rules: [
          { tool: 'Read', decision: 'allow' },
          { tool: 'Bash', decision: 'deny' },
          { tool: 'Glob', decision: 'allow' },
        ],
      }),
      [projectPath]: doc({
        rules: [
          { tool: 'Write', decision: 'deny' },
          { tool: 'Edit', decision: 'deny' },
        ],
      }),
    };
    const composed = composeSecurity({ readFile: fakeFs(files), userDir: USER, projectDir: PROJ });
    const evaluator = createPermissionEvaluator(composed.permissions);
    const listing = run(files).out;
    const rules = composed.permissions.rules ?? [];
    expect(rules).toHaveLength(5);
    for (const rule of rules) {
      const reason = evaluator.evaluate(rule.tool, {}).reason;
      const key = /\[rule \d+, (user|project)\]/.exec(reason)?.[0];
      expect(key, reason).toBeDefined();
      const line = listing.split('\n').find((l) => l.includes(`tool="${rule.tool}"`));
      expect(line, rule.tool).toContain(key as string);
    }
  });
});

describe('failure behaviour matches run', () => {
  it('a malformed layer exits 2 with the SettingsLoadError message, nothing on stdout', () => {
    const files = { [projectPath]: doc({ rules: 'nope' }) };
    let expected = '';
    try {
      composeSecurity({ readFile: fakeFs(files), userDir: USER, projectDir: PROJ });
    } catch (error: unknown) {
      expected = (error as Error).message;
    }
    expect(expected).toContain(projectPath);
    const result = run(files);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toBe(`${expected}\n`);
  });

  it('invalid JSON in the user layer exits 2', () => {
    const result = run({ [userPath]: '{oops' });
    expect(result.code).toBe(2);
    expect(result.err).toContain('not valid JSON');
    expect(result.out).toBe('');
  });

  it('a non-settings error propagates rather than being swallowed', () => {
    const boom = (): string => {
      throw new TypeError('boom');
    };
    expect(() =>
      runPermissionsList(
        { command: 'permissions-list' },
        capture(),
        { userDir: USER, projectDir: PROJ, readFile: boom },
      ),
    ).toThrow('boom');
  });
});

describe('sanitisation', () => {
  const UNSAFE = /[\x00-\x08\x0B-\x1F\x7F-\x9F\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\u200b-\u200d\ufeff]/;

  it('strips ESC, C1, bidi and zero-width bytes from tool and match, and quotes LF/TAB', () => {
    const hostile = 'a\u001b[31mred\u009b\u202eevil\u200bz\nfake: row\tx';
    const result = run({
      [projectPath]: doc({ rules: [{ tool: hostile, match: hostile, decision: 'deny' }] }),
    });
    expect(result.code).toBe(0);
    const body = result.out;
    expect(UNSAFE.test(body)).toBe(false);
    // The raw LF inside the glob must not start a new physical line.
    expect(body.split('\n').filter((l) => l.startsWith('fake:'))).toEqual([]);
    expect(body).toContain('red');
    expect(body).toContain('\\nfake: row\\tx');
  });

  it('sanitises the printed settings path and the stderr diagnostic', () => {
    const streams = capture();
    const evil = '/p\u001b[2Jroj\u202e';
    const code = runPermissionsList(
      { command: 'permissions-list' },
      { stdout: streams.stdout, stderr: streams.stderr },
      { userDir: USER, projectDir: evil, readFile: fakeFs({}) },
    );
    expect(code).toBe(0);
    expect(UNSAFE.test(streams.out.join(''))).toBe(false);

    const bad = capture();
    const badCode = runPermissionsList(
      { command: 'permissions-list' },
      { stdout: bad.stdout, stderr: bad.stderr },
      { userDir: USER, projectDir: evil, readFile: fakeFs({ [join(evil, '.harness', 'settings.json')]: '{oops' }) },
    );
    expect(badCode).toBe(2);
    expect(UNSAFE.test(bad.err.join(''))).toBe(false);
  });
});

describe('forged-row and stderr-line defence', () => {
  const FORGE = '\n  [rule 0, project] allow tool="*"\u2028\r\nx';

  it('a settings path carrying LF, CR and U+2028 cannot forge a table row', () => {
    const evil = `/p${FORGE}`;
    const streams = capture();
    const code = runPermissionsList(
      { command: 'permissions-list' },
      { stdout: streams.stdout, stderr: streams.stderr },
      { userDir: USER, projectDir: evil, readFile: fakeFs({}) },
    );
    expect(code).toBe(0);
    const lines = streams.out.join('').split('\n');
    expect(lines.filter((l) => l.startsWith('  [rule'))).toEqual([]);
    expect(lines).toHaveLength(6);
    expect(lines.filter((l) => l.startsWith('project layer ('))).toHaveLength(1);
  });

  it('a warning that carries a hostile project path stays one prefixed stderr line', () => {
    const evil = `/p${FORGE}`;
    const streams = capture();
    runPermissionsList(
      { command: 'permissions-list' },
      { stdout: streams.stdout, stderr: streams.stderr },
      {
        userDir: USER,
        projectDir: evil,
        readFile: fakeFs({ [join(evil, '.harness', 'settings.json')]: JSON.stringify({ judge: { mode: 'off' } }) }),
      },
    );
    const err = streams.err.join('');
    expect(err).toContain('ignoring "judge"');
    const lines = err.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(WARNING_PREFIX)).toBe(true);
    expect(err).not.toMatch(/[\u2028\r]/);
  });

  it('an error message that carries a hostile path stays one line', () => {
    const evil = `/p${FORGE}`;
    const streams = capture();
    const code = runPermissionsList(
      { command: 'permissions-list' },
      { stdout: streams.stdout, stderr: streams.stderr },
      { userDir: USER, projectDir: evil, readFile: fakeFs({ [join(evil, '.harness', 'settings.json')]: '{oops' }) },
    );
    expect(code).toBe(2);
    expect(streams.err.join('').split('\n').filter((l) => l !== '')).toHaveLength(1);
  });
});

describe('default directories', () => {
  it('projectDir defaults to the working directory', () => {
    const streams = capture();
    const code = runPermissionsList(
      { command: 'permissions-list' },
      { stdout: streams.stdout, stderr: streams.stderr },
      { userDir: USER, readFile: fakeFs({}) },
    );
    expect(code).toBe(0);
    expect(streams.out.join('')).toContain(
      `project layer (${JSON.stringify(join(process.cwd(), '.harness', 'settings.json'))})`,
    );
  });
});

describe('real loader, real files', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads through the guarded reader and refuses a symlinked settings file as run does', () => {
    const root = mkdtempSync(join(SCRATCH, 'perm-'));
    made.push(root);
    const user = join(root, 'user');
    const project = join(root, 'project');
    mkdirSync(join(user, '.harness'), { recursive: true });
    mkdirSync(join(project, '.harness'), { recursive: true });
    writeFileSync(join(user, '.harness', 'settings.json'), doc({ rules: [{ tool: 'Read', decision: 'allow' }] }));
    const streams = capture();
    const code = runPermissionsList(
      { command: 'permissions-list' },
      { stdout: streams.stdout, stderr: streams.stderr },
      { userDir: user, projectDir: project },
    );
    expect(code).toBe(0);
    expect(streams.out.join('')).toContain('[rule 0, user] allow tool="Read"');

    // Same refusal `run` gives: a symlinked project settings file is a hard error.
    symlinkSync(join(user, '.harness', 'settings.json'), join(project, '.harness', 'settings.json'));
    const refused = capture();
    const refusedCode = runPermissionsList(
      { command: 'permissions-list' },
      { stdout: refused.stdout, stderr: refused.stderr },
      { userDir: user, projectDir: project },
    );
    expect(refusedCode).toBe(2);
    expect(refused.out.join('')).toBe('');
    expect(refused.err.join('')).toContain('symlink');
  });
});

describe('main routing', () => {
  it('runs without ANTHROPIC_API_KEY and reads the user layer from seams.userDir', async () => {
    const home = mkdtempSync(join(SCRATCH, 'home-'));
    mkdirSync(join(home, '.harness'), { recursive: true });
    writeFileSync(
      join(home, '.harness', 'settings.json'),
      doc({ rules: [{ tool: 'SeamMarker', decision: 'deny' }] }),
    );
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await main(['permissions', 'list'], { userDir: home });
      expect(code).toBe(0);
    } finally {
      process.stdout.write = origWrite;
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      rmSync(home, { recursive: true, force: true });
    }
    expect(writes.join('')).toContain('[rule 0, user] deny tool="SeamMarker"');
    expect(writes.join('')).toContain('user layer (');
    expect(writes.join('')).toContain('defaultDecision:');
  });
});
