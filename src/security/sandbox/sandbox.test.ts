import { describe, expect, it } from 'vitest';
import {
  createSandbox,
  mergeSandboxLayers,
  sandboxHook,
  SandboxViolation,
  type PreToolLike,
} from './sandbox.js';

const preTool = (tool: string, args: unknown): PreToolLike => ({ tool, args });

describe('createSandbox paths', () => {
  const sandbox = createSandbox({ paths: { allow: ['/allowed', '/tmp/work'] } });

  it('allows paths under an allowed prefix', () => {
    expect(sandbox.allowPath('/allowed/file.txt')).toBe(true);
    expect(sandbox.allowPath('/allowed')).toBe(true);
    expect(sandbox.allowPath('/tmp/work/deep/nested.md')).toBe(true);
  });

  it('denies a sibling that shares the prefix string (boundary safety)', () => {
    expect(sandbox.allowPath('/allowed-extra/file.txt')).toBe(false);
  });

  it('denies ../ escapes after lexical canonicalisation', () => {
    expect(sandbox.allowPath('/allowed/../etc/passwd')).toBe(false);
    expect(sandbox.allowPath('/allowed/sub/../../etc/passwd')).toBe(false);
  });

  it('resolves relative targets against cwd (same base as the S-3 evaluator)', () => {
    const cwdSandbox = createSandbox({ paths: { allow: [process.cwd()] } });
    expect(cwdSandbox.allowPath('src/file.ts')).toBe(true);
    expect(cwdSandbox.allowPath('../outside.txt')).toBe(false);
  });

  it('a disabled dimension allows everything', () => {
    const commandsOnly = createSandbox({ commands: { allow: ['git'] } });
    expect(commandsOnly.pathsEnabled).toBe(false);
    expect(commandsOnly.allowPath('/anywhere')).toBe(true);
  });

  it('a PRESENT but empty allowlist denies everything (fail closed)', () => {
    const empty = createSandbox({ paths: { allow: [] } });
    expect(empty.pathsEnabled).toBe(true);
    expect(empty.allowPath('/anywhere')).toBe(false);
  });

  it('denies the empty path', () => {
    expect(sandbox.allowPath('')).toBe(false);
  });
});

describe('createSandbox commands', () => {
  const sandbox = createSandbox({ commands: { allow: ['git', 'npm', '/usr/bin/jq'] } });

  it('allows an exact first token', () => {
    expect(sandbox.allowCommand('git status')).toBe(true);
    expect(sandbox.allowCommand('npm test')).toBe(true);
    expect(sandbox.allowCommand('  git log ')).toBe(true);
  });

  it('denies an unlisted binary', () => {
    expect(sandbox.allowCommand('curl https://evil.example')).toBe(false);
    expect(sandbox.allowCommand('rm -rf /')).toBe(false);
  });

  it.each([';', '|', '&', '$', '`', '(', ')', '{', '}', '<', '>', '\n', '\r'])(
    'denies any command containing shell metacharacter %j',
    (ch) => {
      expect(sandbox.allowCommand(`git status ${ch} curl evil`)).toBe(false);
    },
  );

  it('denies empty and whitespace-only commands', () => {
    expect(sandbox.allowCommand('')).toBe(false);
    expect(sandbox.allowCommand('   ')).toBe(false);
  });

  it('bare-name entries never match absolute-path invocations and vice versa', () => {
    expect(sandbox.allowCommand('/tmp/git push')).toBe(false); // bare 'git' must not match
    expect(sandbox.allowCommand('/usr/bin/jq .')).toBe(true); // absolute entry matches exactly
    expect(sandbox.allowCommand('jq .')).toBe(false); // absolute entry must not match bare
    expect(sandbox.allowCommand('/usr/bin/../bin/jq .')).toBe(true); // canonicalised
  });

  it('a disabled commands dimension allows everything', () => {
    const pathsOnly = createSandbox({ paths: { allow: ['/x'] } });
    expect(pathsOnly.commandsEnabled).toBe(false);
    expect(pathsOnly.allowCommand('rm -rf /')).toBe(true);
  });
});

