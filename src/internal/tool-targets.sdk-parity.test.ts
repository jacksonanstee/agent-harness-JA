import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { ACKNOWLEDGED_NON_TARGET_FIELDS, TOOL_TARGET_FIELDS } from './tool-targets.js';

// Derived gate for the tool table (issue #86, ADR-0033). The pin test next
// door pins the table to ITSELF, which catches an accidental edit and nothing
// else: at the only SDK version the harness has ever run, five path/command
// tools were never in the table and passed both gates for seven weeks under a
// green suite. This gate reads the installed SDK's own declarations and fails
// when the two disagree, in either direction.
//
// Reach, stated so nobody reads it as total coverage (ADR-0033):
//   catches  a declared tool with a target-shaped field and no table entry;
//            a table field the SDK renamed or removed; a table entry the SDK
//            does not declare; a stale acknowledgement; a kind mismatch.
//   misses   runtime-only tools the SDK dispatches without a declared input
//            type (R-9 by name); a target field whose name falls outside
//            TARGET_FIELD_NAME; a path carried inside an object-typed field
//            (only top-level fields are read); a tool whose dangerous dimension
//            is not a path or a command (REPL `code`, WebFetch `url`: R-3); and
//            anything at production time, because this is a test.
//
// Proxy-parser caveat (the same shape as src/ci-drift.test.ts): there is no
// TypeScript AST walk here, only regex over a generated .d.ts. A proxy that
// finds nothing reads green, so the parse is cross-checked against the SDK's
// own `ToolInputSchemas` union and anchored on tools that must exist; a short
// or inconsistent parse fails as "could not check", never as clean.

const SDK_TOOLS_DTS = join(
  process.cwd(),
  'node_modules',
  '@anthropic-ai',
  'claude-agent-sdk',
  'sdk-tools.d.ts',
);

/**
 * A field is target-shaped when its NAME says path or command. This vocabulary
 * is the gate's reach: a filesystem field the SDK names outside it is unseen.
 */
const TARGET_FIELD_NAME = /path|file|command|cmd|cwd|dir/i;
const COMMAND_FIELD_NAME = /command|cmd/i;

/** SDK interfaces whose name is not `<Tool>Input`; each is asserted to exist. */
const INTERFACE_TO_TOOL: Readonly<Record<string, string>> = {
  FileEditInput: 'Edit',
  FileReadInput: 'Read',
  FileWriteInput: 'Write',
};

/** Tools that must parse, or the parser is broken rather than the SDK small. */
const ANCHOR_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;
const MIN_INTERFACES = 30;

interface SdkField {
  readonly name: string;
  readonly optional: boolean;
}

interface SdkTool {
  readonly iface: string;
  readonly tool: string;
  readonly fields: readonly SdkField[];
}

function parseInterfaces(source: string): SdkTool[] {
  // The first alternative matches a one-line `{}` body so an empty interface
  // never swallows its successor.
  const blocks = source.matchAll(/^export interface (\w+Input) \{(\}|[\s\S]*?^\})/gm);
  const tools: SdkTool[] = [];
  for (const block of blocks) {
    const iface = block[1] ?? '';
    const body = block[2] ?? '';
    // Top-level fields sit at exactly two spaces; nested object members are
    // deeper and an index signature starts with `[`, so neither matches.
    const fields = [...body.matchAll(/^ {2}(\w+)(\?)?:/gm)].map((field) => ({
      name: field[1] ?? '',
      optional: field[2] === '?',
    }));
    tools.push({ iface, tool: INTERFACE_TO_TOOL[iface] ?? iface.replace(/Input$/, ''), fields });
  }
  return tools;
}

function parseUnionMembers(source: string): string[] {
  const union = /^export type ToolInputSchemas =([\s\S]*?);/m.exec(source);
  if (union === null) return [];
  return [...(union[1] ?? '').matchAll(/\b(\w+Input)\b/g)].map((member) => member[1] ?? '');
}

/** Loads and sanity-checks the SDK declarations; every check here is "could not check", not "clean". */
function loadSdkTools(): SdkTool[] {
  const source = readFileSync(SDK_TOOLS_DTS, 'utf8');
  const tools = parseInterfaces(source);
  expect(
    tools.length,
    `parsed ${tools.length} *Input interfaces from ${SDK_TOOLS_DTS}; below ${MIN_INTERFACES} the parser is broken, not the SDK`,
  ).toBeGreaterThanOrEqual(MIN_INTERFACES);
  const parsedNames = tools.map((tool) => tool.iface).sort();
  const unionNames = [...new Set(parseUnionMembers(source))].sort();
  expect(
    parsedNames,
    "the interfaces parsed must equal the members of the SDK's own ToolInputSchemas union; a mismatch means the regex missed or double-counted a block",
  ).toEqual(unionNames);
  for (const alias of Object.keys(INTERFACE_TO_TOOL)) {
    expect(parsedNames.includes(alias), `alias ${alias} no longer exists in the SDK; update INTERFACE_TO_TOOL`).toBe(true);
  }
  const toolNames = new Set(tools.map((tool) => tool.tool));
  for (const anchor of ANCHOR_TOOLS) {
    expect(toolNames.has(anchor), `anchor tool ${anchor} did not parse`).toBe(true);
  }
  return tools;
}

