import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { buildProtectedRoots, CODE_EXECUTION_DENY_REASON, mergeLayers, mergeSandboxLayers, parsePermissionSettings, parseSandboxSettings, SELF_PROTECTION_REASON } from '../security/index.js';
import { DEFAULT_ROUTING_TABLE, TASK_SENSITIVITIES, TASK_SHAPES } from '../router/index.js';
import { TELEMETRY_EVENT_TYPES } from '../telemetry/index.js';

import { apiKeyMissingMessage, loadSdkQuery, parseSafeInt, readPackageVersion, registerSecurityHooks, sanitizeDiagnostic, sanitizeForTerminal, SDK_PACKAGE, USAGE, writeScorecard } from './shared.js';

/** The router table's model ids, deduplicated in first-appearance order: the
 *  same derivation the `--judge-model` usage list must use (issue #96, U-6). */
const TABLE_MODEL_IDS = [...new Set(DEFAULT_ROUTING_TABLE.map((rule) => rule.model))];

describe('USAGE', () => {
  /**
   * Asserts the RENDERED substring rather than looping `toContain(type)` over
   * the array. The loop form is a floorless subset check: an empty
   * TELEMETRY_EVENT_TYPES runs the body zero times and passes vacuously. The
   * rendered form cannot — an empty array joins to `''` and the expected
   * substring becomes `--type <>`, which USAGE does not contain. It is also
   * strictly stronger: a partial enumeration or a reordering fails too.
   *
   * ANCHORED TO THE `telemetry export` LINE, not to USAGE as a whole. Against
   * the whole blob the assertion is position-independent: interpolating onto
   * the `run` line while reverting this one to the literal `<t>` advertises
   * `--type` on a command that does not take it, leaves the command that DOES
   * need it undiscoverable, and still passes (Task 6 review finding).
   *
   * What it CANNOT prove is that USAGE derives the list rather than
   * hand-copying it — no test can, since both produce the same bytes. What it
   * does buy is the drift catch: add a fifth event type and a hand-copied
   * USAGE goes RED here.
   */
  it('enumerates every valid --type value on the telemetry line, from the same source of truth the validator uses', () => {
    const telemetryLine = USAGE.split('\n').find((line) => line.includes('telemetry export'));
    expect(telemetryLine).toBeDefined();
    expect(telemetryLine).toContain(`--type <${TELEMETRY_EVENT_TYPES.join('|')}>`);
  });

  /**
   * Same pattern and same rationale as the --type pin above, anchored to the
   * `run` line: the rendered join catches an empty, partial, or reordered
   * enumeration, and anchoring to the one line that takes the flags keeps a
   * cross-line interpolation from passing (issue #88).
   */
  it('enumerates every valid --shape and --sensitivity value on the run line, from the arrays route() enforces', () => {
    const runLine = USAGE.split('\n').find((line) => line.includes(' run '));
    expect(runLine).toBeDefined();
    expect(runLine).toContain(`--shape <${TASK_SHAPES.join('|')}>`);
    expect(runLine).toContain(`--sensitivity <${TASK_SENSITIVITIES.join('|')}>`);
    expect(runLine).toContain('--expected-tokens <n>');
  });

  // The eval line is a hand-written literal (no array to derive from), so this
  // is a literal-substring pin and nothing more (issue #95).
  it('names --max-tasks on the eval line (literal pin; the eval line is not derived)', () => {
    const evalLine = USAGE.split('\n').find((line) => line.includes(' eval '));
    expect(evalLine).toBeDefined();
    expect(evalLine).toContain('[--max-tasks <n>]');
  });

  // Issue #96 PR-A, pins 21 and 32: the redteam line gains the judge arm's
  // three flags, and the `--judge-model` list is RENDERED from the router
  // table the same way --shape/--type are (an empty or reordered table fails
  // here; a hand-copied list goes red the day the table changes).
  it('the redteam line names --judge, --holdout and a --judge-model list derived from the router table', () => {
    const redteamLine = USAGE.split('\n').find((line) => line.includes(' redteam '));
    expect(redteamLine).toBeDefined();
    expect(TABLE_MODEL_IDS.length).toBeGreaterThan(1);
    expect(redteamLine).toBe(
      `       agent-harness-ja redteam [--out <dir>] [--update-baseline] [--baseline <path>] [--judge] [--judge-model <${TABLE_MODEL_IDS.join('|')}>] [--holdout <path>] [--samples <n>]`,
    );
  });
});

