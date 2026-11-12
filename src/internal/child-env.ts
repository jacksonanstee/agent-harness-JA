/**
 * The environment the harness hands every bundled-CLI child it starts: the
 * primary session (issue #250, ADR-0040 D-8 as amended 12/11/2026) and, since
 * issues #254 and #255 (amended 13/11/2026), the judge and the eval adversary.
 *
 * The SDK's `Options.env` REPLACES the child's environment; it is not merged
 * with `process.env` (sdk.d.ts, SDK 0.3.312). So the builder carries every
 * inherited variable and then applies the harness's own table on top, and the
 * harness value wins over whatever the operator's environment holds.
 *
 * The builder is deliberately a pipeline of one step today (apply
 * FORCED_CHILD_ENV). A later rule that must REMOVE an inherited variable is
 * another step here, with its own table and tests; nothing is stripped now.
 *
 * Every vendor claim below is labelled: OBSERVED (a loopback mock of the
 * Messages API driving the real CLI 2.1.312, `scripts/mock-cli-probe.mjs`),
 * READ (the minified binary, a lead and not a verdict) or INFERRED.
 */

/**
 * The bundled CLI's switch for background tasks. With it set, CLI 2.1.312
 * (OBSERVED, loopback mock API driving the real CLI, 12/11/2026):
 * - rejects a Bash call that passes `run_in_background` as an unexpected parameter;
 * - kills a foreground Bash command at its timeout instead of moving it to the
 *   background (the move is what armed the stall notice without the flag);
 * - runs a plain `Agent` call in the foreground, so the subagent's report comes
 *   back as a tool result (issue #252).
 * No type declares the name; tool-targets.sdk-parity.test.ts checks the
 * installed binary still holds it.
 */
export const BACKGROUND_TASKS_SWITCH = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS';

/**
 * The bundled CLI's switch for scheduled tasks (issue #254). Without it, a
 * `.claude/scheduled_tasks.json` in the working directory holding an overdue
 * recurring job had the job's `prompt` sent to the model as a user turn AHEAD
 * of the operator's prompt, in the primary session, the judge child and the
 * adversary child alike, outside every hook (OBSERVED 13/11/2026; in the
 * primary session the job fired in each of the 4 runs made one at a time
 * whose logs are kept, and not in one earlier run made beside six others, so
 * whether it fires is a race). With the switch set the job's prompt reached no
 * request and `CronCreate`, `CronDelete` and `CronList` left the tool list the
 * CLI reports at start-up (OBSERVED, same date). READ: one gate function tests
 * the variable, and it is what those three tools' `isEnabled` return; no other
 * effect was found in the binary or seen in a run.
 */
export const CRON_SWITCH = 'CLAUDE_CODE_DISABLE_CRON';

/**
 * The file the CLI reads durable scheduled jobs from, under `.claude` in its
 * working directory (READ: the path is joined onto the project directory;
 * OBSERVED 13/11/2026: a job planted there fired, and the same job planted in
 * the parent directory's `.claude`, in the config directory or in the config
 * directory's `.claude` did not, 1 run each). The self-protection deny
 * (ADR-0042) covers it; the SDK parity test checks the binary still names it.
 */
export const SCHEDULED_TASKS_FILE = 'scheduled_tasks.json';

/**
 * The bundled CLI's switch for attachments (issue #255). Without it, an
 * `@<path>` token in the prompt made the CLI read that file and put its raw
 * content in the request as a "Called the Read tool" note: in the primary
 * session, and in the judge and the adversary, whose prompt is text the
 * harness did not write and which run with `tools: []` (OBSERVED 13/11/2026).
 * With the switch set no file content was added in any of the three (OBSERVED,
 * same date).
 *
 * It is a broad switch, and what else it removes is the cost (OBSERVED in the
 * primary session, same date, unless marked READ). The model is no longer told:
 * its working directory, platform, shell and OS version; its model name and
 * knowledge cutoff; the names of the tools it can load through ToolSearch; the
 * CLI's own bundled skills; the tokens and dollars left; and a nested
 * CLAUDE.md beside a file it reads (under an opted-in project source). READ,
 * not seen in a run: file-changed-on-disk notices, MCP server instructions and
 * `@` mentions of MCP resources, plan-mode and todo reminders and IDE
 * diagnostics go the same way. Unchanged in the same runs: the harness's
 * system prompt and the skills it carries, the tool list, the agent list, a
 * root CLAUDE.md, ToolSearch by name, a Read by relative path, and redaction
 * of a tool result.
 */
export const ATTACHMENTS_SWITCH = 'CLAUDE_CODE_DISABLE_ATTACHMENTS';

/** Variables the harness sets in every child whatever the inherited environment says. Frozen; three entries. */
export const FORCED_CHILD_ENV: Readonly<Record<string, string>> = Object.freeze({
  [BACKGROUND_TASKS_SWITCH]: '1',
  [CRON_SWITCH]: '1',
  [ATTACHMENTS_SWITCH]: '1',
});

/** A process environment as Node and the SDK type it: a name maps to a string, or to undefined when unset. */
export type ChildEnv = Record<string, string | undefined>;

/**
 * The child environment: every inherited variable, then FORCED_CHILD_ENV over
 * it. Pure: a fresh object each call, the input untouched.
 */
export function buildChildEnv(inherited: Readonly<ChildEnv>): ChildEnv {
  return { ...inherited, ...FORCED_CHILD_ENV };
}

/** The harness's flag settings for the child: an `env` block and nothing else. */
export interface ChildSettings {
  env: Record<string, string>;
}

/**
 * FORCED_CHILD_ENV again, as the SDK's `Options.settings` (the CLI's flag
 * settings). The CLI applies each loaded settings file's `env` block over its
 * own environment, so a file that names a forced variable replaces the value
 * `buildChildEnv` set. The flag settings' value won over the user, project and
 * local settings files and the global config file (OBSERVED for the
 * background-tasks switch, loopback mock API, CLI 2.1.312, 12/11/2026). For
 * the cron and attachments switches the global config file alone was run
 * (OBSERVED 13/11/2026, in the judge child, which loads no other settings
 * file: an `env` block setting the switch to "" undid the inherited value, and
 * with the flag settings beside it the switch held, 1 run each); the other
 * three files are INFERRED to behave as they did for the first switch. That
 * flag settings are applied later is inferred from those results.
 * Managed settings are applied after flag settings (a binary reading), so this is a second layer and not a
 * replacement for the settings-env scan, which refuses such a file outright.
 * Fresh objects each call.
 */
export function buildChildSettings(): ChildSettings {
  return { env: { ...FORCED_CHILD_ENV } };
}
