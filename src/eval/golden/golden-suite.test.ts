import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadOracle } from './oracle.js';
import { parseTaskFile } from './task.js';
import type { SessionResult } from '../../session/index.js';

// Keyless pins on the SHIPPED golden suite (#213): every task parses, every
// oracle loads, and the tool-using task's oracle can tell a read from a guess.
const SUITE = join(process.cwd(), 'eval', 'golden');
const taskFiles = readdirSync(SUITE).filter((name) => name.endsWith('.task.md')).sort();

const result = (over: Partial<SessionResult>): SessionResult =>
  ({ resultSubtype: 'success', resultText: '', ...over }) as SessionResult;

describe('the shipped golden suite (eval/golden)', () => {
  it('has the three tasks, including one that needs a tool', () => {
    expect(taskFiles).toEqual(['hello-world.task.md', 'no-tools-needed.task.md', 'read-fixture.task.md']);
  });

  it.each(taskFiles)('%s parses and its oracle loads', async (name) => {
    const parsed = parseTaskFile(join(SUITE, name));
    if (!parsed.ok) throw new Error(parsed.message);
    await expect(loadOracle(parsed.value.oraclePath)).resolves.toBeTypeOf('function');
  });

  it('read-fixture: the prompt names the fixture, and the oracle passes only on its code word', async () => {
    const parsed = parseTaskFile(join(SUITE, 'read-fixture.task.md'));
    if (!parsed.ok) throw new Error(parsed.message);
    const fixture = readFileSync(join(SUITE, 'fixtures', 'read-fixture.txt'), 'utf8');
    const word = fixture.split('\n')[1]?.trim() ?? '';
    expect(word).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
    expect(parsed.value.prompt).toContain('eval/golden/fixtures/read-fixture.txt');
    expect(parsed.value.prompt).not.toContain(word);
    // The word lives in the fixture alone: not in the task, not in the oracle (docs-parity D2).
    expect(readFileSync(join(SUITE, 'read-fixture.oracle.mjs'), 'utf8')).not.toContain(word);
    const oracle = await loadOracle(parsed.value.oraclePath);
    expect((await oracle(result({ resultText: `  ${word.toUpperCase()}\n` }))).pass).toBe(true);
    expect((await oracle(result({ resultText: 'I could not read the file.' }))).pass).toBe(false);
    expect((await oracle(result({ resultText: word, resultSubtype: 'error_max_turns' }))).pass).toBe(false);
  });
});
