#!/usr/bin/env node
// Capture GENUINE SDK PreToolUse/PostToolUse hook inputs and freeze them as a
// fixture, so a test can prove the harness reads the shape the real SDK sends
// (issue #83: the harness read `tool_output`; the SDK sends `tool_response`; a
// hand-written fake could not have caught it).
//
// Three drives, two tools (issues #84, #103): Bash success (`echo <marker>`),
// Bash failure (`cat <missing file>`, which fires PostToolUseFailure), and Read
// of the committed src/session/fixtures/read-target.txt, whose `tool_response`
// is a NESTED `{type, file: {filePath, content, ...}}` object, not Bash's flat
// `{stdout, stderr, ...}`.
//
// This spends money and needs ANTHROPIC_API_KEY, so it is out-of-band, NOT in
// CI. Re-run it after any SDK bump:
//   ANTHROPIC_API_KEY=... node scripts/capture-sdk-hook-fixture.mjs
// It overwrites src/session/fixtures/sdk-hook-events.json. Review the diff.
//
// Scrubbing and refusal (scripts/fixture-path-scan.mjs, unit-tested offline):
//   1. Volatile TOP-LEVEL fields (session_id, transcript_path, cwd, prompt_id,
//      tool_use_id, duration_ms) become placeholders.
//   2. Only KNOWN literal paths are replaced, at any depth: the Read target
//      (`<read-target>`), the failing-run path and the cwd (`<cwd>/...`). There
//      is no general scrub, because every expected path is one of these.
//   3. The result is then scanned for ANY absolute or home-relative path (not a
//      list of roots), in values and keys, and the script REFUSES to write if
//      one remains: an unexpected path means the run did something unexpected.
// The STRUCTURE and field NAMES are what the test binds.
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildFixture } from './fixture-path-scan.mjs';

const sdk = await import('@anthropic-ai/claude-agent-sdk');
if (typeof sdk.query !== 'function') {
  console.error('SDK does not export query(); check the installed version.');
  process.exit(2);
}
const sdkVersion = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
    'utf8',
  ),
).version;

// A cwd of `/` (or empty) would make the cwd literal swallow every path; refuse
// before any paid drive.
if (process.cwd().length <= 1) {
  console.error(`Refusing to run from cwd ${JSON.stringify(process.cwd())}: run from the repo root (nothing spent).`);
  process.exit(2);
}
// Fixed Read target, checked BEFORE any paid drive (issue #103).
const READ_MARKER = 'harness-fixture-read-marker';
const READ_PATH_PLACEHOLDER = '<read-target>';
const here = dirname(fileURLToPath(import.meta.url));
const READ_TARGET = join(here, '..', 'src', 'session', 'fixtures', 'read-target.txt');
if (!readFileSync(READ_TARGET, 'utf8').includes(READ_MARKER)) {
  console.error(`${READ_TARGET} does not contain ${READ_MARKER}; refusing to drive Read (nothing spent).`);
  process.exit(2);
}
const captured = [];
const recorder = () => async (input) => {
  captured.push(JSON.parse(JSON.stringify(input)));
  return {};
};

const MARKER = 'harness-fixture-capture-marker';
const q = sdk.query({
  prompt:
    `Call the Bash tool exactly once to run: echo ${MARKER}. ` +
    `After the tool result, reply with the single word done.`,
  options: {
    maxTurns: 4,
    hooks: {
      PreToolUse: [{ hooks: [recorder()] }],
      PostToolUse: [{ hooks: [recorder()] }],
      // The SDK routes a FAILED call here, never to PostToolUse (issue #84,
      // S-1). Registered on both drives so a re-capture freezes a genuine
      // PostToolUseFailure event beside the pre/post pair (D7, G-3).
      PostToolUseFailure: [{ hooks: [recorder()] }],
    },
  },
});
for await (const _msg of q) {
  // drain; hooks fire as tools run
}

// Second drive (issue #84, D8): a FAILING command, so the SDK fires
// PostToolUseFailure. Its `error` string is what the model receives; there is
// no rewrite channel on this path, which is exactly the residual D8 records.
const MARKER_FAIL = 'harness-fixture-capture-missing-84.txt';
const FAIL_PATH = `${process.cwd()}/${MARKER_FAIL}`;
const qFail = sdk.query({
  prompt:
    `Call the Bash tool exactly once to run: cat ${FAIL_PATH}. ` +
    `It will fail because the file does not exist. After the tool result, reply with the single word done.`,
  options: {
    maxTurns: 4,
    hooks: {
      PreToolUse: [{ hooks: [recorder()] }],
      PostToolUse: [{ hooks: [recorder()] }],
      PostToolUseFailure: [{ hooks: [recorder()] }],
    },
  },
});
for await (const _msg of qFail) {
  // drain; the failure hook fires when the non-zero exit is seen
}

