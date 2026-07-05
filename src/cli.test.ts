import { describe, expect, it } from 'vitest';

import { main, parseRunArgs, sanitizeForTerminal } from './cli.js';
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

describe('sanitizeForTerminal', () => {
  it('strips ANSI/OSC escape introducers and C1 controls, keeps newlines and tabs', () => {
    expect(sanitizeForTerminal('a\u001b[31mred\u0007b')).toBe('a [31mred b');
    expect(sanitizeForTerminal('line1\nline2\tend')).toBe('line1\nline2\tend');
  });
});

describe('main (pre-SDK paths)', () => {
  it('returns 2 on invalid arguments without touching the environment', async () => {
    expect(await main(['bogus'])).toBe(2);
  });

  it('returns 2 when ANTHROPIC_API_KEY is unset', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await main(['run', 'hello'])).toBe(2);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
