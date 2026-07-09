import { describe, expect, it } from 'vitest';

// Proves the no-restricted-imports layering rules in eslint.config.js
// actually fire (review finding F1): architecture.md treats a layering
// violation as a build failure, so the guarantee must be tested, not assumed.

async function lintViolations(filePath: string, code: string): Promise<string[]> {
  const { loadESLint } = await import('eslint');
  const ESLint = await loadESLint(); // flat config is the default in ESLint 9
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

describe('eslint layering rules', () => {
  it('blocks a leaf module importing the session orchestrator', async () => {
    const violations = await lintViolations(
      'src/telemetry/bad-import.ts',
      "import { createSession } from '../session/index.js';\ncreateSession;\n",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('blocks telemetry importing hooks (peer-leaf rule)', async () => {
    const violations = await lintViolations(
      'src/telemetry/bad-import.ts',
      "import { createHookRuntime } from '../hooks/index.js';\ncreateHookRuntime;\n",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('allows telemetry importing the shared internal leaf', async () => {
    const violations = await lintViolations(
      'src/telemetry/good-import.ts',
      "import { sanitizeControlChars } from '../internal/sanitize.js';\nsanitizeControlChars;\n",
    );
    expect(violations).toEqual([]);
  });

  it('blocks the internal leaf importing ANY sibling domain (zero-dep guarantee)', async () => {
    // internal is the shared leaf both security modules rely on (settings
    // mechanics, tool-target table); an import in the other direction would
    // invert the leaf relationship silently.
    for (const [name, statement] of [
      ['security', "import { scan } from '../security/index.js';\nscan;\n"],
      ['hooks', "import { createHookRuntime } from '../hooks/index.js';\ncreateHookRuntime;\n"],
      ['telemetry', "import { createTelemetryStore } from '../telemetry/index.js';\ncreateTelemetryStore;\n"],
    ] as const) {
      const violations = await lintViolations('src/internal/bad-import.ts', statement);
      expect(violations.length, `internal importing ${name} must be blocked`).toBeGreaterThan(0);
    }
  });

  it('blocks the security layer importing a harness module (router)', async () => {
    const violations = await lintViolations(
      'src/security/injection/bad-import.ts',
      "import { route } from '../../router/index.js';\nroute;\n",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('allows the security layer importing the shared internal leaf', async () => {
    const violations = await lintViolations(
      'src/security/injection/good-import.ts',
      "import { sanitizeControlChars } from '../../internal/sanitize.js';\nsanitizeControlChars;\n",
    );
    expect(violations).toEqual([]);
  });

  it('blocks the security layer importing the eval layer (upward violation)', async () => {
    const violations = await lintViolations(
      'src/security/injection/bad-import.ts',
      "import { runCorpus } from '../../eval/index.js';\nrunCorpus;\n",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('blocks a leaf module importing the eval layer via a NESTED path (globstar)', async () => {
    const violations = await lintViolations(
      'src/telemetry/bad-import.ts',
      "import { createGoldenRunner } from '../eval/golden/runner.js';\ncreateGoldenRunner;\n",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('blocks the session orchestrator importing eval', async () => {
    const violations = await lintViolations(
      'src/session/bad-import.ts',
      "import { createGoldenRunner } from '../eval/golden/runner.js';\ncreateGoldenRunner;\n",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('blocks security importing eval via a nested path', async () => {
    const violations = await lintViolations(
      'src/security/injection/bad-import.ts',
      "import { toCanonicalJson } from '../../eval/scorecard/canonical.js';\ntoCanonicalJson;\n",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('allows eval importing session and security (top of the dependency order)', async () => {
    const violations = await lintViolations(
      'src/eval/golden/good-import.ts',
      "import { createSession } from '../../session/index.js';\nimport { redact } from '../../security/index.js';\ncreateSession;\nredact;\n",
    );
    expect(violations).toEqual([]);
  });
});
