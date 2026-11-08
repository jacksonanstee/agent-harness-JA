import { homedir } from 'node:os';
import {
  AgentDefinitionRefused,
  agentDefinitionRoots,
  agentNameRefusal,
  BUNDLED_AGENT_NAMES,
  checkInit,
  managedSettingsDir,
  scanAgentDefinitions,
} from '../security/index.js';
import type { AgentScanResult, InitCheck, SettingSource } from '../security/index.js';

/**
 * The session's agent gate (issue #229, ADR-0046). Built once per run, BEFORE
 * the SDK is called: the scan refuses the run when a loadable agent file could
 * take a subagent out of reach of the harness hooks, and what it admitted
 * (with the bundled names) decides which `Agent` calls may name an agent. The
 * gate lives in the session, not in a composed hook, because a library caller
 * that composes its own hook stack must not lose it.
 */

export type AgentScanFn = (settingSources: readonly SettingSource[]) => AgentScanResult;

/**
 * The real scan for a home directory: the directories the CLI loads from, for
 * this process's cwd, env and platform. The CLI passes its `userDir` seam, so a
 * test never reads the machine's own agent files.
 */
export function agentScanFor(homeDir: string): AgentScanFn {
  return (settingSources) =>
    scanAgentDefinitions(
      agentDefinitionRoots({
        settingSources,
        cwd: process.cwd(),
        homeDir,
        env: { CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'] },
        managedDir: managedSettingsDir(process.platform),
      }),
    );
}

/** The real scan for the current user's home directory. */
export const defaultAgentScan: AgentScanFn = (settingSources) => agentScanFor(homedir())(settingSources);

export interface AgentGate {
  /** Bundled names plus every name a scanned, clean file defines. */
  readonly admitted: ReadonlySet<string>;
  /** The deny reason for an Agent call's arguments, or null when the call names no agent or an admitted one. */
  refusalFor(args: unknown): string | null;
  /** Checks the SDK's init message against the rulings and the admitted names. */
  checkInit(message: unknown): InitCheck;
}

/** Runs the scan (throws AgentDefinitionRefused on any refusal) and builds the gate. */
export function createAgentGate(settingSources: readonly SettingSource[], scan: AgentScanFn = defaultAgentScan): AgentGate {
  const result = scan(settingSources);
  if (result.refusals.length > 0) throw new AgentDefinitionRefused(result.refusals);
  const admitted: ReadonlySet<string> = new Set([...BUNDLED_AGENT_NAMES, ...result.admittedNames]);
  return {
    admitted,
    refusalFor: (args) => agentNameRefusal(args, admitted)?.message ?? null,
    checkInit: (message) => checkInit(message, admitted),
  };
}
