import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// V16 regression pin: Node package self-reference is only legal when
// package.json declares an `exports` map, so every resolution below exercises
// the shipped map itself. createRequire gives plain Node resolution, immune to
// vitest's resolver. Resolution targets dist/, so a build must exist; CI runs
// build before test (ci.yml), same order as prepublishOnly.
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const nodeRequire = createRequire(import.meta.url);

const resolutionErrorCode = (specifier: string): string => {
  try {
    nodeRequire.resolve(specifier);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'NO_CODE';
  }
  return 'RESOLVED';
};

describe('package.json exports map (self-reference)', () => {
  it('has a built dist to resolve against', () => {
    expect(
      existsSync(resolve(packageRoot, 'dist/index.js')),
      'dist/index.js missing: run `npm run build` first (CI builds before test)',
    ).toBe(true);
  });

  it('resolves the bare specifier to the root barrel', () => {
    expect(nodeRequire.resolve('agent-harness-ja')).toBe(resolve(packageRoot, 'dist/index.js'));
  });

  it('refuses deep imports into dist with ERR_PACKAGE_PATH_NOT_EXPORTED', () => {
    expect(resolutionErrorCode('agent-harness-ja/dist/internal/sanitize.js')).toBe(
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
    );
    expect(resolutionErrorCode('agent-harness-ja/dist/security/index.js')).toBe(
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
    );
    expect(resolutionErrorCode('agent-harness-ja/dist/cli.js')).toBe(
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
    );
  });

  it('still exposes ./package.json', () => {
    expect(nodeRequire.resolve('agent-harness-ja/package.json')).toBe(
      resolve(packageRoot, 'package.json'),
    );
  });
});
