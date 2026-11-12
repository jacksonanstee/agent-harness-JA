import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Child processes, not worker threads: under Node 26 the threads pool
    // crashes the whole run with SIGSEGV (exit 139), on main as well as on
    // branches, while forks passes the same suite. CI's Node 20/22 ran either.
    pool: 'forks',
    // Spec D8a, pin 30: the keyless guard runs in every worker.
    setupFiles: ['./test/sdk-guard.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: [
        // Re-export barrels: no logic, only import/export statements.
        'src/index.ts',
        'src/**/index.ts',
        // Type declarations only — no runtime code for v8 to observe.
        'src/skills/types.ts',
        'src/hooks/types.ts',
        'src/memory/types.ts',
        'src/telemetry/types.ts',
        'src/security/injection/types.ts',
        'src/security/secrets/types.ts',
        'src/skills/__fixtures__/**',
        'src/**/*.test.ts',
      ],
    },
  },
});
