/**
 * Rows for the table-driven policy corpus (issue #190). One row is one tool
 * call put to the composed pre-tool path; the fixture policy the rows are
 * written against is declared at the top of policy-corpus.test.ts.
 *
 * Columns: expect | tool | input | rule | note.
 *
 *   expect  allow: the call proceeds. deny: refused. ask: an 'ask' rule won,
 *           and with no prompter wired that FAILS CLOSED to a refusal
 *           (ADR-0014 section 4); the row is labelled ask so the policy
 *           intent stays visible in the table.
 *   input   tool arguments. `{ROOT}` in any string is replaced with the
 *           per-run temp directory the fixture sandbox allows under.
 *   rule    why the verdict is what it is, so a row cannot pass for the wrong
 *           reason. Every non-allow row's reason must carry that rule's text:
 *             perm:<layer>:<n>   the winning permission rule, by its position
 *                                in that layer's own settings file
 *             sandbox:command    Bash/Monitor command refused by the allowlist
 *             sandbox:path       path tool refused by the allowlist
 *             sandbox:no-target  gated field absent (ADR-0033)
 *             sandbox:not-string gated field present but not a string
 *           An allow row carries `none`.
 *   note    one line on what the row guards.
 */
export type RuleId =
  | 'none'
  | `perm:${'user' | 'project'}:${number}`
  | 'sandbox:command'
  | 'sandbox:path'
  | 'sandbox:no-target'
  | 'sandbox:not-string';

export interface PolicyRow {
  readonly expect: 'allow' | 'ask' | 'deny';
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly rule: RuleId;
  readonly note: string;
}

const bash = (
  expect: PolicyRow['expect'],
  command: unknown,
  rule: RuleId,
  note: string,
): PolicyRow => ({ expect, tool: 'Bash', input: { command }, rule, note });

const file = (
  expect: PolicyRow['expect'],
  tool: string,
  filePath: unknown,
  rule: RuleId,
  note: string,
): PolicyRow => ({ expect, tool, input: { file_path: filePath }, rule, note });

