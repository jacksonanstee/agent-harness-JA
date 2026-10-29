import { describe, expect, it } from 'vitest';

import { CODE_EXECUTING_TOOLS } from '../internal/tool-targets.js';
import { CODE_EXECUTION_DENY_REASON, codeExecutionDenyHook, CodeExecutionDenied } from './code-execution-deny.js';

const preTool = (tool: string, args: unknown) => ({ event: 'pre-tool' as const, tool, args, redactions: null });

describe('codeExecutionDenyHook (#211, ADR-0040 D-8): a built-in deny for tools no gate can check and the CLI allows', () => {
  const hook = codeExecutionDenyHook();

  it('denies REPL with the fixed reason, whatever the arguments', async () => {
    for (const args of [{ code: 'process.exit(0)' }, {}, null, 'x']) {
      await expect(hook(preTool('REPL', args))).rejects.toThrow(CodeExecutionDenied);
      await expect(hook(preTool('REPL', args))).rejects.toThrow(CODE_EXECUTION_DENY_REASON);
    }
  });

  it('passes the tools whose gate is not `denied` (the permission and sandbox gates decide them)', async () => {
    await expect(hook(preTool('Bash', { command: 'git status' }))).resolves.toBeUndefined();
    await expect(hook(preTool('Workflow', { script: 'export const meta = {}' }))).resolves.toBeUndefined();
    await expect(hook(preTool('Read', { file_path: '/x' }))).resolves.toBeUndefined();
    await expect(hook(preTool('mcp__x__y', {}))).resolves.toBeUndefined();
  });

  it('denies exactly the `denied` members of CODE_EXECUTING_TOOLS (a future one is covered with no edit here)', async () => {
    const denied = Object.entries(CODE_EXECUTING_TOOLS)
      .filter(([, gate]) => gate === 'denied')
      .map(([tool]) => tool);
    expect(denied).toEqual(['REPL']);
    for (const [tool, gate] of Object.entries(CODE_EXECUTING_TOOLS)) {
      const outcome = hook(preTool(tool, {}));
      if (gate === 'denied') await expect(outcome, tool).rejects.toThrow(CodeExecutionDenied);
      else await expect(outcome, tool).resolves.toBeUndefined();
    }
  });

  it('the reason names no argument (ADR-0031) and says why', () => {
    expect(CODE_EXECUTION_DENY_REASON).toMatch(/^built-in deny: /);
    expect(CODE_EXECUTION_DENY_REASON).toContain('ADR-0040 D-8');
  });
});
