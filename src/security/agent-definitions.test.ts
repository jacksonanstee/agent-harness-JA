import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_SCAN_MAX_DEPTH,
  AgentDefinitionRefused,
  BUNDLED_AGENT_NAMES,
  CLI_FRONTMATTER,
  cliFrontmatterBlock,
  agentDefinitionRoots,
  agentFileVerdict,
  managedSettingsDir,
  scanAgentDefinitions,
} from './agent-definitions.js';
import type { AgentRoot } from './agent-definitions.js';

const fm = (body: string): string => `---\nname: helper\ndescription: helps\n${body}---\nYou help.\n`;

describe('agentFileVerdict: the keys that move a subagent out of reach of the harness hooks', () => {
  it('admits a plain definition and reports its name', () => {
    expect(agentFileVerdict(fm('tools: Read, Grep\nmodel: sonnet\n'))).toEqual({ ok: true, name: 'helper' });
  });

  it('admits isolation: worktree (in-process, hooks still fire)', () => {
    expect(agentFileVerdict(fm('isolation: worktree\n'))).toEqual({ ok: true, name: 'helper' });
  });

  it.each([
    ['isolation: remote', 'isolation'],
    ['isolation: local', 'isolation'],
    ['isolation: ""', 'isolation'],
    ['isolation: null', 'isolation'],
    ['permissionMode: acceptEdits', 'permissionMode'],
    ['permissionMode: default', 'permissionMode'],
    ['hooks:\n  PreToolUse: []', 'hooks'],
    ['hooks: null', 'hooks'],
    ['mcpServers:\n  evil:\n    command: node', 'mcpServers'],
    ['mcpServers:\n  - github\n  - evil:\n      command: node', 'mcpServers'],
    ['mcpServers: github', 'mcpServers'],
  ])('refuses %j as %s', (line, key) => {
    expect(agentFileVerdict(fm(`${line}\n`))).toEqual({ ok: false, reason: key });
  });

  it('admits mcpServers as a list of server names (references; the MCP allowlist still gates their tools)', () => {
    expect(agentFileVerdict(fm('mcpServers:\n  - github\n  - linear\n'))).toEqual({ ok: true, name: 'helper' });
  });

  it('refuses a key in flow style', () => {
    expect(agentFileVerdict('---\n{name: helper, isolation: remote}\n---\nbody\n')).toEqual({ ok: false, reason: 'isolation' });
  });

  it('refuses a duplicated key even when the parse keeps the safe value (parsers disagree on which wins)', () => {
    expect(agentFileVerdict(fm('isolation: remote\nisolation: worktree\n'))).toEqual({ ok: false, reason: 'unparsable' });
  });

  it('refuses a key the text shows twice even when the parse sees one safe copy (the other hides in a block scalar)', () => {
    expect(agentFileVerdict(fm('note: |\n  isolation: remote\nisolation: worktree\n'))).toEqual({ ok: false, reason: 'unparsable' });
  });

  it('refuses a key the parse did not see at the top level but the text shows at a line start', () => {
    // A block scalar hides the line from the YAML parse; another parser could read it as a key.
    expect(agentFileVerdict(fm('note: |\n  x\nisolation:remote\n')).ok).toBe(false);
    expect(agentFileVerdict(fm('note: |\n  hooks: {}\n'))).toEqual({ ok: false, reason: 'hooks' });
  });

  it('does not refuse a key name that only appears inside a value', () => {
    expect(agentFileVerdict(fm('description2: "manage hooks: and isolation: notes"\n'))).toEqual({ ok: true, name: 'helper' });
  });

  it('refuses a quoted key', () => {
    expect(agentFileVerdict(fm('"permissionMode": acceptEdits\n'))).toEqual({ ok: false, reason: 'permissionMode' });
  });

  it('refuses a non-YAML fence language without evaluating it', () => {
    expect(agentFileVerdict('---js\n{ isolation: "remote" }\n---\nbody\n')).toEqual({ ok: false, reason: 'unparsable' });
  });

  it('refuses frontmatter that fails to parse', () => {
    expect(agentFileVerdict('---\nname: [unclosed\n---\nbody\n')).toEqual({ ok: false, reason: 'unparsable' });
  });

  it('refuses frontmatter whose top level is not a mapping', () => {
    expect(agentFileVerdict('---\n- isolation\n---\nbody\n')).toEqual({ ok: false, reason: 'unparsable' });
  });

  it('admits a file with no frontmatter and no name (the CLI cannot load it as an agent)', () => {
    expect(agentFileVerdict('just notes\n')).toEqual({ ok: true, name: null });
  });

  it('refuses a dangerous key in a file with no frontmatter fence only if the text has one at a line start', () => {
    expect(agentFileVerdict('isolation: remote\n')).toEqual({ ok: true, name: null });
  });

  it('handles CRLF and a BOM', () => {
    expect(agentFileVerdict('\uFEFF---\r\nname: helper\r\nisolation: remote\r\n---\r\nbody\r\n')).toEqual({ ok: false, reason: 'isolation' });
  });

  describe('the block is the one the CLI reads (dT in Gl, CLI 2.1.312): up to the FIRST `---` anywhere', () => {
    it.each([
      ['text after the closing fence', '---\nname: helper\nisolation: remote\n---body\n', 'isolation'],
      ['a comment after the closing fence', '---\nname: helper\npermissionMode: bypassPermissions\n---#\n', 'permissionMode'],
      ['a CR-only close at end of file', '---\nname: helper\nhooks:\n  PreToolUse: []\n---\r', 'hooks'],
      ['spaces after the opening fence', '---   \nname: helper\nisolation: remote\n---\n', 'isolation'],
    ])('refuses with %s', (_label, raw, reason) => {
      expect(agentFileVerdict(raw)).toEqual({ ok: false, reason });
    });

    it('a block with no second `---` is no frontmatter to the CLI (indexOf("---", 3) < 0), so no agent', () => {
      expect(cliFrontmatterBlock('---\nname: helper\nisolation: remote\n')).toBeNull();
      expect(agentFileVerdict('---\nname: helper\nisolation: remote\n')).toEqual({ ok: true, name: null });
    });

    it('a `---` inside a value ends the block there, as it does for the CLI', () => {
      expect(cliFrontmatterBlock('---\nname: helper\ndescription: a---b\nisolation: remote\n---\n')).toBe('name: helper\ndescription: a');
    });

    it('judges that block only: a key after the early `---` is body to the CLI, so it is not refused', () => {
      // The CLI block is always a prefix of any wider reading, so judging a wider block could only over-refuse.
      expect(agentFileVerdict('---\nname: helper\ndescription: a---b\nisolation: remote\n---\n')).toEqual({ ok: true, name: 'helper' });
    });

    it('matches the regex the CLI uses, character for character', () => {
      expect(CLI_FRONTMATTER.source).toBe('^---\\s*\\n([\\s\\S]*?)---\\s*\\n?');
    });
  });

  it('returns a non-string name as null', () => {
    expect(agentFileVerdict('---\nname: 42\n---\nbody\n')).toEqual({ ok: true, name: null });
  });
});