describe('writeScorecard filename prefix (issue #96 pin 31)', () => {
  const dirs: string[] = [];
  const freshDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'write-scorecard-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });
  const NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
  const card = { rows: [] as { id: string }[] };

  it("default: 'scorecard-<stamp>.json' (the existing name, unchanged)", () => {
    const out = freshDir();
    const written = writeScorecard(card, out, NOW_MS);
    expect(written).toEqual({ ok: true, path: join(out, 'scorecard-2026-01-02T03-04-05Z.json') });
    expect(readdirSync(out)).toEqual(['scorecard-2026-01-02T03-04-05Z.json']);
  });

  it("with the prefix 'judge-scorecard': 'judge-scorecard-<stamp>.json', so two writes in one second cannot collide", () => {
    const out = freshDir();
    const heuristic = writeScorecard(card, out, NOW_MS);
    const judge = writeScorecard(card, out, NOW_MS, 'judge-scorecard');
    expect(heuristic).toEqual({ ok: true, path: join(out, 'scorecard-2026-01-02T03-04-05Z.json') });
    expect(judge).toEqual({ ok: true, path: join(out, 'judge-scorecard-2026-01-02T03-04-05Z.json') });
    expect(readdirSync(out).sort()).toEqual(['judge-scorecard-2026-01-02T03-04-05Z.json', 'scorecard-2026-01-02T03-04-05Z.json']);
  });
});

