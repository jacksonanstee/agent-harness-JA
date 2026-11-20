import { isVendorName, onlyToollessAllowedNames, VENDOR_NAME_NEEDLES, withoutStrippedVendorNames } from './child-env-policy.js';
import type { ChildEnv } from './child-env-policy.js';

export type { ChildEnv } from './child-env-policy.js';

/**
 * The environment the harness hands every bundled-CLI child it starts: the
 * primary session (issue #250, ADR-0040 D-8 as amended 12/11/2026) and, since
 * issues #254 and #255 and their review (amended 13/11/2026), the judge and
 * the eval adversary.
 *
 * The SDK's `Options.env` REPLACES the child's environment; it is not merged
 * with `process.env` (sdk.d.ts, SDK 0.3.312). So each builder decides which
 * inherited variables the child gets and then applies the harness's own table
 * on top, and the harness value wins over whatever the operator's environment
 * holds.
 *
 * Each builder is a pipeline of two steps (issue #251, amended 13/11/2026):
 * 1. choose the inherited names, by the rule in `child-env-policy.ts`. The
 *    primary session drops the vendor namespace except a keep list and
 *    carries everything else; the tool-less children get an allowlist.
 * 2. apply FORCED_CHILD_ENV.
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
 * request and `CronCreate`, `CronDelete` and `CronList` left the `tools` array
 * of the SDK's init message (22 names without it, 19 with; OBSERVED, same
 * date, primary session). READ: one gate function tests
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
 * primary session, same date, unless marked READ). The model is no longer
 * given: the names of the tools it can load through ToolSearch; the CLI's own
 * bundled skills; the tokens and dollars left; and a nested CLAUDE.md beside a
 * file it reads (under an opted-in project source). READ, and not seen in a
 * run with the switch or without it: file-changed-on-disk notices, MCP server
 * instructions, `@` mentions of MCP resources, plan-mode and todo reminders
 * and IDE diagnostics go the same way. Unchanged in the same runs: the
 * environment block (working directory, platform, shell, OS version) and the
 * model line, the harness's system prompt and the skills it carries, the tool
 * list, the agent list, a root CLAUDE.md, ToolSearch by name, a Read by
 * relative path, and redaction of a tool result.
 */
export const ATTACHMENTS_SWITCH = 'CLAUDE_CODE_DISABLE_ATTACHMENTS';

/**
 * The bundled CLI's switch for auto-memory (found by the security review of
 * the #254 and #255 change). Without it the CLI added the project's memory
 * index, `MEMORY.md` in `projects/<slug>/memory` under its config directory,
 * to the first turn of the primary session, the judge, the adversary and a
 * subagent, under the default isolation and outside every hook (OBSERVED
 * 13/11/2026, 1 run each). With the switch set the index reached no request
 * in any of the four, and nothing else changed in the primary session's
 * requests (OBSERVED, same date). The switch does NOT stop the agent writing
 * that file: Write, Edit and a Bash redirect still changed it with the switch
 * set (OBSERVED), which is why self-protection covers the directory
 * (ADR-0042). READ: an inherited value the CLI reads as false would force
 * auto-memory on; the forced "1" replaces any inherited value.
 */
export const AUTO_MEMORY_SWITCH = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';

/**
 * The bundled CLI's switch for its "bare" mode (issue #251), the variable form
 * of its `--bare` flag (READ). With it on, CLI 2.1.312 ran NO hook the harness
 * registered: the tool list of the SDK's init message fell from 19 names to 3,
 * a Read's result reached the model raw with no redaction marker, the run
 * exited 0, and none of the hook events a spy registered fired, the prompt
 * hook included (OBSERVED, loopback mock, 13/11/2026). Three producers turned
 * it on, 1 run each: the inherited environment ("1" and "TRUE"), the global
 * config file's `env` block under the default isolation, and the user
 * settings file's `env` block under the `user` source. A project or local
 * settings file's `env` block did not (OBSERVED, 1 run each; READ: the binary
 * lists this variable among those a project's settings may not set).
 *
 * The harness therefore sets it OFF in every child, on both layers. "0" and
 * "" each left hooks running as an inherited value (OBSERVED, 1 run each;
 * READ: the CLI reads the variable as a boolean, on for "1", "true", "yes"
 * and "on" in any letter case). As a flag setting, "0" and "" each kept hooks
 * running over a "1" in the global config file and in the user settings file,
 * and "0" over an inherited "1" (OBSERVED, 1 run each; a flag setting of "1"
 * turned bare mode on by itself, so the layer is live). "0" is used: it says
 * off, where an empty value reads like a mistake.
 *
 * Every OBSERVED in this comment was run again on 20/11/2026 against a build
 * of the commit before this change; the run directories are `before-*` under
 * `tasks/issue-251-evidence/impl2/out` (not tracked).
 */
export const BARE_MODE_SWITCH = 'CLAUDE_CODE_SIMPLE';

/**
 * Variables the harness sets in every child whatever the inherited
 * environment says. Frozen; five entries: four features switched off by "1",
 * and bare mode held off by "0".
 */
export const FORCED_CHILD_ENV: Readonly<Record<string, string>> = Object.freeze({
  [BACKGROUND_TASKS_SWITCH]: '1',
  [CRON_SWITCH]: '1',
  [ATTACHMENTS_SWITCH]: '1',
  [AUTO_MEMORY_SWITCH]: '1',
  [BARE_MODE_SWITCH]: '0',
});

