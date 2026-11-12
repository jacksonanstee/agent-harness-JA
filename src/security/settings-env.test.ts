import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanSettingsEnv, SETTINGS_ENV_REFUSED_REASON, settingsEnvFiles, SettingsEnvRefused } from './settings-env.js';
import type { SettingsEnvFile } from './settings-env.js';

const KEY = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS';
const FORCED = [KEY];
const tmp = (): string => mkdtempSync(join(tmpdir(), 'senv-'));
const file = (dir: string, name: string, text: string): SettingsEnvFile => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return { source: 'user', path };
};
const scanText = (text: string) => scanSettingsEnv([file(tmp(), 'settings.json', text)], FORCED);

describe('settingsEnvFiles (#250): every settings file whose env block the bundled CLI applies, for the chosen sources', () => {
  const base = { cwd: '/work/repo', homeDir: '/home/u', env: {}, managedDir: '/managed' };
  const paths = (files: readonly SettingsEnvFile[], source: string) => files.filter((f) => f.source === source).map((f) => f.path);

  it('with no sources: the managed file and the global config files, nothing else', () => {
    const files = settingsEnvFiles({ ...base, settingSources: [] });
    expect([...new Set(files.map((f) => f.source))].sort()).toEqual(['global', 'managed']);
    expect(paths(files, 'managed')).toEqual(['/managed/managed-settings.json']);
    expect(paths(files, 'global')).toEqual([
      '/home/u/.claude/.config.json',
      '/home/u/.claude.json',
      '/home/u/.claude-custom-oauth.json',
      '/home/u/.claude-local-oauth.json',
      '/home/u/.claude-staging-oauth.json',
    ]);
  });

  it('CLAUDE_CONFIG_DIR moves the global and the user files; an empty value is unset', () => {
    const moved = settingsEnvFiles({ ...base, env: { CLAUDE_CONFIG_DIR: '/cfg' }, settingSources: ['user'] });
    expect(paths(moved, 'global').slice(0, 2)).toEqual(['/cfg/.config.json', '/cfg/.claude.json']);
    expect(paths(moved, 'user')).toEqual(['/cfg/settings.json', '/cfg/cowork_settings.json']);
    const unset = settingsEnvFiles({ ...base, env: { CLAUDE_CONFIG_DIR: '' }, settingSources: ['user'] });
    expect(paths(unset, 'user')).toEqual(['/home/u/.claude/settings.json', '/home/u/.claude/cowork_settings.json']);
  });

  it('each source adds only its own files', () => {
    expect(paths(settingsEnvFiles({ ...base, settingSources: ['project'] }), 'project')).toContain('/work/repo/.claude/settings.json');
    expect(paths(settingsEnvFiles({ ...base, settingSources: ['project'] }), 'local')).toEqual([]);
    expect(paths(settingsEnvFiles({ ...base, settingSources: ['local'] }), 'local')).toContain('/work/repo/.claude/settings.local.json');
    expect(paths(settingsEnvFiles({ ...base, settingSources: ['local'] }), 'project')).toEqual([]);
    expect(paths(settingsEnvFiles({ ...base, settingSources: ['local'] }), 'user')).toEqual([]);
  });

  it('project and local files are listed from cwd up to the git root, and for a worktree its main checkout', () => {
    const root = tmp();
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    const files = settingsEnvFiles({ ...base, cwd: join(root, 'a', 'b'), settingSources: ['project', 'local'] });
    expect(paths(files, 'project')).toEqual([join(root, 'a', 'b', '.claude', 'settings.json'), join(root, 'a', '.claude', 'settings.json'), join(root, '.claude', 'settings.json')]);
    expect(paths(files, 'local')).toEqual([join(root, 'a', 'b', '.claude', 'settings.local.json'), join(root, 'a', '.claude', 'settings.local.json'), join(root, '.claude', 'settings.local.json')]);
  });

  it('lists every entry of the managed drop-in directory, sorted', () => {
    const managed = tmp();
    mkdirSync(join(managed, 'managed-settings.d'));
    writeFileSync(join(managed, 'managed-settings.d', 'b.json'), '{}');
    writeFileSync(join(managed, 'managed-settings.d', 'a.json'), '{}');
    const files = settingsEnvFiles({ ...base, managedDir: managed, settingSources: [] });
    expect(paths(files, 'managed')).toEqual([
      join(managed, 'managed-settings.json'),
      join(managed, 'managed-settings.d', 'a.json'),
      join(managed, 'managed-settings.d', 'b.json'),
    ]);
  });
});

