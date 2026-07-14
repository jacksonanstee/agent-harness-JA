import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArgs } from '../cli.js';
import { INIT_TARGET_PATHS } from './init-templates.js';
import { parseInitArgs, renderInvocation, runInit } from './init-command.js';
import { USAGE } from './shared.js';

interface CapturedStreams {
  out: string[];
  err: string[];
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function captureStreams(): CapturedStreams {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  };
}

describe('parseInitArgs', () => {
  it('defaults dir to "."', () => {
    const parsed = parseInitArgs([]);
    expect(parsed).toEqual({ ok: true, value: { command: 'init', dir: '.' } });
  });

  it('accepts a single positional dir', () => {
    const parsed = parseInitArgs(['my-agent']);
    expect(parsed).toEqual({ ok: true, value: { command: 'init', dir: 'my-agent' } });
  });

  it('rejects extra positional arguments', () => {
    const parsed = parseInitArgs(['a', 'b']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('Unexpected extra argument');
  });

  it('rejects flags (no flags in v1)', () => {
    const parsed = parseInitArgs(['--force']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Unknown flag '--force'");
  });
});

describe('cli dispatch', () => {
  it('routes init through parseArgs', () => {
    const parsed = parseArgs(['init', 'somewhere']);
    expect(parsed).toEqual({ ok: true, value: { command: 'init', dir: 'somewhere' } });
  });

  it('lists init in USAGE', () => {
    expect(USAGE).toContain('init [dir]');
  });
});

describe('renderInvocation', () => {
  it('renders a node command relative to the target dir when the cli path is a script', () => {
    const cliPath = resolve('/repo/dist/cli.js');
    const target = resolve('/repo/hello');
    expect(renderInvocation(cliPath, target)).toBe(`node ..${sep}dist${sep}cli.js`);
  });

  it('falls back to the bin name when no script path is available', () => {
    expect(renderInvocation(undefined, resolve('/anywhere'))).toBe('agent-harness-ja');
  });

  it('uses the bin name when invoked through the installed bin shim', () => {
    const shim = resolve('/usr/local/lib/node_modules/.bin/agent-harness-ja');
    expect(renderInvocation(shim, resolve('/anywhere'))).toBe('agent-harness-ja');
  });

  it('falls back to an absolute path when the relative climb is long', () => {
    const cliPath = resolve('/repo/dist/cli.js');
    const target = resolve('/a/b/c/d/e/target');
    expect(renderInvocation(cliPath, target)).toBe(`node ${cliPath}`);
  });

  it('keeps the relative form at exactly three climbs (boundary)', () => {
    const cliPath = resolve('/repo/dist/cli.js');
    const target = resolve('/repo/a/b/target');
    expect(renderInvocation(cliPath, target)).toBe(
      `node ..${sep}..${sep}..${sep}dist${sep}cli.js`,
    );
  });

  it('prints the npx form when running from the ephemeral npx cache', () => {
    const cliPath = resolve('/Users/x/.npm/_npx/0123abc/node_modules/agent-harness-ja/dist/cli.js');
    expect(renderInvocation(cliPath, resolve('/anywhere'))).toBe('npx agent-harness-ja');
  });
});

describe('runInit', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'init-cmd-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('scaffolds all target files into a fresh dir and exits 0', () => {
    const target = join(root, 'starter');
    const streams = captureStreams();
    const code = runInit({ command: 'init', dir: target }, streams);
    expect(code).toBe(0);
    for (const rel of INIT_TARGET_PATHS) {
      expect(existsSync(join(target, rel)), `${rel} should exist`).toBe(true);
    }
    expect(streams.err).toEqual([]);
  });

  it('creates nested target dirs recursively', () => {
    const target = join(root, 'a', 'b', 'starter');
    const code = runInit({ command: 'init', dir: target }, captureStreams());
    expect(code).toBe(0);
    expect(existsSync(join(target, 'README.md'))).toBe(true);
  });

  it('prints the created tree, next steps, R-10 pointer, and artefact locations', () => {
    const target = join(root, 'starter');
    const streams = captureStreams();
    // env/cliPath injected so the assertion set is deterministic regardless
    // of the developer's shell (key may be exported) and test runner path.
    runInit({ command: 'init', dir: target }, streams, {
      env: {},
      cliPath: join(root, 'dist', 'cli.js'),
    });
    const output = streams.out.join('');
    for (const rel of INIT_TARGET_PATHS) {
      expect(output).toContain(rel);
    }
    expect(output).toContain('ANTHROPIC_API_KEY');
    expect(output).toContain('https://console.anthropic.com/settings/keys');
    expect(output).toContain('R-10');
    expect(output).toContain('eval .');
    expect(output).toContain('a few cents at most');
    expect(output).toContain('.harness/telemetry.db');
    expect(output).toContain('.harness/eval/');
    // Pre-publish there is no bin on PATH: the printed commands must use the
    // computed invocation, never a bare hardcoded bin name on its own line.
    expect(output).toContain('node ');
  });

  it('branches the key step on whether ANTHROPIC_API_KEY is set', () => {
    const target1 = join(root, 's1');
    const withKey = captureStreams();
    runInit({ command: 'init', dir: target1 }, withKey, {
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    });
    expect(withKey.out.join('')).toContain('already set');

    const target2 = join(root, 's2');
    const withoutKey = captureStreams();
    runInit({ command: 'init', dir: target2 }, withoutKey, { env: {} });
    expect(withoutKey.out.join('')).toContain('export ANTHROPIC_API_KEY=');
  });

  it('refuses on any collision: exit 2, full conflict list, zero writes', () => {
    const target = join(root, 'occupied');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'README.md'), 'existing\n');
    writeFileSync(join(target, '.gitignore'), 'existing\n');
    const streams = captureStreams();
    const code = runInit({ command: 'init', dir: target }, streams);
    expect(code).toBe(2);
    const err = streams.err.join('');
    expect(err).toContain('README.md');
    expect(err).toContain('.gitignore');
    expect(err).toContain('init <new-dir>');
    // Fail-closed means nothing was written, not even non-colliding files.
    expect(existsSync(join(target, '.harness'))).toBe(false);
    expect(existsSync(join(target, 'skills'))).toBe(false);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('existing\n');
  });

  it('refuses when the target dir itself is an existing file', () => {
    const target = join(root, 'a-file');
    writeFileSync(target, 'not a dir\n');
    const streams = captureStreams();
    expect(runInit({ command: 'init', dir: target }, streams)).toBe(2);
    expect(streams.err.join('')).toContain('not a directory');
  });

  it('renders the computed invocation in the collision remedy, not the bare bin name', () => {
    const target = join(root, 'occupied2');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'README.md'), 'existing\n');
    const streams = captureStreams();
    runInit({ command: 'init', dir: target }, streams, {
      cliPath: join(root, 'dist', 'cli.js'),
    });
    expect(streams.err.join('')).toContain('node ');
    expect(streams.err.join('')).toContain('init <new-dir>');
  });

  it('refuses a pre-planted symlinked intermediate dir with zero writes (review PoC)', () => {
    const target = join(root, 'trap');
    const victim = join(root, 'victim');
    mkdirSync(target, { recursive: true });
    mkdirSync(victim, { recursive: true });
    symlinkSync(victim, join(target, '.harness'));
    const streams = captureStreams();
    expect(runInit({ command: 'init', dir: target }, streams)).toBe(2);
    expect(streams.err.join('')).toContain('symlink');
    expect(streams.err.join('')).toContain('.harness');
    expect(existsSync(join(victim, 'settings.json'))).toBe(false);
    expect(existsSync(join(target, 'README.md'))).toBe(false);
  });

  it('refuses a dangling leaf symlink (invisible to existsSync, followed by write)', () => {
    const target = join(root, 'dangling');
    mkdirSync(target, { recursive: true });
    symlinkSync(join(root, 'nowhere', 'redirected.md'), join(target, 'README.md'));
    const streams = captureStreams();
    expect(runInit({ command: 'init', dir: target }, streams)).toBe(2);
    expect(streams.err.join('')).toContain('symlink');
    expect(existsSync(join(root, 'nowhere'))).toBe(false);
  });

  it('refuses a symlinked target dir itself', () => {
    const real = join(root, 'real-target');
    const link = join(root, 'link-target');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const streams = captureStreams();
    expect(runInit({ command: 'init', dir: link }, streams)).toBe(2);
    expect(streams.err.join('')).toContain('symlink');
    expect(existsSync(join(real, 'README.md'))).toBe(false);
  });

  it('strips terminal escapes from an operator-supplied dir name in all output', () => {
    const esc = String.fromCharCode(0x1b);
    // A real ESC byte in the dir name: the filesystem accepts it, a terminal
    // would interpret it. Success and error paths must both strip it.
    const evil = join(root, `evil${esc}[8m${esc}]0;PWNED`);
    const streams = captureStreams();
    expect(runInit({ command: 'init', dir: evil }, streams, { env: {} })).toBe(0);
    expect(streams.out.join('')).not.toContain(esc);

    const streams2 = captureStreams();
    expect(runInit({ command: 'init', dir: evil }, streams2)).toBe(2);
    expect(streams2.err.join('')).not.toContain(esc);
  });
});

describe('scaffolded .gitignore semantics (git check-ignore)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'init-git-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function checkIgnore(cwd: string, path: string): boolean {
    try {
      execFileSync('git', ['check-ignore', '-q', path], { cwd });
      return true;
    } catch {
      return false;
    }
  }

  it('ignores harness artefacts but keeps the committed policy tracked', () => {
    const target = join(root, 'starter');
    runInit({ command: 'init', dir: target }, captureStreams());
    execFileSync('git', ['init', '-q'], { cwd: target });
    writeFileSync(join(target, '.harness', 'telemetry.db'), '');
    mkdirSync(join(target, '.harness', 'eval'), { recursive: true });
    writeFileSync(join(target, '.harness', 'eval', 'scorecard-x.json'), '{}');

    expect(checkIgnore(target, '.harness/telemetry.db')).toBe(true);
    expect(checkIgnore(target, '.harness/eval/scorecard-x.json')).toBe(true);
    expect(checkIgnore(target, '.harness/settings.json')).toBe(false);
  });
});
