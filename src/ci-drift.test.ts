import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// CI gate drift guards (ADR-0022 R6). R6 fired because `docs-links` was added
// to ci.yml and never to the publish build job, so the deploy path ran fewer
// checks than PR CI. The rule was held by a "keep this list in sync" comment,
// and the comment lost. gates.yml now makes that failure mode impossible by
// construction; these tests pin the invariants construction alone does not:
// that both callers actually delegate, that the gate ORDER holds, and that the
// security topology of the publish path stays as ADR-0022 describes it.
//
// Honest limitation: this is the weaker cousin of the byte-identity precedent
// in src/telemetry/migrations/ddl-drift.test.ts, which compares two real
// imported constants. There is no YAML parser in dependencies or
// devDependencies (gray-matter's js-yaml is transitive and undeclared, and its
// public API only parses frontmatter), so extraction here is line-based — i.e.
// a proxy parser, exactly the shape DEC-0016 warns about. A proxy that finds
// nothing reads green, so every extractor below throws rather than returning a
// silently empty result, and the assertions guard against the -1 sentinel.

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
  [/^(?:npm run check:docs|bash scripts\/check-docs\.sh)$/, 'check-docs'],
  [/^(?:npm run check:testcount|bash scripts\/check-test-count\.sh)$/, 'check-testcount'],
  [/^(?:npm run check:corpus|node scripts\/check-corpus-numbers\.mjs)$/, 'check-corpus'],
];

const canonicalise = (command: string): string | null =>
  CANONICAL.find(([pattern]) => pattern.test(command))?.[1] ?? null;

const isComment = (line: string): boolean => /^\s*#/.test(line);

/**
 * Drops whole-line comments so a structural check cannot match the PROSE that
 * describes an invariant instead of the config that implements it. Caught in
 * review: `gates.yml`'s comments legitimately contain the strings
 * "id-token: write" and "secrets: inherit" while explaining that neither may
 * appear, and publish.yml's say "no `cache: npm` in this job".
 * Deliberately whole-line only — stripping trailing comments too would risk
 * removing real config, whereas a whole-line comment is never config, and a
 * violation smuggled onto a line with a trailing comment still gets caught.
 *
 * Known limitation (round-2 review): this is YAML-context-blind, so a `#` line
 * inside a `run: |` block scalar is a shell comment yet reads as YAML
 * commentary and gets dropped. Since every consumer below is a `not.toMatch`,
 * dropping text can only make a check PASS — the unsafe direction. No workflow
 * currently has such a line. If one is ever added, scope the strip to
 * non-block-scalar regions rather than trusting this.
 */
const stripComments = (yaml: string): string =>
  yaml
    .split('\n')
    .filter((line) => !isComment(line))
    .join('\n');

/**
 * Returns the body lines of a top-level job. Throws when the job cannot be
 * found, so a restructured workflow fails the suite instead of quietly
 * matching nothing.
 *
 * A job ends at the next line indented exactly two spaces that is neither
 * blank nor a comment — comments must be skipped explicitly, because `#` is
 * non-whitespace and would otherwise read as the next job key and truncate the
 * body early (a silent under-read, which is the failure mode this file exists
 * to avoid). Trailing comments belonging to the following job are dropped.
 */
const extractJobBody = (yaml: string, jobName: string): string[] => {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) {
    throw new Error(`ci-drift extractor lost job "${jobName}" — the workflow moved, update this test`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^ {2}\S/.test(line) && !isComment(line)) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  while (body.length > 0 && (isComment(body[body.length - 1]!) || body[body.length - 1]!.trim() === '')) {
    body.pop();
  }
  return body;
};

/** Ordered `run:` commands of a job. Handles both `run: cmd` and block form (`run: |`). */
const extractRunCommands = (yaml: string, jobName: string): string[] => {
  const body = extractJobBody(yaml, jobName);
  const commands: string[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const match = /^\s*(?:- )?run:\s*(.*)$/.exec(body[i]!);
    if (!match) continue;
    const inline = match[1]!.trim();
    if (!['|', '|-', '>', '>-'].includes(inline)) {
      commands.push(inline);
      continue;
    }
    const blockIndent = /^(\s*)/.exec(body[i]!)![1]!.length;
    for (let j = i + 1; j < body.length; j += 1) {
      const line = body[j]!;
      if (line.trim() === '') continue;
      if (/^(\s*)/.exec(line)![1]!.length <= blockIndent) break;
      commands.push(line.trim());
      i = j;
    }
  }
  return commands;
};