/**
 * The primary session's child environment: the inherited variables minus the
 * vendor names that are not on the keep list (`child-env-policy.ts`), then
 * FORCED_CHILD_ENV over them. A forced name is itself a stripped vendor name,
 * so an inherited spelling of it in another letter case is gone before the
 * harness's own is set. The table is applied LAST, so a forced name the
 * first step lets through (none in the shipped table) would still carry the
 * harness value. `forced` is a seam for the test of that order; every call
 * site passes the inherited environment alone, which the call-site inventory
 * test requires. Pure: a fresh object each call, the input untouched.
 */
export function buildChildEnv(inherited: Readonly<ChildEnv>, forced: Readonly<Record<string, string>> = FORCED_CHILD_ENV): ChildEnv {
  return { ...withoutStrippedVendorNames(inherited), ...forced };
}

/**
 * The environment of a child that runs no tool (the judge and the eval
 * adversary, both `tools: []`): only the allowlisted inherited names
 * (`child-env-policy.ts`), then FORCED_CHILD_ENV. Such a child needs nothing
 * of the operator's toolchain, so nothing else is passed. `forced` is the
 * same test seam as `buildChildEnv`'s. Pure.
 */
export function buildToollessChildEnv(inherited: Readonly<ChildEnv>, forced: Readonly<Record<string, string>> = FORCED_CHILD_ENV): ChildEnv {
  return { ...onlyToollessAllowedNames(inherited), ...forced };
}

/**
 * What the settings-env scan refuses in a settings file's `env` block: ANY
 * name in the vendor namespace, and any name the harness forces. The CLI
 * applies such a block over its own environment, so the file would put back
 * what the harness took out, replace what it set, or move a name the
 * operator's environment set. The keep list does not apply to files (owner
 * ruling 13/11/2026, after the security review reported a global config
 * file's `env` block moving the endpoint, adding a request header and moving
 * the config directory). The endpoint was run again: before this change,
 * with the base URL in that block pointing at a closed port, no request
 * reached the mock the operator's environment named (OBSERVED 20/11/2026,
 * 1 run, `before-genv-base-url`; after, the same file refuses the run,
 * `after-genv-kept-name`). The other two were not run again. A credential,
 * an endpoint or a provider belongs in the operator's environment, never in
 * a file the CLI reads.
 * `needles` is what a text must contain to hold any refused name.
 */
export interface ChildEnvNamePolicy {
  refuses(name: string): boolean;
  readonly needles: readonly string[];
}

/**
 * The policy for a forced table. The forced clause matters only for a forced
 * name outside the vendor namespace; every name in the shipped table is in
 * it (pinned by a test), so for that table the clause adds nothing.
 */
export function childEnvNamePolicy(forced: Readonly<Record<string, string>>): ChildEnvNamePolicy {
  const forcedUpper = Object.keys(forced).map((name) => name.toUpperCase());
  return Object.freeze({
    refuses: (name: string): boolean => isVendorName(name) || forcedUpper.includes(name.toUpperCase()),
    needles: Object.freeze([...new Set([...VENDOR_NAME_NEEDLES, ...forcedUpper])]),
  });
}

/** The one policy the session's gate passes to the scan: the vendor namespace and the shipped forced table. */
export const CHILD_ENV_NAME_POLICY: ChildEnvNamePolicy = childEnvNamePolicy(FORCED_CHILD_ENV);

/**
 * The `CLAUDE_CONFIG_DIR` the child is handed, exactly as written: read from
 * the environment `buildChildEnv` builds, so a rule that sets or strips the
 * variable moves this with it (it is on the keep list, so both builders pass
 * the operator's value). Self-protection protects directories under
 * it, and must be told the same value the CLI gets. The CLI does not expand a
 * leading `~` in it (OBSERVED, loopback mock, CLI 2.1.312, 13/11/2026: given
 * `~/cfgt` with HOME set it made `<cwd>/~/cfgt`), so neither does anything here.
 */
export function childConfigDir(inherited: Readonly<ChildEnv>, platform: string = process.platform): string | undefined {
  const env = buildChildEnv(inherited);
  if (Object.hasOwn(env, CONFIG_DIR_NAME) || platform !== 'win32') return env[CONFIG_DIR_NAME];
  // Windows reads the environment without regard to case, so `Claude_Config_Dir` is this variable there
  // (INFERRED from how Node documents `process.env` on Windows; not run on Windows).
  const spelt = Object.keys(env).find((name) => name.toUpperCase() === CONFIG_DIR_NAME);
  return spelt === undefined ? undefined : env[spelt];
}

const CONFIG_DIR_NAME = 'CLAUDE_CONFIG_DIR';

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
 * three files are INFERRED to behave as they did for the first switch. For
 * the bare-mode switch (#251) the flag settings' "0" won over a "1" in the
 * global config file, in the user settings file and in the inherited
 * environment (OBSERVED 13/11/2026 and again 20/11/2026, 1 run each, primary
 * session; `before-flag0-genv`, `-senv`, `-inherit`). That
 * flag settings are applied later is inferred from those results.
 * Managed settings are applied after flag settings (a binary reading), so this is a second layer and not a
 * replacement for the settings-env scan, which refuses such a file outright.
 * Fresh objects each call.
 */
export function buildChildSettings(): ChildSettings {
  return { env: { ...FORCED_CHILD_ENV } };
}