describe('agentDefinitionRoots: the directories the CLI loads agent files from (0.3.312, read)', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'agent-roots-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const roots = (over: Partial<Parameters<typeof agentDefinitionRoots>[0]>): AgentRoot[] =>
    agentDefinitionRoots({
      settingSources: [],
      cwd: join(base, 'home', 'work', 'repo', 'pkg'),
      homeDir: join(base, 'home'),
      env: {},
      managedDir: join(base, 'managed'),
      ...over,
    });

  it('always includes the managed directory, even with no setting sources', () => {
    expect(roots({})).toEqual([{ source: 'managed', dir: join(base, 'managed', '.claude', 'agents') }]);
  });

  it('adds ~/.claude/agents for user, and CLAUDE_CONFIG_DIR/agents when set', () => {
    expect(roots({ settingSources: ['user'] })[1]).toEqual({ source: 'user', dir: join(base, 'home', '.claude', 'agents') });
    expect(roots({ settingSources: ['user'], env: { CLAUDE_CONFIG_DIR: join(base, 'cfg') } })[1]).toEqual({
      source: 'user',
      dir: join(base, 'cfg', 'agents'),
    });
  });

  it('ignores an empty CLAUDE_CONFIG_DIR', () => {
    expect(roots({ settingSources: ['user'], env: { CLAUDE_CONFIG_DIR: '' } })[1]?.dir).toBe(join(base, 'home', '.claude', 'agents'));
  });

  it('adds nothing for local', () => {
    expect(roots({ settingSources: ['local'] })).toHaveLength(1);
  });

  it('walks project dirs from cwd up to the git root (inclusive)', () => {
    mkdirSync(join(base, 'home', 'work', 'repo', 'pkg'), { recursive: true });
    mkdirSync(join(base, 'home', 'work', 'repo', '.git'));
    expect(roots({ settingSources: ['project'] }).slice(1)).toEqual([
      { source: 'project', dir: join(base, 'home', 'work', 'repo', 'pkg', '.claude', 'agents') },
      { source: 'project', dir: join(base, 'home', 'work', 'repo', '.claude', 'agents') },
    ]);
  });

  it('with no git root, walks up to but not including $HOME', () => {
    mkdirSync(join(base, 'home', 'work', 'repo', 'pkg'), { recursive: true });
    expect(roots({ settingSources: ['project'] }).slice(1).map((r) => r.dir)).toEqual([
      join(base, 'home', 'work', 'repo', 'pkg', '.claude', 'agents'),
      join(base, 'home', 'work', 'repo', '.claude', 'agents'),
      join(base, 'home', 'work', '.claude', 'agents'),
    ]);
  });

  it('outside $HOME with no git root, walks to the filesystem root', () => {
    const r = roots({ settingSources: ['project'], cwd: join(base, 'outside'), homeDir: join(base, 'home') });
    expect(r.at(-1)?.dir).toBe(join('/', '.claude', 'agents'));
  });

  it('in a linked worktree, adds the main checkout (a .git FILE pointing at <main>/.git/worktrees/x)', () => {
    const main = join(base, 'home', 'main');
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const wt = join(base, 'home', 'wt');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    expect(roots({ settingSources: ['project'], cwd: wt }).slice(1).map((r) => r.dir)).toEqual([
      join(wt, '.claude', 'agents'),
      join(main, '.claude', 'agents'),
    ]);
  });

  it('managedSettingsDir follows the CLI per platform', () => {
    expect(managedSettingsDir('darwin')).toBe('/Library/Application Support/ClaudeCode');
    expect(managedSettingsDir('win32')).toBe('C:\\Program Files\\ClaudeCode');
    expect(managedSettingsDir('linux')).toBe('/etc/claude-code');
  });
});