describe('writeScorecard never follows or replaces what is already at the name (issue #150)', () => {
  const NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
  const NAME = 'scorecard-2026-01-02T03-04-05Z.json';
  const card = { rows: [] as { id: string }[] };
  const dirs: string[] = [];
  const freshDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'write-scorecard-150-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a symlink planted at the exact name: ok false naming the path, target unchanged', () => {
    const out = freshDir();
    const target = join(freshDir(), 'victim.txt');
    writeFileSync(target, 'keep me');
    symlinkSync(target, join(out, NAME));
    const written = writeScorecard(card, out, NOW_MS);
    expect(written).toEqual({ ok: false, message: expect.stringContaining(join(out, NAME)) });
    expect(readFileSync(target, 'utf8')).toBe('keep me');
  });

  it('a dangling symlink at the name is refused too, and its target is not created', () => {
    const out = freshDir();
    const target = join(freshDir(), 'not-yet.txt');
    symlinkSync(target, join(out, NAME));
    expect(writeScorecard(card, out, NOW_MS).ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it('a regular file already at the name (a same-second re-run) is kept, and the new card lands on the next free suffix', () => {
    const out = freshDir();
    writeFileSync(join(out, NAME), 'first run');
    const written = writeScorecard(card, out, NOW_MS);
    expect(written).toEqual({ ok: true, path: join(out, 'scorecard-2026-01-02T03-04-05Z-1.json') });
    expect(readFileSync(join(out, NAME), 'utf8')).toBe('first run');
    expect(JSON.parse(readFileSync(join(out, 'scorecard-2026-01-02T03-04-05Z-1.json'), 'utf8'))).toEqual(card);
  });

  it('a symlink at a suffixed name is refused, not followed, even after a regular file took the base name', () => {
    const out = freshDir();
    const target = join(freshDir(), 'victim.txt');
    writeFileSync(target, 'keep me');
    writeFileSync(join(out, NAME), 'first run');
    symlinkSync(target, join(out, 'scorecard-2026-01-02T03-04-05Z-1.json'));
    const written = writeScorecard(card, out, NOW_MS);
    expect(written).toEqual({ ok: false, message: expect.stringContaining('scorecard-2026-01-02T03-04-05Z-1.json') });
    expect(readFileSync(target, 'utf8')).toBe('keep me');
  });

  it('every suffix taken: ok false, nothing overwritten', () => {
    const out = freshDir();
    writeFileSync(join(out, NAME), 'base');
    for (let k = 1; k <= 9; k += 1) writeFileSync(join(out, `scorecard-2026-01-02T03-04-05Z-${k}.json`), `run ${k}`);
    const written = writeScorecard(card, out, NOW_MS);
    expect(written).toEqual({ ok: false, message: expect.stringContaining('refusing to overwrite') });
    expect(readFileSync(join(out, NAME), 'utf8')).toBe('base');
    expect(readdirSync(out)).toHaveLength(10);
  });

  it('the refusal message does not echo the symlink target or its contents', () => {
    const out = freshDir();
    const target = join(freshDir(), 'secret.txt');
    writeFileSync(target, 'SECRET-CONTENT');
    symlinkSync(target, join(out, NAME));
    const written = writeScorecard(card, out, NOW_MS);
    expect(written.ok).toBe(false);
    if (!written.ok) {
      expect(written.message).not.toContain('SECRET-CONTENT');
      expect(written.message).not.toContain(target);
    }
  });

  it('a non-Error thrown value still maps to a message, never escapes (review LOW)', () => {
    const written = writeScorecard({ get rows(): never { throw null; } } as unknown as typeof card, freshDir(), NOW_MS);
    expect(written).toEqual({ ok: false, message: 'null' });
  });
});

describe('readPackageVersion', () => {
  it('pins to the version in the repo package.json (catches ../package.json depth mistakes)', () => {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version: string };
    expect(readPackageVersion()).toBe(parsed.version);
  });
});

// Architecture lens A-3: the key refusal and the SDK load-and-guard had a copy
// in each of cli.ts, eval-command.ts and redteam-command.ts, and only the
// redteam text was pinned. One helper each; every caller's text pinned here.
describe('apiKeyMissingMessage (architecture lens A-3)', () => {
  const tail =
    'Export it, then re-run:\n' +
    '  export ANTHROPIC_API_KEY=sk-ant-...\n\n' +
    'Get a key at https://console.anthropic.com/settings/keys\n';

  it('the run path: no reason clause', () => {
    expect(apiKeyMissingMessage()).toBe(`ANTHROPIC_API_KEY is not set.\n\n${tail}`);
  });

  it('eval and redteam --judge: the reason in parentheses before the full stop', () => {
    expect(apiKeyMissingMessage('required for eval')).toBe(`ANTHROPIC_API_KEY is not set (required for eval).\n\n${tail}`);
    expect(apiKeyMissingMessage('required for --judge; the red-team gate itself runs without it')).toBe(
      `ANTHROPIC_API_KEY is not set (required for --judge; the red-team gate itself runs without it).\n\n${tail}`,
    );
  });
});

describe('loadSdkQuery (architecture lens A-3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the one SDK package', () => {
    expect(SDK_PACKAGE).toBe('@anthropic-ai/claude-agent-sdk');
  });

  it('returns the module query() and writes nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const query = vi.fn();
    await expect(loadSdkQuery(() => Promise.resolve({ query }))).resolves.toBe(query);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('a module without query() is reported on stderr and read as null', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(loadSdkQuery(() => Promise.resolve({ query: 'not a function' }))).resolves.toBeNull();
    expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toEqual([
      'The installed @anthropic-ai/claude-agent-sdk does not export query(); check the SDK version.\n',
    ]);
  });

  it('an import rejection propagates: each caller keeps its own policy for it', async () => {
    await expect(loadSdkQuery(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});

describe('sanitizeDiagnostic vs sanitizeForTerminal: the pinned split (#127)', () => {
  // Stdout prose (model text, reports) keeps legitimate ZWJ/ZWNJ/VS16/LRM; only
  // diagnostics that echo operator- or repo-named strings drop them.
  const PROSE = 'fam\u{1F468}\u200D\u{1F469} mi\u200Ckhaham heart\u2764\uFE0F rtl\u200Eend';

  it('sanitizeForTerminal keeps ZWJ, ZWNJ, VS16 and LRM (onText-style content)', () => {
    expect(sanitizeForTerminal(PROSE)).toBe(PROSE);
  });

  it('sanitizeDiagnostic strips the whole Default_Ignorable_Code_Point class and every bidi control', () => {
    expect(sanitizeDiagnostic(PROSE)).toBe('fam\u{1F468}\u{1F469} mikhaham heart\u2764 rtl end');
  });

  it('still does everything sanitizeForTerminal does (ESC, CR; keeps LF and TAB)', () => {
    expect(sanitizeDiagnostic('a\u001b[31mb\rc\nd\te')).toBe('a [31mb c\nd\te');
  });

  it('turns bidi controls into a space and deletes the other ignorables, so a path stays readable', () => {
    expect(sanitizeDiagnostic('a\u202eb\u200bc')).toBe('a bc');
  });

  it('covers every code point of the two properties (a property class, not a list)', () => {
    const bad = /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/u;
    const survivors: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (bad.test(ch) && bad.test(sanitizeDiagnostic(`a${ch}b`))) survivors.push(cp.toString(16));
    }
    expect(survivors).toEqual([]);
  });
});

describe('sanitizeDiagnostic surrogate handling (#127 review LOW-1)', () => {
  it('does not rebuild a tag character from a lone surrogate pair split by a ZWSP', () => {
    const out = sanitizeDiagnostic('\uDB40\u200B\uDC01');
    expect(out).toBe('\uFFFD\uFFFD');
    expect(out.includes('\u{E0001}')).toBe(false);
  });

  it('keeps a valid emoji', () => {
    expect(sanitizeDiagnostic('x\u{1F600}y')).toBe('x\u{1F600}y');
  });
});

describe('parseSafeInt (issue #128)', () => {
  it('parses digit strings up to Number.MAX_SAFE_INTEGER, zero and padding included', () => {
    expect(parseSafeInt('0')).toBe(0);
    expect(parseSafeInt('1')).toBe(1);
    expect(parseSafeInt('007')).toBe(7);
    expect(parseSafeInt('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns undefined for anything that is not a plain safe digit string', () => {
    for (const bad of ['', '-1', '+1', '4.5', '5abc', 'abc', ' 5', '5 ', '1e3', '0x10', '9007199254740992', '99999999999999999999']) {
      expect(parseSafeInt(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('registerSecurityHooks (#140, ADR-0040 D3; the one registration site for run and eval)', () => {
  const bashRule = (decision: 'allow' | 'deny') => ({ permissions: { rules: [{ tool: 'Bash', match: 'git *', decision }] } });
  const compose = (user: unknown, ungrantable: string[], sandbox: unknown = {}) => ({
    permissions: mergeLayers(parsePermissionSettings(user), parsePermissionSettings({})),
    grantPolicy: { ungrantableTools: new Set(ungrantable) },
    sandbox: mergeSandboxLayers(parseSandboxSettings(sandbox), parseSandboxSettings({})),
  });
  const payload = { event: 'pre-tool' as const, tool: 'Bash', args: { command: 'git status' }, redactions: null };
  // #188: a real roots set over a throwaway home and project.
  const spHome = mkdtempSync(join(tmpdir(), 'rsh-home-'));
  const spProject = mkdtempSync(join(tmpdir(), 'rsh-proj-'));
  const roots = buildProtectedRoots({ userDir: spHome, projectDir: spProject, skillsDir: null, dbPath: ':memory:' });

  it('registers permissionHook then sandboxHook: when both would deny, the permission reason is the one reported', async () => {
    const hooks = createHookRuntime();
    registerSecurityHooks(hooks, compose(bashRule('deny'), [], { sandbox: { commands: { allow: ['ls'] } } }), roots);
    const result = await hooks.fire('pre-tool', payload);
    expect(result.denied).toBe(true);
    if (!result.denied) throw new Error('unreachable');
    expect(result.reason).toBe('permission: deny Bash [rule 0, user]');
  });

  it('registers exactly four pre-tool handlers (self-protection, code-execution deny, permissions, sandbox; #188, #211)', async () => {
    const hooks = createHookRuntime();
    registerSecurityHooks(hooks, compose({}, []), roots);
    const result = await hooks.fire('pre-tool', payload);
    expect(result.denied).toBe(false);
    expect(result.handlersFired).toBe(4);
  });

  // #211: no rule or sandbox list can grant REPL, whose own CLI floor is allow.
  it('a user allow-everything rule with both sandbox lists cannot let REPL run; the built-in reason is reported', async () => {
    const hooks = createHookRuntime();
    const allowAll = { permissions: { rules: [{ tool: '*', decision: 'allow' }] } };
    registerSecurityHooks(hooks, compose(allowAll, [], { sandbox: { paths: { allow: ['/'] }, commands: { allow: ['node'] } } }), roots);
    const result = await hooks.fire('pre-tool', { event: 'pre-tool', tool: 'REPL', args: { code: '1' }, redactions: null });
    expect(result.denied).toBe(true);
    if (!result.denied) throw new Error('unreachable');
    expect(result.reason).toBe(CODE_EXECUTION_DENY_REASON);
  });

  // #188 D5: first, so no rule, grant or absent sandbox can let a policy write through.
  it.each([
    ['Write', { file_path: join(spHome, '.harness', 'settings.json') }],
    ['Bash', { command: 'echo {} > ~/.harness/settings.json' }],
  ])('a user allow-everything rule cannot grant a %s to the harness policy; the self-protection reason is reported', async (tool, args) => {
    const hooks = createHookRuntime();
    registerSecurityHooks(hooks, compose({ permissions: { rules: [{ tool: '*', decision: 'allow' }] } }, []), roots);
    const result = await hooks.fire('pre-tool', { event: 'pre-tool', tool, args, redactions: null });
    expect(result.denied).toBe(true);
    if (!result.denied) throw new Error('unreachable');
    expect(result.reason).toBe(SELF_PROTECTION_REASON);
  });

  it('passes grantPolicy through: the same allow grants with an empty policy and does not when Bash is ungrantable', async () => {
    const open = createHookRuntime();
    registerSecurityHooks(open, compose(bashRule('allow'), []), roots);
    const granted = await open.fire('pre-tool', payload);
    expect(granted.denied).toBe(false);
    expect(granted.denied === false && granted.granted).toBe(true);

    const closed = createHookRuntime();
    registerSecurityHooks(closed, compose(bashRule('allow'), ['Bash']), roots);
    const withheld = await closed.fire('pre-tool', payload);
    expect(withheld.denied).toBe(false);
    expect(withheld.denied === false && withheld.granted).toBe(false);
  });
});
