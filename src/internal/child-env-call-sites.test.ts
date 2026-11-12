import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

// Issues #254 and #255. Every place that starts a bundled-CLI child must hand it the forced
// environment on both layers, or be listed here with the reason it does not. The judge and the
// eval adversary passed none until #254: `tools: []` does not stop the CLI running a scheduled
// job or expanding an `@path`. This inventory fails when a call site appears, moves or loses its
// wiring, so a new caller cannot be added without a ruling.

// The repository root: vitest runs from it, as the SDK parity test assumes too.
const ROOT = process.cwd();
/** An SDK `query` call: `query({`, `deps.query(` or `sdk.query(`. A method named query on another object is not one. */
const CALL = /(?<![.\w])query\(\{|\b(?:deps|sdk)\.query\(/gu;
const WIRED_ENV = /\benv: buildChildEnv\(process\.env\)/gu;
const WIRED_SETTINGS = /\bsettings: buildChildSettings\(\)/gu;

interface Site {
  /** How many SDK query calls the file makes. */
  calls: number;
  /** Why the file is not wired; absent means every call passes the forced table on both layers. */
  excluded?: string;
}

const SITES: Readonly<Record<string, Site>> = {
  'src/session/session.ts': { calls: 1 },
  'src/session/judge.ts': { calls: 1 },
  'src/cli/eval-command.ts': { calls: 1 },
  'scripts/capture-sdk-hook-fixture.mjs': {
    calls: 3,
    excluded: 'a keyed developer tool that records the SDK\'s own hook payloads with no harness session, by design; its prompts are written in the script',
  },
  'scripts/mock-cli-probe.mjs': {
    calls: 1,
    excluded: 'a tee around the arguments the harness itself built: it forwards the env and settings it is given',
  },
};

function sourceFiles(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((name) => keep(name))
    .map((name) => relative(ROOT, join(ROOT, dir, name)).split(sep).join('/'));
}

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

describe('every SDK query call site is wired to the forced child environment, or excluded with a reason (#254, #255)', () => {
  const files = [
    ...sourceFiles('src', (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')),
    ...sourceFiles('scripts', (name) => name.endsWith('.mjs')),
  ];
  const found = Object.fromEntries(
    files.map((file) => [file, count(readFileSync(join(ROOT, file), 'utf8'), CALL)] as const).filter(([, calls]) => calls > 0),
  );

  it('the scan sees the source tree (a scan that finds nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('src/session/session.ts');
    expect(files).toContain('scripts/mock-cli-probe.mjs');
  });

  it('the call sites are exactly the listed ones, with the listed counts', () => {
    expect(found).toEqual(Object.fromEntries(Object.entries(SITES).map(([file, site]) => [file, site.calls])));
  });

  it.each(Object.entries(SITES).filter(([, site]) => site.excluded === undefined))('%s passes env and flag settings on every call', (file, site) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(count(text, WIRED_ENV)).toBe(site.calls);
    expect(count(text, WIRED_SETTINGS)).toBe(site.calls);
  });
});