describe('scanAgentDefinitions', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'agent-scan-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const write = (rel: string, text: string): void => {
    const full = join(base, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  };
  const root = (rel = 'agents', source: AgentRoot['source'] = 'project'): AgentRoot => ({ source, dir: join(base, rel) });

  it('skips a missing root', () => {
    expect(scanAgentDefinitions([root('nope')])).toEqual({ admittedNames: new Set(), refusals: [], filesScanned: 0 });
  });

  it('admits clean files by frontmatter name only (the CLI never names a file agent by its stem)', () => {
    write('agents/a.md', fm(''));
    write('agents/orphan.md', 'no frontmatter\n');
    write('agents/nameless.md', '---\ndescription: x\n---\nbody\n');
    const result = scanAgentDefinitions([root()]);
    expect(result.refusals).toEqual([]);
    expect([...result.admittedNames]).toEqual(['helper']);
    expect(result.filesScanned).toBe(3);
  });

  it('refuses a bad file in a nested directory, naming source, root-relative path and key, never the value', () => {
    write('agents/team/x.md', fm('isolation: remote\n'));
    const result = scanAgentDefinitions([root('agents', 'user')]);
    expect(result.refusals).toEqual([{ source: 'user', path: join('team', 'x.md'), reason: 'isolation' }]);
    expect(result.admittedNames.has('helper')).toBe(false);
  });

  it('reads .MD case-insensitively and hidden files, ignores other extensions', () => {
    write('agents/.hidden.MD', fm('hooks: {}\n'));
    write('agents/notes.txt', fm('hooks: {}\n'));
    expect(scanAgentDefinitions([root()]).refusals.map((r) => r.path)).toEqual(['.hidden.MD']);
  });

  it('follows a symlinked file and a symlinked directory, as the CLI does', () => {
    write('elsewhere/evil.md', fm('permissionMode: acceptEdits\n'));
    write('elsewhere2/dir/evil2.md', fm('isolation: remote\n'));
    mkdirSync(join(base, 'agents'));
    symlinkSync(join(base, 'elsewhere', 'evil.md'), join(base, 'agents', 'link.md'));
    symlinkSync(join(base, 'elsewhere2', 'dir'), join(base, 'agents', 'sub'));
    expect(scanAgentDefinitions([root()]).refusals.map((r) => r.reason).sort()).toEqual(['isolation', 'permissionMode']);
  });

  it('follows a symlinked root', () => {
    write('real/x.md', fm('hooks: {}\n'));
    symlinkSync(join(base, 'real'), join(base, 'agents'));
    expect(scanAgentDefinitions([root()]).refusals).toHaveLength(1);
  });

  it('survives a symlink cycle', () => {
    write('agents/x.md', fm(''));
    symlinkSync(join(base, 'agents'), join(base, 'agents', 'loop'));
    const result = scanAgentDefinitions([root()]);
    expect(result.refusals).toEqual([]);
    expect(result.admittedNames.has('helper')).toBe(true);
  });

  it('refuses a dangling symlink as unreadable (fail closed)', () => {
    mkdirSync(join(base, 'agents'));
    symlinkSync(join(base, 'missing.md'), join(base, 'agents', 'gone.md'));
    expect(scanAgentDefinitions([root()]).refusals).toEqual([{ source: 'project', path: 'gone.md', reason: 'unreadable' }]);
  });

  it('refuses a file over the byte limit', () => {
    write('agents/big.md', fm('') + 'x'.repeat(64));
    expect(scanAgentDefinitions([root()], { maxFileBytes: 32 }).refusals).toEqual([{ source: 'project', path: 'big.md', reason: 'limit' }]);
  });

  it('refuses when the file count limit is passed, and reports the count capped at the limit', () => {
    for (let i = 0; i < 4; i += 1) write(`agents/f${i}.md`, fm(''));
    const result = scanAgentDefinitions([root()], { maxFiles: 3 });
    expect(result.refusals.map((r) => r.reason)).toEqual(['limit']);
    expect(result.filesScanned).toBe(3);
  });

  it('exactly the file limit passes', () => {
    for (let i = 0; i < 3; i += 1) write(`agents/f${i}.md`, fm(''));
    expect(scanAgentDefinitions([root()], { maxFiles: 3 }).refusals).toEqual([]);
  });

  it('refuses a tree deeper than the depth limit', () => {
    write(`agents/${'d/'.repeat(AGENT_SCAN_MAX_DEPTH + 1)}x.md`, fm(''));
    expect(scanAgentDefinitions([root()]).refusals.map((r) => r.reason)).toContain('limit');
  });

  it('scans every root (a clean file in one does not hide a bad one in another)', () => {
    write('a/x.md', fm(''));
    write('b/y.md', fm('isolation: remote\n'));
    expect(scanAgentDefinitions([root('a', 'user'), root('b', 'managed')]).refusals).toEqual([
      { source: 'managed', path: 'y.md', reason: 'isolation' },
    ]);
  });

  it('sanitises control and bidi characters in a reported path', () => {
    write('agents/a\u001b[31mb\u202Ec.md', fm('hooks: {}\n'));
    expect(scanAgentDefinitions([root()]).refusals[0]?.path).not.toMatch(/[\u001b\u202E]/);
  });
});

describe('AgentDefinitionRefused', () => {
  it('names each refusal by source, path and key, caps the list, and has a fixed prefix', () => {
    const refusals = Array.from({ length: 12 }, (_, i) => ({ source: 'project' as const, path: `f${i}.md`, reason: 'hooks' as const }));
    const error = new AgentDefinitionRefused(refusals);
    expect(error.name).toBe('AgentDefinitionRefused');
    expect(error.message).toMatch(/^agent definition refused: /);
    expect(error.message).toContain('project:f0.md (hooks)');
    expect(error.message).toContain('and 4 more');
    expect(error.refusals).toHaveLength(12);
  });
});

describe('BUNDLED_AGENT_NAMES', () => {
  it('is the 11 bundled definitions read from the 0.3.312 binary (teammate takes a dynamic name, so it is not here)', () => {
    expect([...BUNDLED_AGENT_NAMES].sort()).toEqual(
      [
        'Explore',
        'Plan',
        'claude',
        'claude-code-guide',
        'comment-thread-analyst',
        'fork',
        'general-purpose',
        'statusline-setup',
        'web-fetch',
        'worker',
        'workflow-subagent',
      ].sort(),
    );
  });
});
