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
        {
          patterns: [
            '**/session/*',
            '**/session',
            '**/cli',
            '**/cli.js',
            '**/cli/**',
            '**/eval/**',
            '**/eval',
          ],
        },
      ],
    },
  },
  // src/internal is the ZERO-DEP shared leaf (sanitize, settings mechanics,
  // tool-target table): every other domain may import it, it imports nothing.
  {
    files: ['src/internal/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '**/router/*', '**/router',
            '**/skills/*', '**/skills',
            '**/hooks/*', '**/hooks',
            '**/memory/*', '**/memory',
            '**/telemetry/*', '**/telemetry',
            '**/security/*', '**/security',
            '**/session/*', '**/session',
            '**/cli', '**/cli.js', '**/cli/**',
            '**/eval/**', '**/eval',
          ],
        },
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
            '**/cli/**',
            '**/hooks/*',
            '**/hooks',
            '**/eval/**',
            '**/eval',
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
            '**/cli/**',
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
            '**/eval/**',
            '**/eval',
          ],
        },
      ],
    },
  },
  // Session is the harness orchestrator: below eval, above the leaves. It
  // must not import the eval layer (which drives IT) or the CLI. The CLI
  // (src/cli.ts) is the composition root and is deliberately exempt from all
  // layering blocks — it wires every layer together.
  {
    files: ['src/session/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['**/eval/**', '**/eval', '**/cli', '**/cli.js', '**/cli/**'] },
      ],
    },
  },
  // Eval sits directly under the composition root: cli.ts imports eval, so
  // eval importing the CLI back would be a real ESM cycle.
  {
    files: ['src/eval/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/cli', '**/cli.js', '**/cli/**'] }],
    },
  },
  // Intra-eval direction (Week-4; closes the E-3 review3 MEDIUM): scorecard/
  // is the producer-agnostic core — producers (golden, redteam) and the
  // verifier import IT, never the reverse. NOTE: flat-config
  // no-restricted-imports OVERRIDES rather than merges (the known telemetry
  // peer-ban gap), so this block must restate the eval-wide CLI ban above.
  {
    files: ['src/eval/scorecard/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '**/cli', '**/cli.js', '**/cli/**',
            '**/golden', '**/golden/**',
            '**/redteam', '**/redteam/**',
            '**/verifier', '**/verifier/**',
          ],
        },
      ],
    },
  },
  // The root barrel is the published library surface (ADR-0023). The CLI
  // composition root (dynamic SDK import, process-level side effects) must
  // never leak into the library import graph through it.
  {
    files: ['src/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['**/cli', '**/cli.js', '**/cli/**'],
        },
      ],
    },
  },
);
