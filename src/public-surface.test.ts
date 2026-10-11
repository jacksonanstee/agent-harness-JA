import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Issue #144 pin for ADR-0023's rule: every type a public signature references
// must be reachable from the root barrel. The walk uses the TypeScript compiler
// API over the EMITTED dist/index.d.ts (what a consumer actually sees), visits
// every identifier inside every root-exported declaration, and fails on any
// that resolves to a module-level declaration inside dist/ which the root does
// not export. References into node_modules or lib files (better-sqlite3, the
// SDK, node:*) are the consumer's to import from their own packages and are not
// counted. Like src/exports-map.test.ts this needs a built dist, deliberately
// without skipIf (DEC-0016).
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distRoot = resolve(packageRoot, 'dist') + sep;
const entry = resolve(packageRoot, 'dist/index.d.ts');

const loadProgram = (): ts.Program =>
  ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
    types: ['node'],
  });

const resolveAlias = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

const isDistModuleLevel = (declaration: ts.Declaration): boolean =>
  ts.isSourceFile(declaration.parent) &&
  declaration.getSourceFile().fileName.startsWith(distRoot.split(sep).join('/'));

interface Walk {
  /** Root-exported symbols visited. */
  readonly exportedCount: number;
  /** References that resolved to a dist module-level declaration (reachable or not). */
  readonly resolvedCount: number;
  /** Referenced dist names (with file) that the root does not export. */
  readonly unreachable: string[];
}

const walkRootSurface = (): Walk => {
  const program = loadProgram();
  const checker = program.getTypeChecker();
  const rootFile = program.getSourceFile(entry);
  if (rootFile === undefined) throw new Error('dist/index.d.ts is not in the program');
  const rootSymbol = checker.getSymbolAtLocation(rootFile);
  if (rootSymbol === undefined) throw new Error('dist/index.d.ts has no module symbol');

  const exported = checker.getExportsOfModule(rootSymbol).map((s) => resolveAlias(checker, s));
  const reachable = new Set<ts.Declaration>(exported.flatMap((s) => s.declarations ?? []));
  const missing = new Set<string>();
  let resolvedCount = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const target = symbol === undefined ? undefined : resolveAlias(checker, symbol);
      const declarations = target?.declarations ?? [];
      const inDist =
        target !== undefined && declarations.length > 0 && declarations.every(isDistModuleLevel);
      if (inDist) resolvedCount += 1;
      if (inDist && !declarations.some((d) => reachable.has(d))) {
        const file = declarations[0]?.getSourceFile().fileName.slice(distRoot.length);
        missing.add(`${target?.getName() ?? '?'} (${file})`);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const symbol of exported) {
    for (const declaration of symbol.declarations ?? []) visit(declaration);
  }
  return { exportedCount: exported.length, resolvedCount, unreachable: [...missing].sort() };
};

describe('root barrel type closure (ADR-0023, issue #144)', () => {
  it('has a built dist to walk', () => {
    expect(
      existsSync(entry),
      'dist/index.d.ts missing: run `npm run build` first (CI builds before test)',
    ).toBe(true);
  });

  it('actually walks the surface (a no-op walk would pass the next test vacuously)', () => {
    const walk = walkRootSurface();
    expect(walk.exportedCount).toBeGreaterThan(200);
    expect(walk.resolvedCount).toBeGreaterThan(500);
  });

  it('exports every dist type that a root-exported signature references', () => {
    expect(walkRootSurface().unreachable).toEqual([]);
  });
});
