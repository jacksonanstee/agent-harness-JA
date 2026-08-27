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
//            does not declare; a stale acknowledgement; a kind mismatch; a
//            new `missingMeansCwd` outside the {Glob, Grep} pin.
//   misses   tools the SDK dispatches without a declared input type (R-9 by
//            name); a target field whose name falls outside TARGET_FIELD_NAME;
//            a path carried inside an object-typed field (only top-level
//            fields are read); WHICH of two target-shaped fields an entry
//            gates (bound by the sandbox and evaluate pins instead); a tool
//            whose dangerous dimension is not a path or a command (REPL
//            `code`, WebFetch `url`: R-3); and anything at production time,
//            because this is a test.
//
// Proxy-parser caveat (the same shape as src/ci-drift.test.ts): there is no
// TypeScript AST walk here, only regex over a generated .d.ts. A proxy that
// finds nothing reads green, so: the tool list is taken from the SDK's own
// `ToolInputSchemas` union, every identifier in it whatever its name (review
// finding: a cross-check whose two sides share one naming heuristic is not a
// check); every union member must have a parsed interface, so an alias, an
// `extends` or a generic member fails loudly; declarations are split at
// `export` boundaries, so a stray column-0 `}` cannot truncate a body; and the
// parse is anchored on tools that must exist. A short or inconsistent parse
// fails as "could not check", never as clean.

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

/**
 * `ToolInputSchemas` names one member that is not a tool-input interface:
 * `ToolOutputSchemas`, the SDK's own nested union of the *Output types. It is
 * acknowledged here so the union-member check can require every OTHER member to
 * resolve to a parsed interface; a NEW non-interface member (an alias, an
 * extends clause, a generic) then fails as "could not check" rather than being
 * dropped for not ending in `Input` (review finding: the old collector's
 * `\w+Input` filter shared the parser's naming heuristic and hid exactly this).
 */
const KNOWN_NON_INTERFACE_UNION_MEMBERS = ['ToolOutputSchemas'] as const;

interface SdkField {
  readonly name: string;
  readonly optional: boolean;
}

interface SdkTool {
  readonly iface: string;
  readonly tool: string;
  readonly fields: readonly SdkField[];
}

/** Every `export interface X {` declaration, keyed by name, with its top-level fields. */
function parseInterfaces(source: string): Map<string, SdkField[]> {
  const interfaces = new Map<string, SdkField[]>();
  // Split at declaration boundaries rather than at the first `}`: a body is
  // everything up to the next `export`, so a column-0 brace inside it cannot
  // end the block early and silently drop the fields after it.
  for (const declaration of source.split(/^(?=export )/m)) {
    const header = /^export interface (\w+) \{/.exec(declaration);
    if (header === null) continue;
    // Top-level fields sit at exactly two spaces; nested object members and
    // JSDoc lines are deeper, an index signature starts with `[`, and a
    // generator may emit `readonly` or a quoted key, all read here.
    const fields = [
      ...declaration.matchAll(/^ {2}(?:readonly )?(?:"([^"]+)"|'([^']+)'|(\w+))(\?)?:/gm),
    ].map((field) => ({
      name: field[1] ?? field[2] ?? field[3] ?? '',
      optional: field[4] === '?',
    }));
    interfaces.set(header[1] ?? '', fields);
  }
  return interfaces;
}

/** Every identifier the `ToolInputSchemas` union names, whatever it is called. */
function parseUnionMembers(source: string): string[] {
  // Bounded at the next declaration, not at a `;`: the generated union has no
  // terminator, and a lazy match to the first `;` swallowed the next `export`.
  const union = source
    .split(/^(?=export )/m)
    .find((declaration) => declaration.startsWith('export type ToolInputSchemas ='));
  if (union === undefined) return [];
  return [...union.matchAll(/\|\s*(\w+)/g)].map((member) => member[1] ?? '');
}

const toolNameOf = (iface: string): string => INTERFACE_TO_TOOL[iface] ?? iface.replace(/Input$/, '');

/** Loads and sanity-checks the SDK declarations; every check here is "could not check", not "clean". */
function loadSdkTools(): SdkTool[] {
  const source = readFileSync(SDK_TOOLS_DTS, 'utf8');
  const interfaces = parseInterfaces(source);
  const members = [...new Set(parseUnionMembers(source))];
  expect(
    members.length,
    `the ToolInputSchemas union in ${SDK_TOOLS_DTS} names ${members.length} members; below ${MIN_INTERFACES} the parser is broken, not the SDK`,
  ).toBeGreaterThanOrEqual(MIN_INTERFACES);
  const nonInterface = members.filter((member) => !interfaces.has(member));
  expect(
    [...nonInterface].sort(),
    'union members with no parsed `export interface X {` declaration (an alias, an extends clause or a generic lands here); only the known output-union alias is expected, anything else is "could not check"',
  ).toEqual([...KNOWN_NON_INTERFACE_UNION_MEMBERS].sort());
  const orphaned = [...interfaces.keys()].filter((name) => /Input$/.test(name) && !members.includes(name));
  expect(orphaned, '*Input interfaces the union does not name: the union is no longer the tool list').toEqual([]);
  for (const alias of Object.keys(INTERFACE_TO_TOOL)) {
    expect(members.includes(alias), `alias ${alias} no longer exists in the SDK; update INTERFACE_TO_TOOL`).toBe(true);
  }
  const tools = members
    .filter((member) => interfaces.has(member))
    .map((iface) => ({ iface, tool: toolNameOf(iface), fields: interfaces.get(iface) ?? [] }));
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

  it('missingMeansCwd is pinned to the tools whose SDK contract defines a missing path as cwd', () => {
    // The SDK declares optionality, not what absence MEANS; that is prose in
    // the tool description, so it cannot be derived. Pinning the set makes a
    // new cwd-default a visible act rather than a way to turn "deny, refuse to
    // guess" into "gate cwd" for an optional field (review finding).
    const cwdDefaulting = Object.entries(TOOL_TARGET_FIELDS)
      .filter(([, entry]) => entry.missingMeansCwd === true)
      .map(([tool]) => tool)
      .sort();
    expect(cwdDefaulting).toEqual(['Glob', 'Grep']);
  });
});
