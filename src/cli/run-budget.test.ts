import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatBudgetGapLine, formatStopLine, main, parseRunArgs } from '../cli.js';
import { DEFAULT_MAX_BUDGET_USD } from '../internal/limits.js';
import type { QueryFn, QueryOptions, SdkMessage } from '../session/index.js';
import { createTelemetryStore, openTelemetryDatabase } from '../telemetry/index.js';
import { installSigintHandler } from './interrupt.js';
import { USAGE } from './shared.js';

// Issue #187 at the CLI: `--max-budget-usd`, precedence flag > user settings >
// session default (D3), the stop line (D4, D7) and Ctrl-C (D5). The real SDK
// is never loaded; `onInterrupt` stands in for process SIGINT.

const tmp: string[] = [];
const saved = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

function dir(settings?: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'run-budget-'));
  tmp.push(d);
  if (settings !== undefined) {
    mkdirSync(join(d, '.harness'));
    writeFileSync(join(d, '.harness', 'settings.json'), JSON.stringify(settings));
  }
  return d;
}

const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sdk-1' };
const SUCCESS: SdkMessage = { type: 'result', subtype: 'success', result: 'done', session_id: 'sdk-1', num_turns: 1, total_cost_usd: 0.01 };

function scripted(messages: SdkMessage[], throwAfter?: Error) {
  const options: QueryOptions[] = [];
  const query: QueryFn = (args) => {
    if (args.options !== undefined) options.push(args.options);
    return (async function* () {
      for (const m of messages) yield m;
      if (throwAfter !== undefined) throw throwAfter;
    })();
  };
  return { query, options };
}

interface RunOpts {
  user?: unknown;
  project?: unknown;
  onInterrupt?: (handler: () => void) => () => void;
}

async function runMain(extraArgv: string[], query: QueryFn, opts: RunOpts = {}) {
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
  vi.spyOn(process, 'cwd').mockReturnValue(dir(opts.project));
  const db = join(dir(), 'telemetry.db');
  const argv = ['run', 'hi', '--db', db, '--skills-dir', dir(), ...extraArgv];
  const code = await main(argv, {
    userDir: dir(opts.user),
    importSdk: async () => ({ query }),
    ...(opts.onInterrupt === undefined ? {} : { onInterrupt: opts.onInterrupt }),
  });
  return { code, stdout: out.join(''), stderr: err.join(''), db };
}

function turnCostPayload(db: string) {
  const store = createTelemetryStore(openTelemetryDatabase({ path: db }));
  const row = store.query({ type: 'turn-cost' })[0];
  if (row?.type !== 'turn-cost') throw new Error('no turn-cost row');
  return row.payload;
}

describe('parseRunArgs --max-budget-usd', () => {
  it('leaves the key absent when the flag is not given (the session default applies)', () => {
    const parsed = parseRunArgs(['run', 'hi']);
    expect(parsed.ok && parsed.value.command === 'run' && 'maxBudgetUsd' in parsed.value).toBe(false);
  });

  it.each([
    ['1', 1],
    ['0.5', 0.5],
    ['1.00', 1],
    ['25', 25],
  ])('accepts %s', (raw, expected) => {
    const parsed = parseRunArgs(['run', 'hi', '--max-budget-usd', raw]);
    expect(parsed.ok && parsed.value.command === 'run' ? parsed.value.maxBudgetUsd : undefined).toBe(expected);
  });

  it.each([['0'], ['0.00'], ['-1'], ['abc'], ['1e3'], ['.5'], ['1.'], [''], ['Infinity'], ['9'.repeat(400)]])(
    'rejects %j with the pinned message',
    (raw) => {
      expect(parseRunArgs(['run', 'hi', '--max-budget-usd', raw])).toEqual({
        ok: false,
        error: `--max-budget-usd must be a number of US dollars greater than 0, such as 2.50. ${USAGE}`,
      });
    },
  );

  it('reports a missing value', () => {
    expect(parseRunArgs(['run', 'hi', '--max-budget-usd'])).toEqual({
      ok: false,
      error: `Missing value for --max-budget-usd. ${USAGE}`,
    });
  });

  it('is named in the usage text', () => {
    expect(USAGE).toContain('[--max-budget-usd <usd>]');
  });
});

describe('cap precedence: flag > user settings > default (D3)', () => {
  it('uses the session default with no flag and no settings', async () => {
    const fake = scripted([INIT, SUCCESS]);
    const { code } = await runMain([], fake.query);
    expect(code).toBe(0);
    expect(fake.options[0]?.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD);
  });

  it('uses the user settings cap', async () => {
    const fake = scripted([INIT, SUCCESS]);
    await runMain([], fake.query, { user: { budget: { maxUsd: 4 } } });
    expect(fake.options[0]?.maxBudgetUsd).toBe(4);
  });

  it('lets the flag beat the user settings cap', async () => {
    const fake = scripted([INIT, SUCCESS]);
    await runMain(['--max-budget-usd', '0.25'], fake.query, { user: { budget: { maxUsd: 4 } } });
    expect(fake.options[0]?.maxBudgetUsd).toBe(0.25);
  });

  it('ignores a project cap, with one warning', async () => {
    const fake = scripted([INIT, SUCCESS]);
    const { stderr } = await runMain([], fake.query, { project: { budget: { maxUsd: 99 } } });
    expect(fake.options[0]?.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD);
    expect(stderr.match(/ignoring "budget"/g)).toHaveLength(1);
  });

  it('exits 2 on a malformed user cap, before the SDK is called', async () => {
    const fake = scripted([INIT, SUCCESS]);
    const { code } = await runMain([], fake.query, { user: { budget: { maxUsd: 0 } } });
    expect(code).toBe(2);
    expect(fake.options).toHaveLength(0);
  });
});

