import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { ATTACHMENTS_SWITCH, AUTO_MEMORY_SWITCH, BACKGROUND_TASKS_SWITCH, CRON_SWITCH, FORCED_CHILD_ENV, SCHEDULED_TASKS_FILE } from './child-env.js';
import {
  ACKNOWLEDGED_NON_TARGET_FIELDS,
  ACKNOWLEDGED_TOOLS,
  ALLOWED_TOOL_NAMES,
  BASH_BACKGROUND_FIELD,
  BINARY_ONLY_TOOLS,
  CODE_EXECUTING_TOOLS,
  DENIED_TOOL_PREFIXES,
  DENIED_TOOLS,
  MCP_TOOL_PREFIX,
  REVIEWED_REFUSED_TOOLS,
  TOOL_TARGET_FIELDS,
} from './tool-targets.js';

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
//            whose dangerous dimension is not a path or a command (`WebFetch.url`
//            network egress is R-3; `REPL.code` is arbitrary code execution,
//            outside the path/command axis, so no configurable gate checks
//            it; CODE_EXECUTING_TOOLS marks it `denied`, the block below pins
//            that a `denied` tool has no table entry, and
//            code-execution-deny.test.ts pins REPL itself, #211); and
//            anything at production time, because this is a test.
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

// The bundled native CLI for this platform (a sibling optional dependency). It
// is read only to CHECK binary evidence for a deny that the typed surface
// cannot carry (#219); nothing is derived from it, so the table stays
// typed-surface-only (R-9). Named for darwin and linux (glibc), the dev and CI
// platforms; anywhere else (win32, whose file name is unverified; musl, a `-musl` package)
// it is absent and every binary check FAILS as "could not check", never passes.
const PLATFORM_BINARY = join(
  process.cwd(),
  'node_modules',
  '@anthropic-ai',
  `claude-agent-sdk-${process.platform}-${process.arch}`,
  'claude',
);
let platformBinaryBytes: Buffer | undefined;

/** A prefix `mcp__<server>__` names its needle when the needle is `"<server>"`, allowing for `_`/`-` normalisation. */
const prefixNamesNeedle = (prefix: string, needle: string): boolean => {
  const fold = (name: string): string => name.replace(/[_-]/g, '-');
  return `"${fold(prefix.slice(MCP_TOOL_PREFIX.length, -'__'.length))}"` === fold(needle);
};

/** True when the installed platform binary holds `needle`; a missing binary fails the calling test. */
function binaryHolds(needle: string): boolean {
  if (platformBinaryBytes === undefined) {
    expect(existsSync(PLATFORM_BINARY), `could not check: no platform binary at ${PLATFORM_BINARY}`).toBe(true);
    platformBinaryBytes = readFileSync(PLATFORM_BINARY);
  }
  return platformBinaryBytes.includes(needle);
}

/**
 * A field is target-shaped when its NAME says path or command. This vocabulary
 * is the gate's reach: a filesystem field the SDK names outside it is unseen.
 */
const TARGET_FIELD_NAME = /path|file|command|cmd|cwd|dir/i;
const COMMAND_FIELD_NAME = /command|cmd/i;
/**
 * A field is execution-shaped when its name, or one WORD of it (camelCase,
 * snake_case, kebab-case; an all-caps run such as `JS` in `runJS` is one word),
 * says it carries something the SDK runs (issue #211).
 * Words, not substrings: `description` contains `script`. Each word is
 * lower-cased and loses a plural `s` and trailing digits, so `CMD`, `scripts`
 * and `code2` read as hits. Left out because the pinned SDK uses them for
 * non-code fields (`ts` too: a timestamp suffix such as `created_ts` is likely): `run` (`run_in_background`, `resumeFromRunId`), `shell`
 * (`TaskStop.shell_id`), `source` (`NotebookEdit.new_source`). Same reach
 * caveat as TARGET_FIELD_NAME: a code field named outside this list is unseen.
 */
const EXECUTION_WORDS: ReadonlySet<string> = new Set([
  'command', 'cmd', 'script', 'code', 'exec', 'eval', 'javascript', 'js', 'typescript', 'python', 'sql',
  'program', 'expression', 'expr', 'snippet', 'statement',
]);
const normaliseWord = (word: string): string => {
  const lower = word.toLowerCase().replace(/\d+$/, '');
  return lower.length > 3 && lower.endsWith('s') ? lower.slice(0, -1) : lower;
};
const isExecutionShaped = (name: string): boolean =>
  [name, ...name.split(/_|-|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)].some((word) =>
    EXECUTION_WORDS.has(normaliseWord(word)),
  );