describe('scanSettingsEnv (#250): a settings file that names a forced variable in its env block is refused', () => {
  it('skips a missing file and a missing directory', () => {
    expect(scanSettingsEnv([{ source: 'user', path: join(tmp(), 'nope.json') }, { source: 'user', path: join(tmp(), 'no', 'dir', 'x.json') }], FORCED)).toEqual([]);
  });

  // Any value: the CLI applies the block over the child's environment, so "" and "0" undo the switch and "1" is refused the same way.
  it.each(['', '0', '1', 'false', null, 0, {}, []])('refuses env naming the key with value %j', (value) => {
    const refusals = scanText(JSON.stringify({ env: { [KEY]: value } }));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ source: 'user', reason: 'env' });
  });

  it('matches the key whatever its letter case', () => {
    expect(scanText(JSON.stringify({ env: { [KEY.toLowerCase()]: '' } }))).toHaveLength(1);
  });

  it.each([
    ['no env block', { model: 'x' }],
    ['an env block naming other variables', { env: { PATH: '/bin', CLAUDE_CODE_DISABLE_BACKGROUND: '1' } }],
    ['an env that is not an object', { env: KEY }],
    ['the name outside the env block', { history: [`export ${KEY}=0`], permissions: { env: { [KEY]: '' } } }],
    ['an empty object', {}],
  ])('passes %s', (_label, value) => {
    expect(scanText(JSON.stringify(value))).toEqual([]);
  });

  it('passes an empty file and a file that is not JSON and does not name the key', () => {
    expect(scanText('')).toEqual([]);
    expect(scanText('  \n')).toEqual([]);
    expect(scanText('// a comment\n{ "model": "x", }')).toEqual([]);
  });

  // The CLI's parser is not this one. A file this scan cannot parse is vouched for only when it cannot name the key at all.
  it('refuses a file that is not JSON but names the key, plainly or through a unicode escape', () => {
    expect(scanText(`// c\n{ "env": { "${KEY}": "" }, }`)[0]).toMatchObject({ reason: 'unparsable' });
    expect(scanText(`{ "env": { "\\u0043LAUDE_CODE_DISABLE_BACKGROUND_TASKS": "" }, }`)[0]).toMatchObject({ reason: 'unparsable' });
    expect(scanText(`[ "${KEY.toLowerCase()}" `)[0]).toMatchObject({ reason: 'unparsable' });
  });

  it('refuses JSON that is not an object when it names the key', () => {
    expect(scanText(JSON.stringify([{ env: { [KEY]: '' } }]))[0]).toMatchObject({ reason: 'unparsable' });
    expect(scanText('null')).toEqual([]);
  });

  it('refuses a path it cannot read: a directory, and a file over the size limit', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'settings.json'));
    expect(scanSettingsEnv([{ source: 'project', path: join(dir, 'settings.json') }], FORCED)).toEqual([{ source: 'project', path: join(dir, 'settings.json'), reason: 'unreadable' }]);
    const big = file(tmp(), 'big.json', JSON.stringify({ pad: 'x'.repeat(64) }));
    expect(scanSettingsEnv([big], FORCED, { maxFileBytes: 32 })[0]).toMatchObject({ reason: 'unreadable' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a file it has no permission to read', () => {
    const f = file(tmp(), 'settings.json', JSON.stringify({ env: {} }));
    chmodSync(f.path, 0o000);
    expect(scanSettingsEnv([f], FORCED)[0]).toMatchObject({ reason: 'unreadable' });
  });

  it('follows a symlink, as the CLI does', () => {
    const dir = tmp();
    const target = file(dir, 'real.json', JSON.stringify({ env: { [KEY]: '' } }));
    symlinkSync(target.path, join(dir, 'settings.json'));
    expect(scanSettingsEnv([{ source: 'user', path: join(dir, 'settings.json') }], FORCED)).toHaveLength(1);
  });

  it('checks every forced key and every file, reporting each refused file once', () => {
    const dir = tmp();
    const a = file(dir, 'a.json', JSON.stringify({ env: { A: '', B: '' } }));
    const b = file(dir, 'b.json', JSON.stringify({ env: { B: '' } }));
    const c = file(dir, 'c.json', JSON.stringify({ env: { C: '' } }));
    expect(scanSettingsEnv([a, b, c], ['A', 'B']).map((r) => r.path)).toEqual([a.path, b.path]);
    expect(scanSettingsEnv([a, b, c], [])).toEqual([]);
  });
});

