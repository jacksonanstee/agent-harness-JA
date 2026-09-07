import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// process/01-requirements.md is the file every ADR, test and release entry
// traces back to (its own "Traceability" section). Its rows are prose, so
// until now nothing bound them: IDs were unique by care, and a deferred row
// could vanish with no test going red. This file pins the structure the
// traceability promise depends on, and the two roadmap rows issue #101 added
// (H-7 ceilings and cancellation, H-8 retry and timeout policy), so the next
// review finds them by ID instead of rediscovering the gap.

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '..', 'process', '01-requirements.md'), 'utf8');

interface Row {
  id: string;
  priority: string;
  requirement: string;
  verification: string;
}

const ID_RE = /^[HSEN]-\d+$/;

/** Every table row whose first cell is a requirement ID, in file order. */
function requirementRows(): Row[] {
  const rows: Row[] = [];
  for (const line of source.split('\n')) {
    // A GFM row `| a | b | c | d |` splits to an empty cell, four cells, an
    // empty cell. Rows with any other cell count are headers, separators or
    // prose and are skipped; a requirement cell must therefore carry no `|`.
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length !== 6 || cells[0] !== '' || cells[5] !== '') continue;
    const id = cells[1] ?? '';
    if (!ID_RE.test(id)) continue;
    rows.push({
      id,
      priority: cells[2] ?? '',
      requirement: cells[3] ?? '',
      verification: cells[4] ?? '',
    });
  }
  // A proxy parser that finds nothing reads green (DEC-0016), so an empty
  // parse is a failure of this file, not a clean requirements table.
  if (rows.length === 0) throw new Error('no requirement rows parsed: the table format changed');
  return rows;
}

function row(id: string): Row {
  const found = requirementRows().find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`${id} is not in process/01-requirements.md`);
  return found;
}

describe('process/01-requirements.md structure', () => {
  it('every requirement ID is unique', () => {
    const ids = requirementRows().map((r) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  it('within each layer the IDs run from 1 with no gap, in file order', () => {
    const byLayer = new Map<string, number[]>();
    for (const { id } of requirementRows()) {
      const [layer = '', number = ''] = id.split('-');
      byLayer.set(layer, [...(byLayer.get(layer) ?? []), Number(number)]);
    }
    expect([...byLayer.keys()].sort()).toEqual(['E', 'H', 'N', 'S']);
    for (const [layer, numbers] of byLayer) {
      expect({ layer, numbers }).toEqual({ layer, numbers: numbers.map((_, index) => index + 1) });
    }
  });

  it('every priority is MUST, SHOULD or COULD', () => {
    const rows = requirementRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const { id, priority } of rows) {
      expect({ id, priority }).toEqual({ id, priority: expect.stringMatching(/^(MUST|SHOULD|COULD)$/) });
    }
  });

  it('every COULD row says so in its verification cell', () => {
    const could = requirementRows().filter((r) => r.priority === 'COULD');
    expect(could.length).toBeGreaterThan(0);
    for (const { id, verification } of could) {
      expect({ id, verification }).toEqual({ id, verification: expect.stringContaining('Deferred') });
    }
  });
});

describe('the roadmap rows from issue #101', () => {
  it('H-7 records token and wall-clock ceilings with cancellation, deferred to v1.x', () => {
    const h7 = row('H-7');
    expect(h7.priority).toBe('COULD');
    expect(h7.requirement).toMatch(/token/);
    expect(h7.requirement).toMatch(/wall-clock/);
    expect(h7.requirement).toMatch(/cancel/);
    expect(h7.verification).toContain('Deferred to v1.x');
  });

  it('H-8 records the retry and timeout policy for the SDK call, deferred to v1.x', () => {
    const h8 = row('H-8');
    expect(h8.priority).toBe('COULD');
    expect(h8.requirement).toMatch(/retr(y|ies)/);
    expect(h8.requirement).toMatch(/timeout/);
    expect(h8.verification).toContain('Deferred to v1.x');
  });
});
