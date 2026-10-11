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

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  noEmit: true,
  types: ['node'],
};

/** Programs over in-memory files: lets the walk be proven against a fixture without touching disk. */
const loadVirtualProgram = (files: Readonly<Record<string, string>>, root: string): ts.Program => {
  const host = ts.createCompilerHost(compilerOptions);
  const { getSourceFile, fileExists, readFile } = host;
  host.fileExists = (name) => name in files || fileExists.call(host, name);
  host.readFile = (name) => files[name] ?? readFile.call(host, name);
  host.getSourceFile = (name, ...rest) => {
    const text = files[name];
    return text === undefined
      ? getSourceFile.call(host, name, ...rest)
      : ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true);
  };
  return ts.createProgram([root], { ...compilerOptions, types: [] }, host);
};

const resolveAlias = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

// A module-level declaration is a direct child of the SourceFile (interface, type,
// class, function) or a `const`/`let`/`var` inside a top-level VariableStatement
// (`typeof X` can name the latter). Nested members and parameters are not.
const isModuleLevel = (declaration: ts.Declaration): boolean => {
  const { parent } = declaration;
  return (
    ts.isSourceFile(parent) ||
    (ts.isVariableDeclarationList(parent) &&
      ts.isVariableStatement(parent.parent) &&
      ts.isSourceFile(parent.parent.parent))
  );
};

interface Walk {
  /** Root-exported symbols visited. */
  readonly exportedCount: number;
  /** References that resolved to a dist module-level declaration (reachable or not). */
  readonly resolvedCount: number;
  /** Referenced dist names (with file) that the root does not export. */
  readonly unreachable: string[];
}

const walkSurface = (program: ts.Program, rootPath: string, distDir: string): Walk => {
  const checker = program.getTypeChecker();
  const rootFile = program.getSourceFile(rootPath);
  if (rootFile === undefined) throw new Error(`${rootPath} is not in the program`);
  const rootSymbol = checker.getSymbolAtLocation(rootFile);
  if (rootSymbol === undefined) throw new Error(`${rootPath} has no module symbol`);

  const isDistModuleLevel = (declaration: ts.Declaration): boolean =>
    isModuleLevel(declaration) &&
    declaration.getSourceFile().fileName.startsWith(distDir.split(sep).join('/'));

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
        const file = declarations[0]?.getSourceFile().fileName.slice(distDir.length);
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

const walkRootSurface = (): Walk =>
  walkSurface(ts.createProgram([entry], compilerOptions), entry, distRoot);

// Vacuity floors (exclusive lower bounds): about 80% of the counts measured on
// 2026-10-12 (332 root exports, 725 resolved dist references; 0.8 x 332 = 265,
// 0.8 x 725 = 580). They only prove the walk visited the real surface, not pin it
// exactly. Re-derive them (measure, then take ~80%) whenever the surface shrinks
// on purpose; growth never trips them.
const EXPORT_FLOOR = 265;
const RESOLVED_FLOOR = 580;

describe('root barrel type closure (ADR-0023, issue #144)', () => {
  it('has a built dist to walk', () => {
    expect(
      existsSync(entry),
      'dist/index.d.ts missing: run `npm run build` first (CI builds before test)',
    ).toBe(true);
  });

  it('actually walks the surface (a no-op walk would pass the next test vacuously)', () => {
    const walk = walkRootSurface();
    expect(walk.exportedCount).toBeGreaterThan(EXPORT_FLOOR);
    expect(walk.resolvedCount).toBeGreaterThan(RESOLVED_FLOOR);
  });

  it('exports every dist type that a root-exported signature references', () => {
    const { unreachable } = walkRootSurface();
    expect(
      unreachable,
      'Re-export each name listed here from src/index.ts (or narrow the public signature that ' +
        'references it): every type a root signature mentions must be reachable from the root ' +
        '(ADR-0023, issue #144).',
    ).toEqual([]);
  });
});

describe('walkSurface detection (fixture, no disk)', () => {
  const dist = '/virtual/dist/';
  const detect = (files: Record<string, string>): Walk => {
    const root = `${dist}index.d.ts`;
    return walkSurface(loadVirtualProgram({ [root]: files['index'] ?? '', ...files }, root), root, dist);
  };

  it('flags an unexported interface referenced by an exported signature', () => {
    const walk = detect({
      index: 'interface Hidden { a: 1 }\nexport declare function f(): Hidden;\nexport {};',
    });
    expect(walk.unreachable).toEqual(['Hidden (index.d.ts)']);
  });

  it('flags a typeof reference to an unexported module-level const', () => {
    const walk = detect({
      index: 'declare const hidden: { a: 1 };\nexport declare const x: typeof hidden;\nexport {};',
    });
    expect(walk.unreachable).toEqual(['hidden (index.d.ts)']);
  });

  it('passes when the referenced name is exported', () => {
    const walk = detect({
      index: 'export interface Shown { a: 1 }\nexport declare function f(): Shown;',
    });
    expect(walk.unreachable).toEqual([]);
    expect(walk.resolvedCount).toBeGreaterThan(0);
  });
});