describe('scanSettingsEnv refuses what it cannot read as the CLI would (#250, security re-review)', () => {
  const envJson = JSON.stringify({ env: { [KEY]: '' } });
  const bytesFile = (bytes: Buffer): SettingsEnvFile => {
    const path = join(tmp(), 'settings.json');
    writeFileSync(path, bytes);
    return { source: 'user', path };
  };
  const swap16 = (le: Buffer): Buffer => Buffer.from(le).swap16();
  const utf32le = (text: string): Buffer => Buffer.concat([...text].map((ch) => { const b = Buffer.alloc(4); b.writeUInt32LE(ch.codePointAt(0) ?? 0); return b; }));

  // Real encoded bytes: the CLI decodes such a file and applies its env block, while a UTF-8 read of it never spells the name.
  it.each([
    ['UTF-16LE with a BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(envJson, 'utf16le')])],
    ['UTF-16BE with a BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), swap16(Buffer.from(envJson, 'utf16le'))])],
    ['UTF-16LE with no BOM', Buffer.from(envJson, 'utf16le')],
    ['UTF-32LE with a BOM', Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), utf32le(envJson)])],
    ['UTF-32BE BOM alone', Buffer.from([0x00, 0x00, 0xfe, 0xff])],
    ['UTF-16LE that does not name the key', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"model":"x"}', 'utf16le')])],
    ['a bare UTF-16LE BOM', Buffer.from([0xff, 0xfe])],
    ['a bare UTF-16BE BOM', Buffer.from([0xfe, 0xff])],
    ['UTF-8 with one NUL byte', Buffer.concat([Buffer.from('{"model":"x"}'), Buffer.from([0])])],
  ])('refuses %s as encoding', (_label, bytes) => {
    expect(scanSettingsEnv([bytesFile(bytes)], FORCED)).toEqual([expect.objectContaining({ reason: 'encoding' })]);
  });

  it('the UTF-16LE fixture really is UTF-16 and really names the key once decoded', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(envJson, 'utf16le')]);
    expect(bytes.toString('utf8')).not.toContain(KEY);
    expect(bytes.subarray(2).toString('utf16le')).toBe(envJson);
  });

  it('a UTF-8 BOM is not an encoding refusal: the file is judged on its text', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    expect(scanSettingsEnv([bytesFile(Buffer.concat([bom, Buffer.from('{"model":"x"}')]))], FORCED)).toEqual([]);
    expect(scanSettingsEnv([bytesFile(Buffer.concat([bom, Buffer.from(envJson)]))], FORCED)).toHaveLength(1);
  });

  // mkfifo must exist: where it does not, this test fails rather than skips, so the guard is never silently untested.
  it('refuses a FIFO at a scanned path without blocking on it', () => {
    const fifo = join(tmp(), 'settings.json');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    const refusals = scanSettingsEnv([{ source: 'project', path: fifo }], FORCED);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(refusals).toEqual([{ source: 'project', path: fifo, reason: 'unreadable' }]);
  }, 4000);

  it('refuses a symlink to something that is not a regular file, and a device', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'real-dir'));
    symlinkSync(join(dir, 'real-dir'), join(dir, 'settings.json'));
    expect(scanSettingsEnv([{ source: 'user', path: join(dir, 'settings.json') }], FORCED)[0]).toMatchObject({ reason: 'unreadable' });
    expect(scanSettingsEnv([{ source: 'user', path: '/dev/null' }], FORCED)[0]).toMatchObject({ reason: 'unreadable' });
  });

  it('skips a dangling symlink (the CLI finds no file there)', () => {
    const dir = tmp();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'settings.json'));
    expect(scanSettingsEnv([{ source: 'user', path: join(dir, 'settings.json') }], FORCED)).toEqual([]);
  });

  it('reads a file exactly at the size limit and refuses one byte over', () => {
    const exact = file(tmp(), 'a.json', envJson);
    expect(scanSettingsEnv([exact], FORCED, { maxFileBytes: Buffer.byteLength(envJson) })[0]).toMatchObject({ reason: 'env' });
    expect(scanSettingsEnv([exact], FORCED, { maxFileBytes: Buffer.byteLength(envJson) - 1 })[0]).toMatchObject({ reason: 'unreadable' });
  });
});

describe('SettingsEnvRefused', () => {
  it('carries the refusals and a fixed reason that names the files and no value', () => {
    const error = new SettingsEnvRefused([{ source: 'user', path: '/cfg/settings.json', reason: 'env' }]);
    expect(error.name).toBe('SettingsEnvRefused');
    expect(error.refusals).toHaveLength(1);
    expect(error.message).toBe(`settings env refused: user:/cfg/settings.json (env). ${SETTINGS_ENV_REFUSED_REASON}`);
    expect(SETTINGS_ENV_REFUSED_REASON).toContain('#250');
  });

  it('lists at most eight files and counts the rest; control characters in a path are cleaned', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ source: 'project' as const, path: `/p/${i}\u001b[31m.json`, reason: 'env' as const }));
    const message = new SettingsEnvRefused(many).message;
    expect(message).toContain('; and 2 more');
    expect(message).toContain('/p/7');
    expect(message).not.toContain('/p/8');
    expect(message).not.toContain('\u001b');
  });
});
