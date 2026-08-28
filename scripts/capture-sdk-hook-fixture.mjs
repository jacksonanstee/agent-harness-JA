#!/usr/bin/env node
// Capture GENUINE SDK PreToolUse/PostToolUse hook inputs and freeze them as a
// fixture, so a test can prove the harness reads the shape the real SDK sends
// (issue #83: the harness read `tool_output`; the SDK sends `tool_response`; a
// hand-written fake could not have caught it).
//
// This spends money and needs ANTHROPIC_API_KEY, so it is out-of-band, NOT in
// CI. Re-run it after any SDK bump:
//   ANTHROPIC_API_KEY=... node scripts/capture-sdk-hook-fixture.mjs
// It overwrites src/session/fixtures/sdk-hook-events.json. Review the diff.
//
// Volatile fields (session_id, transcript_path, cwd, prompt_id, tool_use_id,
// duration_ms) are replaced with stable placeholders so the fixture is
// machine-independent; the STRUCTURE and field NAMES are what the test binds.
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    },
  },
});
for await (const _msg of q) {
  // drain; hooks fire as tools run
}

const PLACEHOLDERS = {
  session_id: '<session>',
  transcript_path: '<transcript>',
  cwd: '<cwd>',
  prompt_id: '<prompt>',
  tool_use_id: '<tool_use_id>',
  duration_ms: 0,
};
// Scrub TOP-LEVEL keys only. The volatile fields are BaseHookInput members at
// the event root; recursing would also overwrite an identically-named field
// nested inside tool_input/tool_response (plausible for a filesystem tool whose
// output carries a `cwd`), silently mangling real captured data.
const scrubTopLevel = (event) => {
  const out = {};
  for (const [k, v] of Object.entries(event)) {
    out[k] = k in PLACEHOLDERS ? PLACEHOLDERS[k] : v;
  }
  return out;
};

const pre = captured.find((e) => e.hook_event_name === 'PreToolUse');
const post = captured.find((e) => e.hook_event_name === 'PostToolUse');
if (!pre || !post) {
  console.error(`Did not capture both events (pre=${!!pre} post=${!!post}). Raw:`, JSON.stringify(captured, null, 2));
  process.exit(1);
}

// Refuse to write unless the captured pair is exactly the fixed benign command
// this script drove. The model could in principle call a different tool first
// or deviate from the one-line instruction; without this check whatever it did
// would be frozen into a committed fixture. Asserting the marker guarantees the
// captured content is the known string and nothing attacker- or model-authored.
const bad = [];
if (pre.tool_name !== 'Bash') bad.push(`pre.tool_name=${pre.tool_name}`);
if (post.tool_name !== 'Bash') bad.push(`post.tool_name=${post.tool_name}`);
const stdout = post.tool_response?.stdout;
if (stdout !== MARKER) bad.push(`post.tool_response.stdout=${JSON.stringify(stdout)}`);
if (bad.length) {
  console.error(
    `Refusing to write: captured events are not the expected Bash marker run (${bad.join(', ')}).\n` +
      `The model deviated from the fixed prompt. Inspect and re-run; nothing was written.`,
  );
  process.exit(1);
}

const fixture = {
  _provenance: {
    capturedFrom: '@anthropic-ai/claude-agent-sdk',
    sdkVersion,
    marker: MARKER,
    note: 'Genuine SDK hook inputs, volatile fields replaced with placeholders. Re-capture with scripts/capture-sdk-hook-fixture.mjs after an SDK bump.',
  },
  preToolUse: scrubTopLevel(pre),
  postToolUse: scrubTopLevel(post),
};
const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'session', 'fixtures', 'sdk-hook-events.json');
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
console.log(`Wrote ${outPath}`);
console.log(`post-tool keys: ${Object.keys(fixture.postToolUse).join(', ')}`);
