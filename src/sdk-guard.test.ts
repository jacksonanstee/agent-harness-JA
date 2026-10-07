import { describe, expect, it } from 'vitest';

import { loadSdkQuery, SDK_PACKAGE } from './cli/shared.js';

// Spec D8a, pin 30. Unsetting ANTHROPIC_API_KEY is not keyless on a machine
// logged in to Claude Code (decision log, Guardian G-11), so the unit suite
// must never load the SDK entry point at runtime at all. The guard lives in
// test/sdk-guard.setup.ts (vitest setupFiles); these tests prove it is
// installed and that the production loader goes through it. Type-only
// imports of the SDK (sdk-types.test.ts, sdk-contract.test.ts) are erased at
// compile time and never reach it.

interface GuardState {
  loads: number;
  expected: number;
}

function guard(): GuardState {
  const state = (globalThis as { __harnessSdkGuard?: GuardState }).__harnessSdkGuard;
  if (state === undefined) throw new Error('the D8a SDK guard is not installed (vitest.config.ts setupFiles)');
  return state;
}

describe('keyless unit suite (spec D8a, pin 30)', () => {
  it('the guard is installed in this worker and has seen no load', () => {
    expect(guard().loads).toBe(0);
  });

  it('a runtime import of the SDK package is refused and counted', async () => {
    guard().expected = 1;
    await expect(import(SDK_PACKAGE)).rejects.toThrow();
    expect(guard().loads).toBe(1);
  });

  it('the production loader (loadSdkQuery, default importer) is refused the same way', async () => {
    guard().expected = 1;
    await expect(loadSdkQuery()).rejects.toThrow();
    expect(guard().loads).toBe(1);
  });
});
