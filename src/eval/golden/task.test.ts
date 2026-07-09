import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TASK_SENSITIVITIES, TASK_SHAPES } from '../../router/index.js';
import taskSchema from './schema.json' with { type: 'json' };
import { DEFAULT_MAX_TURNS, parseTaskFile } from './task.js';

const here = dirname(fileURLToPath(import.meta.url));
const valid = (name: string) => join(here, '__fixtures__', 'valid', name);
const invalid = (name: string) => join(here, '__fixtures__', 'invalid', name);

describe('parseTaskFile', () => {
  it('parses a full task: id, descriptor, maxTurns, prompt from the body', () => {
    const result = parseTaskFile(valid('hello.task.md'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('hello');
    expect(result.value.prompt).toBe('Reply with exactly the single word: pong');
    expect(result.value.descriptor).toEqual({
      shape: 'lookup',
      sensitivity: 'low',
      expected_tokens: 200,
    });
    expect(result.value.maxTurns).toBe(3);
    expect(result.value.oraclePath).toBe(valid('hello.oracle.mjs'));
  });

  it('defaults maxTurns and skillsDir on a minimal task', () => {
    const result = parseTaskFile(valid('minimal.task.md'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(result.value.skillsDir).toBe(resolve(join(here, '__fixtures__', 'valid', 'skills')));
    expect(result.value.descriptor).toBeUndefined();
  });

  it('rejects an id that violates the pattern, keyed by the frontmatter id', () => {
    const result = parseTaskFile(invalid('bad-id.task.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rowId).toBe('Has Spaces And Caps');
    expect(result.message).toMatch(/id/);
  });

  it('rejects a missing id, keyed by the file basename (stable fallback)', () => {
    const result = parseTaskFile(invalid('no-id.task.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rowId).toBe('no-id.task.md');
    expect(result.message).toMatch(/id/);
  });

  it('rejects an empty prompt body', () => {
    const result = parseTaskFile(invalid('empty-body.task.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/prompt|body/i);
  });

  it('rejects an invalid descriptor at parse time (not a mid-session TypeError)', () => {
    const result = parseTaskFile(invalid('bad-descriptor.task.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/descriptor|shape/);
  });

  it('refuses a js frontmatter fence WITHOUT executing it (RCE guard)', () => {
    const result = parseTaskFile(invalid('js-fence.task.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/YAML/i);
    expect(result.message).not.toMatch(/EVAL EXECUTED/);
  });

  it('returns a read error for a missing file', () => {
    const result = parseTaskFile(invalid('does-not-exist.task.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rowId).toBe('does-not-exist.task.md');
  });
});

describe('schema/router lockstep', () => {
  // The descriptor enums are hand-copied into schema.json (a JSON import
  // widens value types, so a compile-time guard can't see them). This test is
  // the drift guard.
  it('descriptor enums match the router constants exactly', () => {
    const descriptor = taskSchema.properties.descriptor;
    expect(descriptor.properties.shape.enum).toEqual([...TASK_SHAPES]);
    expect(descriptor.properties.sensitivity.enum).toEqual([...TASK_SENSITIVITIES]);
  });
});
