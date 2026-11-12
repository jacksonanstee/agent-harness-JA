import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

// Issues #254 and #255. Every place that starts a bundled-CLI child must hand it the forced
// environment on both layers, or be listed here with the reason it does not. The judge and the
// eval adversary passed none until #254: `tools: []` does not stop the CLI running a scheduled
// job or expanding an `@path`. This inventory fails when a call, a reference or an SDK import
// appears, moves or loses its wiring, so a new caller cannot be added without a ruling.
//
// What it is: a text scan, tightened after review (13/11/2026). Comments are stripped; a call is
// any identifier that IS or ENDS IN `query`/`Query`, through any member chain, given at least one
// argument (so `query(args)`, `query(\n{`, `deps?.query(`, `sdk.query<T>(`, `runQuery(` all
// count); a reference is `query` used without a call (`const q = deps.query`, `{ query }`,
// `sdk["query"]`); an SDK mention is the package name in any import. Wiring is checked per CALL,
// in that call's own argument text. It reads src/ (test files aside), scripts/, examples/, eval/
// and the test/ helpers.
// What it is not: a proof. A function reached under a name that never says `query` (a default
// import renamed twice, a value built at run time) passes, and the SDK's own start-up calls are
// outside it. The branded `QueryFn` options type that would make an unwired call a COMPILE error
// is issue #261; until then a reviewer reads every line this test flags.

// The repository root: vitest runs from it, as the SDK parity test assumes too.
const ROOT = process.cwd();
const SOURCE = /\.(?:ts|mts|cts|js|mjs|cjs)$/u;
const SKIPPED = /\.test\.ts$|\.d\.ts$/u;
const DIRS = ['src', 'scripts', 'examples', 'eval', 'test'] as const;

