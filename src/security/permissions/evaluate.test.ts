import { describe, expect, it } from 'vitest';
import {
  createPermissionEvaluator,
  matchesGlob,
  PermissionDenied,
  permissionHook,
  type PreToolLike,
} from './evaluate.js';
import type { LayeredRule } from './types.js';

const rule = (partial: Partial<LayeredRule> & Pick<LayeredRule, 'tool' | 'decision'>): LayeredRule => ({
  layer: 'project',
  ...partial,
});

const preTool = (tool: string, args: unknown): PreToolLike => ({ tool, args });

describe('matchesGlob', () => {
  it('matches exact strings', () => {
    expect(matchesGlob('Bash', 'Bash')).toBe(true);
    expect(matchesGlob('Bash', 'bash')).toBe(false);
    expect(matchesGlob('Bash', 'BashX')).toBe(false);
  });

  it('matches trailing-* prefixes', () => {
    expect(matchesGlob('mcp__*', 'mcp__drive__read')).toBe(true);
    expect(matchesGlob('mcp__*', 'mcp__')).toBe(true);
    expect(matchesGlob('mcp__*', 'Bash')).toBe(false);
    expect(matchesGlob('*', 'anything')).toBe(true);
  });

  it('treats mid-string * as a literal, not a wildcard', () => {
    expect(matchesGlob('a*b', 'a*b')).toBe(true);
    expect(matchesGlob('a*b', 'axb')).toBe(false);
  });
});

describe('createPermissionEvaluator', () => {
  it('applies defaultDecision (allow) when no rule matches', () => {
    const evaluator = createPermissionEvaluator();
    const result = evaluator.evaluate('Bash', { command: 'ls' });
    expect(result.decision).toBe('allow');
    expect(result.ruleIndex).toBeNull();
  });

  it('honours an explicit defaultDecision', () => {
    const evaluator = createPermissionEvaluator({ defaultDecision: 'deny' });
    expect(evaluator.evaluate('Read', {}).decision).toBe('deny');
  });

  it('matches a tool-only rule', () => {
    const evaluator = createPermissionEvaluator({
      rules: [rule({ tool: 'Bash', decision: 'deny' })],
    });
    const result = evaluator.evaluate('Bash', { command: 'ls' });
    expect(result.decision).toBe('deny');
    expect(result.ruleIndex).toBe(0);
    expect(result.reason).toContain('Bash');
  });

  it('matches Bash args.command against a match prefix-glob', () => {
    const evaluator = createPermissionEvaluator({
      rules: [rule({ tool: 'Bash', match: 'rm *', decision: 'deny' })],
    });
    expect(evaluator.evaluate('Bash', { command: 'rm -rf /' }).decision).toBe('deny');
    expect(evaluator.evaluate('Bash', { command: 'ls' }).decision).toBe('allow');
  });

  it('matches file tools against args.file_path', () => {
    const evaluator = createPermissionEvaluator({
      rules: [rule({ tool: 'Write', match: '/etc/*', decision: 'deny' })],
    });
    expect(evaluator.evaluate('Write', { file_path: '/etc/passwd' }).decision).toBe('deny');
    expect(evaluator.evaluate('Write', { file_path: '/tmp/x' }).decision).toBe('allow');
  });

  it('a match rule does not fire when args lack the canonical field shape', () => {
    const evaluator = createPermissionEvaluator({
      rules: [rule({ tool: 'Bash', match: 'rm *', decision: 'deny' })],
    });
    // No command string: match target falls back to JSON of args.
    expect(evaluator.evaluate('Bash', {}).decision).toBe('allow');
  });

  it('specificity: match rule beats tool-only rule beats wildcard rule', () => {
    const evaluator = createPermissionEvaluator({
      rules: [
        rule({ tool: '*', decision: 'deny' }),
        rule({ tool: 'Bash', decision: 'ask' }),
        rule({ tool: 'Bash', match: 'npm *', decision: 'allow' }),
      ],
    });
    expect(evaluator.evaluate('Bash', { command: 'npm test' }).decision).toBe('allow');
    expect(evaluator.evaluate('Bash', { command: 'ls' }).decision).toBe('ask');
    expect(evaluator.evaluate('Read', { file_path: '/x' }).decision).toBe('deny');
  });

  it('severity at equal specificity: deny > ask > allow', () => {
    const evaluator = createPermissionEvaluator({
      rules: [
        rule({ tool: 'Bash', decision: 'allow' }),
        rule({ tool: 'Bash', decision: 'deny' }),
        rule({ tool: 'Bash', decision: 'ask' }),
      ],
    });
    expect(evaluator.evaluate('Bash', {}).decision).toBe('deny');
  });

  it('user-layer deny survives project-layer allow (sticky deny)', () => {
    const evaluator = createPermissionEvaluator({
      rules: [
        rule({ tool: 'Bash', decision: 'deny', layer: 'user' }),
        rule({ tool: 'Bash', decision: 'allow', layer: 'project' }),
      ],
    });
    const result = evaluator.evaluate('Bash', {});
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('user');
  });
});

describe('permissionHook', () => {
  const denyBash = createPermissionEvaluator({
    rules: [rule({ tool: 'Bash', decision: 'deny' })],
  });
  const askBash = createPermissionEvaluator({
    rules: [rule({ tool: 'Bash', decision: 'ask' })],
  });

  it('does not throw for allowed tools', async () => {
    const hook = permissionHook(denyBash);
    await expect(hook(preTool('Read', { file_path: '/x' }))).resolves.toBeUndefined();
  });

  it('throws PermissionDenied with a rule-bearing reason on deny', async () => {
    const hook = permissionHook(denyBash);
    await expect(hook(preTool('Bash', { command: 'ls' }))).rejects.toThrowError(PermissionDenied);
    await expect(hook(preTool('Bash', { command: 'ls' }))).rejects.toThrow(/permission/);
  });

  it("fails closed on 'ask' with no prompter", async () => {
    const hook = permissionHook(askBash);
    await expect(hook(preTool('Bash', { command: 'ls' }))).rejects.toThrow(/no prompter/);
  });

  it("resolves 'ask' via the prompter: true allows, false denies", async () => {
    const allowAll = permissionHook(askBash, async () => true);
    await expect(allowAll(preTool('Bash', {}))).resolves.toBeUndefined();

    const denyAll = permissionHook(askBash, async () => false);
    await expect(denyAll(preTool('Bash', {}))).rejects.toThrowError(PermissionDenied);
  });

  it('fails closed when the prompter throws or rejects', async () => {
    const throwing = permissionHook(askBash, () => {
      throw new Error('tty gone');
    });
    await expect(throwing(preTool('Bash', {}))).rejects.toThrowError(PermissionDenied);

    const rejecting = permissionHook(askBash, async () => {
      throw new Error('tty gone');
    });
    await expect(rejecting(preTool('Bash', {}))).rejects.toThrowError(PermissionDenied);
  });
});