export const POLICY_ROWS: readonly PolicyRow[] = [
  // ---- allow: ordinary work inside the fixture sandbox ----
  bash('allow', 'git status', 'none', 'allowlisted program, no rule matches'),
  bash('allow', 'ls -la', 'none', 'allowlisted program with a flag'),
  bash('allow', 'git log --oneline', 'none', 'git subcommand covered by the git allow rule'),
  bash('allow', 'npm test', 'none', 'npm is allowlisted; only npm publish is denied'),
  bash('allow', 'cat README.md', 'none', 'allowlisted reader'),
  bash('allow', '  git   status  ', 'none', 'blank runs and padding are normalised, not refused'),
  file('allow', 'Read', '{ROOT}/work/src/a.ts', 'none', 'path under the allowlisted base'),
  file('allow', 'Write', '{ROOT}/work/out.txt', 'none', 'write under the allowlisted base'),
  file('allow', 'Edit', '{ROOT}/work/src/a.ts', 'none', 'edit under the allowlisted base'),
  file('allow', 'Read', '{ROOT}/work/../work/src/a.ts', 'none', '.. that stays inside the base'),
  { expect: 'allow', tool: 'Glob', input: { path: '{ROOT}/work' }, rule: 'none', note: 'glob of the base itself' },
  { expect: 'allow', tool: 'Grep', input: { path: '{ROOT}/work/src', pattern: 'x' }, rule: 'none', note: 'grep under the base' },
  { expect: 'allow', tool: 'TodoWrite', input: { todos: [] }, rule: 'none', note: 'tool outside both gates falls to default allow' },

  // ---- allow: negative controls (look dangerous, must pass) ----
  bash('allow', 'git commit -m "fix: rm -rf cleanup"', 'none', 'NEGATIVE CONTROL: message text contains rm -rf, argv0 is git'),
  bash('allow', 'echo git push --force', 'none', 'NEGATIVE CONTROL: deny rule is a prefix of the command, not a substring'),
  bash('allow', 'git commit -m "docs: never git push --force"', 'none', 'NEGATIVE CONTROL: force-push words inside a quoted argument'),
  file('allow', 'Read', '{ROOT}/work/force-push.md', 'none', 'NEGATIVE CONTROL: file named after a dangerous command'),
  file('allow', 'Read', '{ROOT}/work/secrets-notes.md', 'none', 'NEGATIVE CONTROL: sibling that shares the secrets prefix string'),
  file('allow', 'Read', '{ROOT}/work/.env.example', 'none', 'NEGATIVE CONTROL: dodges the exact-match deny on .env (rule 8) by its boundary'),
  bash('allow', 'ls rm', 'none', 'NEGATIVE CONTROL: rm is an argument, not the program'),

  // ---- deny: permission rules ----
  bash('deny', 'git push --force origin main', 'perm:user:0', 'force push: deny beats the ask and allow rules that also match'),
  bash('deny', 'rm -rf /', 'perm:user:2', 'permission gets first say; the sandbox would also refuse rm'),
  bash('deny', 'rm -rf ~', 'perm:user:2', 'same rule, different target'),
  file('deny', 'Read', '{ROOT}/work/secrets/key.pem', 'perm:user:3', 'deny glob on a secrets directory'),
  file('deny', 'Read', '{ROOT}/work/secrets', 'perm:user:3', 'the bare directory is covered by dir/* (inclusive boundary)'),
  file('deny', 'Read', '{ROOT}/work/x/../secrets/key.pem', 'perm:user:3', '.. is resolved before matching'),
  { expect: 'deny', tool: 'WebFetch', input: { url: 'https://example.com' }, rule: 'perm:user:7', note: 'tool denied by name' },
  file('deny', 'Read', '{ROOT}/work/.env', 'perm:user:8', 'exact-match deny on the env file'),
  bash('deny', 'npm publish', 'perm:project:1', 'a project layer can tighten policy'),

  // ---- ask: ADR-0014 section 4, no prompter so the ask fails closed ----
  bash('ask', 'git push origin main', 'perm:user:1', 'ask: a project allow rule cannot loosen a user ask (ADR-0014 section 5)'),
  bash('ask', 'git push -f origin main', 'perm:user:1', 'ask: -f is not caught by the --force deny prefix, falls to the push ask (documented limit)'),
  { expect: 'ask', tool: 'mcp__github__create_issue', input: { title: 't' }, rule: 'perm:user:5', note: 'ask: wildcard tool rule' },
  file('ask', 'Write', '{ROOT}/work/config/settings.json', 'perm:user:4', 'ask: guarded write path'),

  // ---- deny: sandbox command gate ----
  bash('deny', 'curl http://example.com', 'sandbox:command', 'program not on the allowlist'),
  bash('deny', 'python -c "print(1)"', 'sandbox:command', 'interpreter not on the allowlist'),
  bash('deny', 'sh -c "ls"', 'sandbox:command', 'shell runner'),
  bash('deny', 'env ls', 'sandbox:command', 'env IS allowlisted in the fixture; the static blocklist still wins (ADR-0015 section 3)'),
  bash('deny', 'sudo ls', 'sandbox:command', 'sudo IS allowlisted in the fixture; exec wrappers are blocked regardless'),
  bash('deny', 'git status; ls', 'sandbox:command', 'metacharacter: semicolon after an allowlisted program'),
  bash('deny', 'git status && ls', 'sandbox:command', 'metacharacter: ampersand'),
  bash('deny', 'ls | cat', 'sandbox:command', 'metacharacter: pipe'),
  bash('deny', 'ls > out.txt', 'sandbox:command', 'metacharacter: redirect'),
  bash('deny', 'ls $(whoami)', 'sandbox:command', 'metacharacter: command substitution'),
  bash('deny', 'ls `whoami`', 'sandbox:command', 'metacharacter: backtick'),
  bash('deny', 'git status\nls', 'sandbox:command', 'metacharacter: newline ends a command'),
  bash('deny', '"git" status', 'sandbox:command', 'quote in argv0 names one program and starts another (ADR-0034)'),
  bash('deny', 'g*t status', 'sandbox:command', 'glob in argv0'),
  bash('deny', 'FOO=bar git status', 'sandbox:command', 'assignment prefix hides argv0'),
  bash('deny', '/usr/bin/git status', 'sandbox:command', 'path-shaped argv0 does not match a bare-name entry'),
  bash('deny', 'git\u00a0status', 'sandbox:command', 'NBSP is not a blank: bash runs a program named git<NBSP>status (#161)'),
  bash('deny', '', 'sandbox:command', 'empty command'),
  { expect: 'deny', tool: 'Bash', input: {}, rule: 'sandbox:no-target', note: 'command absent (ADR-0033)' },
  { expect: 'deny', tool: 'Bash', input: { command: 42 }, rule: 'sandbox:not-string', note: 'command of the wrong type: refuse to guess' },

  // ---- deny: sandbox path gate ----
  file('deny', 'Read', '/etc/passwd', 'sandbox:path', 'outside every allowlisted base'),
  file('deny', 'Read', '{ROOT}/work/../outside/x.txt', 'sandbox:path', '.. escapes the base after resolution'),
  file('deny', 'Read', '{ROOT}/work-extra/x.txt', 'sandbox:path', 'sibling sharing the base prefix string (boundary safety)'),
  file('deny', 'Write', '{ROOT}/elsewhere/x.txt', 'sandbox:path', 'write outside the base'),
  file('deny', 'Read', 'relative/x.txt', 'sandbox:path', 'relative path resolves against cwd, which is outside the base'),
  { expect: 'deny', tool: 'NotebookEdit', input: { notebook_path: '/etc/x.ipynb' }, rule: 'sandbox:path', note: 'notebook tool is in the shared table' },
  { expect: 'deny', tool: 'Glob', input: { pattern: '*' }, rule: 'sandbox:path', note: 'Glob without path means cwd, which is outside the base (ADR-0015 section 2)' },
  { expect: 'deny', tool: 'Edit', input: {}, rule: 'sandbox:no-target', note: 'file_path absent (ADR-0033)' },
  { expect: 'deny', tool: 'Read', input: { file_path: 7 }, rule: 'sandbox:not-string', note: 'file_path of the wrong type' },
];
