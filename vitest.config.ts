import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
        'src/skills/__fixtures__/**',
        'src/**/*.test.ts',
      ],
    },
  },
});
