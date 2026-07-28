import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// CI gate drift guards (ADR-0022 R6). R6 fired because `docs-links` was added
// to ci.yml and never to the publish build job, so the deploy path ran fewer
// checks than PR CI. The rule was held by a "keep this list in sync" comment,
// and the comment lost. gates.yml now makes that failure mode impossible by
// construction; these tests pin the invariants construction alone does not:
// that both callers actually delegate, and that the gate ORDER holds.
//
// Honest limitation: this is the weaker cousin of the byte-identity precedent
// in src/telemetry/migrations/ddl-drift.test.ts, which compares two real
// imported constants. There is no YAML parser in dependencies or
// devDependencies (gray-matter's js-yaml is transitive and undeclared, and its
// public API only parses frontmatter), so extraction here is line-based — i.e.
// a proxy parser, exactly the shape DEC-0016 warns about. A proxy that finds
// nothing reads green, so `extractRunCommands` asserts anchors and throws
// rather than returning a silently empty list.

const repoFile = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

/** Maps every command spelling used across the workflows and package.json to one canonical gate. */
const CANONICAL: ReadonlyArray<readonly [RegExp, string]> = [
  [/^npm ci$/, 'install'],
  [/^rm -rf dist$/, 'clean'],
  [/^npm run lint$/, 'lint'],
  [/^npm run typecheck$/, 'typecheck'],
  [/^npm run build$/, 'build'],
  [/^npm (?:run )?test$/, 'test'],
  [/^(?:npm run redteam|node \.?\/?dist\/cli\.js redteam)$/, 'redteam'],
  [/^(?:npm run check:links|bash scripts\/check-links\.sh)$/, 'check-links'],
];

const canonicalise = (command: string): string | null =>
  CANONICAL.find(([pattern]) => pattern.test(command))?.[1] ?? null;

/**
 * Returns the ordered `run:` commands of a top-level job in a workflow file.
 * Handles both `run: cmd` and block form (`run: |`). Deliberately narrow: it
 * throws when it cannot find the job at all, so a restructured workflow fails
 * the suite instead of quietly matching nothing.
 */
const extractRunCommands = (yaml: string, jobName: string): string[] => {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) {
    throw new Error(`ci-drift extractor lost job "${jobName}" — the workflow moved, update this test`);
  }
  // A top-level job ends at the next line indented exactly two spaces that is
  // not a comment or blank.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  const commands: string[] = [];
  for (let i = start + 1; i < end; i += 1) {
    const match = /^\s*(?:- )?run:\s*(.*)$/.exec(lines[i]!);
    if (!match) continue;
    const inline = match[1]!.trim();
    if (inline !== '|' && inline !== '|-' && inline !== '>' && inline !== '>-') {
      commands.push(inline);
      continue;
    }
    // Block scalar: take the more-indented lines that follow.
    const blockIndent = /^(\s*)/.exec(lines[i]!)![1]!.length;
    for (let j = i + 1; j < end; j += 1) {
      const body = lines[j]!;
      if (body.trim() === '') continue;
      const indent = /^(\s*)/.exec(body)![1]!.length;
      if (indent <= blockIndent) break;
      commands.push(body.trim());
      i = j;
    }
  }
  return commands;
};

const gatesYaml = repoFile('.github/workflows/gates.yml');
const publishYaml = repoFile('.github/workflows/publish.yml');
const ciYaml = repoFile('.github/workflows/ci.yml');
const packageJson = JSON.parse(repoFile('package.json')) as { scripts: Record<string, string> };

const GATE_NAMES = ['lint', 'typecheck', 'build', 'test', 'redteam'] as const;

describe('CI gate sequence (ADR-0022 R6)', () => {
  const buildTest = extractRunCommands(gatesYaml, 'build-test');
  const gateOrder = buildTest.map(canonicalise).filter((name): name is string => name !== null);

  it('the extractor still finds the gate sequence (fails closed if the workflow is restructured)', () => {
    expect(
      buildTest.length,
      'ci-drift extractor found too few run: commands — gates.yml changed shape, update this test',
    ).toBeGreaterThanOrEqual(6);
    expect(gateOrder).toContain('install');
    for (const gate of GATE_NAMES) {
      expect(gateOrder, `gates.yml no longer runs the ${gate} gate`).toContain(gate);
    }
  });

  it('runs build before test before the red-team gate', () => {
    // src/exports-map.test.ts resolves against dist/ and deliberately does not
    // skip when dist/ is missing, so it needs the build first.
    // src/eval/redteam/baseline-e2e.test.ts documents that `npm test` running
    // before the red-team gate is what makes the vitest e2e the first failure
    // surface on baseline drift. Nothing else pins this order in YAML.
    expect(gateOrder.indexOf('build')).toBeLessThan(gateOrder.indexOf('test'));
    expect(gateOrder.indexOf('test')).toBeLessThan(gateOrder.indexOf('redteam'));
  });

  it('still runs the docs-links gate that R6 fired over', () => {
    expect(extractRunCommands(gatesYaml, 'docs-links').map(canonicalise)).toContain('check-links');
  });

  it('both CI and the publish path delegate to the one shared definition', () => {
    expect(ciYaml).toContain('uses: ./.github/workflows/gates.yml');
    expect(publishYaml).toContain('uses: ./.github/workflows/gates.yml');
  });

  it('the publish workflow defines no gates of its own (re-inlining would revive R6)', () => {
    // The publish job legitimately runs `npm install -g npm@...` and
    // `npm publish`, neither of which canonicalises to a gate.
    const publishJobCommands = extractRunCommands(publishYaml, 'publish').map(canonicalise);
    for (const gate of GATE_NAMES) {
      expect(publishJobCommands, `publish.yml re-inlined the ${gate} gate`).not.toContain(gate);
    }
  });

  it('prepublishOnly is an ordered subset of the workflow gates (never stricter)', () => {
    // ADR-0022 decision 4's invariant is directional: the workflow is the
    // stricter of the two and that direction is the safe one. Equality would
    // force pointless reconciliation of `npm ci` and `rm -rf dist`.
    const segments = packageJson.scripts.prepublishOnly!.split('&&').map((part) => part.trim());
    const prepublishGates = segments.map((segment) => {
      const name = canonicalise(segment);
      if (name === null) {
        throw new Error(`ci-drift does not recognise prepublishOnly command "${segment}" — add it to CANONICAL`);
      }
      return name;
      // 'clean' has no workflow counterpart: a fresh runner has nothing to clean.
    }).filter((name) => name !== 'clean');

    let cursor = 0;
    for (const gate of prepublishGates) {
      const found = gateOrder.indexOf(gate, cursor);
      expect(found, `prepublishOnly runs "${gate}", which the workflow gates do not run in that order`).toBeGreaterThanOrEqual(0);
      cursor = found + 1;
    }
  });
});
