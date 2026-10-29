import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../cli.js';
import { SELF_PROTECTION_REASON } from '../security/index.js';
import type { QueryFn, SdkHookCallback, SdkMessage } from '../session/index.js';

// Issue #188 (ADR-0042) at the `run` entrypoint: main builds the protected
// roots from the user dir, the cwd, --skills-dir and --db, and registers the
// deny before any rule. The fake SDK drives one PreToolUse callback per call.

const tmp: string[] = [];
const saved = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});
function dir(settings?: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'run-sp-'));
  tmp.push(d);
  if (settings !== undefined) {
    mkdirSync(join(d, '.harness'));
    writeFileSync(join(d, '.harness', 'settings.json'), JSON.stringify(settings));
  }
  return d;
}

interface Dirs {
  userDir: string;
  project: string;
  skills: string;
  db: string;
}

function dirs(): Dirs {
  const outside = dir();
  return {
    // An allow-everything user rule: the deny must not depend on the policy.
    userDir: dir({ permissions: { rules: [{ tool: '*', decision: 'allow' }] } }),
    project: dir(),
    skills: join(outside, 'skills'),
    db: join(outside, 'tel.db'),
  };
}

async function drive(d: Dirs, calls: { tool: string; input: Record<string, unknown> }[]) {
  process.env.ANTHROPIC_API_KEY = 'dummy';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'cwd').mockReturnValue(d.project);
  const outputs: unknown[] = [];
  const query: QueryFn = (args) =>
    (async function* () {
      for (const call of calls) {
        for (const matcher of args.options?.hooks?.PreToolUse ?? []) {
          for (const cb of matcher.hooks as unknown as SdkHookCallback[]) {
            outputs.push(
              await cb({ hook_event_name: 'PreToolUse', tool_name: call.tool, tool_input: call.input, tool_use_id: 'toolu_1' }, 'toolu_1', {
                signal: new AbortController().signal,
              }),
            );
          }
        }
      }
      yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's', num_turns: 1, total_cost_usd: 0.01 } as SdkMessage;
    })();
  const argv = ['run', 'hi', '--skills-dir', d.skills, '--db', d.db];
  const code = await main(argv, { userDir: d.userDir, importSdk: async () => ({ query }), onInterrupt: () => () => undefined });
  return { code, outputs };
}

const DENY = {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: SELF_PROTECTION_REASON },
};

describe('run registers the self-protection deny (#188)', () => {
  it('denies writes to the user settings, the project .harness, --skills-dir and a --db sidecar', async () => {
    const d = dirs();
    const { code, outputs } = await drive(d, [
      { tool: 'Write', input: { file_path: join(d.userDir, '.harness', 'settings.json') } },
      { tool: 'Edit', input: { file_path: join(d.project, '.harness', 'settings.json') } },
      { tool: 'Write', input: { file_path: join(d.skills, 'evil', 'SKILL.md') } },
      { tool: 'Bash', input: { command: `echo x > ${d.db}-wal` } },
    ]);
    expect(code).toBe(0);
    expect(outputs).toEqual([DENY, DENY, DENY, DENY]);
  });

  it('still lets an ordinary project write through to the policy (the allow rule grants it)', async () => {
    const d = dirs();
    const { outputs } = await drive(d, [{ tool: 'Write', input: { file_path: join(d.project, 'notes.md') } }]);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).not.toEqual(DENY);
  });
});
