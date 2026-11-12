import { describe, expect, it } from 'vitest';

import { CODE_EXECUTING_TOOLS } from '../internal/tool-targets.js';
import { CODE_EXECUTION_DENY_REASON, codeExecutionDenial, CodeExecutionDenied, MONITOR_DENY_REASON } from './code-execution-deny.js';

describe('codeExecutionDenial (#211, ADR-0040 D-8; a toolNameDenyHook step since #230): a built-in deny for tools no gate can check and the CLI allows', () => {
  // "Whatever the arguments" is now structural (the function takes only the name) and is pinned on
  // toolNameDenyHook, whose test hands it arguments that throw on any read.
  it('denies REPL with the fixed reason', () => {
    expect(codeExecutionDenial('REPL')).toBeInstanceOf(CodeExecutionDenied);
    expect(codeExecutionDenial('REPL')?.message).toBe(CODE_EXECUTION_DENY_REASON);
  });

  // #248: Monitor's output reaches the model as task-notification text that no hook sees, so it is refused
  // like REPL, with its own reason (owner, 12/11/2026): it is the output, not the code, that no gate can check.
  it('denies Monitor with its own fixed reason (#248)', () => {
    expect(codeExecutionDenial('Monitor')).toBeInstanceOf(CodeExecutionDenied);
    expect(codeExecutionDenial('Monitor')?.message).toBe(MONITOR_DENY_REASON);
  });

  // Literal pins, not the constants compared to themselves: swapping the two texts, or giving both
  // tools one text, fails here.
  it('the two reasons are the pinned texts: REPL keeps its #211 wording, Monitor has the #248 one', () => {
    expect(codeExecutionDenial('REPL')?.message).toBe(
      'built-in deny: this tool runs code that no harness gate can check, so the harness refuses it whatever the rules say (ADR-0040 D-8)',
    );
    expect(codeExecutionDenial('Monitor')?.message).toBe(
      'built-in deny: Monitor delivers command output outside a tool result, so no harness gate can check it (#248)',
    );
  });

  it('passes the tools whose gate is not `denied` (the permission and sandbox gates decide them)', () => {
    for (const tool of ['Bash', 'Workflow', 'Read', 'mcp__x__y', 'repl', 'REPL ', 'monitor', 'Monitor ']) {
      expect(codeExecutionDenial(tool), tool).toBeUndefined();
    }
  });

  it('denies exactly the `denied` members of CODE_EXECUTING_TOOLS (a future one is covered with no edit here)', () => {
    const denied = Object.entries(CODE_EXECUTING_TOOLS)
      .filter(([, gate]) => gate === 'denied')
      .map(([tool]) => tool);
    expect([...denied].sort()).toEqual(['Monitor', 'REPL']);
    for (const [tool, gate] of Object.entries(CODE_EXECUTING_TOOLS)) {
      if (gate === 'denied') expect(codeExecutionDenial(tool), tool).toBeInstanceOf(CodeExecutionDenied);
      else expect(codeExecutionDenial(tool), tool).toBeUndefined();
    }
  });

  it('the reason names no argument (ADR-0031) and says why', () => {
    expect(CODE_EXECUTION_DENY_REASON).toMatch(/^built-in deny: /);
    expect(CODE_EXECUTION_DENY_REASON).toContain('ADR-0040 D-8');
    expect(MONITOR_DENY_REASON).toMatch(/^built-in deny: /);
    expect(MONITOR_DENY_REASON).toContain('#248');
    expect(MONITOR_DENY_REASON).not.toBe(CODE_EXECUTION_DENY_REASON);
  });

  it('the reason is fixed per tool: Monitor gets its own text, REPL and the default constructor the shared one', () => {
    expect(codeExecutionDenial('Monitor')?.message).toBe(MONITOR_DENY_REASON);
    expect(codeExecutionDenial('REPL')?.message).toBe(CODE_EXECUTION_DENY_REASON);
    expect(new CodeExecutionDenied().message).toBe(CODE_EXECUTION_DENY_REASON);
  });
});
