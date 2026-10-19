/**
 * Table-driven policy corpus (issue #190). Every row in policy-corpus.rows.ts
 * is put to the REAL composed pre-tool path: a hook runtime with
 * permissionHook then sandboxHook registered in that order, exactly as the
 * CLI composition root registers them (src/cli.ts, src/cli/eval-command.ts),
 * and fired with a 'pre-tool' payload. The individual evaluators are not
 * called for the verdict; the rows pin what a tool call actually meets.
 *
 * FIXTURE POLICY (declared here so the rows can be read against it). It is
 * built through the production parsers and merge functions, not object
 * literals, so a parser change that alters it is seen.
 *
 *   sandbox (user layer)
 *     paths.allow     {ROOT}/work           ({ROOT} is a per-run temp dir)
 *     commands.allow  git ls cat npm echo env sudo
 *                     (env and sudo are listed ON PURPOSE: the static
 *                     blocklist must beat the allowlist, ADR-0015 section 3)
 *
 *   permissions, user layer (index = position in this list)
 *     0  Bash  match 'git push --force*'            deny
 *     1  Bash  match 'git push*'                    ask
 *     2  Bash  match 'rm *'                         deny
 *     3  Read  match '{ROOT}/work/secrets/*'        deny
 *     4  Write match '{ROOT}/work/config/*'         ask
 *     5  mcp__*                                     ask
 *     6  Bash  match 'git *'                        allow
 *     7  WebFetch                                   deny
 *     8  Read  match '{ROOT}/work/.env'             deny    (exact, no glob)
 *   permissions, project layer
 *     0  Bash  match 'git push*'                    allow   (tries to loosen user rule 1)
 *     1  Bash  match 'npm publish*'                 deny    (tightens)
 *   defaultDecision: unset (allow, ADR-0014 section 3)
 *
 * No prompter is wired, as in the shipped CLI, so an 'ask' verdict is a
 * refusal (ADR-0014 section 4). Rows are labelled ask to keep the policy
 * intent visible; the test asserts the fail-closed refusal AND the ask rule.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TOOL_TARGET_FIELDS } from '../src/internal/tool-targets.js';
import { createHookRuntime } from '../src/hooks/index.js';
import type { HookRuntime } from '../src/hooks/index.js';
import {
  createPermissionEvaluator,
  createSandbox,
  mergeLayers,
  mergeSandboxLayers,
  parsePermissionSettings,
  parseSandboxSettings,
  permissionHook,
  sandboxHook,
} from '../src/security/index.js';
import { POLICY_ROWS } from './policy-corpus.rows.js';
import type { PolicyRow } from './policy-corpus.rows.js';

const ROOT_TOKEN = '{ROOT}';
const ASK_TAIL = "'ask' with no prompter configured";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'policy-corpus-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function substitute(value: unknown): unknown {
  if (typeof value === 'string') return value.split(ROOT_TOKEN).join(root);
  if (Array.isArray(value)) return value.map(substitute);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
  }
  return value;
}

function fixtureDocs(): { user: unknown; project: unknown } {
  const user = {
    sandbox: {
      paths: { allow: [`${root}/work`] },
      commands: { allow: ['git', 'ls', 'cat', 'npm', 'echo', 'env', 'sudo'] },
    },
    permissions: {
      rules: [
        { tool: 'Bash', match: 'git push --force*', decision: 'deny' },
        { tool: 'Bash', match: 'git push*', decision: 'ask' },
        { tool: 'Bash', match: 'rm *', decision: 'deny' },
        { tool: 'Read', match: `${root}/work/secrets/*`, decision: 'deny' },
        { tool: 'Write', match: `${root}/work/config/*`, decision: 'ask' },
        { tool: 'mcp__*', decision: 'ask' },
        { tool: 'Bash', match: 'git *', decision: 'allow' },
        { tool: 'WebFetch', decision: 'deny' },
        { tool: 'Read', match: `${root}/work/.env`, decision: 'deny' },
      ],
    },
  };
  const project = {
    permissions: {
      rules: [
        { tool: 'Bash', match: 'git push*', decision: 'allow' },
        { tool: 'Bash', match: 'npm publish*', decision: 'deny' },
      ],
    },
  };
  return { user, project };
}

function composedRuntime(): HookRuntime {
  const { user, project } = fixtureDocs();
  const permissions = mergeLayers(parsePermissionSettings(user), parsePermissionSettings(project));
  const sandbox = mergeSandboxLayers(parseSandboxSettings(user), parseSandboxSettings(project));
  const hooks = createHookRuntime();
  // Same order as the composition root: permissions first, sandbox as backstop.
  hooks.register('pre-tool', permissionHook(createPermissionEvaluator(permissions)));
  hooks.register('pre-tool', sandboxHook(createSandbox(sandbox)));
  return hooks;
}

async function run(row: PolicyRow): Promise<{ denied: boolean; reason: string }> {
  const result = await composedRuntime().fire('pre-tool', {
    event: 'pre-tool',
    tool: row.tool,
    args: substitute(row.input),
    redactions: [],
  });
  return result.denied
    ? { denied: true, reason: result.reason }
    : { denied: false, reason: '' };
}

function expectedFragment(row: PolicyRow): string {
  const { rule, tool } = row;
  if (rule.startsWith('perm:')) {
    const [, layer, index] = rule.split(':');
    // The reason names the winning RULE's tool pattern (mcp__*), not the call's.
    const docs = fixtureDocs() as Record<string, { permissions: { rules: { tool: string }[] } }>;
    const ruleTool = docs[layer ?? '']?.permissions.rules[Number(index)]?.tool;
    return `permission: ${row.expect} ${ruleTool} [rule ${index}, ${layer}]`;
  }
  const field = TOOL_TARGET_FIELDS[tool]?.field;
  if (field === undefined) throw new Error(`${tool} is not a gated tool; rule ${rule} cannot apply`);
  const fragments: Record<string, string> = {
    'sandbox:command': `sandbox: ${tool} ${field} not in allowlist`,
    'sandbox:path': `sandbox: ${tool} ${field} not in allowlist`,
    'sandbox:no-target': `sandbox: ${tool} has no ${field}; this mode has no`,
    'sandbox:not-string': `sandbox: ${tool} ${field} is not a string; refusing to guess`,
  };
  const fragment = fragments[rule];
  if (fragment === undefined) throw new Error(`no fragment for rule ${rule}`);
  return fragment;
}

describe('policy corpus: shape', () => {
  it('has the volume and the mix the issue asks for', () => {
    expect(POLICY_ROWS.length).toBeGreaterThanOrEqual(40);
    expect(POLICY_ROWS.length).toBeLessThanOrEqual(80);
    for (const verdict of ['allow', 'ask', 'deny'] as const) {
      expect(POLICY_ROWS.some((r) => r.expect === verdict)).toBe(true);
    }
    expect(POLICY_ROWS.filter((r) => r.note.startsWith('NEGATIVE CONTROL')).length).toBeGreaterThanOrEqual(5);
  });

  it('every row names its rule: allow rows none, every other row a real rule id', () => {
    for (const row of POLICY_ROWS) {
      expect(row.rule === 'none', `${row.tool} ${JSON.stringify(row.input)}`).toBe(row.expect === 'allow');
      if (row.expect === 'ask') expect(row.rule.startsWith('perm:')).toBe(true);
    }
  });

  it('the composition under test is the one the CLI registers (order and members)', () => {
    const expected = [
      "hooks.register('pre-tool', permissionHook(createPermissionEvaluator(security.permissions)));",
      "hooks.register('pre-tool', sandboxHook(createSandbox(security.sandbox)));",
    ];
    for (const file of ['../src/cli.ts', '../src/cli/eval-command.ts']) {
      // Comment lines are dropped first, so a commented-out registration
      // cannot satisfy the pin. The behavioural `rm -rf /` row (perm:user:2,
      // where the sandbox would also refuse) pins the same order by outcome.
      const text = readFileSync(new URL(file, import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      const first = text.indexOf(expected[0] ?? '');
      const second = text.indexOf(expected[1] ?? '');
      expect(first, `${file} registers permissionHook`).toBeGreaterThanOrEqual(0);
      expect(second, `${file} registers sandboxHook after it`).toBeGreaterThan(first);
    }
  });
});

describe('policy corpus: rows through the composed pre-tool path', () => {
  it.each(POLICY_ROWS.map((row) => [`${row.expect} ${row.tool} ${JSON.stringify(row.input)}`, row] as const))(
    '%s',
    async (_label, row) => {
      const outcome = await run(row);
      if (row.expect === 'allow') {
        expect(outcome.denied, `${row.note}: ${outcome.reason}`).toBe(false);
        return;
      }
      expect(outcome.denied, row.note).toBe(true);
      expect(outcome.reason, row.note).toContain(expectedFragment(row));
      if (row.expect === 'ask') expect(outcome.reason).toContain(ASK_TAIL);
      else expect(outcome.reason).not.toContain(ASK_TAIL);
    },
  );

  it('a sandbox-attributed deny is the sandbox alone: the permission layer lets the row through', async () => {
    const { user, project } = fixtureDocs();
    const evaluator = createPermissionEvaluator(
      mergeLayers(parsePermissionSettings(user), parsePermissionSettings(project)),
    );
    for (const row of POLICY_ROWS.filter((r) => r.rule.startsWith('sandbox:'))) {
      const verdict = evaluator.evaluate(row.tool, substitute(row.input));
      expect(verdict.decision, `${row.tool} ${JSON.stringify(row.input)}`).toBe('allow');
    }
  });

  it('a rule-attributed row names the rule that wins, not just one that matches', async () => {
    const { user, project } = fixtureDocs();
    const evaluator = createPermissionEvaluator(
      mergeLayers(parsePermissionSettings(user), parsePermissionSettings(project)),
    );
    for (const row of POLICY_ROWS.filter((r) => r.rule.startsWith('perm:'))) {
      const verdict = evaluator.evaluate(row.tool, substitute(row.input));
      expect(`perm:${verdict.layer}:${verdict.ruleIndex}`, row.note).toBe(row.rule);
      expect(verdict.decision, row.note).toBe(row.expect);
    }
  });
});
