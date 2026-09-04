import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EvalUsageError, toCanonicalJson } from '../eval/index.js';
import type { HookEventRecord } from '../hooks/index.js';
import { GuardedReadError, refuseSymlink } from '../internal/guarded-read.js';
import { loadJsonSettings } from '../internal/settings.js';
import { TERMINAL_UNSAFE } from '../internal/sanitize.js';
import {
  mergeLayers,
  mergeSandboxLayers,
  parsePermissionSettings,
  parseSandboxSettings,
  isBlockedFirstToken,
  PermissionSettingsError,
  SandboxSettingsError,
} from '../security/index.js';
import type { EvaluatorOptions, RedactResult, SandboxConfig } from '../security/index.js';
import { TASK_SENSITIVITIES, TASK_SHAPES } from '../router/index.js';
import { boundHookEventReason, TELEMETRY_EVENT_TYPES } from '../telemetry/index.js';
import type { TelemetryEventInput } from '../telemetry/index.js';

/** Default scorecard output directory, shared by eval and redteam (both are
 *  scorecard producers writing through the same `writeScorecard` helper). */
export const EVAL_OUT_DIR = join('.harness', 'eval');

/**
 * Prefix of every warning line `run` and `eval` write to stderr. README's
 * Settings section quotes it; src/readme-settings.test.ts pins the quote to
 * this constant and asserts neither command spells its own prefix, so every
 * writer goes through here (issue #100).
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
export const USAGE =
  `Usage: agent-harness-ja run "<prompt>" [--skills-dir <dir>] [--db <path>] [--max-turns <n>] [--shape <${TASK_SHAPES.join('|')}>] [--sensitivity <${TASK_SENSITIVITIES.join('|')}>] [--expected-tokens <n>]\n` +
  '       agent-harness-ja eval [taskDir] [--challenge] [--max-tasks <n>]\n' +
  '       agent-harness-ja redteam [--out <dir>] [--update-baseline] [--baseline <path>]\n' +
  `       agent-harness-ja telemetry export [--db <path>] [--out <file>] [--session <id>] [--type <${TELEMETRY_EVENT_TYPES.join('|')}>] [--scrub-prefix <abs-path>]...\n` +
  '       agent-harness-ja init [dir]';

// TERMINAL_UNSAFE itself now lives in src/internal/sanitize.ts, beside the
// JSON_TEXT_UNSAFE that derives from it: the zero-dep leaf is the only home
// reachable by src/eval/**, which eslint blocks from importing src/cli/**.
// The FUNCTION stays here, where all forty-odd of its callers are.

export function sanitizeForTerminal(text: string): string {
  return text.replace(TERMINAL_UNSAFE, ' ');
}


/** Filesystem-safe scorecard timestamp (spec: arbiter condition 2 — no colons). */
export function scorecardFilename(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `scorecard-${stamp}.json`;
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
 * Generic over any scorecard envelope (golden, redteam, ...): the same
 * constraint `toCanonicalJson` requires, so every scorecard producer writes
 * through this one helper instead of duplicating it.
 */
export function writeScorecard<T extends { rows: ReadonlyArray<{ id: string }> }>(
  scorecard: T,
  outDir: string,
  nowMs: number = Date.now(),
): { ok: true; path: string } | { ok: false; message: string } {
  try {
    mkdirSync(outDir, { recursive: true });
    // Re-checks only the leaf path (outDir); it narrows the TOCTOU window
    // opened by mkdir but does not close it — an in-process oracle can write
    // anywhere regardless (security-model R-10).
    refuseSymlinkedDir(outDir);
    const path = join(outDir, scorecardFilename(nowMs));
    writeFileSync(path, toCanonicalJson(scorecard));
    return { ok: true, path };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
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
  sandbox: SandboxConfig;
  /** Startup notices for the operator (prompter gaps, risky allowlists). */
  warnings: string[];
}

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
 * Loads and merges both security settings layers. Each file is read ONCE and
 * its parsed doc feeds both key-parsers (permissions ADR-0014, sandbox
 * ADR-0015). Module parse errors are re-tagged SettingsLoadError so the
 * shared loader path-prefixes them and main() has one failure type to map to
 * exit 2. Extracted from main() so the composition logic is unit-testable
 * without an SDK or API key.
 */
export function composeSecurity(deps: ComposeSecurityDeps): SecurityComposition {
  const layers = [
    join(deps.userDir, '.harness', 'settings.json'),
    join(deps.projectDir, '.harness', 'settings.json'),
  ].map((path) =>
    loadJsonSettings(
      path,
      (doc) => {
        try {
          return {
            permissions: parsePermissionSettings(doc),
            sandbox: parseSandboxSettings(doc),
          };
        } catch (error: unknown) {
          if (
            error instanceof PermissionSettingsError ||
            error instanceof SandboxSettingsError
          ) {
            throw new SettingsLoadError(error.message);
          }
          throw error;
        }
      },
      { permissions: { rules: [] }, sandbox: {} },
      SettingsLoadError,
      deps.readFile,
    ),
  );
  const [user, project] = layers as [(typeof layers)[0], (typeof layers)[0]];
  const permissions = mergeLayers(user.permissions, project.permissions);
  const sandbox = mergeSandboxLayers(user.sandbox, project.sandbox);

  const warnings: string[] = [];
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
  // Shell runners and argv-passthrough exec wrappers are DENIED by the sandbox
  // regardless of the allowlist; surface the conflict at startup. Uses the same
  // predicate the gate enforces with, so the warning never drifts from the
  // blocklist (ADR-0015 §3).
  const blocked = (sandbox.commands?.allow ?? []).filter((entry) => isBlockedFirstToken(entry));
  if (blocked.length > 0) {
    warnings.push(
      `sandbox command allowlist includes ${blocked.join(', ')} — shell runners and exec wrappers defeat first-token enforcement and are always denied (ADR-0015 §3)`,
    );
  }
  return { permissions, sandbox, warnings };
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
 */
export function hookRecordToTelemetryInput(
  record: HookEventRecord,
  ids: { sessionId: string; turnId: string },
  deps: HookTelemetryDeps,
): TelemetryEventInput {
  const base = { type: 'hook-event' as const, sessionId: ids.sessionId, turnId: ids.turnId };
  if (record.kind === 'denied-by-hook') {
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