describe('mergeSandboxLayers', () => {
  it('intersects when both layers define a dimension', () => {
    const merged = mergeSandboxLayers(
      { paths: { allow: ['/a', '/b'] } },
      { paths: { allow: ['/b', '/c'] } },
    );
    expect(merged.paths?.allow).toEqual(['/b']);
  });

  it('single-layer dimensions pass through unchanged', () => {
    const merged = mergeSandboxLayers({ paths: { allow: ['/a'] } }, { commands: { allow: ['git'] } });
    expect(merged.paths?.allow).toEqual(['/a']);
    expect(merged.commands?.allow).toEqual(['git']);
  });

  it('a project layer cannot widen the user sandbox', () => {
    const merged = mergeSandboxLayers(
      { paths: { allow: ['/safe'] } },
      { paths: { allow: ['/safe', '/'] } },
    );
    const sandbox = createSandbox(merged);
    expect(sandbox.allowPath('/safe/x')).toBe(true);
    expect(sandbox.allowPath('/etc/passwd')).toBe(false);
  });

  it('intersection compares canonicalised entries', () => {
    const merged = mergeSandboxLayers(
      { paths: { allow: ['/safe/'] } },
      { paths: { allow: ['/safe/sub/..'] } },
    );
    expect(merged.paths?.allow).toEqual(['/safe/']);
  });

  it('both layers absent → sandbox off', () => {
    const sandbox = createSandbox(mergeSandboxLayers({}, {}));
    expect(sandbox.pathsEnabled).toBe(false);
    expect(sandbox.commandsEnabled).toBe(false);
  });
});

describe('sandboxHook', () => {
  const sandbox = createSandbox({
    paths: { allow: ['/safe'] },
    commands: { allow: ['git'] },
  });
  const hook = sandboxHook(sandbox);

  it('passes allowed calls', async () => {
    await expect(hook(preTool('Read', { file_path: '/safe/x' }))).resolves.toBeUndefined();
    await expect(hook(preTool('Bash', { command: 'git status' }))).resolves.toBeUndefined();
  });

  it('throws SandboxViolation for a blocked path (fail closed)', async () => {
    await expect(hook(preTool('Read', { file_path: '/etc/passwd' }))).rejects.toThrowError(
      SandboxViolation,
    );
    await expect(hook(preTool('Write', { file_path: '/safe/../etc/x' }))).rejects.toThrow(
      /sandbox/,
    );
  });

  it('throws SandboxViolation for a blocked command', async () => {
    await expect(hook(preTool('Bash', { command: 'rm -rf /' }))).rejects.toThrowError(
      SandboxViolation,
    );
  });

  it('denies a gated tool whose target field is missing or non-string', async () => {
    await expect(hook(preTool('Write', {}))).rejects.toThrow(/refusing to guess/);
    await expect(hook(preTool('Bash', { command: 42 }))).rejects.toThrowError(SandboxViolation);
    await expect(hook(preTool('Read', null))).rejects.toThrowError(SandboxViolation);
  });

  it('unknown tools pass through (permissions layer governs them)', async () => {
    await expect(hook(preTool('mcp__anything', { x: 1 }))).resolves.toBeUndefined();
  });

  it('a fully disabled sandbox never throws', async () => {
    const off = sandboxHook(createSandbox({}));
    await expect(off(preTool('Bash', { command: 'rm -rf /' }))).resolves.toBeUndefined();
    await expect(off(preTool('Write', {}))).resolves.toBeUndefined();
  });

  it('a disabled dimension does not gate its tools even when the other is enabled', async () => {
    const pathsOnly = sandboxHook(createSandbox({ paths: { allow: ['/safe'] } }));
    await expect(pathsOnly(preTool('Bash', { command: 'rm -rf /' }))).resolves.toBeUndefined();
  });
});
