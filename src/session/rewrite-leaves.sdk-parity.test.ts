import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SDK_OUTPUT_LITERALS } from './rewrite-leaves.js';

// Derived gate for the fail-closed shape keeper's literal table (issue #203).
// The keeper keeps a leaf only if its key and value are a string-literal field
// the SDK declares in a `*Output` type. This test re-derives that vocabulary
// from the installed SDK's own declarations and fails when the table and the
// SDK disagree in either direction, so an SDK bump that adds a literal or a
// field cannot silently reopen the revert (the CLI discards a rewrite that
// fails its output schema and the raw output reaches the model).
//
// Reach: the SDK declarations are the proxy for the CLI's zod schemas, not the
// schemas themselves, so a literal the CLI constrains but sdk-tools.d.ts does
// not declare (for example Skill's `forked`/`inline` `status`) is NOT covered;
// that residual is recorded in ADR-0035 (2026-10-20 note). Regex over a
// generated .d.ts, no AST: the negative controls below fail when the parser
// finds nothing, so a broken parse cannot read as clean.

const SDK_TOOLS_DTS = join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk-tools.d.ts');

/**
 * Declared fields whose type the parser cannot read as a pure string-literal
 * union are ignored by design, and listed here so none is dropped silently.
 * Empty at SDK 0.3.201: every literal-bearing field parsed.
 */
const UNPARSEABLE_FIELDS: readonly string[] = [];

/** Every `*Output` declaration (interface or type alias), comments stripped. */
function outputDeclarations(source: string): { name: string; body: string }[] {
  return source
    .split(/^(?=export )/m)
    .map((d) => ({ d, m: /^export (?:interface|type) (\w+Output)\b/.exec(d) }))
    .filter((x): x is { d: string; m: RegExpExecArray } => x.m !== null)
    .map((x) => ({ name: x.m[1] ?? '', body: x.d.replace(/\/\*[\s\S]*?\*\//g, '') }));
}

/** key -> sorted unique literals, for fields typed as a string literal or a union of them (any depth). */
function deriveLiterals(source: string): Record<string, string[]> {
  const table = new Map<string, Set<string>>();
  for (const { body } of outputDeclarations(source)) {
    const keyRe = /(\w+|"[^"]+")\??:\s*/g;
    for (let m = keyRe.exec(body); m !== null; m = keyRe.exec(body)) {
      const key = (m[1] ?? '').replace(/"/g, '');
      const rest = body.slice(keyRe.lastIndex);
      const end = rest.indexOf(';');
      const expr = end < 0 ? rest : rest.slice(0, end);
      const literals = [...expr.matchAll(/"([^"]*)"/g)].map((x) => x[1] ?? '');
      const residue = expr.replace(/"[^"]*"/g, '').replace(/[()|\s]|\[\]|null/g, '');
      if (literals.length === 0 || residue !== '') continue;
      const set = table.get(key) ?? new Set<string>();
      for (const l of literals) set.add(l);
      table.set(key, set);
    }
  }
  return Object.fromEntries([...table.keys()].sort().map((k) => [k, [...(table.get(k) ?? [])].sort()]));
}

describe('SDK_OUTPUT_LITERALS is derived from the installed SDK declarations (issue #203)', () => {
  const source = readFileSync(SDK_TOOLS_DTS, 'utf8');
  const derived = deriveLiterals(source);

  it('equals the literals the SDK declares in its *Output types', () => {
    expect(derived).toEqual(SDK_OUTPUT_LITERALS);
  });

  it('keeps the table sorted (keys and values) so a diff is reviewable', () => {
    const keys = Object.keys(SDK_OUTPUT_LITERALS);
    expect(keys).toEqual([...keys].sort());
    for (const k of keys) expect(SDK_OUTPUT_LITERALS[k]).toEqual([...(SDK_OUTPUT_LITERALS[k] ?? [])].sort());
  });

  it('negative control: the parser finds known entries, so an empty parse cannot pass', () => {
    expect(outputDeclarations(source).length).toBeGreaterThanOrEqual(30);
    expect(derived.status).toEqual(expect.arrayContaining(['modified', 'added']));
    expect(derived.type).toEqual(expect.arrayContaining(['text', 'image/png']));
    expect(derived.mode).toEqual(['content', 'count', 'files_with_matches']);
  });

  it('every ToolOutputSchemas member resolves to a parsed *Output declaration', () => {
    const union = source.split(/^(?=export )/m).find((d) => d.startsWith('export type ToolOutputSchemas ='));
    const members = [...(union ?? '').matchAll(/\|\s*(\w+)/g)].map((m) => m[1] ?? '');
    expect(members.length).toBeGreaterThanOrEqual(30);
    const declared = new Set(outputDeclarations(source).map((d) => d.name));
    expect(members.filter((m) => !declared.has(m))).toEqual([]);
  });

  it('lists no unparseable field silently', () => {
    expect(UNPARSEABLE_FIELDS).toEqual([]);
  });

  it('the derivation fails on a synthetic added literal and a synthetic added field', () => {
    const extra = source + '\nexport interface FakeOutput {\n  status: "novel";\n  brandNew: "x" | "y";\n}\n';
    expect(deriveLiterals(extra)).not.toEqual(SDK_OUTPUT_LITERALS);
    expect(deriveLiterals(extra).status).toContain('novel');
    expect(deriveLiterals(extra).brandNew).toEqual(['x', 'y']);
  });
});
