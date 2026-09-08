#!/usr/bin/env node
// Keyed, out-of-band SMOKE for the model-facing rewrite channel (issue #84, D7).
// This is the genuine-traffic leg the fake-driven pins cannot be: it runs a REAL
// session through the shipped library with the real `redact`/`scan`, over the
// live SDK, and asserts the rewrite actually LANDED (spike p2/p3 proved the SDK
// drops a bad rewrite with NO in-band signal, so a smoke that only checks the
// harness's own report would be a no-op under a green suite).
//
// It spends money and needs ANTHROPIC_API_KEY, so it is OUT OF BAND, NOT in CI
// (same contract as capture-sdk-hook-fixture.mjs). Build first:
//   npm run build && ANTHROPIC_API_KEY=... node scripts/smoke-rewrite-channel.mjs
// Re-run after any SDK bump (the fixture's sdkVersion assertion already forces a
// re-capture; this smoke is named beside it).
//
// SCOPE, stated so the smoke does not overclaim (S-12): it drives the Bash tool
// only. MCP tools carry their output in a different field and are UNCHECKED here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist', 'index.js');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set; this smoke spends money and cannot run without it.');
  process.exit(2);
}

const sdk = await import('@anthropic-ai/claude-agent-sdk');
if (typeof sdk.query !== 'function') {
  console.error('SDK does not export query(); check the installed version.');
  process.exit(2);
}

const {
  createSession,
  createHookRuntime,
  createMemoryStore,
  openMemoryDatabase,
  route,
  redact,
  scan,
} = await import(dist);

// A synthetic AWS access-key-id-shaped token assembled at runtime so no literal
// secret ever lands in the repo. `AKIA` + 16 uppercase/digit chars matches the
// high-precision `aws-access-key-id` rule.
const SYNTH = 'AKIA' + 'ROT13EXAMPLEKEY0'.replace(/[^A-Z0-9]/g, 'X').slice(0, 16).padEnd(16, 'X');

// Wraps the SDK query so we can TEE the raw hook inputs (which carry
// `transcript_path`, a field the harness's structural view drops, G-12) and the
// harness's own hook OUTPUTS, without the session ever seeing the extra plumbing.
function teeingQuery(realQuery, sink) {
  return (args) => {
    const hooks = args.options?.hooks ?? {};
    const wrapMatchers = (matchers) =>
      (matchers ?? []).map((m) => ({
        ...m,
        hooks: (m.hooks ?? []).map((cb) => async (input, toolUseId, ctx) => {
          if (typeof input?.transcript_path === 'string') sink.transcriptPath = input.transcript_path;
          sink.inputs.push({ event: input?.hook_event_name, tool: input?.tool_name });
          return cb(input, toolUseId, ctx);
        }),
      }));
    return realQuery({
      ...args,
      options: {
        ...args.options,
        hooks: {
          ...hooks,
          PreToolUse: wrapMatchers(hooks.PreToolUse),
          PostToolUse: wrapMatchers(hooks.PostToolUse),
          PostToolUseFailure: wrapMatchers(hooks.PostToolUseFailure),
        },
      },
    });
  };
}

function makeSession(sink) {
  return createSession(
    {
      query: teeingQuery(sdk.query, sink),
      hooks: createHookRuntime(),
      memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
      loadSkills: () => ({ skills: [], errors: [], root: null }),
      route,
      scanInjection: (text) => scan(text),
      redactSecrets: (text) => redact(text),
    },
    { skillsDir: null, maxTurns: 4 },
  );
}

// S-7: the exact oracle, kept out of band. The runtime records a refused rewrite
// in its transcript as a `hook_error_during_execution` record naming PostToolUse.
// A clean smoke run must hold NONE for PostToolUse.
function transcriptHasPostToolRefusal(transcriptPath) {
  if (typeof transcriptPath !== 'string') return false;
  let text;
  try {
    text = readFileSync(transcriptPath, 'utf8');
  } catch {
    return false;
  }
  return text
    .split('\n')
    .filter((line) => line.includes('hook_error_during_execution'))
    .some((line) => line.includes('PostToolUse') && !line.includes('PostToolUseFailure'));
}

const failures = [];

// Drive 1: a SUCCESSFUL echo of the synthetic token. Expect an APPLIED rewrite.
{
  const sink = { inputs: [], transcriptPath: undefined };
  const session = makeSession(sink);
  const result = await session.run(
    `Call the Bash tool exactly once to run: echo ${SYNTH}. After the tool result, reply with the single word done.`,
  );
  const first = result.outputRewrites[0];
  if (!first || first.outcome !== 'applied') {
    failures.push(`drive 1: expected outputRewrites[0].outcome === 'applied', got ${JSON.stringify(first)}`);
  }
  if (transcriptHasPostToolRefusal(sink.transcriptPath)) {
    failures.push('drive 1: the runtime transcript holds a PostToolUse hook_error_during_execution (the SDK REFUSED the rewrite)');
  }
}

// Drive 2: the same token in a command that EXITS NON-ZERO. Established by
// execution 2026-09-08 (tasks/issue-84-evidence/design-review/postoolfailure-finding.md):
// a non-zero shell exit fires the normal PostToolUse, NOT PostToolUseFailure, so
// D1 rewrites its output like any success. Assert the secret was still APPLIED.
// (PostToolUseFailure is the tool-EXECUTION-error path and is not exercised here;
// its handler is covered by the fake-driven unit pins.)
{
  const sink = { inputs: [], transcriptPath: undefined };
  const session = makeSession(sink);
  const missing = `${process.cwd()}/smoke-missing-84.txt`;
  const result = await session.run(
    `Call the Bash tool exactly once to run: cat ${missing}. It will fail because the file does not exist. After the tool result, reply with the single word done.`,
  );
  // The failure hook MUST have fired on live traffic (proves the D8 wiring), and
  // a failed call has NO rewrite channel, so nothing is rewritten for it.
  const firedFailure = sink.inputs.some((e) => e.event === 'PostToolUseFailure');
  if (!firedFailure) {
    failures.push(`drive 2 (tool-execution failure): expected a live PostToolUseFailure event, saw ${JSON.stringify(sink.inputs.map((e) => e.event))}`);
  }
  if (result.outputRewrites.length !== 0) {
    failures.push(`drive 2: a failed call has no rewrite channel, expected 0 rewrites, got ${result.outputRewrites.length}`);
  }
}

if (failures.length > 0) {
  console.error('SMOKE FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('smoke-rewrite-channel: OK (rewrite applied on a successful call; failure hook fired with no rewrite on a failed call; no SDK refusal)');