// Third drive (issue #103): a structurally different tool. Read returns a
// structured file object in tool_response (`{type, file: {filePath, content,
// ...}}`), not Bash's `{stdout, stderr, ...}`, so a harness that only handles
// the Bash shape cannot pass for both. The target is a dedicated committed
// fixture file with innocuous content; its absolute path is machine-specific
// and is replaced by READ_PATH_PLACEHOLDER wherever it appears (nested too).
const capturedRead = [];
const readRecorder = () => async (input) => {
  capturedRead.push(JSON.parse(JSON.stringify(input)));
  return {};
};
const qRead = sdk.query({
  prompt:
    `Call the Read tool exactly once on the file ${READ_TARGET}. ` +
    `After the tool result, reply with the single word done.`,
  options: {
    maxTurns: 4,
    hooks: {
      PreToolUse: [{ hooks: [readRecorder()] }],
      PostToolUse: [{ hooks: [readRecorder()] }],
    },
  },
});
for await (const _msg of qRead) {
  // drain; hooks fire as the tool runs
}

const PLACEHOLDERS = {
  session_id: '<session>',
  transcript_path: '<transcript>',
  cwd: '<cwd>',
  prompt_id: '<prompt>',
  tool_use_id: '<tool_use_id>',
  duration_ms: 0,
};
// Known machine-specific literals, most specific first. Every path the three
// drives are EXPECTED to produce is one of these; scrubbing is by exact literal
// only (the volatile BaseHookInput fields at the event root are placeholdered
// by key, top-level only, so a nested `cwd` in a tool_response is never mangled).
// Any OTHER path-looking string makes buildFixture refuse to write.
const PATH_LITERALS = [
  [READ_TARGET, READ_PATH_PLACEHOLDER],
  [FAIL_PATH, `<cwd>/${MARKER_FAIL}`],
  [process.cwd(), '<cwd>'],
];

const pre = captured.find((e) => e.hook_event_name === 'PreToolUse');
const post = captured.find((e) => e.hook_event_name === 'PostToolUse');
const fail = captured.find((e) => e.hook_event_name === 'PostToolUseFailure');
const readPre = capturedRead.find((e) => e.hook_event_name === 'PreToolUse');
const readPost = capturedRead.find((e) => e.hook_event_name === 'PostToolUse');
if (!readPre || !readPost) {
  console.error(
    `Did not capture both Read events (pre=${!!readPre} post=${!!readPost}). Raw:`,
    JSON.stringify(capturedRead, null, 2),
  );
  process.exit(1);
}
if (!pre || !post) {
  console.error(`Did not capture both events (pre=${!!pre} post=${!!post}). Raw:`, JSON.stringify(captured, null, 2));
  process.exit(1);
}
if (!fail) {
  // Not fatal for the pre/post pair, but D8's replay leg needs it. Warn loudly
  // so a re-capture that failed to elicit a failure event is noticed.
  console.error(
    'WARNING: no PostToolUseFailure event captured; the D8 replay leg will stay skipped. ' +
      'The model may not have run the failing command. Inspect and re-run to freeze it.',
  );
}

// Validate and scan (scripts/fixture-path-scan.mjs, unit-tested offline): the
// captured events must be exactly the fixed Bash and Read marker runs, and after
// the known literals are replaced no path-looking string may remain anywhere
// (values or keys, including model-written `description` and the failure
// `command`). Either refusal exits before anything is written.
const result = buildFixture(
  { pre, post, fail, readPre, readPost },
  {
    marker: MARKER,
    markerFail: MARKER_FAIL,
    readMarker: READ_MARKER,
    readPlaceholder: READ_PATH_PLACEHOLDER,
    literals: PATH_LITERALS,
    volatile: PLACEHOLDERS,
    sdkVersion,
  },
);
if (!result.ok && result.kind === 'bad') {
  console.error(
    `Refusing to write: captured events are not the expected Bash and Read marker runs (${result.problems.join(', ')}).\n` +
      `The model deviated from the fixed prompt. Inspect and re-run; nothing was written.`,
  );
  process.exit(1);
}
if (!result.ok) {
  console.error(
    `Refusing to write: unexpected machine paths remain after the known literals were replaced:\n  ${result.problems.join('\n  ')}\n` +
      `The run touched a path this script did not expect. Inspect and re-run; nothing was written.`,
  );
  process.exit(1);
}
const { fixture } = result;

const outPath = join(here, '..', 'src', 'session', 'fixtures', 'sdk-hook-events.json');
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
console.log(`Wrote ${outPath}`);
console.log(`read post-tool response keys: ${Object.keys(fixture.readPostToolUse.tool_response ?? {}).join(', ')}`);
console.log(`post-tool keys: ${Object.keys(fixture.postToolUse).join(', ')}`);
console.log(
  fixture.postToolUseFailure
    ? `post-tool-failure keys: ${Object.keys(fixture.postToolUseFailure).join(', ')}`
    : 'post-tool-failure: NOT captured (D8 replay leg stays skipped)',
);
