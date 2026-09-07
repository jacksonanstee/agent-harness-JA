import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// process/01-requirements.md is the file every ADR, test and release entry
// traces back to (its own "Traceability" section). Its rows are prose, so
// until now nothing bound them. This file pins the structure the traceability
// promise depends on (one table per layer in architecture order, IDs
// contiguous from 1 within a layer, a pinned last ID per layer so a row cannot
// vanish from the end either, priorities in the enum, COULD rows marked
// deferred) and the two roadmap rows issue #101 added (H-7 ceilings and
// cancellation, H-8 retry and timeout policy), so the next review finds them by
// ID instead of rediscovering the gap.
//
// The parser is line-based and therefore a proxy (the DEC-0016 shape that
// src/ci-drift.test.ts also carries). Two rules keep it fail-closed: inside a
// requirements table every row is VALIDATED and an unrecognised one throws,
// rather than being filtered out of sight (against the first cut the code lens
// deleted the last row of a layer and inserted `| H-7a | MAYBE |`, both
// green); and fenced code is skipped, so an example row inside a fence is
// neither a duplicate nor a phantom requirement.

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '..', 'process', '01-requirements.md'), 'utf8');

interface Row {
  id: string;
  layer: string;
  priority: string;
  /** The requirement sentence, with any trailing dated note removed. */
  requirement: string;
  /** The trailing `*( ... )*` note, or null when the cell carries none. */
  note: string | null;
  verification: string;
}

interface Table {
  layer: string;
  rows: Row[];
}

const ID_RE = /^([HSEN])-[1-9]\d*$/;
const HEADER = 'ID|Priority|Requirement|Verification';
const SEPARATOR_RE = /^\|(?:\s*:?-+:?\s*\|)+$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// The file's in-row note idiom: `sentence. *(dated note)*`. Pins read the
// sentence, not the note; the architecture lens showed three word-pins bound
// to the note's wording when the whole cell was matched.
const NOTE_RE = /^(.*?)\s*\*\((.*)\)\*$/s;

/**
 * The last ID of each layer, hand-pinned on purpose: adding a requirement is a
 * deliberate act and updates this line (the README ADR-count gate is the
 * precedent). Without it the contiguity check would let the final row of a
 * layer be deleted green.
 */
const LAST_ID: Record<string, string> = { H: 'H-8', S: 'S-6', E: 'E-5', N: 'N-7' };

/**
 * Splits a GFM row on unescaped pipes and unescapes `\|` inside the cells.
 * Returns null when the line is not a well-formed four-cell row.
 */
function cells(line: string): string[] | null {
  const parts = line.trim().split(/(?<!\\)\|/);
  if (parts.length !== 6 || parts[0] !== '' || parts[5] !== '') return null;
  return parts.slice(1, 5).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/**
 * Every requirements table (header exactly ID / Priority / Requirement /
 * Verification) in file order, every row inside it validated, fenced code
 * skipped. A table with any other header is not a requirements table and is
 * ignored; the layer-order pin notices if a layer goes missing that way.
 */
function requirementTables(): Table[] {
  const lines = source.split('\n');
  const tables: Table[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const marker = FENCE_RE.exec(line)?.[1] ?? null;
    if (fence === null && marker !== null) {
      fence = marker;
      continue;
    }
    if (fence !== null) {
      if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    const header = cells(line);
    if (header === null || header.join('|') !== HEADER) continue;
    if (!SEPARATOR_RE.test((lines[i + 1] ?? '').trim())) continue;
    const rows: Row[] = [];
    let j = i + 2;
    for (; j < lines.length && (lines[j] ?? '').trim().startsWith('|'); j += 1) {
      const raw = lines[j] ?? '';
      const parsed = cells(raw);
      if (parsed === null) throw new Error(`malformed requirement row at line ${j + 1}: ${raw}`);
      const [id = '', priority = '', cell = '', verification = ''] = parsed;
      const layer = ID_RE.exec(id)?.[1];
      if (layer === undefined) throw new Error(`requirement row at line ${j + 1} has no valid ID: ${raw}`);
      const split = NOTE_RE.exec(cell);
      const requirement = split?.[1] ?? cell;
      const note = split?.[2] ?? null;
      rows.push({ id, layer, priority, requirement, note, verification });
    }
    const layers = [...new Set(rows.map((row) => row.layer))];
    if (layers.length !== 1) {
      throw new Error(`requirements table at line ${i + 1} holds layers [${layers.join(', ')}], expected one`);
    }
    tables.push({ layer: layers[0] ?? '', rows });
    i = j - 1;
  }
  // A proxy parser that finds nothing reads green (DEC-0016), so an empty
  // parse is a failure of this file, not a clean requirements file.
  if (tables.length === 0) throw new Error('no requirements table parsed: the file format changed');
  return tables;
}

const allRows = (): Row[] => requirementTables().flatMap((table) => table.rows);

function row(id: string): Row {
  const found = allRows().find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`${id} is not in process/01-requirements.md`);
  return found;
}

describe('process/01-requirements.md structure', () => {
  it('has one table per layer, in architecture order: harness, security, eval, cross-cutting', () => {
    expect(requirementTables().map((table) => table.layer)).toEqual(['H', 'S', 'E', 'N']);
  });

  it('numbers each layer from 1 with no gap, in file order, and ends where the pin says', () => {
    for (const table of requirementTables()) {
      table.rows.forEach((candidate, index) => {
        expect(candidate.id).toBe(`${table.layer}-${index + 1}`);
      });
      expect(table.rows[table.rows.length - 1]?.id).toBe(LAST_ID[table.layer]);
    }
  });

  it('every requirement ID is unique across the file', () => {
    const ids = allRows().map((candidate) => candidate.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  it('every priority is MUST, SHOULD or COULD', () => {
    for (const { id, priority } of allRows()) {
      expect({ id, priority }).toEqual({ id, priority: expect.stringMatching(/^(MUST|SHOULD|COULD)$/) });
    }
  });

  it('every COULD row says so in its verification cell', () => {
    const could = allRows().filter((candidate) => candidate.priority === 'COULD');
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
    expect(h7.note).toMatch(/issue #101/);
    expect(h7.verification).toContain('Deferred to v1.x');
  });

  it('H-8 records the retry and timeout policy for the SDK call, deferred to v1.x', () => {
    const h8 = row('H-8');
    expect(h8.priority).toBe('COULD');
    expect(h8.requirement).toMatch(/retr(y|ies)/);
    expect(h8.requirement).toMatch(/timeout/);
    expect(h8.note).toMatch(/issue #101/);
    expect(h8.verification).toContain('Deferred to v1.x');
  });
});