/** Ordered `uses:` values of a job. Anchored, so a commented-out call does not count. */
const extractUses = (yaml: string, jobName: string): string[] =>
  extractJobBody(yaml, jobName)
    .map((line) => /^\s*(?:- )?uses:\s*(\S+)\s*$/.exec(line)?.[1] ?? null)
    .filter((value): value is string => value !== null);

/** Top-level job names of a workflow, in file order. */
const extractJobNames = (yaml: string): string[] => {
  const bare = stripComments(yaml);
  const jobsAt = bare.indexOf('\njobs:');
  if (jobsAt === -1) {
    throw new Error('ci-drift extractor found no jobs: block — the workflow moved, update this test');
  }
  return bare
    .slice(jobsAt + 1)
    .split('\n')
    .map((line) => /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1] ?? null)
    .filter((name): name is string => name !== null);
};

const WORKFLOW_DIR = '.github/workflows';
// Enumerated from disk, never hardcoded: a repo-level invariant asserted over a
// fixed file list is only an invariant about those files, and a new workflow
// would escape every check below (round-2 review finding).
const allWorkflows: ReadonlyArray<readonly [string, string]> = readdirSync(join(process.cwd(), WORKFLOW_DIR))
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort()
  .map((name) => [name, repoFile(`${WORKFLOW_DIR}/${name}`)] as const);

const workflow = (name: string): string => {
  const found = allWorkflows.find(([file]) => file === name);
  if (!found) throw new Error(`ci-drift expected ${WORKFLOW_DIR}/${name} to exist`);
  return found[1];
};

const gatesYaml = workflow('gates.yml');
const publishYaml = workflow('publish.yml');
const ciYaml = workflow('ci.yml');
const packageJson = JSON.parse(repoFile('package.json')) as { scripts: Record<string, string> };

