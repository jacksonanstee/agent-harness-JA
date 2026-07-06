import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Sanitizers in hooks/router/skills intentionally match control characters.
      'no-control-regex': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // Dependency direction (docs/architecture.md): leaf harness modules must not
  // import the orchestrator (session) or the CLI. Extend as layers land.
  {
    files: [
      'src/router/**',
      'src/skills/**',
      'src/hooks/**',
      'src/memory/**',
      'src/telemetry/**',
      'src/internal/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['**/session/*', '**/session', '**/cli', '**/cli.js'] },
      ],
    },
  },
  // Telemetry and hooks are peer leaf modules: hooks feeds telemetry through an
  // injected sink adapter in the composition root (cli), never via imports.
  {
    files: ['src/telemetry/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '**/session/*',
            '**/session',
            '**/cli',
            '**/cli.js',
            '**/hooks/*',
            '**/hooks',
          ],
        },
      ],
    },
  },
  // Security sits BELOW the harness layer (eval → harness → security → SDK):
  // it must not import any harness module or the orchestrator/CLI. The LLM
  // judge (S-5) calls the SDK directly via an injected dependency. Security
  // may import src/internal/ (zero-dep shared leaf).
  {
    files: ['src/security/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '**/session/*',
            '**/session',
            '**/cli',
            '**/cli.js',
            '**/router/*',
            '**/router',
            '**/skills/*',
            '**/skills',
            '**/hooks/*',
            '**/hooks',
            '**/memory/*',
            '**/memory',
            '**/telemetry/*',
            '**/telemetry',
          ],
        },
      ],
    },
  },
);
