import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TELEMETRY_EVENT_TYPES } from '../telemetry/index.js';

import { readPackageVersion, USAGE } from './shared.js';

describe('USAGE', () => {
  /**
   * Asserts the RENDERED substring rather than looping `toContain(type)` over
   * the array. The loop form is a floorless subset check: an empty
   * TELEMETRY_EVENT_TYPES runs the body zero times and passes vacuously. The
   * rendered form cannot — an empty array joins to `''` and the expected
   * substring becomes `--type <>`, which USAGE does not contain. It is also
   * strictly stronger: a partial enumeration or a reordering fails too.
   *
   * ANCHORED TO THE `telemetry export` LINE, not to USAGE as a whole. Against
   * the whole blob the assertion is position-independent: interpolating onto
   * the `run` line while reverting this one to the literal `<t>` advertises
   * `--type` on a command that does not take it, leaves the command that DOES
   * need it undiscoverable, and still passes (Task 6 review finding).
   *
   * What it CANNOT prove is that USAGE derives the list rather than
   * hand-copying it — no test can, since both produce the same bytes. What it
   * does buy is the drift catch: add a fifth event type and a hand-copied
   * USAGE goes RED here.
   */
  it('enumerates every valid --type value on the telemetry line, from the same source of truth the validator uses', () => {
    const telemetryLine = USAGE.split('\n').find((line) => line.includes('telemetry export'));
    expect(telemetryLine).toBeDefined();
    expect(telemetryLine).toContain(`--type <${TELEMETRY_EVENT_TYPES.join('|')}>`);
  });
});

describe('readPackageVersion', () => {
  it('pins to the version in the repo package.json (catches ../package.json depth mistakes)', () => {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version: string };
    expect(readPackageVersion()).toBe(parsed.version);
  });
});
