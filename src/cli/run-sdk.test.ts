import { describe, expect, it } from 'vitest';

import { sdkStartLine } from './run-sdk.js';

describe('sdkStartLine (#140, ADR-0040 D2)', () => {
  it('is null for the default', () => {
    expect(sdkStartLine([])).toBeNull();
  });

  it('pins the literal, with the members in canonical order whatever the file order', () => {
    expect(sdkStartLine(['local', 'user'])).toBe(
      '[harness] claude code settings: inherited (user, local); their permission rules, hooks, plugins, MCP servers and CLAUDE.md files apply to this run',
    );
    expect(sdkStartLine(['user', 'project', 'local'])).toBe(
      '[harness] claude code settings: inherited (user, project, local); their permission rules, hooks, plugins, MCP servers and CLAUDE.md files apply to this run',
    );
  });
});
