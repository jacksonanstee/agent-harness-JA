import { describe, expect, it } from 'vitest';

import { parseRunArgs } from './cli.js';
import { DEFAULT_DB_PATH } from './memory/index.js';

describe('parseRunArgs', () => {
  it('parses a bare run command with defaults', () => {
    const parsed = parseRunArgs(['run', 'say hello']);
    expect(parsed).toEqual({
      ok: true,
      value: {
        command: 'run',
        prompt: 'say hello',
        skillsDir: './skills',
        dbPath: DEFAULT_DB_PATH,
        maxTurns: 10,
      },
    });
  });

  it('parses all flags', () => {
    const parsed = parseRunArgs([
      'run',
      'hi',
      '--skills-dir',
      '/tmp/skills',
      '--db',
      '/tmp/mem.db',
      '--max-turns',
      '3',
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.skillsDir).toBe('/tmp/skills');
      expect(parsed.value.dbPath).toBe('/tmp/mem.db');
      expect(parsed.value.maxTurns).toBe(3);
    }
  });

  it('rejects an unknown command', () => {
    const parsed = parseRunArgs(['serve']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Unknown command 'serve'");
  });

  it('rejects a missing prompt', () => {
    expect(parseRunArgs(['run']).ok).toBe(false);
    expect(parseRunArgs(['run', '  ']).ok).toBe(false);
  });

  it('rejects a flag with no value', () => {
    const parsed = parseRunArgs(['run', 'hi', '--db']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('--db');
  });

  it('rejects unknown flags and extra positionals', () => {
    expect(parseRunArgs(['run', 'hi', '--verbose']).ok).toBe(false);
    expect(parseRunArgs(['run', 'hi', 'there']).ok).toBe(false);
  });

  it('rejects a non-positive --max-turns', () => {
    expect(parseRunArgs(['run', 'hi', '--max-turns', '0']).ok).toBe(false);
    expect(parseRunArgs(['run', 'hi', '--max-turns', 'abc']).ok).toBe(false);
  });
});