const SHARED_WORKFLOW = './.github/workflows/gates.yml';
// Tolerant of the spellings YAML permits for the same meaning. Round-2 review
// demonstrated live bypasses of the exact-literal versions: `id-token:  write`
// (two spaces) and `cache: 'npm'` (quoted) both parse identically and both
// slipped through. A pin that only catches the canonical spelling manufactures
// confidence, which is worse than no pin.
const ID_TOKEN_GRANT = /id-token:\s*['"]?write/g;
const NPM_CACHE = /cache:\s*['"]?npm/;
const SECRETS_INHERIT = /secrets:\s*['"]?inherit/;

const GATE_NAMES = ['lint', 'typecheck', 'build', 'test', 'redteam'] as const;
/**
 * ADR-0022 decision 5 *as amended 2026-07-28*: the floor prepublishOnly must
 * never drop below. Deliberately a separate literal from GATE_NAMES even though
 * the two currently coincide — they answer different questions (what the
 * workflow must run, versus what prepublishOnly must not lose). Aliasing them
 * would silently convert decision 4's directional invariant into forced
 * equality, so a workflow-only gate could never be added again.
 */
const PREPUBLISH_FLOOR = ['lint', 'typecheck', 'build', 'test', 'redteam'] as const;

describe('CI gate sequence (ADR-0022 R6)', () => {
  const buildTest = extractRunCommands(gatesYaml, 'build-test');
  const gateOrder = buildTest.map(canonicalise).filter((name): name is string => name !== null);

  /** Index of a gate, asserted present first so a missing gate cannot pass via the -1 sentinel. */
  const indexOfGate = (gate: string): number => {
    const index = gateOrder.indexOf(gate);
    expect(index, `gates.yml no longer runs the ${gate} gate`).toBeGreaterThanOrEqual(0);
    return index;
  };

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
    expect(indexOfGate('build')).toBeLessThan(indexOfGate('test'));
    expect(indexOfGate('test')).toBeLessThan(indexOfGate('redteam'));
  });

  it('still runs the docs-links gate that R6 fired over', () => {
    expect(extractRunCommands(gatesYaml, 'docs-links').map(canonicalise)).toContain('check-links');
  });

  it('runs the docs structure gate, in the install-free job where it belongs', () => {
    // Issue #61. Asserted against the JOB rather than the whole file, so
    // moving it into build-test — which would delay a broken-table report
    // behind a full install — fails here rather than passing silently.
    expect(extractRunCommands(gatesYaml, 'docs-links').map(canonicalise)).toContain('check-docs');
  });

  it('runs the corpus-number gate in the install-free job, after the structure gate', () => {
    // Issue #89. Same job as check-docs for the same reason (no install), and
    // after it so a broken table is reported before a stale number in one.
    const docsJob = extractRunCommands(gatesYaml, 'docs-links').map(canonicalise);
    expect(docsJob).toContain('check-corpus');
    expect(docsJob.indexOf('check-docs')).toBeLessThan(docsJob.indexOf('check-corpus'));
  });

  it('runs the derived test-count gate after the suite, so a red suite is reported first', () => {
    // ⚠️ AN EARLIER VERSION OF THIS COMMENT WAS WRONG and review caught it: it
    // said ordering this before `test` "would run the suite twice", implying
    // this order avoids that. It does not. check-test-count.sh always shells
    // out to a fresh `npx vitest run`, so the suite runs twice either way.
    // The real reason for the order is failure legibility: `Test` fails first
    // and names the broken test, rather than this gate failing first with a
    // message about a count. Removing the second run means consuming the first
    // one's JSON, which is a larger change than this gate justifies.
    expect(indexOfGate('test')).toBeLessThan(indexOfGate('check-testcount'));
  });

  it('both CI and the publish path delegate to the one shared definition', () => {
    expect(extractUses(ciYaml, 'test')).toContain(SHARED_WORKFLOW);
    expect(extractUses(publishYaml, 'gates')).toContain(SHARED_WORKFLOW);
  });

  it('CI still runs the full Node matrix (the engines >=20.10 claim rests on the Node 20 leg)', () => {
    // ci.yml passes no `node-versions`, so it takes gates.yml's default. An
    // override there could silently drop Node 20 and nothing else would notice.
    expect(extractJobBody(ciYaml, 'test').join('\n')).not.toMatch(/node-versions:/);
    expect(gatesYaml).toContain(`default: '["20","22"]'`);
  });

  it('the publish workflow has exactly the three expected jobs', () => {
    // Pinned so a new inline job cannot appear without this test being updated
    // — which is what makes the "no gates of its own" check below exhaustive
    // rather than a check of one job (round-2 review finding).
    expect(extractJobNames(publishYaml)).toEqual(['verify-tag', 'gates', 'publish']);
  });

  it('the publish workflow defines no gates of its own (re-inlining would revive R6)', () => {
    // Every inline job, not just `publish`: re-inlining a gate into verify-tag
    // would revive R6 just as surely. `gates` is the delegating caller and has
    // no steps of its own. The publish job legitimately runs
    // `npm install -g npm@...` and `npm publish`, neither of which
    // canonicalises to a gate.
    for (const job of extractJobNames(publishYaml).filter((name) => name !== 'gates')) {
      const commands = extractRunCommands(publishYaml, job).map(canonicalise);
      for (const gate of GATE_NAMES) {
        expect(commands, `publish.yml job "${job}" re-inlined the ${gate} gate`).not.toContain(gate);
      }
    }
  });

  it('prepublishOnly is an ordered subset of the workflow gates, and never drops below its floor', () => {
    // ADR-0022 decision 4's invariant is directional: the workflow is the
    // stricter of the two and that direction is the safe one. Equality would
    // force pointless reconciliation of `npm ci` and `rm -rf dist`. A subset
    // check alone has no floor, though — gutting prepublishOnly would read
    // green — so the floor is asserted separately.
    const segments = packageJson.scripts.prepublishOnly!.split('&&').map((part) => part.trim());
    const prepublishGates = segments
      .map((segment) => {
        const name = canonicalise(segment);
        if (name === null) {
          throw new Error(`ci-drift does not recognise prepublishOnly command "${segment}" — add it to CANONICAL`);
        }
        return name;
      })
      // 'clean' has no workflow counterpart: a fresh runner has nothing to clean.
      .filter((name) => name !== 'clean');

    for (const gate of PREPUBLISH_FLOOR) {
      expect(prepublishGates, `prepublishOnly no longer runs the ${gate} gate`).toContain(gate);
    }

    let cursor = 0;
    for (const gate of prepublishGates) {
      const found = gateOrder.indexOf(gate, cursor);
      expect(
        found,
        `prepublishOnly runs "${gate}", which the workflow gates do not run in that order`,
      ).toBeGreaterThanOrEqual(0);
      cursor = found + 1;
    }
  });
});

// The V20 split (ADR-0022, 2026-07-24 amendment) keeps OIDC-minting capability
// away from every line of dependency code. Its guarantees were recorded only as
// INVARIANT comments in the workflows, which is the same posture that let R6
// happen. These pin the load-bearing ones.
describe('publish path security topology (ADR-0022 V20)', () => {
  it('grants id-token: write exactly once across every workflow, in the inline publish job', () => {
    // Counted over the whole directory rather than per-file, so this also
    // catches a WORKFLOW-level grant in a caller (which would be inherited by
    // the gates job and is invisible to a job-body check), and any grant in a
    // workflow file added later.
    const grants = allWorkflows.flatMap(([name, yaml]) =>
      (stripComments(yaml).match(ID_TOKEN_GRANT) ?? []).map(() => name),
    );
    expect(grants, 'id-token: write must be granted exactly once, in publish.yml').toEqual(['publish.yml']);
    expect(stripComments(extractJobBody(publishYaml, 'publish').join('\n'))).toMatch(ID_TOKEN_GRANT);
  });

  it('no workflow passes secrets to the jobs that execute dependency code', () => {
    // Covers `secrets: inherit`. Explicit named forwarding (`secrets:\n  X: ...`)
    // is not matched here, but is a two-file change: gates.yml declares no
    // `on.workflow_call.secrets`, so a caller forwarding a named secret fails at
    // load time until gates.yml is edited too. That declaration is pinned below.
    for (const [name, yaml] of allWorkflows) {
      expect(stripComments(yaml), `${name} passes secrets into a called workflow`).not.toMatch(SECRETS_INHERIT);
    }
    expect(stripComments(gatesYaml), 'gates.yml now accepts secrets from callers').not.toMatch(
      /^\s*secrets:/m,
    );
  });

  it('the shared gates workflow is callable only, never directly triggerable', () => {
    // A `push`/`pull_request`/`workflow_dispatch` trigger here would run the
    // gates outside any caller's permission cap.
    const bare = stripComments(gatesYaml);
    const triggers = bare.slice(bare.indexOf('\non:')).split('\njobs:')[0]!;
    expect(triggers).toContain('workflow_call:');
    for (const forbidden of ['push:', 'pull_request:', 'pull_request_target:', 'workflow_dispatch:', 'workflow_run:']) {
      expect(triggers, `gates.yml gained a ${forbidden} trigger`).not.toContain(forbidden);
    }
  });

  it('caller jobs grant the shared workflow no job-level permissions', () => {
    // A called workflow can only downgrade what the caller job holds, so the
    // caller staying silent (inheriting workflow-level `contents: read`) is
    // what keeps the gates out of token scope. This is the single barrier.
    for (const [name, yaml, job] of [
      ['ci.yml', ciYaml, 'test'],
      ['publish.yml', publishYaml, 'gates'],
    ] as const) {
      expect(
        stripComments(extractJobBody(yaml, job).join('\n')),
        `${name} job "${job}" now grants explicit permissions to the shared workflow`,
      ).not.toMatch(/^\s*permissions:/m);
    }
  });

  it('the publish job neither restores a cache nor reaches outside its own run', () => {
    const publishJob = stripComments(extractJobBody(publishYaml, 'publish').join('\n'));
    // A cache restore inside token scope is a poisoning channel from
    // lower-privileged workflows that can write the shared cache.
    expect(publishJob).not.toMatch(NPM_CACHE);
    // Without github-token/run-id, download-artifact can only read THIS run,
    // which is what makes the gates -> publish handoff unforgeable.
    expect(publishJob).not.toMatch(/github-token:/);
    expect(publishJob).not.toMatch(/run-id:/);
  });
});
