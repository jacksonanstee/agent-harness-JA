import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Child processes, not worker threads: locally under Node 26 and vitest
    // 1.6.1 the threads pool crashed the suite with SIGSEGV (exit 139), on main
    // too, while forks passed it. Root cause unconfirmed (the #175 flake in
    // scripts/check-test-count.sh may be the same). CI (Node 20/22) passed on
    // threads. Forks changes isolation: process.chdir now works in a test but
    // leaks cwd to the rest of its file.
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
