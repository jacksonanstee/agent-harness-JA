import { describe, expect, it } from 'vitest';

import * as barrel from './index.js';
import type {
  AdversaryFn,
  ChallengeInput,
  ScanResult,
  RedactResult,
  TelemetryStore,
  Verifier,
} from './index.js';

// V15/V25 regression pin: the root barrel is the only supported entry once the
// package.json `exports` map lands (see exports-map.test.ts), so every factory
// a SessionDeps / GoldenRunnerDeps field references must be reachable here.
describe('root barrel (src/index.ts)', () => {
  it('exports the security factories and hook adapters', () => {
    expect(typeof barrel.scan).toBe('function');
    expect(typeof barrel.createInjectionScanner).toBe('function');
    expect(typeof barrel.redact).toBe('function');
    expect(typeof barrel.createSecretRedactor).toBe('function');
    expect(typeof barrel.createPermissionEvaluator).toBe('function');
    expect(typeof barrel.createSandbox).toBe('function');
    expect(typeof barrel.permissionHook).toBe('function');
    expect(typeof barrel.sandboxHook).toBe('function');
    expect(barrel.DEFAULT_INJECTION_RULES.length).toBeGreaterThan(0);
    expect(barrel.DEFAULT_SECRET_RULES.length).toBeGreaterThan(0);
  });

  it('exports the telemetry factories, with DEFAULT_DB_PATH aliased', () => {
    expect(typeof barrel.createTelemetryStore).toBe('function');
    expect(typeof barrel.openTelemetryDatabase).toBe('function');
    expect(typeof barrel.runMigrations).toBe('function');
    expect(barrel.TELEMETRY_EVENT_TYPES.length).toBeGreaterThan(0);
    // Memory's DEFAULT_DB_PATH keeps the unprefixed name (pre-existing star
    // export); telemetry's arrives aliased so the collision cannot silently
    // drop either one.
    expect(barrel.TELEMETRY_DEFAULT_DB_PATH).toBe('./.harness/telemetry.db');
    expect(barrel.DEFAULT_DB_PATH).toBe('./.harness/telemetry.db');
  });

  it('exports the verifier factory through the eval barrel', () => {
    expect(typeof barrel.createVerifier).toBe('function');
    expect(barrel.CHALLENGE_CATEGORIES.length).toBeGreaterThan(0);
  });

  it('exports the type closure its own signatures reference (compile-time)', () => {
    // These compile only if the types are importable from the root barrel;
    // the runtime assertions just keep the locals used.
    const adversary: AdversaryFn = async (prompt) => ({ text: prompt, costUsd: null });
    const input: ChallengeInput = { taskId: 't', taskPrompt: 'p', redactedResultText: 'r' };
    const verdictOf = (r: ScanResult): string => r.verdict;
    const findingsOf = (r: RedactResult): number => r.findings.length;
    const idOf = (v: Verifier): string => v.adversaryModelId;
    const closeOf = (s: TelemetryStore): unknown => s;
    expect(typeof adversary).toBe('function');
    expect(input.taskId).toBe('t');
    expect([verdictOf, findingsOf, idOf, closeOf].every((f) => typeof f === 'function')).toBe(true);
  });
});
