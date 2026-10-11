import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../cli.js';
import type { SdkMessage } from '../session/index.js';

// Issue #127. Every stderr diagnostic that echoes an operator- or repo-named
// path must drop bidi controls and default-ignorable code points. The hostile
// name carries ESC, RLO, LRI, PDI, ZWSP and LRM; the visible part must survive.
const HOSTILE = 'dir\u001b[31m\u202e\u2066\u2069\u200b\u200ex';
const FORBIDDEN = /[\u001b\u202e\u2066\u2069\u200b\u200e]/u;

const RESULT: SdkMessage = {
  type: 'result',
  subtype: 'success',
  result: 'ok',
  session_id: 'sdk-1',
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const bases: string[] = [];
const extraCleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of bases.splice(0)) {
    try { chmodSync(join(dir, HOSTILE), 0o700); } catch { /* absent or not chmodded */ }
    rmSync(dir, { recursive: true, force: true });
  }
  for (const path of extraCleanup.splice(0)) rmSync(path, { force: true });
});

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'diag-sinks-'));
  bases.push(base);
  return base;
}

interface Captured {
  stderr: () => string;
}

function capture(base: string): Captured {
  const err: string[] = [];
  vi.spyOn(process, 'cwd').mockReturnValue(base);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  return { stderr: () => err.join('') };
}

function expectCleanButReadable(stderr: string): void {
  expect(stderr).not.toMatch(FORBIDDEN);
  expect(stderr).toContain('dir ');
  expect(stderr).toContain('[31m');
  expect(stderr).toMatch(/\[31m[^]*x/u);
}

async function evalWith(base: string, args: string[]): Promise<{ code: number; stderr: string }> {
  const cap = capture(base);
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'unused';
  try {
    const code = await main(['eval', ...args], {
      userDir: join(base, 'home'),
      importSdk: async () => ({
        query: () =>
          (async function* () {
            yield RESULT;
          })(),
      }),
    });
    return { code, stderr: cap.stderr() };
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  }
}

describe('eval stderr sinks strip bidi and default-ignorables from a hostile task directory name (#127)', () => {
  it('zero task files', async () => {
    const base = makeBase();
    mkdirSync(join(base, HOSTILE));
    const { code, stderr } = await evalWith(base, [HOSTILE]);
    expect(code).toBe(2);
    expect(stderr).toContain('no *.task.md files found in');
    expectCleanButReadable(stderr);
  });

  it('not a directory', async () => {
    const base = makeBase();
    writeFileSync(join(base, HOSTILE), 'x');
    const { code, stderr } = await evalWith(base, [HOSTILE]);
    expect(code).toBe(2);
    expect(stderr).toContain('not a directory');
    expectCleanButReadable(stderr);
  });

  it.skipIf(process.getuid?.() === 0)('cannot read task directory', async () => {
    const base = makeBase();
    mkdirSync(join(base, HOSTILE));
    chmodSync(join(base, HOSTILE), 0o000);
    const { code, stderr } = await evalWith(base, [HOSTILE]);
    expect(code).toBe(2);
    expect(stderr).toContain('cannot read task directory');
    expectCleanButReadable(stderr);
  });

  it('more tasks than the limit', async () => {
    const base = makeBase();
    mkdirSync(join(base, HOSTILE));
    writeFileSync(join(base, HOSTILE, 'a.task.md'), 'x');
    writeFileSync(join(base, HOSTILE, 'b.task.md'), 'x');
    const { code, stderr } = await evalWith(base, [HOSTILE, '--max-tasks', '1']);
    expect(code).toBe(2);
    expect(stderr).toContain('found 2 tasks in');
    expectCleanButReadable(stderr);
  });

  it('discovered N tasks progress line, and the scorecard-written line', async () => {
    const base = makeBase();
    mkdirSync(join(base, HOSTILE));
    writeFileSync(
      join(base, HOSTILE, 'a.task.md'),
      '---\nid: a\ndescriptor:\n  shape: lookup\n  sensitivity: low\n  expected_tokens: 200\nmaxTurns: 1\n---\nsay pong\n',
    );
    const { stderr } = await evalWith(base, [HOSTILE]);
    const written = /scorecard written to (.+)\n/u.exec(stderr);
    if (written?.[1] !== undefined) extraCleanup.push(written[1]);
    expect(stderr).toContain('discovered 1 task in');
    expectCleanButReadable(stderr);
  });
});

describe('run stderr sinks strip bidi and default-ignorables from a hostile skills directory name (#127)', () => {
  it('refusing to load skills (symlinked skills directory)', async () => {
    const base = makeBase();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(base, HOSTILE), 'dir');
    const cap = capture(base);
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'unused';
    try {
      expect(await main(['run', '--skills-dir', join(base, HOSTILE), 'hello'], { userDir: join(base, 'home') })).toBe(2);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
    expect(cap.stderr()).toContain('symlink');
    expectCleanButReadable(cap.stderr());
  });
});

describe('redteam stderr sinks strip bidi and default-ignorables from a hostile baseline path (#127)', () => {
  it('baseline parent directory does not exist', async () => {
    const base = makeBase();
    const cap = capture(base);
    const code = await main(['redteam', '--update-baseline', '--baseline', join(base, HOSTILE, 'baseline.json')]);
    expect(code).toBe(2);
    expect(cap.stderr()).toContain('does not exist');
    expectCleanButReadable(cap.stderr());
  });
});
