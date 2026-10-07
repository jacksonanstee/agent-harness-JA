import { afterEach, vi } from 'vitest';

// Spec D8a, pin 30: any RUNTIME load of the SDK entry point in the unit suite
// fails the test that caused it, even when that test catches the import
// error. vitest re-invokes the factory on every import (measured 01/10/2026),
// so each load is counted. A test that loads it on purpose sets `expected`.
const state = vi.hoisted(() => {
  const s = { loads: 0, expected: 0 };
  (globalThis as { __harnessSdkGuard?: typeof s }).__harnessSdkGuard = s;
  return s;
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  state.loads += 1;
  throw new Error(
    'D8a: the unit suite must never load @anthropic-ai/claude-agent-sdk at runtime (pin 30); inject a fake QueryFn instead',
  );
});

afterEach(() => {
  const unexpected = state.loads - state.expected;
  state.loads = 0;
  state.expected = 0;
  if (unexpected > 0) {
    throw new Error(
      `D8a: this test loaded @anthropic-ai/claude-agent-sdk at runtime ${unexpected} time(s); the unit suite must use a fake QueryFn (pin 30)`,
    );
  }
});
