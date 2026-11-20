import { homedir } from 'node:os';
import { CHILD_ENV_NAME_POLICY, childConfigDir } from '../internal/child-env.js';
import { managedSettingsDir, REFUSED_SETTINGS_KEYS, scanSettingsEnv, SettingsEnvRefused, settingsEnvFiles } from '../security/index.js';
import type { SettingSource, SettingsEnvRefusal } from '../security/index.js';

/**
 * The session's settings-env gate (issue #250). Run at the start of every
 * `run()`, BEFORE the SDK is called: a settings file the CLI would load whose
 * `env` block names any of the CLI's own variables (CHILD_ENV_NAME_POLICY;
 * widened by issue #251) would replace the harness's value, put a stripped
 * one back or move one the operator set, so the run is refused. It lives in the
 * session, beside the agent gate, so a library caller that composes its own
 * hook stack does not lose it.
 */
export type SettingsEnvScanFn = (settingSources: readonly SettingSource[]) => readonly SettingsEnvRefusal[];

/** The real scan for a home directory, for this process's cwd, env and platform. The CLI passes its `userDir` seam. */
export function settingsEnvScanFor(homeDir: string): SettingsEnvScanFn {
  return (settingSources) =>
    scanSettingsEnv(
      settingsEnvFiles({
        settingSources,
        cwd: process.cwd(),
        homeDir,
        // The directory the child is handed, not a second reading of the environment.
        env: { CLAUDE_CONFIG_DIR: childConfigDir(process.env) },
        managedDir: managedSettingsDir(process.platform),
      }),
      CHILD_ENV_NAME_POLICY,
      { refusedTopLevelKeys: REFUSED_SETTINGS_KEYS },
    );
}

/** The real scan for the current user's home directory. */
export const defaultSettingsEnvScan: SettingsEnvScanFn = (settingSources) => settingsEnvScanFor(homedir())(settingSources);

/** Runs the scan and throws SettingsEnvRefused on any refusal. */
export function assertSettingsEnv(settingSources: readonly SettingSource[], scan: SettingsEnvScanFn = defaultSettingsEnvScan): void {
  const refusals = scan(settingSources);
  if (refusals.length > 0) throw new SettingsEnvRefused(refusals);
}
