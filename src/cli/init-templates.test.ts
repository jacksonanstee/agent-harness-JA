// Semantic-validity tests: the scaffolded starter must parse under the REAL
// loaders (skills validate, both settings parsers, golden-task parser, oracle
// contract), not just contain the right substrings. A template that drifts
// from any schema fails here, keyless, on every PR.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOracle, parseTaskFile } from '../eval/index.js';
import {
  parsePermissionSettings,
  parseSandboxSettings,
} from '../security/index.js';
import type { SessionResult } from '../session/index.js';
import { validate } from '../skills/index.js';
import { INIT_FILES, INIT_README, INIT_SETTINGS_JSON } from './init-templates.js';
import { runInit } from './init-command.js';

// Fully-typed SessionResult so a rename of any field the scaffolded oracle
// reads (resultSubtype/numTurns/resultText) fails compilation here rather
// than leaving the oracle silently reading undefined in every real eval.
function sessionResult(overrides: Partial<SessionResult>): SessionResult {
  return {
    resultText: null,
    resultSubtype: null,
    sessionId: 'test-session',
    modelChoice: { model: 'claude-sonnet-4-6', rule_id: 'test', reason: 'test' },
    usage: null,
    costUsd: null,
    numTurns: null,
    denied: [],
    memoryEntryId: null,
    skillErrors: [],
    ...overrides,
  };
}

let target: string;

beforeAll(() => {
  target = join(mkdtempSync(join(tmpdir(), 'init-tpl-')), 'starter');
  const code = runInit(
    { command: 'init', dir: target },
    { stdout: () => {}, stderr: () => {} },
  );
  expect(code).toBe(0);
});

afterAll(() => {
  rmSync(join(target, '..'), { recursive: true, force: true });
});

describe('scaffolded skill', () => {
  it('passes the real skills validate()', () => {
    const result = validate(join(target, 'skills', 'getting-started.md'));
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('getting-started');
    }
  });
});

describe('scaffolded settings', () => {
  it('parses under BOTH real settings parsers', () => {
    const doc: unknown = JSON.parse(INIT_SETTINGS_JSON);
    const permissions = parsePermissionSettings(doc);
    expect(() => parseSandboxSettings(doc)).not.toThrow();
    expect(permissions.rules).toHaveLength(2);
    expect(permissions.rules.map((r) => r.tool).sort()).toEqual(['WebFetch', 'WebSearch']);
    expect(permissions.rules.every((r) => r.decision === 'deny')).toBe(true);
  });

  it('omits defaultDecision (R-8: the one project-overrides-user scalar)', () => {
    const parsed = JSON.parse(INIT_SETTINGS_JSON) as Record<string, unknown>;
    const permissions = parsed.permissions as Record<string, unknown>;
    expect('defaultDecision' in permissions).toBe(false);
  });
});

describe('scaffolded golden task', () => {
  it('parses under the real golden-task parser with the pinned id and turns', () => {
    const parsed = parseTaskFile(join(target, 'hello-harness.task.md'));
    expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.id).toBe('hello-harness');
      expect(parsed.value.maxTurns).toBe(5);
      expect(parsed.value.prompt).toContain('without');
      expect(parsed.value.prompt.toLowerCase()).toContain('tool');
    }
  });
});

describe('scaffolded oracle', () => {
  it('satisfies the oracle contract and passes a grounded 1-turn answer', async () => {
    const oracle = await loadOracle(join(target, 'hello-harness.oracle.mjs'));
    const verdict = await oracle(
      sessionResult({
        resultSubtype: 'success',
        numTurns: 1,
        resultText:
          'The policy denies WebFetch and WebSearch. Before running eval on a ' +
          'project you did not create, read the oracle file first.',
      }),
    );
    expect(verdict).toEqual({ pass: true });
  });

  it('fails a multi-turn answer with a plain-language turns explanation', async () => {
    const oracle = await loadOracle(join(target, 'hello-harness.oracle.mjs'));
    const verdict = await oracle(
      sessionResult({
        resultSubtype: 'success',
        numTurns: 3,
        resultText: 'The policy denies WebFetch and WebSearch. Read the oracle file.',
      }),
    );
    expect(verdict.pass).toBe(false);
    if (!verdict.pass) {
      expect(verdict.reason).toMatch(/turn/i);
      expect(verdict.reason).toMatch(/tool/i);
    }
  });

  it('fails an answer that misses the denied tools', async () => {
    const oracle = await loadOracle(join(target, 'hello-harness.oracle.mjs'));
    const verdict = await oracle(
      sessionResult({
        resultSubtype: 'success',
        numTurns: 1,
        resultText: 'It denies some tools. Read the oracle first.',
      }),
    );
    expect(verdict.pass).toBe(false);
  });
});

describe('scaffolded README', () => {
  it('carries the required honesty and safety content', () => {
    expect(INIT_README).toContain('R-10');
    expect(INIT_README).toContain('https://console.anthropic.com/settings/keys');
    // Route-around honesty: names the Bash curl route around the network
    // deny and shows the one-line tighten.
    expect(INIT_README).toContain('Bash');
    expect(INIT_README).toContain('"tool": "Bash", "decision": "deny"');
    // Guided trip-the-denial demo.
    expect(INIT_README.toLowerCase()).toContain('denied');
    // Turns-failure explainer for the numTurns === 1 pin.
    expect(INIT_README).toContain('1-turn');
    // Ancestor-gitignore caveat.
    expect(INIT_README).toContain('check-ignore');
    // Keyless-CI invariant carried through.
    expect(INIT_README).toContain('redteam');
    expect(INIT_README.toLowerCase()).toContain('never');
  });

  it('no template contains an em-dash (voice rule)', () => {
    for (const file of INIT_FILES) {
      expect(file.content.includes('—'), `em-dash in ${file.path}`).toBe(false);
    }
  });
});