describe('the stop line (D4, D7)', () => {
  const budgetResult: SdkMessage = {
    type: 'result',
    subtype: 'error_max_budget_usd',
    session_id: 'sdk-1',
    num_turns: 2,
    total_cost_usd: 1.1234,
  };

  it('formats a budget stop with the cap and the SDK-reported cost', () => {
    expect(formatStopLine({ resultSubtype: 'error_max_budget_usd', costUsd: 1.1234, maxBudgetUsd: 1 })).toBe(
      '[harness] budget: run stopped at the $1.0000 cap after the turn that crossed it ' +
        '(SDK-reported cost $1.1234; the cap is checked after each turn, ADR-0041)',
    );
  });

  it('formats a budget stop with no reported cost', () => {
    expect(formatStopLine({ resultSubtype: 'error_max_budget_usd', costUsd: null, maxBudgetUsd: 2 })).toContain(
      'SDK-reported cost n/a',
    );
  });

  it('names any other non-success subtype', () => {
    expect(formatStopLine({ resultSubtype: 'error_max_turns', costUsd: 0.2, maxBudgetUsd: 1 })).toBe(
      '[harness] stopped: the run ended without success (result="error_max_turns")',
    );
  });

  it('prints nothing for success or for no result', () => {
    expect(formatStopLine({ resultSubtype: 'success', costUsd: 0.2, maxBudgetUsd: 1 })).toBeNull();
    expect(formatStopLine({ resultSubtype: null, costUsd: null, maxBudgetUsd: 1 })).toBeNull();
  });

  it('prints the summary and the budget line and exits 1 when the cap trips, despite the SDK throw', async () => {
    const fake = scripted([INIT, budgetResult], new Error('Claude Code returned an error result: Reached maximum budget ($1)'));
    const { code, stdout, stderr, db } = await runMain([], fake.query);
    expect(code).toBe(1);
    expect(stdout).toContain('cost=$1.1234');
    expect(stderr).toContain('[harness] budget: run stopped at the $1.0000 cap');
    expect(stderr).not.toContain('error:');
    const payload = turnCostPayload(db);
    expect(payload.resultSubtype).toBe('error_max_budget_usd');
    expect(payload.maxBudgetUsd).toBe(1);
  });
});

describe('Ctrl-C (D5)', () => {
  function abortable() {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const query: QueryFn = (args) => {
      const signal = args.options?.abortController?.signal;
      return (async function* () {
        yield INIT;
        started();
        await new Promise<never>((_, reject) => {
          if (signal === undefined) return;
          const fail = () => reject(new Error('Claude Code process aborted by user'));
          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail, { once: true });
        });
      })();
    };
    return { query, running };
  }

  it('aborts the run, records an interrupted cost row, uninstalls the handler and exits 130', async () => {
    const fake = abortable();
    let handler: (() => void) | undefined;
    const uninstall = vi.fn();
    const pending = runMain([], fake.query, {
      onInterrupt: (h) => {
        handler = h;
        return uninstall;
      },
    });
    await fake.running;
    expect(handler).toBeDefined();
    handler?.();
    const { code, stderr, db } = await pending;

    expect(code).toBe(130);
    expect(stderr).toContain('[harness] interrupted: the run was stopped; its turn-cost row is recorded (cost unknown)');
    expect(stderr).not.toContain('error:');
    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(turnCostPayload(db).interrupted).toBe(true);
  });

  it('uninstalls the handler after a normal run too', async () => {
    const uninstall = vi.fn();
    const { code } = await runMain([], scripted([INIT, SUCCESS]).query, { onInterrupt: () => uninstall });
    expect(code).toBe(0);
    expect(uninstall).toHaveBeenCalledTimes(1);
  });

  it('still rethrows a stream failure that was not an interrupt', async () => {
    const fake = scripted([INIT], new Error('stream died'));
    await expect(runMain([], fake.query, { onInterrupt: () => () => undefined })).rejects.toThrow('stream died');
  });
});

