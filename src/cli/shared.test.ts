import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPackageVersion } from './shared.js';

describe('readPackageVersion', () => {
  it('pins to the version in the repo package.json (catches ../package.json depth mistakes)', () => {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version: string };
    expect(readPackageVersion()).toBe(parsed.version);
  });
});
