import { homedir } from 'node:os';
import { FORCED_CHILD_ENV } from '../internal/child-env.js';
import { managedSettingsDir, scanSettingsEnv, SettingsEnvRefused, settingsEnvFiles } from '../security/index.js';
import type { SettingSource, SettingsEnvRefusal } from '../security/index.js';

/**
 * The session's settings-env gate (issue #250). Run at the start of every
 * `run()`, BEFORE the SDK is called: a settings file the CLI would load whose
 * `env` block names a variable in FORCED_CHILD_ENV would replace the
 * harness's value in the child, so the run is refused. It lives in the
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
        env: { CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'] },
        managedDir: managedSettingsDir(process.platform),
      }),
      Object.keys(FORCED_CHILD_ENV),
    );
}

/** The real scan for the current user's home directory. */
export const defaultSettingsEnvScan: SettingsEnvScanFn = (settingSources) => settingsEnvScanFor(homedir())(settingSources);

/** Runs the scan and throws SettingsEnvRefused on any refusal. */
export function assertSettingsEnv(settingSources: readonly SettingSource[], scan: SettingsEnvScanFn = defaultSettingsEnvScan): void {
  const refusals = scan(settingSources);
  if (refusals.length > 0) throw new SettingsEnvRefused(refusals);
}