describe('installSigintHandler (the default onInterrupt)', () => {
  it('runs the handler once on the first SIGINT, then leaves SIGINT to Node so a second one kills', () => {
    const before = process.listenerCount('SIGINT');
    const onFirst = vi.fn();
    const uninstall = installSigintHandler(onFirst);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);

    process.emit('SIGINT');
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGINT')).toBe(before);

    uninstall(); // idempotent after the first signal
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('uninstall removes the listener when no signal came', () => {
    const before = process.listenerCount('SIGINT');
    const uninstall = installSigintHandler(() => undefined);
    uninstall();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('review fold (#187)', () => {
  it('exits 130 when the interrupt raced the end of the stream and the run returned', async () => {
    let handler: (() => void) | undefined;
    const query: QueryFn = () =>
      (async function* () {
        yield INIT;
        yield SUCCESS;
        handler?.();
      })();
    const { code, stderr, stdout } = await runMain([], query, {
      onInterrupt: (h) => {
        handler = h;
        return () => undefined;
      },
    });
    expect(code).toBe(130);
    expect(stdout).toContain('cost=$0.0100');
    expect(stderr).toContain('[harness] interrupted: the run was stopped; its turn-cost row is recorded (cost $0.0100)');
  });

  it.each([
    [['--max-budget-usd', '0.25'], undefined, '[harness] budget: cap $0.2500 per run (from --max-budget-usd)'],
    [[], { budget: { maxUsd: 4 } }, '[harness] budget: cap $4.0000 per run (from ~/.harness/settings.json)'],
  ])('prints the cap at start when the flag or the settings file sets it (%j)', async (argv, user, line) => {
    const { stderr } = await runMain(argv, scripted([INIT, SUCCESS]).query, { user });
    expect(stderr).toContain(`${line}\n`);
  });

  it('prints no cap line when no cap is set', async () => {
    const { stderr } = await runMain([], scripted([INIT, SUCCESS]).query);
    expect(stderr).not.toContain('[harness] budget: cap');
  });
});

describe('the budget gap line (#212, D4): the cap is enforced on the SDK figure', () => {
  it('names the ratio and the real-dollar stop point when the SDK figure differs from the harness figure', () => {
    expect(formatBudgetGapLine({ costUsd: 0.15, pricedCostUsd: 0.1, maxBudgetUsd: 1 })).toBe(
      "[harness] budget: the cap is enforced on the SDK's cost figure, which read 1.50x the harness-priced " +
        'figure on this run, so the $1.0000 cap stops near $0.6667 at list prices (#212)',
    );
  });

  it('prints nothing within 5% either way, or when either figure is missing or zero', () => {
    expect(formatBudgetGapLine({ costUsd: 0.104, pricedCostUsd: 0.1, maxBudgetUsd: 1 })).toBeNull();
    expect(formatBudgetGapLine({ costUsd: 0.096, pricedCostUsd: 0.1, maxBudgetUsd: 1 })).toBeNull();
    expect(formatBudgetGapLine({ costUsd: null, pricedCostUsd: 0.1, maxBudgetUsd: 1 })).toBeNull();
    expect(formatBudgetGapLine({ costUsd: 0.1, pricedCostUsd: null, maxBudgetUsd: 1 })).toBeNull();
    expect(formatBudgetGapLine({ costUsd: 0.1, pricedCostUsd: 0, maxBudgetUsd: 1 })).toBeNull();
    expect(formatBudgetGapLine({ costUsd: 0, pricedCostUsd: 0.1, maxBudgetUsd: 1 })).toBeNull();
  });

  it('prints nothing when the ratio is not finite (a denormal harness figure)', () => {
    expect(formatBudgetGapLine({ costUsd: 1, pricedCostUsd: Number.MIN_VALUE, maxBudgetUsd: 1 })).toBeNull();
    // Security re-check: a finite ratio can still overflow the stop point.
    expect(formatBudgetGapLine({ costUsd: 0.5, pricedCostUsd: 1, maxBudgetUsd: 1e308 })).toBeNull();
    expect(formatBudgetGapLine({ costUsd: 1e-300, pricedCostUsd: 2e9, maxBudgetUsd: 1 })).toBeNull();
  });

  it('also reports an SDK figure BELOW list (the cap then lets more through than it says)', () => {
    expect(formatBudgetGapLine({ costUsd: 0.05, pricedCostUsd: 0.1, maxBudgetUsd: 2 })).toContain('read 0.50x');
    expect(formatBudgetGapLine({ costUsd: 0.05, pricedCostUsd: 0.1, maxBudgetUsd: 2 })).toContain('stops near $4.0000');
  });

  it('main prints it on stderr after a run whose two figures differ', async () => {
    const MU = { inputTokens: 1e6, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 3, contextWindow: 1, maxOutputTokens: 1 };
    const result: SdkMessage = { ...SUCCESS, total_cost_usd: 3, modelUsage: { 'claude-sonnet-5': MU } };
    const fake = scripted([INIT, result]);
    const { code, stderr, db } = await runMain([], fake.query);
    expect(code).toBe(0);
    const payload = turnCostPayload(db);
    expect(payload.pricedCostUsd).toBe(2); // 1 MTok input at $2
    expect(stderr).toContain("[harness] budget: the cap is enforced on the SDK's cost figure, which read 1.50x");
  });

  it('main prints no gap line when the run carries no per-model usage', async () => {
    const { stderr } = await runMain([], scripted([INIT, SUCCESS]).query);
    expect(stderr).not.toContain('cap is enforced on');
  });
});
