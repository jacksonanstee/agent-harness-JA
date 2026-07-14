// Starter templates for `init`, embedded as string constants so they compile
// into dist/ and survive `npm pack` (the files allowlist ships only dist,
// README, LICENSE; a loose templates/ dir would silently vanish from the
// tarball). Semantic validity is pinned by init-templates.test.ts against the
// REAL loaders, not substring checks.

export const INIT_SETTINGS_JSON = `{
  "permissions": {
    "rules": [
      { "tool": "WebFetch", "decision": "deny" },
      { "tool": "WebSearch", "decision": "deny" }
    ]
  }
}
`;

export const INIT_GITIGNORE = `# Harness artefacts (telemetry DB, eval scorecards) stay local; the
# committed security policy stays tracked.
.harness/*
!.harness/settings.json
`;

export const INIT_SKILL = `---
name: getting-started
description: Answers questions about this scaffolded starter project, its files, its security policy, and how run and eval work.
version: 0.1.0
---

# Getting started with this project

This project was scaffolded by \`agent-harness-ja init\`. Facts this skill
answers from:

- It contains six files: README.md, .gitignore, .harness/settings.json,
  skills/getting-started.md, hello-harness.task.md, and
  hello-harness.oracle.mjs.
- The security policy in .harness/settings.json denies exactly two tools:
  WebFetch and WebSearch. It omits defaultDecision, so this project can
  tighten a user-level policy but never loosen it.
- Before running eval on a project you did not create, read the oracle file
  (hello-harness.oracle.mjs) first: oracles are in-process code the eval CLI
  executes with no gate (security-model residual risk R-10).
`;

export const INIT_TASK = `---
id: hello-harness
descriptor:
  shape: lookup
  sensitivity: low
  expected_tokens: 300
maxTurns: 5
---
Answer directly from the getting-started skill you have loaded, without
using any tools, in two or three sentences: which two tools does this
project's security policy deny, and what should you do before running eval
on a project you did not create?
`;

// The typed JSDoc import matches the documented oracle authoring contract
// (src/eval/golden/oracle.ts) and examples/repo-qa; it resolves only once the
// package is installed and is harmless plain text until then.
export const INIT_ORACLE = `/** @type {import('agent-harness-ja').OracleFn} */
export const oracle = (result) => {
  if (result.resultSubtype !== 'success') {
    return { pass: false, reason: \`expected subtype success, got \${result.resultSubtype}\` };
  }
  // Groundedness pin: a single turn means the answer came from the loaded
  // skill. More turns usually means the agent reached for a tool instead.
  if (result.numTurns !== 1) {
    return {
      pass: false,
      reason:
        \`expected a 1-turn skill-grounded answer, got \${result.numTurns} turns; \` +
        'the agent likely reached for a tool instead of answering from the loaded skill',
    };
  }
  const text = result.resultText ?? '';
  if (!/webfetch/i.test(text) || !/websearch/i.test(text)) {
    return {
      pass: false,
      reason: 'expected the answer to name both denied tools (WebFetch and WebSearch)',
    };
  }
  return /read/i.test(text) && /oracle/i.test(text)
    ? { pass: true }
    : { pass: false, reason: 'expected the read-the-oracle-before-eval (R-10) step' };
};
`;

export const INIT_README = `# My harness project

Scaffolded by \`agent-harness-ja init\`: a small agent with one skill, one
committed security policy, and one golden eval task.

## Quickstart

1. Export your API key (get one at
   https://console.anthropic.com/settings/keys):

       export ANTHROPIC_API_KEY=sk-ant-...

2. Ask the agent something the skill can answer:

       agent-harness-ja run "Using only the getting-started skill, say which two tools this project's policy denies."

   Running from a clone instead of an install? Use \`node <path>/dist/cli.js\`
   in place of \`agent-harness-ja\`; \`init\` printed the exact command.

3. Evaluate it. Run this from THIS directory: the security policy in
   \`.harness/settings.json\` is loaded from the current working directory.

       agent-harness-ja eval .

   Expect 1/1 pass in 1 turn, a few cents at most.

## The security policy, and its honest limits

\`.harness/settings.json\` denies the two network tools, WebFetch and
WebSearch. It deliberately omits \`defaultDecision\`: a project policy can
tighten your user-level policy but never loosen it.

Watch a request get denied, attributed to the rule and layer that fired:

    agent-harness-ja run "Fetch https://example.com and summarise it"

Know the route-around: with Bash allowed, an agent can still reach the
network with \`curl\`. A deny-list is not a boundary until the alternate
routes are closed. To close this one, add a rule:

    { "tool": "Bash", "decision": "deny" }

This starter leaves Bash open so your first prompts work unhindered; tighten
the policy the moment your use case does not need shell access.

## The eval, and what a failure means

\`hello-harness.task.md\` asks a question the getting-started skill answers,
and its oracle requires a 1-turn answer. One turn means the answer came from
the loaded skill; more turns usually means the agent reached for a tool
instead of answering from the skill. If the eval fails on turns, that is
what it is telling you.

## Trust note (R-10)

\`hello-harness.oracle.mjs\` is in-process code the eval CLI executes with no
gate. Read every oracle before running \`eval\` on a project you did not
create; treat oracles as code you are executing, because they are.

## Housekeeping

- Run telemetry lands in \`.harness/telemetry.db\`; eval scorecards in
  \`.harness/eval/\`. Both are gitignored; the committed policy is not.
- If this directory sits inside a repo whose ancestor .gitignore ignores
  \`.harness/\`, confirm the policy is still tracked:
  \`git check-ignore .harness/settings.json\` should print nothing.
- If you add CI, run only the keyless \`redteam\` gate. Never put an API key
  in CI to run \`eval\`: a fork PR plus a CI key plus in-process oracles is
  an exfiltration primitive.
`;

export interface InitFile {
  /** Path relative to the target dir, POSIX separators (also used in output). */
  path: string;
  content: string;
}

export const INIT_FILES: ReadonlyArray<InitFile> = [
  { path: 'README.md', content: INIT_README },
  { path: '.gitignore', content: INIT_GITIGNORE },
  { path: '.harness/settings.json', content: INIT_SETTINGS_JSON },
  { path: 'skills/getting-started.md', content: INIT_SKILL },
  { path: 'hello-harness.task.md', content: INIT_TASK },
  { path: 'hello-harness.oracle.mjs', content: INIT_ORACLE },
];

export const INIT_TARGET_PATHS: ReadonlyArray<string> = INIT_FILES.map((f) => f.path);