/** SDK interfaces whose name is not `<Tool>Input`; each is asserted to exist. */
const INTERFACE_TO_TOOL: Readonly<Record<string, string>> = {
  FileEditInput: 'Edit',
  FileReadInput: 'Read',
  FileWriteInput: 'Write',
};

/** Tools that must parse, or the parser is broken rather than the SDK small. */
const ANCHOR_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;
const MIN_UNION_MEMBERS = 30;

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
    `the ToolInputSchemas union in ${SDK_TOOLS_DTS} names ${members.length} members; below ${MIN_UNION_MEMBERS} the parser is broken, not the SDK`,
  ).toBeGreaterThanOrEqual(MIN_UNION_MEMBERS);
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

/** Refused by name whatever its arguments: a DENIED_TOOLS entry (#219) or a `denied` code runner (#211, #248). */
const refusedByName = (tool: string): boolean =>
  Object.hasOwn(DENIED_TOOLS, tool) || CODE_EXECUTING_TOOLS[tool] === 'denied';

describe('TOOL_TARGET_FIELDS is derived from the installed SDK declarations (issue #86, ADR-0033)', () => {
  let sdkTools: SdkTool[] = [];
  let targetBearing: SdkTool[] = [];

  beforeAll(() => {
    sdkTools = loadSdkTools();
    targetBearing = sdkTools.filter((tool) => tool.fields.some(isTargetShaped));
  });

  it('parses the SDK declarations completely (a partial parse fails here, not as clean elsewhere)', () => {
    // Independent of the union-driven parse: count the interface headers by a
    // second regex, so this can actually fail if the two disagree (review: the
    // old `loadSdkTools().length).toBe(sdkTools.length)` compared a pure
    // function on one file to itself).
    const interfaceHeaders = (readFileSync(SDK_TOOLS_DTS, 'utf8').match(/^export interface \w+Input \{/gm) ?? [])
      .length;
    expect(
      sdkTools.length,
      'the union-derived tool list must equal the count of *Input interface headers in the file',
    ).toBe(interfaceHeaders);
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

  // #219: a tool refused by name (DENIED_TOOLS) is covered by the refusal and has no table entry,
  // the same rule as a `denied` CODE_EXECUTING_TOOLS member (REPL; and Monitor since #248, the
  // first such member with a target-shaped field, `command`).
  it('every SDK tool that declares a path/command field has a table entry or is refused by name (completeness direction)', () => {
    const missing = targetBearing
      .filter((tool) => TOOL_TARGET_FIELDS[tool.tool] === undefined && !refusedByName(tool.tool))
      .map(
        (tool) =>
          `${tool.tool} (${tool.iface}: ${tool.fields.filter(isTargetShaped).map((f) => f.name).join(', ')})`,
      );
    expect(missing, 'SDK tools with a path/command field but no table entry: both gates pass them').toEqual([]);
  });

  it('every other target-shaped field is acknowledged with a reason, and no acknowledgement is stale', () => {
    const unacknowledged: string[] = [];
    const visited: string[] = [];
    for (const tool of targetBearing) {
      // #219, #248: a tool refused by name has every field covered by the refusal.
      if (refusedByName(tool.tool)) continue;
      visited.push(...tool.fields.filter(isTargetShaped).map((field) => `${tool.tool}.${field.name}`));
      const entry = TOOL_TARGET_FIELDS[tool.tool];
      const acknowledged = ACKNOWLEDGED_NON_TARGET_FIELDS[tool.tool] ?? {};
      for (const field of tool.fields.filter(isTargetShaped)) {
        if (entry?.field === field.name) continue;
        const reason = acknowledged[field.name];
        if (typeof reason === 'string' && reason.trim() !== '') continue;
        unacknowledged.push(`${tool.tool}.${field.name}: target-shaped, neither gated nor acknowledged with a reason`);
      }
    }
    // Non-vacuity (a mutation widening the skip to every tool survived without this): the walk must
    // visit exactly the target fields of every target-bearing tool that is NOT refused by name,
    // computed here from the SDK list by name alone, so any wider or narrower skip fails.
    // Literal, not derived from the maps the skip reads (a rebuilt expected set passes by construction).
    const refused = new Set(['Artifact', 'Monitor']);
    const expected = sdkTools
      .filter((tool) => !refused.has(tool.tool))
      .flatMap((tool) => tool.fields.filter((field) => TARGET_FIELD_NAME.test(field.name)).map((field) => `${tool.tool}.${field.name}`));
    expect([...visited].sort()).toEqual([...expected].sort());
    expect(visited).toContain('Projects.path');
    expect(visited).toContain('Bash.command');
    expect(visited).not.toContain('Monitor.command');
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

  it('every table entry names an SDK tool and gates a field that tool declares, with the right kind (table -> SDK direction)', () => {
    // Sourced from sdkTools, NOT targetBearing: a tool leaves targetBearing the
    // moment it has no target-shaped field, so a renamed Artifact.file_path
    // (Artifact still declared, now with no gateable field) or a bogus entry on
    // a non-target-bearing tool (WebSearch: { field: 'queryy' }) would slip a
    // check that only iterated targetBearing (code + architecture review). This
    // is the direction the "a field name nothing can verify is not a gate"
    // argument (ADR-0033 decision 3) rests on.
    const sdkByTool = new Map(sdkTools.map((tool) => [tool.tool, tool] as const));
    const problems: string[] = [];
    for (const [toolName, entry] of Object.entries(TOOL_TARGET_FIELDS)) {
      const sdk = sdkByTool.get(toolName);
      if (sdk === undefined) {
        problems.push(
          `${toolName}: not an SDK-declared tool (MultiEdit was one); undeclared runtime tools are R-9, not table entries`,
        );
        continue;
      }
      const declared = sdk.fields.find((field) => field.name === entry.field);
      if (declared === undefined) {
        problems.push(`${toolName}.${entry.field}: a field the SDK does not declare (renamed or removed)`);
        continue;
      }
      const wantKind = COMMAND_FIELD_NAME.test(entry.field) ? 'command' : 'path';
      if (entry.kind !== wantKind) {
        problems.push(`${toolName}.${entry.field}: kind '${entry.kind}' but the field's class is '${wantKind}'`);
      }
      if (!declared.optional && entry.missingMeansCwd !== undefined) {
        problems.push(`${toolName}.${entry.field}: required in the SDK, so missingMeansCwd is meaningless`);
      }
    }
    expect(
      problems,
      'every table entry must name an SDK tool and gate a field it declares, whether or not the tool still has OTHER target-shaped fields',
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

describe('CODE_EXECUTING_TOOLS is derived from the installed SDK declarations (issue #211, ADR-0040 D-8)', () => {
  let sdkTools: SdkTool[] = [];
  const members = Object.keys(CODE_EXECUTING_TOOLS);

  beforeAll(() => {
    sdkTools = loadSdkTools();
  });

  it('the execution vocabulary is pinned (a widened or emptied list would make the checks below vacuous)', () => {
    for (const name of ['command', 'script', 'scriptPath', 'code', 'shell_command', 'sourceCode', 'CMD', 'SCRIPT', 'commands', 'scripts', 'code2', 'jsCode', 'exec', 'eval', 'program', 'expression', 'runJS', 'shellCMD', 'exprs']) {
      expect(isExecutionShaped(name), `${name} must read as execution-shaped`).toBe(true);
    }
    // One literal row per word (not a loop over EXECUTION_WORDS, which would shrink with it), so
    // removing any word from the list turns this red.
    for (const name of ['command', 'cmd', 'script', 'code', 'exec', 'eval', 'javascript', 'js', 'typescript', 'python', 'sql', 'program', 'expression', 'expr', 'snippet', 'statement']) {
      expect(isExecutionShaped(name), `${name} must read as execution-shaped`).toBe(true);
    }
    // The last four are real non-code fields of the pinned SDK: the reason run, shell and source are not words.
    for (const name of ['file_path', 'path', 'content', 'query', 'name', 'description', 'prompt', 'url', 'encoding', 'run_in_background', 'resumeFromRunId', 'shell_id', 'new_source']) {
      expect(isExecutionShaped(name), `${name} must not read as execution-shaped`).toBe(false);
    }
  });

  it('every SDK tool with an execution-shaped field is a member (completeness direction)', () => {
    const missing = sdkTools
      .filter((tool) => tool.fields.some((field) => isExecutionShaped(field.name)))
      .filter((tool) => CODE_EXECUTING_TOOLS[tool.tool] === undefined)
      .map((tool) => `${tool.tool} (${tool.fields.filter((f) => isExecutionShaped(f.name)).map((f) => f.name).join(', ')})`);
    expect(missing, 'SDK tools that run a command or script but that a user rule allow could still grant unconditionally').toEqual([]);
  });

  // #219 D3: a member the SDK stopped declaring but the bundled binary still
  // names stays, via BINARY_ONLY_TOOLS (evidence required). An entry the
  // SDK declares again is stale and fails, so the exception cannot outlive its cause.
  it('every member is a tool the SDK declares, or a binary-only tool with evidence (map -> SDK direction)', () => {
    const declared = new Set(sdkTools.map((tool) => tool.tool));
    expect(members.filter((name) => !declared.has(name) && BINARY_ONLY_TOOLS[name] === undefined)).toEqual([]);
  });

  it('every BINARY_ONLY_TOOLS entry is a member, is undeclared by the SDK, and carries evidence', () => {
    const declared = new Set(sdkTools.map((tool) => tool.tool));
    const stale = Object.entries(BINARY_ONLY_TOOLS).flatMap(([name, evidence]) => [
      ...(CODE_EXECUTING_TOOLS[name] === undefined ? [`${name}: not a CODE_EXECUTING_TOOLS member`] : []),
      ...(declared.has(name) ? [`${name}: the SDK declares it again, drop the exception`] : []),
      ...(evidence.note.trim() === '' ? [`${name}: no note`] : []),
      ...(binaryHolds(evidence.binaryNeedle) ? [] : [`${name}: "${evidence.binaryNeedle}" is gone from the binary`]),
    ]);
    expect(stale).toEqual([]);
    expect(Object.keys(BINARY_ONLY_TOOLS)).toEqual(['REPL']);
  });

  it('`commands` is exactly the command-kind table entries: no other dimension constrains what runs', () => {
    const commandKind = Object.entries(TOOL_TARGET_FIELDS)
      .filter(([, target]) => target.kind === 'command')
      .map(([name]) => name)
      .sort();
    const commandsGated = Object.entries(CODE_EXECUTING_TOOLS)
      .filter(([, gate]) => gate === 'commands')
      .map(([name]) => name)
      .sort();
    expect(commandKind.length).toBeGreaterThan(0);
    expect(commandsGated).toEqual(commandKind);
  });

  it('a `denied` member has no table entry: no configurable gate sees it, so the built-in deny is its only check', () => {
    const denied = Object.entries(CODE_EXECUTING_TOOLS).filter(([, gate]) => gate === 'denied');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.filter(([name]) => TOOL_TARGET_FIELDS[name] !== undefined).map(([name]) => name)).toEqual([]);
  });
});

describe('DENIED_TOOLS evidence holds against the installed SDK and binary (issue #219)', () => {
  const declaredTools = (): Set<string> => new Set(loadSdkTools().map((tool) => tool.tool));

  it('a declared entry is a tool the SDK declares; a binary entry is not, and its needle is in the installed binary', () => {
    const declared = declaredTools();
    const stale = Object.entries(DENIED_TOOLS).flatMap(([tool, entry]) => {
      if (entry.evidence === 'declared') return declared.has(tool) ? [] : [`${tool}: the SDK does not declare the tool`];
      return [
        ...(declared.has(tool) ? [`${tool}: the SDK declares it now, use 'declared' evidence`] : []),
        ...(binaryHolds(entry.evidence.binaryNeedle) ? [] : [`${tool}: needle gone from the binary`]),
      ];
    });
    expect(stale).toEqual([]);
  });

  it('a tool refused by name has no table entry (a gate it can never reach would mislead readers and callers)', () => {
    expect(Object.keys(DENIED_TOOLS).filter((tool) => TOOL_TARGET_FIELDS[tool] !== undefined)).toEqual([]);
  });

  it('a refused prefix is a whole MCP server segment, and its needle is in the installed binary', () => {
    const stale = Object.entries(DENIED_TOOL_PREFIXES).flatMap(([prefix, entry]) => [
      ...(/^mcp__[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*__$/.test(prefix) ? [] : [`${prefix}: not of the form mcp__<server>__`]),
      ...(entry.evidence === 'declared' ? [`${prefix}: MCP tools are never declared; evidence must be a binary needle`] : []),
      ...(entry.evidence !== 'declared' && !binaryHolds(entry.evidence.binaryNeedle) ? [`${prefix}: needle gone from the binary`] : []),
      // The needle must be the server's own name, so a rename fails here rather than leaving a dead prefix.
      ...(entry.evidence !== 'declared' && !prefixNamesNeedle(prefix, entry.evidence.binaryNeedle) ? [`${prefix}: needle is not this server's name`] : []),
    ]);
    expect(stale).toEqual([]);
  });

  it('a denied tool is not also a code-executing tool (one built-in deny per tool, one reason in telemetry)', () => {
    expect(Object.keys(DENIED_TOOLS).filter((tool) => CODE_EXECUTING_TOOLS[tool] !== undefined)).toEqual([]);
  });

  it('the binary check is not vacuous: a needle that is not there reads as absent', () => {
    expect(binaryHolds('CLAUDE_CODE_REPL')).toBe(true);
    expect(binaryHolds('no such needle #219 \u0000 zz')).toBe(false);
  });
});

// Issue #225, ADR-0045: the default-deny allowlist. The hook refuses every
// unlisted non-MCP name at runtime; these checks make the REVIEW keep up with
// the SDK, so an unruled typed-surface name fails CI instead of only failing
// closed in a session.
//
// Reach: the typed surface (BUILTIN_TOOL_NAMES, read as text from sdk.d.ts,
// plus the ToolInputSchemas union) is checked name by name. Tools the binary
// defines outside it are refused by default and not named here; the CI signal
// for them is a ratchet on the count of definition SITES in the installed
// binary. A site is a call, not a tool: at 0.3.312 four sites are factories
// that define about ten tools, so a tool added to a factory's array, or one
// added as another removed, leaves the count unchanged. The run-time
// `system/init` tools check (the second #225 change) is the stronger signal.
// The needle is a minified call (`tn({name:`), so a minifier rename also fails
// it: that reads as "could not check", re-derive the needle.
describe('the default-deny allowlist is reviewed against the installed SDK and binary (issue #225)', () => {
  /** Declared interface names whose runtime tool name differs (the hook and BUILTIN_TOOL_NAMES spell the runtime name). */
  const DECLARED_TO_RUNTIME: Readonly<Record<string, string>> = {
    ListMcpResources: 'ListMcpResourcesTool',
    ReadMcpResource: 'ReadMcpResourceTool',
    ReadMcpResourceDir: 'ReadMcpResourceDirTool',
    ProposeSkills: 'propose_skills',
  };
  /** Union members that are not tools: `McpInput` is the generic input of every MCP tool. */
  const DECLARED_NON_TOOLS = ['Mcp'] as const;
  /** Tool-definition sites in the 0.3.312 darwin/linux binary, counted 05/11/2026. Re-read the binary when this moves. */
  const BINARY_TOOL_DEFINITION_NEEDLE = /\btn\(\{name:/g;
  const BINARY_TOOL_DEFINITIONS = 77;

  /** `BUILTIN_TOOL_NAMES` read from sdk.d.ts as text: the unit suite never loads the SDK at runtime (pin 30). */
  const readBuiltinToolNames = (): readonly string[] => {
    const source = readFileSync(join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.d.ts'), 'utf8');
    const list = /export declare const BUILTIN_TOOL_NAMES: readonly \[([^\]]*)\];/.exec(source)?.[1];
    expect(list, 'could not check: no `BUILTIN_TOOL_NAMES` tuple in sdk.d.ts').toBeDefined();
    return [...(list ?? '').matchAll(/'([^']+)'/g)].map((name) => name[1] ?? '');
  };

  let BUILTIN_TOOL_NAMES: readonly string[] = [];
  let typedSurface: ReadonlySet<string> = new Set();

  beforeAll(() => {
    BUILTIN_TOOL_NAMES = readBuiltinToolNames();
    const declared = loadSdkTools()
      .map((tool) => tool.tool)
      .filter((tool) => !(DECLARED_NON_TOOLS as readonly string[]).includes(tool))
      .map((tool) => DECLARED_TO_RUNTIME[tool] ?? tool);
    typedSurface = new Set([...BUILTIN_TOOL_NAMES, ...declared]);
  });

  it('reads a real typed surface (a short read is "could not check", not clean)', () => {
    expect(BUILTIN_TOOL_NAMES.length).toBeGreaterThanOrEqual(MIN_UNION_MEMBERS);
    for (const anchor of ANCHOR_TOOLS) expect(typedSurface.has(anchor), anchor).toBe(true);
  });

  it('every alias and non-tool exception still holds (none outlives its cause)', () => {
    const declared = new Set(loadSdkTools().map((tool) => tool.tool));
    const stale = [
      ...Object.entries(DECLARED_TO_RUNTIME).flatMap(([iface, runtime]) => [
        ...(declared.has(iface) ? [] : [`${iface}: no longer declared`]),
        ...(BUILTIN_TOOL_NAMES.includes(runtime) ? [] : [`${runtime}: not in BUILTIN_TOOL_NAMES`]),
      ]),
      ...DECLARED_NON_TOOLS.filter((name) => !declared.has(name)).map((name) => `${name}: no longer declared`),
    ];
    expect(stale).toEqual([]);
  });

  it('every typed-surface tool carries a ruling: allowed, refused by name, a denied code runner, or reviewed-refused', () => {
    const ruled = (tool: string): boolean =>
      ALLOWED_TOOL_NAMES.has(tool) ||
      Object.hasOwn(DENIED_TOOLS, tool) ||
      CODE_EXECUTING_TOOLS[tool] === 'denied' ||
      Object.hasOwn(REVIEWED_REFUSED_TOOLS, tool);
    expect([...typedSurface].filter((tool) => !ruled(tool)).sort(), 'unruled typed-surface tools: rule each in tool-targets.ts').toEqual([]);
  });

  // A quoted name anywhere in the binary is weak evidence (it shows the name, not a definition); only StructuredOutput relies on it.
  it('every acknowledged or reviewed-refused entry names a tool the SDK lists or the binary names (no stale ruling)', () => {
    const stale = [...Object.keys(ACKNOWLEDGED_TOOLS), ...Object.keys(REVIEWED_REFUSED_TOOLS)].filter(
      (tool) => !typedSurface.has(tool) && !binaryHolds(`"${tool}"`),
    );
    expect(stale).toEqual([]);
  });

  it('the tool-definition count in the installed binary is the one the classification read', () => {
    binaryHolds('CLAUDE_CODE_REPL'); // loads the binary, failing loudly when it is missing
    const sites = (platformBinaryBytes ?? Buffer.alloc(0)).toString('latin1').match(BINARY_TOOL_DEFINITION_NEEDLE) ?? [];
    expect(sites.length, 'tool definitions in the binary changed: re-read it, rule each new tool, then update the count').toBe(BINARY_TOOL_DEFINITIONS);
  });
});

// Issue #250 (ADR-0040 D-8 as amended 12/11/2026). The harness turns the CLI's
// background tasks off by forcing an environment variable into the child. That
// rests on the CLI still reading the name, which no type declares, so the
// evidence is the binary itself (the #219 pattern): a missing binary or a
// missing name FAILS, never skips. This catches the name going away; it cannot
// catch the CLI keeping the name and changing what it does, which is what the
// keyless mock runs recorded in R-28 are for.
describe('the background-tasks switch and field still exist in the installed SDK and binary (issue #250)', () => {
  it('the platform binary names every variable the harness forces into the child', () => {
    const names = Object.keys(FORCED_CHILD_ENV);
    expect(names).toContain(BACKGROUND_TASKS_SWITCH);
    expect(names).toContain(CRON_SWITCH);
    expect(names).toContain(ATTACHMENTS_SWITCH);
    expect(names).toContain(AUTO_MEMORY_SWITCH);
    expect(names.filter((name) => !binaryHolds(name))).toEqual([]);
  });

  // #254: the self-protection deny names the file the CLI reads durable jobs from. This catches the
  // file name going away; a new location is what the keyless `cron-plant` probe is for.
  it('the platform binary still names the scheduled-tasks file the self-protection deny covers', () => {
    expect(binaryHolds(SCHEDULED_TASKS_FILE)).toBe(true);
  });

  it('the SDK still declares the Bash field the background deny reads', () => {
    const bash = loadSdkTools().find((tool) => tool.tool === 'Bash');
    expect(bash, 'could not check: Bash did not parse').toBeDefined();
    expect(bash?.fields.map((field) => field.name)).toContain(BASH_BACKGROUND_FIELD);
  });
});
