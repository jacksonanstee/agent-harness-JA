import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EvalUsageError, toCanonicalJson, UNKNOWN_HARNESS_VERSION } from '../eval/index.js';
import type { HookEventRecord, HookRuntime } from '../hooks/index.js';
import { GuardedReadError, refuseSymlink } from '../internal/guarded-read.js';
import { boundEcho, loadJsonSettings } from '../internal/settings.js';
import { stripBidi, stripInvisibles, TERMINAL_UNSAFE } from '../internal/sanitize.js';
import {
  createPermissionEvaluator,
  createSandbox,
  hasGlobCharacter,
  hasJudgeKey,
  hasSdkKey,
  JudgeSettingsError,
  mergeLayers,
  mergeSandboxLayers,
  parseJudgeSettings,
  parseSdkSettings,
  parsePermissionSettings,
  parseSandboxSettings,
  isBlockedFirstToken,
  PermissionSettingsError,
  permissionHook,
  SandboxSettingsError,
  SdkSettingsError,
  sandboxHook,
} from '../security/index.js';
import type { EvaluatorOptions, GrantPolicy, JudgeSettings, RedactResult, SandboxConfig, SettingSource } from '../security/index.js';
import type { QueryFn } from '../session/index.js';
import { DEFAULT_ROUTING_TABLE, TASK_SENSITIVITIES, TASK_SHAPES } from '../router/index.js';
import { boundHookEventReason, TELEMETRY_EVENT_TYPES } from '../telemetry/index.js';
import type { TelemetryEventInput } from '../telemetry/index.js';

/** Default scorecard output directory, shared by eval and redteam (both are
 *  scorecard producers writing through the same `writeScorecard` helper). */
export const EVAL_OUT_DIR = join('.harness', 'eval');

/**
 * Prefix of the warning lines `run` and `eval` compose in the two command
 * files: the settings warnings, the telemetry-record failure, the session
 * onWarning relay, eval's oracle notice and its taskDir suppression. README's
 * Settings section quotes it; src/readme-settings.test.ts pins the quote to
 * this constant and asserts neither command file spells its own prefix. One
 * warning is composed elsewhere: the golden runner's `--challenge` notice
 * (src/eval/golden/runner.ts) carries its own literal and reaches stderr
 * through onProgress, because the runner sits below the CLI in the enforced
 * dependency direction (issue #100).
 */
export const WARNING_PREFIX = 'warning: ';

// The `--type` values are DERIVED from TELEMETRY_EVENT_TYPES, not hand-copied:
// a fifth event type appears in the usage text without anyone remembering to
// come here. Before this, `--type <t>` was discoverable only by guessing wrong
// and reading `parseTelemetryArgs`'s rejection message (src/cli.ts), which
// renders the same array — so both surfaces now come from one source and
// cannot disagree about what is valid.
// The run line's --shape/--sensitivity lists derive from TASK_SHAPES /
// TASK_SENSITIVITIES the same way (issue #88): the router's validator and
// the usage text share one source for what is valid, so they cannot drift
// apart the way two hand-copied lists would (the in-process-mutation
// residual is issue #123).
// The redteam line's --judge-model list derives from the router TABLE the
// same way (issue #96, U-6): the ids, deduplicated in first-appearance
// order. `parseRedteamArgs` validates against this same array, so a tier
// bump that retires an id changes the usage text and the rejection together.
// The router is not USED for the judge (ADR-0016 decision 6); only its list
// of known ids is read.
export const JUDGE_MODEL_IDS: readonly string[] = [...new Set(DEFAULT_ROUTING_TABLE.map((rule) => rule.model))];

