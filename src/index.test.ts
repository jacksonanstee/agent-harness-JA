import { describe, expect, it } from 'vitest';

import * as barrel from './index.js';
import * as securityBarrel from './security/index.js';
import * as sessionBarrel from './session/index.js';
import type {
  AdversaryFn,
  ChallengeInput,
  JudgeCall,
  JudgeCallResult,
  JudgedScanner,
  JudgedScannerOptions,
  JudgedScanResult,
  JudgeErrorKind,
  JudgeMode,
  JudgeRunState,
  OutputAnnotation,
  OutputRewrite,
  OutputRewriteOutcome,
  QueryFn,
  RefusalSource,
  ScanResult,
  RedactResult,
  SessionRefusal,
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

  it('has no runtime-name collision among the star-exported sub-barrels', async () => {
    // ESM ambiguous-star semantics silently EXCLUDE any name two star
    // sub-barrels both export, and a named re-export silently SHADOWS a
    // same-named star export (ADR-0023 residual risk). This guard turns the
    // silent value-level cases into a test failure. Type-only collisions
    // remain undetectable at runtime; the ADR names that residual.
    const starBarrels = {
      router: await import('./router/index.js'),
      skills: await import('./skills/index.js'),
      hooks: await import('./hooks/index.js'),
      memory: await import('./memory/index.js'),
      session: await import('./session/index.js'),
      eval: await import('./eval/index.js'),
    };
    const named = {
      security: await import('./security/index.js'),
      telemetry: await import('./telemetry/index.js'),
    };
    const owners = new Map<string, string>();
    const collisions: string[] = [];
    for (const [barrelName, mod] of Object.entries(starBarrels)) {
      for (const exportName of Object.keys(mod)) {
        const owner = owners.get(exportName);
        if (owner) collisions.push(`${exportName} (${owner} vs ${barrelName})`);
        owners.set(exportName, barrelName);
      }
    }
    // Named-vs-star: only the known, deliberately aliased collision may exist.
    for (const [barrelName, mod] of Object.entries(named)) {
      for (const exportName of Object.keys(mod)) {
        const owner = owners.get(exportName);
        const isKnownAliasedPair = barrelName === 'telemetry' && exportName === 'DEFAULT_DB_PATH';
        if (owner && !isKnownAliasedPair) {
          collisions.push(`${exportName} (${owner} vs ${barrelName})`);
        }
      }
    }
    expect(collisions, collisions.join('; ')).toEqual([]);
  });

  // Issue #96 PR-A, pin 13 (ADR-0023, G-7, U-10): the judged scanner AND the
  // hardened builder are public; the judge's wire internals are not, exactly
  // as the verifier's buildChallengePrompt/parseAdversaryResponse/ParsedWire
  // stay off. verdictRank/stricterVerdict live on the SECURITY barrel only.
  it('exports the S-5 judge surface: createJudgedScanner, toInjectionJudge, the four constants and buildJudge', () => {
    expect(typeof barrel.createJudgedScanner).toBe('function');
    expect(typeof barrel.toInjectionJudge).toBe('function');
    expect(typeof barrel.buildJudge).toBe('function');
    expect(barrel.JUDGE_MODES).toEqual(['off', 'suspicious', 'always']);
    expect(barrel.JUDGE_TIMEOUT_MS).toBe(60_000);
    expect(barrel.MAX_JUDGE_INPUT_BYTES).toBe(131_072);
    expect(barrel.JUDGE_RULE_IDS).toEqual({ block: 'judge-block', ask: 'judge-ask' });
  });

  it('keeps the judge wire internals off the root and session barrels, and the verdict helpers on the security barrel only', () => {
    const rootNames = Object.keys(barrel);
    const sessionNames = Object.keys(sessionBarrel);
    for (const internal of ['buildJudgePrompt', 'parseJudgeResponse', 'JUDGE_SYSTEM_PROMPT']) {
      expect(rootNames, `root barrel must not export ${internal}`).not.toContain(internal);
      expect(sessionNames, `session barrel must not export ${internal}`).not.toContain(internal);
    }
    expect(sessionNames).toContain('buildJudge');
    expect(typeof securityBarrel.verdictRank).toBe('function');
    expect(typeof securityBarrel.stricterVerdict).toBe('function');
    expect(rootNames).not.toContain('verdictRank');
    expect(rootNames).not.toContain('stricterVerdict');
  });

  it('exports the judge type closure its public signatures reference (compile-time; npm run typecheck is the gate)', () => {
    const mode: JudgeMode = 'suspicious';
    const state: JudgeRunState = 'judged';
    const kind: JudgeErrorKind = 'call-failed';
    const ok: JudgeCallResult = { ok: true, verdict: 'ask', costUsd: null };
    const failed: JudgeCallResult = { ok: false, errorKind: kind, costUsd: null };
    const call: JudgeCall = async () => ok;
    const opts: JudgedScannerOptions = { mode, judge: barrel.toInjectionJudge(call) };
    const scanner: JudgedScanner = barrel.createJudgedScanner(opts);
    const resultOf = (r: JudgedScanResult): JudgeRunState => r.judge;
    const query: QueryFn = () => (async function* () {})();
    const built: JudgeCall = barrel.buildJudge(query, 'claude-haiku-4-5');
    expect(typeof scanner.scanWithJudge).toBe('function');
    expect(typeof built).toBe('function');
    expect([state, failed.ok, typeof resultOf]).toEqual(['judged', false, 'function']);
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
    // SessionResult.refusal is typed SessionRefusal | null, so both are in the
    // closure this test guards. Note WHICH gate enforces it: vitest strips
    // types, so the runtime assertion below is near-tautological and `npm test`
    // proves nothing here. The real check is `npm run typecheck`, which compiles
    // this file via tsconfig.test.json; a bogus type name from the barrel is a
    // TS2305 there. The runtime collision guard above cannot see type-only
    // names at all (ADR-0023 residual).
    const source: RefusalSource = 'system-event';
    const refusal: SessionRefusal = { source, category: null, fallbackModel: null };
    // Issue #84 additive public types: reachable from the root barrel.
    const outcome: OutputRewriteOutcome = 'applied';
    const rewrite: OutputRewrite = { tool: 'Bash', tool_use_id: null, findings: 0, truncated: false, outcome };
    const annotation: OutputAnnotation = { tool: 'Bash', tool_use_id: null, phase: 'post-tool', verdict: 'block', ruleIds: [] };
    expect(typeof adversary).toBe('function');
    expect(input.taskId).toBe('t');
    expect(refusal.source).toBe('system-event');
    expect(rewrite.outcome).toBe('applied');
    expect(annotation.phase).toBe('post-tool');
    expect([verdictOf, findingsOf, idOf, closeOf].every((f) => typeof f === 'function')).toBe(true);
  });
});
