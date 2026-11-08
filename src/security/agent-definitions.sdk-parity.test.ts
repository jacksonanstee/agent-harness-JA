import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLED_AGENT_NAMES, CLI_FRONTMATTER } from './agent-definitions.js';

// #229 (ADR-0046): BUNDLED_AGENT_NAMES was read from the 0.3.312 binary. This
// checks it still matches the INSTALLED platform binary, as the tool parity
// test does (ADR-0045 D6): a missing binary fails as "could not check", never
// passes. Both checks are tripwires, not proofs: a name check shows the string,
// not a definition, and a count of definition sites stays the same when one
// bundled agent replaces another. The run-time init check is the stronger
// signal: an unknown bundled name is reported there and refused if called.
const PLATFORM_BINARY = join(
  process.cwd(),
  'node_modules',
  '@anthropic-ai',
  `claude-agent-sdk-${process.platform}-${process.arch}`,
  'claude',
);

/** Bundled agent definition objects carry this field exactly once each (0.3.312, read 08/11/2026). */
const DEFINITION_SITE = 'baseDir:"built-in"';
const DEFINITION_SITES_AT_0_3_312 = 11;

function binary(): Buffer {
  expect(existsSync(PLATFORM_BINARY), `could not check: no platform binary at ${PLATFORM_BINARY}`).toBe(true);
  return readFileSync(PLATFORM_BINARY);
}

function countOf(haystack: Buffer, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

describe('BUNDLED_AGENT_NAMES against the installed binary (#229)', () => {
  it('every name is quoted in the binary', () => {
    const bytes = binary();
    expect([...BUNDLED_AGENT_NAMES].filter((name) => !bytes.includes(`"${name}"`))).toEqual([]);
  });

  it(`the binary has exactly ${DEFINITION_SITES_AT_0_3_312} bundled definition sites, one per pinned name`, () => {
    expect(countOf(binary(), DEFINITION_SITE)).toBe(DEFINITION_SITES_AT_0_3_312);
    expect(BUNDLED_AGENT_NAMES.size).toBe(DEFINITION_SITES_AT_0_3_312);
  });

  it('the CLI still splits frontmatter with the regex the scan mirrors, behind the same second-fence precheck', () => {
    const bytes = binary();
    expect(bytes.includes(`/${CLI_FRONTMATTER.source}/`)).toBe(true);
    expect(bytes.includes('indexOf("---",3)<0?null:')).toBe(true);
  });

  it('the checks are not vacuous', () => {
    const bytes = binary();
    expect(bytes.includes('"no-such-agent-#229"')).toBe(false);
    expect(countOf(Buffer.from('a baseDir:"built-in" b baseDir:"built-in"'), DEFINITION_SITE)).toBe(2);
  });
});