export const USAGE =
  `Usage: agent-harness-ja run "<prompt>" [--skills-dir <dir>] [--db <path>] [--max-turns <n>] [--shape <${TASK_SHAPES.join('|')}>] [--sensitivity <${TASK_SENSITIVITIES.join('|')}>] [--expected-tokens <n>] [--expected-output-tokens <n>]\n` +
  '       agent-harness-ja eval [taskDir] [--challenge] [--max-tasks <n>]\n' +
  `       agent-harness-ja redteam [--out <dir>] [--update-baseline] [--baseline <path>] [--judge] [--judge-model <${JUDGE_MODEL_IDS.join('|')}>] [--holdout <path>] [--samples <n>]\n` +
  `       agent-harness-ja telemetry export [--db <path>] [--out <file>] [--session <id>] [--type <${TELEMETRY_EVENT_TYPES.join('|')}>] [--scrub-prefix <abs-path>]...\n` +
  '       agent-harness-ja telemetry cost [--db <path>] [--since <YYYY-MM-DD>] [--by model|session|day] [--estimate]\n' +
  '       agent-harness-ja init [dir]\n' +
  '       agent-harness-ja permissions list\n' +
  '       agent-harness-ja skills lint <dir>';

/**
 * The integer-flag parse the `run` and `eval` flags share (issue #128):
 * digits only, then `parseInt`, then `Number.isSafeInteger`. Returns
 * `undefined` for anything else; the CALLER applies its own floor and words
 * its own message, because the floors differ (`--max-turns` and `--max-tasks`
 * need 1, `--expected-tokens` accepts 0) and the messages are pinned.
 *
 * isSafeInteger, not isInteger: above 2^53 `parseInt` silently rewrites the
 * digits (code lens on 472b1eb), and a bound the operator never typed is worse
 * than a rejection. `redteam --samples` deliberately does not use this: its
 * regex also rejects a leading zero and its range is 1 to 10.
 */