const CALL = /(?<![\w$])((?:[\w$]+\s*\??\.\s*)*[\w$]*[qQ]uery)\s*(?:<[^>()]*>)?\(\s*(?!\))/gu;
// A member access that is not called, a bracket access, or a destructuring that takes `query` out of something.
const REFERENCE = /[\w$\])]\s*\??\.\s*query\b(?!\s*(?:<[^>()]*>)?\()|\[\s*['"`]query['"`]\s*\]|\{[^{}]*\bquery\b[^{}]*\}\s*=(?!=|>)/gu;
const SDK_MENTION = /claude-agent-sdk/gu;
const WIRED_ENV = /\benv: buildChildEnv\(process\.env\)/u;
const WIRED_SETTINGS = /\bsettings: buildChildSettings\(\)/u;

/** Block comments and line comments out (a `//` inside a URL or a string keeps its line). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/gu, '$1');
}

/** The argument text of the call whose `(` ends at `from`: up to the matching `)`. */
function argumentText(text: string, from: number): string {
  let depth = 1;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
    if (depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

interface Found {
  /** callee text -> how many calls. A declaration (`function query(`) is not a call. */
  calls: Record<string, number>;
  /** callee text -> how many of its calls carry both wiring keys in their own arguments. */
  wired: Record<string, number>;
  references: number;
  sdkMentions: number;
}

function scan(text: string): Found {
  const clean = stripComments(text);
  const calls: Record<string, number> = {};
  const wired: Record<string, number> = {};
  for (const match of clean.matchAll(CALL)) {
    const before = clean.slice(Math.max(0, match.index - 12), match.index);
    if (/function\s*\*?\s*$/u.test(before)) continue;
    const callee = (match[1] ?? '').replace(/\s+/gu, '');
    const args = argumentText(clean, match.index + match[0].length);
    calls[callee] = (calls[callee] ?? 0) + 1;
    if (WIRED_ENV.test(args) && WIRED_SETTINGS.test(args)) wired[callee] = (wired[callee] ?? 0) + 1;
  }
  return { calls, wired, references: (clean.match(REFERENCE) ?? []).length, sdkMentions: (clean.match(SDK_MENTION) ?? []).length };
}

/** `wired`: every call of that callee passes env and flag settings. Anything else is the reason it need not. */
type Verdict = 'wired' | string;
interface Site {
  calls?: Record<string, [count: number, verdict: Verdict]>;
  /** Uses of `query` that are not calls, with what they are. */
  references?: [count: number, what: string];
  /** Mentions of the SDK package, with what they are. */
  sdk?: [count: number, what: string];
}

const LOADER = 'loads the SDK and returns its query function; the caller hands it to a wired site';
const TELEMETRY = "the telemetry store's own query method, not the SDK's";
const SQL = 'builds SQL text';
const TEE = "a tee around the arguments the harness itself built: it forwards the env and settings it is given";

const HANDED_ON = 'takes the function out to hand it to a wired site or a tee; it does not call it';
const SDK_LOAD = 'the one place the harness imports the SDK';

const SITES: Readonly<Record<string, Site>> = {
  'src/session/session.ts': { calls: { 'deps.query': [1, 'wired'] } },
  'src/session/judge.ts': { calls: { query: [1, 'wired'] } },
  'src/cli/eval-command.ts': { calls: { query: [1, 'wired'], loadSdkQuery: [1, LOADER] }, references: [1, HANDED_ON] },
  'src/cli.ts': { calls: { 'store.query': [1, TELEMETRY], loadSdkQuery: [1, LOADER] } },
  'src/cli/redteam-judge-arm.ts': { calls: { loadSdkQuery: [1, LOADER] } },
  'src/cli/shared.ts': { references: [2, 'loadSdkQuery itself: checks the export is a function and returns it'], sdk: [1, SDK_LOAD] },
  'src/memory/store.ts': { calls: { buildReadQuery: [1, SQL] } },
  'src/telemetry/store.ts': { calls: { buildQuery: [1, SQL] } },
  'src/telemetry/types.ts': { calls: { query: [1, `${TELEMETRY} (its type signature)`] } },
  'scripts/capture-sdk-hook-fixture.mjs': {
    calls: { 'sdk.query': [3, "a keyed developer tool that records the SDK's own hook payloads with no harness session, by design; its prompts are written in the script"] },
    references: [1, 'checks the export is a function'],
    sdk: [2, 'its own import of the SDK'],
  },
  'scripts/fixture-path-scan.mjs': { sdk: [1, 'names the package in a path it scans; it starts no child'] },
  'scripts/mock-cli-probe.mjs': { calls: { 'sdk.query': [1, TEE] }, references: [1, HANDED_ON], sdk: [1, 'its own import of the SDK, by path'] },
  'scripts/smoke-judge-session.mjs': {
    calls: { realQuery: [1, TEE], teeingQuery: [2, 'builds that tee'], 'store.query': [3, TELEMETRY] },
    references: [4, HANDED_ON],
    sdk: [1, 'its own import of the SDK'],
  },
  'scripts/smoke-rewrite-channel.mjs': {
    calls: { realQuery: [1, TEE], teeingQuery: [1, 'builds that tee'] },
    references: [2, HANDED_ON],
    sdk: [1, 'its own import of the SDK'],
  },
  'test/sdk-guard.setup.ts': { sdk: [3, 'the test guard that refuses a real SDK import'] },
  'test/session-harness.ts': { calls: { 'telemetry.query': [1, TELEMETRY] } },
};

function sourceFiles(): string[] {
  return DIRS.flatMap((dir) => {
    let names: string[];
    try {
      names = readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' });
    } catch {
      return [];
    }
    return names
      .filter((name) => SOURCE.test(name) && !SKIPPED.test(name) && statSync(join(ROOT, dir, name)).isFile())
      .map((name) => [dir, ...name.split(sep)].join('/'));
  });
}

describe('every SDK query call site is wired to the forced child environment, or excluded with a reason (#254, #255)', () => {
  const files = sourceFiles();
  const found = new Map(files.map((file) => [file, scan(readFileSync(join(ROOT, file), 'utf8'))] as const));
  const interesting = [...found].filter(([, f]) => Object.keys(f.calls).length + f.references + f.sdkMentions > 0);

  it('the scan sees the source tree (a scan that finds nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(50);
    for (const file of ['src/session/session.ts', 'scripts/mock-cli-probe.mjs', 'test/session-harness.ts']) expect(files).toContain(file);
    expect(files.some((file) => file.startsWith('examples/'))).toBe(true);
  });

  it('the files that call, reference or import a query are exactly the listed ones', () => {
    expect(interesting.map(([file]) => file).sort()).toEqual(Object.keys(SITES).sort());
  });

  it.each(Object.entries(SITES))('%s: calls, references and SDK mentions are as listed', (file, site) => {
    const f = found.get(file);
    expect(f?.calls).toEqual(Object.fromEntries(Object.entries(site.calls ?? {}).map(([callee, [count]]) => [callee, count])));
    expect(f?.references).toBe(site.references?.[0] ?? 0);
    expect(f?.sdkMentions).toBe(site.sdk?.[0] ?? 0);
  });

  const wiredCallees = Object.entries(SITES).flatMap(([file, site]) =>
    Object.entries(site.calls ?? {}).filter(([, [, verdict]]) => verdict === 'wired').map(([callee, [count]]) => [file, callee, count] as const),
  );

  it('at least the three children are wired (the primary session, the judge, the adversary)', () => {
    expect(wiredCallees.map(([file]) => file).sort()).toEqual(['src/cli/eval-command.ts', 'src/session/judge.ts', 'src/session/session.ts']);
  });

  it.each(wiredCallees)('%s: every %s call passes env and flag settings in its own arguments', (file, callee, count) => {
    expect(found.get(file)?.wired[callee] ?? 0).toBe(count);
  });

  it('the matcher catches the spellings the first version missed', () => {
    const spelt = scan(
      [
        'query(args);',
        'query(\n  {});',
        'deps?.query({});',
        'sdk.query<Out>({});',
        'const q = deps.query; q({});',
        'const { query: run } = sdk;',
        'sdk["query"]({});',
        'runQuery(options);',
        '// query({ commented: true })',
        '/* sdk.query({}) */',
        'function query(filter) {}',
        'query();',
      ].join('\n'),
    );
    expect(spelt.calls).toEqual({ query: 2, 'deps?.query': 1, 'sdk.query': 1, runQuery: 1 });
    // `deps.query;`, `{ query: run }` and `sdk["query"]`; the declaration and the empty call are neither.
    expect(spelt.references).toBe(3);
  });

  it('wiring is judged per call: one wired call does not cover an unwired one in the same file', () => {
    const two = scan('query({ env: buildChildEnv(process.env), settings: buildChildSettings() });\nquery({ prompt });');
    expect(two.calls).toEqual({ query: 2 });
    expect(two.wired).toEqual({ query: 1 });
    // Mutation M18: both layers are required; either one alone is not wired.
    expect(scan('query({ env: buildChildEnv(process.env) });').wired).toEqual({});
    expect(scan('query({ settings: buildChildSettings() });').wired).toEqual({});
  });
});