const isTargetShaped = (field: SdkField): boolean => TARGET_FIELD_NAME.test(field.name);

describe('TOOL_TARGET_FIELDS is derived from the installed SDK declarations (issue #86, ADR-0033)', () => {
  let sdkTools: SdkTool[] = [];
  let targetBearing: SdkTool[] = [];

  beforeAll(() => {
    sdkTools = loadSdkTools();
    targetBearing = sdkTools.filter((tool) => tool.fields.some(isTargetShaped));
  });

  it('parses the SDK declarations completely (a partial parse fails here, not as clean elsewhere)', () => {
    expect(loadSdkTools().length).toBe(sdkTools.length);
    // The vocabulary itself is pinned: an edit that widens it to everything or
    // narrows it to nothing would turn every check below vacuous.
    for (const name of ['file_path', 'path', 'notebook_path', 'local_path', 'scriptPath', 'command']) {
      expect(TARGET_FIELD_NAME.test(name), `${name} must read as target-shaped`).toBe(true);
    }
    for (const name of ['pattern', 'glob', 'url', 'content', 'query', 'script', 'name', 'description']) {
      expect(TARGET_FIELD_NAME.test(name), `${name} must not read as target-shaped`).toBe(false);
    }
    expect(targetBearing.length).toBeGreaterThan(0);
  });

  it('every SDK tool that declares a path/command field has a table entry on a field the SDK declares, with the right kind', () => {
    const missing = targetBearing
      .filter((tool) => TOOL_TARGET_FIELDS[tool.tool] === undefined)
      .map(
        (tool) =>
          `${tool.tool} (${tool.iface}: ${tool.fields.filter(isTargetShaped).map((f) => f.name).join(', ')})`,
      );
    expect(missing, 'SDK tools with a path/command field but no table entry: both gates pass them').toEqual([]);

    for (const tool of targetBearing) {
      const entry = TOOL_TARGET_FIELDS[tool.tool];
      if (entry === undefined) continue;
      const declared = tool.fields.find((field) => field.name === entry.field);
      expect(
        declared,
        `${tool.tool}: table field '${entry.field}' is not declared by the SDK (renamed or removed)`,
      ).toBeDefined();
      expect(entry.kind, `${tool.tool}.${entry.field}: kind must follow the field's class`).toBe(
        COMMAND_FIELD_NAME.test(entry.field) ? 'command' : 'path',
      );
      if (declared !== undefined && !declared.optional) {
        expect(
          entry.missingMeansCwd,
          `${tool.tool}.${entry.field} is required in the SDK, so missingMeansCwd is meaningless`,
        ).toBeUndefined();
      }
    }
  });

  it('every other target-shaped field is acknowledged with a reason, and no acknowledgement is stale', () => {
    const unacknowledged: string[] = [];
    for (const tool of targetBearing) {
      const entry = TOOL_TARGET_FIELDS[tool.tool];
      const acknowledged = ACKNOWLEDGED_NON_TARGET_FIELDS[tool.tool] ?? {};
      for (const field of tool.fields.filter(isTargetShaped)) {
        if (entry?.field === field.name) continue;
        const reason = acknowledged[field.name];
        if (typeof reason === 'string' && reason.trim() !== '') continue;
        unacknowledged.push(`${tool.tool}.${field.name}: target-shaped, neither gated nor acknowledged with a reason`);
      }
    }
    expect(unacknowledged).toEqual([]);

    const stale: string[] = [];
    for (const [tool, fields] of Object.entries(ACKNOWLEDGED_NON_TARGET_FIELDS)) {
      const sdk = sdkTools.find((candidate) => candidate.tool === tool);
      for (const [field, reason] of Object.entries(fields)) {
        if (sdk === undefined) {
          stale.push(`${tool}.${field}: the SDK does not declare the tool`);
          continue;
        }
        if (!sdk.fields.some((candidate) => candidate.name === field)) {
          stale.push(`${tool}.${field}: the SDK does not declare the field`);
        } else if (!TARGET_FIELD_NAME.test(field)) {
          stale.push(`${tool}.${field}: not target-shaped, the acknowledgement is dead weight`);
        }
        if (TOOL_TARGET_FIELDS[tool]?.field === field) {
          stale.push(`${tool}.${field}: both gated and acknowledged`);
        }
        if (reason.trim() === '') stale.push(`${tool}.${field}: empty reason`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('every table entry names a tool the SDK declares (a field name nothing can verify is not a gate)', () => {
    const declared = new Set(sdkTools.map((tool) => tool.tool));
    const undeclared = Object.keys(TOOL_TARGET_FIELDS).filter((tool) => !declared.has(tool));
    expect(
      undeclared,
      'table entries for tools the pinned SDK does not declare (MultiEdit was one); undeclared runtime tools are R-9, not table entries',
    ).toEqual([]);
  });
});