export function parseSafeInt(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

// TERMINAL_UNSAFE itself now lives in src/internal/sanitize.ts, beside the
// JSON_TEXT_UNSAFE that derives from it: the zero-dep leaf is the only home
// reachable by src/eval/**, which eslint blocks from importing src/cli/**.
// The FUNCTION stays here, where all forty-odd of its callers are.

export function sanitizeForTerminal(text: string): string {
  return text.replace(TERMINAL_UNSAFE, ' ');
}

/**
 * `sanitizeForTerminal` plus the bidi controls and every default-ignorable code
 * point, for STDERR DIAGNOSTICS that echo an operator- or repo-named string (a
 * task directory, a skills directory, a baseline path). Issue #127,
 * security-model section 5.
 *
 * A SEPARATE function rather than a fold into `sanitizeForTerminal`, because
 * that one also guards stdout PROSE (model text via `onText`, rendered
 * reports), where ZWJ (emoji sequences), ZWNJ (Persian, Indic), VS16 (emoji
 * presentation) and LRM/RLM (genuine RTL text) are legitimate. Bidi stripping
 * is opt-in per sink (src/internal/sanitize.ts); every stderr diagnostic opts in.
 *
 * Reuses the two existing leaf strippers rather than a third charset:
 * `stripBidi` (bidi controls to a space, so reordered text cannot hide) then
 * `stripInvisibles` (`\p{Default_Ignorable_Code_Point}` plus U+FFF9-FFFB,
 * deleted, so a zero-width byte leaves the visible name intact). The property
 * class is a superset of `\p{Bidi_Control}`; shared.test.ts sweeps both.
 */
export function sanitizeDiagnostic(text: string): string {
  return sanitizeForTerminal(stripInvisibles(stripBidi(text)));
}


// `prefix` names the producer (issue #96): the judge arm writes
// `judge-scorecard-<stamp>.json` beside the heuristic `scorecard-<stamp>.json`,
// so two writes in one second cannot collide.
/** Filesystem-safe scorecard timestamp (spec: arbiter condition 2 — no colons). */
export function scorecardFilename(nowMs: number, prefix = 'scorecard'): string {
  const stamp = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${prefix}-${stamp}.json`;
}

/**
 * A malicious repo must not redirect the scorecard write (spec decision #21):
 * refuse a symlink at the output-dir path. Missing is fine (we mkdir it).
 *
 * The lstat primitive lives in `src/internal/guarded-read.ts` since the
 * settings loader became its third consumer (ADR-0034 decision 4); this
 * keeps the eval layer's error type and message. A stat failure other than
 * ENOENT now surfaces as a message-bearing `GuardedReadError` rather than the
 * raw fs error; both call sites (writeScorecard, the eval pre-flight) map
 * both errors this can raise to a message and an exit 2.
 */
export function refuseSymlinkedDir(path: string): void {
  try {
    refuseSymlink(path, 'directory');
  } catch (error: unknown) {
    if (error instanceof GuardedReadError && error.refusal === 'symlink') {
      throw new EvalUsageError(`refusing to write scorecards: ${path} is a symlink`);
    }
    throw error;
  }
}

/**
 * Write the canonical scorecard under outDir. Every failure maps to a message,
 * never a throw: a failed write means no scorecard was produced, which the
 * caller must surface as exit 2 (ADR-0017 decision #4) — bubbling to the
 * generic exit-1 handler would report it on the code reserved for "ran, at
 * least one row failed". Not just symlink refusals: ENOTDIR (a regular file
 * committed at the output path), EACCES, and ENOSPC all end here too.
 *
 * The file is created with `wx`, so nothing already at a name is ever
 * followed or overwritten (issue #150). A symlink, directory or anything
 * else that is not a regular file at a candidate name is refused with a
 * message naming it. A regular file there (an earlier
 * scorecard from the same second: `redteam` and `eval` share the default
 * out dir and the `scorecard` prefix) is kept, and the new card takes the
 * next free `-<k>` suffix, up to `MAX_SCORECARD_SUFFIX`.
 *
 * Generic over any scorecard envelope (golden, redteam, redteam-judge, ...):
 * the same constraint `toCanonicalJson` requires, so every scorecard
 * producer writes through this one helper instead of duplicating it. The
 * optional filename `prefix` (default `scorecard`) is how the judge arm's
 * write in the same second as the heuristic one lands on its own name.
 */
export function writeScorecard<T extends { rows: ReadonlyArray<{ id: string }> }>(
  scorecard: T,
  outDir: string,
  nowMs: number = Date.now(),
  prefix = 'scorecard',
): { ok: true; path: string } | { ok: false; message: string } {
  const base = scorecardFilename(nowMs, prefix);
  try {
    mkdirSync(outDir, { recursive: true });
    // Re-checks only the leaf path (outDir); it narrows the TOCTOU window
    // opened by mkdir but does not close it — an in-process oracle can write
    // anywhere regardless (security-model R-10).
    refuseSymlinkedDir(outDir);
    const json = toCanonicalJson(scorecard);
    for (let k = 0; k <= MAX_SCORECARD_SUFFIX; k += 1) {
      const path = join(outDir, k === 0 ? base : base.replace(/\.json$/, `-${k}.json`));
      // `wx` (O_CREAT|O_EXCL) refuses anything already at the exact name, a
      // symlink included (dangling or not), without following it.
      if (writeExclusive(path, json)) return { ok: true, path };
      // Only an earlier scorecard (a regular file) is stepped past; a
      // symlink, directory or anything else at the name is refused.
      if (!lstatSync(path).isFile()) {
        return { ok: false, message: `refusing to overwrite ${path}: something other than a scorecard is at that name; remove it and re-run` };
      }
    }
    return {
      ok: false,
      message: `refusing to overwrite ${join(outDir, base)}: it and every suffix to -${MAX_SCORECARD_SUFFIX} exist; move them or re-run in another second`,
    };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Highest `-<k>` suffix a same-second scorecard may take before the write is refused. */
export const MAX_SCORECARD_SUFFIX = 9;

/** Create `path` exclusively; false when something already exists there. Other errors throw. */
function writeExclusive(path: string, data: string): boolean {
  try {
    writeFileSync(path, data, { flag: 'wx' });
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** The one SDK package; the CLI root is the only place it is imported (ADR-0010 decision 1). */
export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

export type ImportSdk = () => Promise<{ query: unknown }>;

/**
 * Test seams for `main` and `runEval` (issue #96 PR-B1). `userDir`: the user
 * settings layer, which a vitest worker cannot redirect through HOME because
 * `os.homedir()` reads libuv's environment (lesson 2026-08-28). `importSdk`:
 * the SDK loader, so a test drives the run path with a fake `query` (D8a).
 * Production passes neither.
 */
export interface CliSeams {
  userDir?: string;
  importSdk?: ImportSdk;
  /** The eval scorecard directory; defaults to `EVAL_OUT_DIR`. A vitest worker cannot chdir, so a test redirects the write here. */
  evalOutDir?: string;
}

const defaultImportSdk: ImportSdk = () => import(SDK_PACKAGE) as Promise<{ query: unknown }>;

/**
 * The CLI's SDK load-and-guard, hoisted on its third consumer (run, eval,
 * redteam --judge; architecture lens A-3, the ADR-0034 rule). An import
 * rejection propagates, so each caller keeps its own policy for it; a module
 * without `query()` is reported on stderr and read as `null`.
 */
export async function loadSdkQuery(importSdk: ImportSdk = defaultImportSdk): Promise<QueryFn | null> {
  const sdk = await importSdk();
  if (typeof sdk.query !== 'function') {
    process.stderr.write(`The installed ${SDK_PACKAGE} does not export query(); check the SDK version.\n`);
    return null;
  }
  return sdk.query as QueryFn;
}

/** The key refusal every keyed command prints; `requiredFor` says why this command needs it (A-3). */
export function apiKeyMissingMessage(requiredFor?: string): string {
  const reason = requiredFor === undefined ? '' : ` (${requiredFor})`;
  return (
    `ANTHROPIC_API_KEY is not set${reason}.\n\n` +
    'Export it, then re-run:\n' +
    '  export ANTHROPIC_API_KEY=sk-ant-...\n\n' +
    'Get a key at https://console.anthropic.com/settings/keys\n'
  );
}

export function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : UNKNOWN_HARNESS_VERSION;
  } catch {
    return UNKNOWN_HARNESS_VERSION;
  }
}

/** Path-prefixed settings failures from the composition root's combined loader. */
export class SettingsLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsLoadError';
  }
}

export interface SecurityComposition {
  permissions: EvaluatorOptions;
  /**
   * Which tools a rule allow must not grant (D-8): `Bash` unless the
   * USER layer's sandbox has a non-empty `commands` allowlist, so ADR-0015's argv parser
   * runs before any explicit SDK allow. Computed once; both registration
   * sites pass it to permissionHook.
   */
  grantPolicy: GrantPolicy;
  sandbox: SandboxConfig;
  /**
   * The session judge (issue #96 PR-B1, spec D1), from the USER layer only;
   * null when absent or `off`. Read by every command that composes security,
   * used only by `run` (D2, R5).
   */
  judge: JudgeSettings | null;
  /**
   * The Claude Code settings sources the SDK child may load (#140, ADR-0040
   * D2), from the USER layer's `sdk.settingSources` only; `[]` (the default)
   * isolates the child. Read by `run` and `eval`.
   */
  sdk: { settingSources: SettingSource[] };
  /** Startup notices for the operator (prompter gaps, risky allowlists, an ignored project judge key). */
  warnings: string[];
}

export const SDK_USER_INHERIT_WARNING =
  'claude code settings: the "user" source is inherited, so the operator\'s ~/.claude settings, hooks and plugins apply to this run (ADR-0040)';
export const SDK_PROJECT_INHERIT_WARNING =
  'claude code settings: the "project" or "local" source is inherited, so the working directory\'s .claude files and CLAUDE.md apply to this run as trusted input (ADR-0040)';

export interface ComposeSecurityDeps {
  /**
   * Test seam only, passed through to the shared loader. Omitted, every
   * loader reads through `readSettingsFile`, the guarded reader (symlink
   * refusal, byte cap, O_NOFOLLOW, regular-file check; ADR-0034 decision 5),
   * which is pinned at the `main()` entrypoint for both `run` and `eval`.
   */
  readFile?: (path: string) => string;
  userDir: string;
  projectDir: string;
}

/**
 * Loads and merges both security settings layers, and reads the judge from
 * the user layer only (spec D1). Each file is read ONCE and its parsed doc
 * feeds the key-parsers (permissions ADR-0014, sandbox
 * ADR-0015). Module parse errors are re-tagged SettingsLoadError so the
 * shared loader path-prefixes them and main() has one failure type to map to
 * exit 2. Extracted from main() so the composition logic is unit-testable
 * without an SDK or API key.
 */
export function composeSecurity(deps: ComposeSecurityDeps): SecurityComposition {
  const userPath = join(deps.userDir, '.harness', 'settings.json');
  const projectPath = join(deps.projectDir, '.harness', 'settings.json');
  const load = (path: string, isUser: boolean) =>
    loadJsonSettings(
      path,
      (doc) => {
        try {
          return {
            permissions: parsePermissionSettings(doc),
            sandbox: parseSandboxSettings(doc),
            // Decision 9: the project layer's `judge` key is never parsed,
            // so a malformed one can never exit 2; it is only detected.
            judge: isUser ? parseJudgeSettings(doc) : null,
            judgeKeyPresent: hasJudgeKey(doc),
            // D-2: the same rule for `sdk`; the project layer's key is only
            // detected, so a malformed one can never exit 2 or widen sources.
            sdk: isUser ? parseSdkSettings(doc) : [],
            sdkKeyPresent: hasSdkKey(doc),
          };
        } catch (error: unknown) {
          if (
            error instanceof PermissionSettingsError ||
            error instanceof SandboxSettingsError ||
            error instanceof JudgeSettingsError ||
            error instanceof SdkSettingsError
          ) {
            throw new SettingsLoadError(error.message);
          }
          throw error;
        }
      },
      { permissions: { rules: [] }, sandbox: {}, judge: null, judgeKeyPresent: false, sdk: [], sdkKeyPresent: false },
      SettingsLoadError,
      deps.readFile,
    );
  const user = load(userPath, true);
  const project = load(projectPath, false);
  const permissions = mergeLayers(user.permissions, project.permissions);
  const sandbox = mergeSandboxLayers(user.sandbox, project.sandbox);

  const warnings: string[] = [];
  if (project.judgeKeyPresent) {
    warnings.push(`ignoring "judge" in ${projectPath}: the judge is configured only in ~/.harness/settings.json`);
  }
  if (project.sdkKeyPresent) {
    warnings.push(`ignoring "sdk" in ${projectPath}: Claude Code settings sources are configured only in ~/.harness/settings.json`);
  }
  if (user.sdk.includes('user')) warnings.push(SDK_USER_INHERIT_WARNING);
  if (user.sdk.includes('project') || user.sdk.includes('local')) warnings.push(SDK_PROJECT_INHERIT_WARNING);
  // No prompter is wired yet (no interactive mode), so every 'ask' resolves
  // to deny — fail closed, but tell the settings author (ADR-0014 §4).
  if (
    (permissions.rules ?? []).some((r) => r.decision === 'ask') ||
    permissions.defaultDecision === 'ask'
  ) {
    warnings.push(
      "settings contain 'ask' permissions but no prompter is configured; 'ask' will deny (ADR-0014 §4)",
    );
  }
  // Shell runners, argv-passthrough exec wrappers and shell builtins are DENIED by the sandbox
  // regardless of the allowlist; surface the conflict at startup. Uses the same
  // predicate the gate enforces with, so the warning never drifts from the
  // blocklist (ADR-0015 §3).
  const blocked = (sandbox.commands?.allow ?? []).filter((entry) => isBlockedFirstToken(entry));
  if (blocked.length > 0) {
    warnings.push(
      `sandbox command allowlist includes ${blocked.join(', ')} — shell runners, exec wrappers and shell builtins (exec, eval, command, builtin, source, .) defeat first-token enforcement and are always denied (ADR-0015 §3)`,
    );
  }
  // Path entries are prefix-matched, so a glob-shaped one is matched
  // literally: it allows only a directory with that exact name (usually none
  // exists), and everything under the intended prefix is denied with no signal (issue #107, ADR-0034 decision 2). Warn
  // only; the entry still parses and still denies. Each layer is checked
  // BEFORE the intersection merge, which would drop an entry the other layer
  // lacks, and the warning names the file so the author knows where to edit.
  warnings.push(
    ...globPathWarnings(user.sandbox, userPath),
    ...globPathWarnings(project.sandbox, projectPath),
  );
  // USER layer only: the merge (intersectDimension) returns the project list when the user has
  // none, so a cloned repo's commands list must not unlock the grant. The merged list stays the gate.
  const grantPolicy: GrantPolicy = {
    ungrantableTools: new Set((user.sandbox.commands?.allow.length ?? 0) > 0 ? [] : ['Bash']),
  };
  return { permissions, grantPolicy, sandbox, judge: user.judge, sdk: { settingSources: user.sdk }, warnings };
}

/**
 * Registers the two security pre-tool hooks in their ONE shipped order, for
 * every command that builds a session (`run`, `eval`). Permissions first,
 * sandbox as the backstop: the deny outcome is identical (the runtime denies
 * on the first throw), but rule-attributed permission reasons are more
 * actionable, so they get first say (ADR-0015 section 4). The sandbox also
 * runs after a grant is returned, so a sandbox deny always overrides it
 * (ADR-0040 D3). `security.grantPolicy` is passed through unchanged.
 */
export function registerSecurityHooks(
  hooks: Pick<HookRuntime, 'register'>,
  security: Pick<SecurityComposition, 'permissions' | 'grantPolicy' | 'sandbox'>,
): void {
  hooks.register('pre-tool', permissionHook(createPermissionEvaluator(security.permissions), undefined, security.grantPolicy));
  hooks.register('pre-tool', sandboxHook(createSandbox(security.sandbox)));
}

/**
 * The fixed form of a glob-shaped path entry, only when it is exact: a
 * trailing `/*` or `/**` stripped to a remainder that is itself glob-free and
 * non-empty. Anything else (`/x/a?b`, `/*`, `/x/*\/y`) gets no suggestion.
 */
function prefixFixFor(entry: string): string | null {
  const stripped = entry.replace(/\/\*{1,2}$/, '');
  return stripped !== entry && stripped !== '' && !hasGlobCharacter(stripped) ? stripped : null;
}

function globPathWarnings(sandbox: SandboxConfig, settingsPath: string): string[] {
  return (sandbox.paths?.allow ?? []).filter(hasGlobCharacter).map((entry) => {
    const fix = prefixFixFor(entry);
    const hint = fix === null ? '' : `; write '${boundEcho(fix)}' to allow that directory and everything under it`;
    return `sandbox path entry '${boundEcho(entry)}' in ${boundEcho(settingsPath)} contains a glob character, but the path allowlist is prefix-based and matches the entry literally, so it allows only a directory with that exact name, not what the pattern suggests${hint} (ADR-0015 §2)`;
  });
}

/**
 * Telemetry sentinel when the secret redactor fails (fail-closed, never raw).
 * Third copy of this literal (src/session/session.ts, src/eval/scorecard/
 * sanitize.ts); each site pins it by test, and ADR-0008's Revisit-if fires at
 * the FOURTH copy: extract to src/internal/ then, not before.
 */
const REDACTION_FAILED = '[REDACTION FAILED]';

/**
 * REQUIRED, not optional, on purpose: an optional redactor with a raw fallback
 * is exactly the standing trap this closes (the memory seam has one because
 * the session's redactor is an injected optional dep; here the composition
 * root always holds `redact`, so the type can demand it). This is a
 * compile-time pin against OMISSION (a caller cannot leave the redactor out),
 * not a runtime guarantee about what the supplied redactor does.
 */
export interface HookTelemetryDeps {
  redactSecrets: (text: string) => RedactResult;
}

/**
 * Redact THEN bound, in that order (session.ts's transform-then-truncate
 * contract): truncating first can slice a secret at the boundary into a
 * fragment too short for its rule to match. The cap itself belongs to
 * telemetry (`boundHookEventReason`, HOOK_EVENT_REASON_MAX): the module that
 * owns the payload shape owns its bound, and the memory copy of the same
 * string is designed to the same ceiling (see the constant's doc comment for
 * the one-unit convention difference). The WHOLE transform sits inside the
 * try and the result is type-checked: a redactor that throws, or returns
 * anything but a string, stores the sentinel. Either failure escaping here
 * would reach the hook sink, which swallows throws (src/hooks/runtime.ts),
 * and the row would be dropped silently.
 * Control characters are not stripped here: the store's write-path
 * sanitizer already does that for every payload string.
 */
function boundReason(reason: string, deps: HookTelemetryDeps): string {
  try {
    const { redacted } = deps.redactSecrets(reason);
    // An array or array-like with a small .length passes a length cut
    // without throwing; the store would then reject the non-string reason
    // with a throw the sink swallows, and the row would vanish silently.
    if (typeof redacted !== 'string') return REDACTION_FAILED;
    return boundHookEventReason(redacted);
  } catch {
    return REDACTION_FAILED;
  }
}

/**
 * Maps a hook runtime record onto telemetry's structural hook-event payload.
 * Lives in cli/shared.ts (not hooks/ or telemetry/) so those two modules stay
 * import-free peers (ADR-0011); cli.ts (and any other cli/ command module)
 * imports it from here.
 *
 * The `reason` of a denied-by-hook or hook-error row is ANY registered hook's
 * throw message, so it is attacker-influenced in principle even though the
 * shipped hooks emit value-free reasons (ADR-0031 decision 1). It passes the
 * same ORDER of redact-then-truncate as the memory summary's `denied[]` copy,
 * to the same ceiling (ADR-0031 decision 4; issue #75). The sibling `tool`
 * field is model-requested too; it is control-char sanitized by the store but
 * neither redacted nor length-bound here, outside #75's scope, named so this
 * mapper is not read as bounding every attacker-influenced string on the row.
 *
 * A `granted-by-rule` row is the audit trail of every `allow` the session
 * returned to the SDK (ADR-0040 D3): the session's SDK-facing reason is one
 * source-neutral literal, so the rule identity lives only on this row.
 */
export function hookRecordToTelemetryInput(
  record: HookEventRecord,
  ids: { sessionId: string; turnId: string },
  deps: HookTelemetryDeps,
): TelemetryEventInput {
  const base = { type: 'hook-event' as const, sessionId: ids.sessionId, turnId: ids.turnId };
  if (record.kind === 'denied-by-hook' || record.kind === 'granted-by-rule') {
    return {
      ...base,
      payload: {
        kind: record.kind,
        event: record.event,
        tool: record.tool,
        reason: boundReason(record.reason, deps),
        handlerIndex: record.handlerIndex,
      },
    };
  }
  if (record.kind === 'hook-error') {
    return {
      ...base,
      payload: {
        kind: record.kind,
        event: record.event,
        reason: boundReason(record.reason, deps),
        handlerIndex: record.handlerIndex,
      },
    };
  }
  return {
    ...base,
    payload: { kind: record.kind, event: record.event, handlersFired: record.handlersFired },
  };
}
