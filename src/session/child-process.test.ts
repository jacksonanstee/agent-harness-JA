
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { createChildOwner, spawnChildProcess, STDERR_LINE_TOO_LONG, STDERR_TAIL_MAX_BYTES, stderrTailOf, withStderrTail } from './child-process.js';
import type { SdkSpawnedProcess, SdkSpawnOptions } from './types.js';

// Issue #251, owner ruling 20/11/2026. The harness starts the bundled CLI itself, through the SDK's
// `spawnClaudeCodeProcess` option, so that it holds the process and can kill it without being told
// an id. These tests cover the spawn function and the owner; `hook-canary.test.ts` covers when the
// session kills.

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});
const exitOf = (child: { once(event: 'exit', l: (code: number | null, signal: NodeJS.Signals | null) => void): void }) =>
  new Promise<NodeJS.Signals | number | null>((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code)));
const options = (over: Partial<SdkSpawnOptions> = {}): SdkSpawnOptions => ({
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
  env: { PATH: process.env['PATH'] },
  signal: new AbortController().signal,
  ...over,
});

interface Stub extends SdkSpawnedProcess {
  sent: NodeJS.Signals[];
}
function stub(over: Partial<{ exitCode: number | null; signalCode: NodeJS.Signals | null; kill: (signal: NodeJS.Signals) => boolean }> = {}): Stub {
  const sent: NodeJS.Signals[] = [];
  return {
    sent,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: over.exitCode ?? null,
    signalCode: over.signalCode ?? null,
    kill: (signal) => {
      sent.push(signal);
      return over.kill === undefined ? true : over.kill(signal);
    },
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
  };
}

describe('spawnChildProcess: the harness starts the CLI itself', () => {
  it('starts the command with the arguments, the working directory and exactly the environment it is given', async () => {
    const child = spawnChildProcess(
      options({ args: ['-e', 'process.stdout.write(JSON.stringify([process.argv.slice(1), process.cwd(), process.env.PROBE_ONLY, process.env.HOME ?? null]))', 'a', 'b'], cwd: '/', env: { PROBE_ONLY: 'yes' } }),
    ) as unknown as ChildProcess;
    children.push(child);
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    await exitOf(child);
    expect(JSON.parse(out)).toEqual([['a', 'b'], '/', 'yes', null]);
  });

  it('gives the SDK a stdin and a stdout pipe', () => {
    const child = spawnChildProcess(options()) as unknown as ChildProcess;
    children.push(child);
    expect(child.stdin).not.toBeNull();
    expect(child.stdout).not.toBeNull();
  });

  it("passes the SDK's signal on: aborting it ends the child", async () => {
    const controller = new AbortController();
    const child = spawnChildProcess(options({ signal: controller.signal })) as unknown as ChildProcess;
    children.push(child);
    child.on('error', () => undefined);
    const exit = exitOf(child);
    controller.abort();
    await expect(exit).resolves.toBe('SIGTERM');
  });
});

/** Runs `script` under node through the harness's spawn function and waits for it to end. */
async function ran(script: string) {
  const child = spawnChildProcess(options({ args: ['-e', script] }));
  children.push(child as unknown as ChildProcess);
  const ended = await exitOf(child);
  return { child, ended };
}

describe("the child's stderr: drained as it comes, the last whole lines kept (#251, owner rulings 20/11/2026)", () => {
  /** `count` numbered lines of 10 bytes each (`L0000000n\n`), then exit with `code`. */
  const lines = (count: number, code: number): string =>
    `let n = 0; const go = () => { if (n === ${count}) return process.exit(${code}); process.stderr.write('L' + String(n++).padStart(8, '0') + '\\n', go); }; go();`;

  it('a child that writes far more to stderr than a pipe holds still finishes: the pipe is drained whether or not anything fails', async () => {
    // 2 MiB in one write; an unread pipe holds about 64 KiB, and the child would block on the write for ever.
    const { child, ended } = await ran("process.stderr.write(('y'.repeat(1023) + '\\n').repeat(2048), () => process.exit(0))");
    expect(ended).toBe(0);
    // 1,024-byte lines: the cut falls exactly on a line break, so the four last lines are kept whole.
    expect(Buffer.byteLength(await stderrTailOf(child))).toBe(STDERR_TAIL_MAX_BYTES);
  }, 10_000);

  it('keeps what a child wrote when it is under the cap, whole, the first line included', async () => {
    const { child } = await ran("process.stderr.write('first line\\nsecond line\\n', () => process.exit(3))");
    expect(await stderrTailOf(child)).toBe('first line\nsecond line\n');
  });

  it('exactly the cap, never cut, is kept whole too', async () => {
    const { child } = await ran(`process.stderr.write('a'.repeat(${STDERR_TAIL_MAX_BYTES - 1}) + '\\n', () => process.exit(1))`);
    expect(await stderrTailOf(child)).toBe(`${'a'.repeat(STDERR_TAIL_MAX_BYTES - 1)}\n`);
  });

  it('keeps writes that arrive apart, joined in order', async () => {
    const { child } = await ran("process.stderr.write('one,'); setTimeout(() => process.stderr.write('two,'), 60); setTimeout(() => process.stderr.write('three', () => process.exit(1)), 120);");
    expect(await stderrTailOf(child)).toBe('one,two,three');
  });

  it('keeps the LAST lines, not the first, and never more than the cap', async () => {
    const { child } = await ran(lines(2000, 1));
    const tail = await stderrTailOf(child);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(STDERR_TAIL_MAX_BYTES);
    expect(Buffer.byteLength(tail)).toBeGreaterThan(STDERR_TAIL_MAX_BYTES - 20);
    expect(tail.endsWith('L00001999\n')).toBe(true);
    expect(tail).not.toContain('L00000000');
  });

  it('once it has had to cut, it drops the partial first line: the tail starts on a whole line', async () => {
    // 10-byte lines and one extra byte in front, so the cut at 4,096 bytes lands inside a line.
    const { child } = await ran(`process.stderr.write('#', () => { ${lines(1000, 1)} })`);
    const tail = await stderrTailOf(child);
    expect(tail).toMatch(/^(L\d{8}\n)+$/);
    expect(tail.split('\n').filter((line) => line !== '').every((line) => line.length === 9)).toBe(true);
  });

  it('a secret that straddles the cut is not left as a fragment: its line is the partial one, and it goes', async () => {
    // The security review's case: 20 characters of the key fall outside the kept bytes, 88 inside.
    const script = "const sk = 'sk-ant-' + 'api03-' + 'Z'.repeat(95); const after = ' rejected\\n' + 'n'.repeat(4096 - 88 - 10 - 1) + '\\n'; process.stderr.write('x'.repeat(9000) + '\\n' + sk + after, () => process.exit(9));";
    const { child } = await ran(script);
    const tail = await stderrTailOf(child);
    expect(tail).not.toContain('ZZZZ');
    expect(tail).not.toContain('rejected');
    expect(tail).toMatch(/^n+\n$/);
  });

  it('a cut inside a multi-byte character does not throw and leaves no broken character', async () => {
    // 3 bytes each, 20 to a line: 61-byte lines, so the cut lands inside a character.
    const { child } = await ran("process.stderr.write(('\\u20ac'.repeat(20) + '\\n').repeat(300), () => process.exit(1))");
    const tail = await stderrTailOf(child);
    expect(tail).not.toContain('�');
    expect(tail).toMatch(/^(€{20}\n)+$/u);
  });

  it('one line longer than the cap cannot be shown in part, so a fixed note stands in for it', async () => {
    const { child } = await ran("process.stderr.write('SECRET-HEAD' + 'm'.repeat(20000) + 'TAIL-END', () => process.exit(1))");
    const tail = await stderrTailOf(child);
    expect(tail).toBe(STDERR_LINE_TOO_LONG);
    expect(tail).not.toContain('TAIL-END');
  });

  it.each([
    ['a line feed', '\\n'],
    ['a carriage return and line feed', '\\r\\n'],
  ])('one over-long line that ends in %s gives the note too, not an empty tail', async (_name, ending) => {
    const { child } = await ran(`process.stderr.write('m'.repeat(9000) + 'TAIL-END${ending}', () => process.exit(1))`);
    expect(await stderrTailOf(child)).toBe(STDERR_LINE_TOO_LONG);
  });

  it('a cut that lands exactly on a line break drops nothing: the first kept line is a whole one', async () => {
    // The kept 4,096 bytes are exactly one line and its break; the byte before them is the break of the line before.
    const { child } = await ran(`process.stderr.write('a'.repeat(9000) + '\\n' + 'b'.repeat(${STDERR_TAIL_MAX_BYTES - 1}) + '\\n', () => process.exit(1))`);
    expect(await stderrTailOf(child)).toBe(`${'b'.repeat(STDERR_TAIL_MAX_BYTES - 1)}\n`);
  });

  it('a cut one byte later than that is inside the line, and the line goes', async () => {
    const { child } = await ran(`process.stderr.write('a'.repeat(9000) + '\\n' + 'b'.repeat(${STDERR_TAIL_MAX_BYTES}) + '\\nlast\\n', () => process.exit(1))`);
    expect(await stderrTailOf(child)).toBe('last\n');
  });

  it('the cap is 4 KiB', () => {
    expect(STDERR_TAIL_MAX_BYTES).toBe(4096);
  });

  it('a process the harness did not start through its own spawn function has no tail', async () => {
    expect(await stderrTailOf(stub())).toBe('');
  });

  it('lets go of the pipe once the child has exited, though a process the child left behind still holds it open', async () => {
    // The security review's case: the grandchild inherits stderr and outlives the child by seconds.
    const child = spawnChildProcess(options({ command: '/bin/sh', args: ['-c', 'echo before >&2; sleep 4 & exit 0'] })) as unknown as ChildProcess;
    children.push(child);
    const started = Date.now();
    await exitOf(child);
    expect(await stderrTailOf(child as never)).toBe('before\n');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(child.stderr?.destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('bytes that arrive just after the exit are still kept: the pipe is given a short while before it is destroyed', async () => {
    const child = spawnChildProcess(options({ command: '/bin/sh', args: ['-c', '(sleep 0.1; echo late >&2) & echo early >&2; exit 0'] })) as unknown as ChildProcess;
    children.push(child);
    await exitOf(child);
    expect(await stderrTailOf(child as never)).toBe('early\nlate\n');
  });

  it('a second error on the stderr stream does not throw: the listener stays', () => {
    const child = spawnChildProcess(options()) as unknown as ChildProcess;
    children.push(child);
    expect(() => {
      child.stderr?.emit('error', new Error('first'));
      child.stderr?.emit('error', new Error('second'));
    }).not.toThrow();
  });
});

describe('withStderrTail: the tail goes on the error the SDK threw', () => {
  it('appends the tail to the message of the same error object, trimmed', () => {
    const error = new Error('Claude Code process exited with code 1');
    expect(withStderrTail(error, '  boom\n')).toBe(error);
    expect(error.message).toBe('Claude Code process exited with code 1. stderr: boom');
  });

  it.each(['', ' \n '])('leaves the error alone when the tail is %j', (tail) => {
    const error = new Error('exited');
    expect(withStderrTail(error, tail)).toBe(error);
    expect(error.message).toBe('exited');
  });

  it.each([
    ['a message that cannot be written', (e: Error) => Object.defineProperty(e, 'message', { value: 'fixed', writable: false })],
    ['a frozen error', (e: Error) => Object.freeze(e)],
    ['a message setter that throws', (e: Error) => Object.defineProperty(e, 'message', { get: () => 'got', set: () => { throw new Error('no'); } })],
  ])('never throws: an error with %s comes back as it was', (_name, lock) => {
    const error = lock(new Error('fixed'));
    expect(() => withStderrTail(error, 'boom')).not.toThrow();
    expect(withStderrTail(error, 'boom')).toBe(error);
  });

  it.each(['a string', null, { message: 'not an Error' }])('leaves a thrown %j alone', (thrown) => {
    const before = JSON.stringify(thrown);
    expect(withStderrTail(thrown, 'boom')).toBe(thrown);
    expect(JSON.stringify(thrown)).toBe(before);
  });
});

describe('createChildOwner.stderrTail: only a child that ended badly has something to say', () => {
  it.each([
    ['exits non-zero', "process.stderr.write('why it failed', () => process.exit(2))", 'why it failed'],
    ['exits zero', "process.stderr.write('just noise', () => process.exit(0))", ''],
  ])('a child that %s', async (_name, script, expected) => {
    const owner = createChildOwner();
    const child = owner.spawn(options({ args: ['-e', script] }));
    children.push(child as unknown as ChildProcess);
    await exitOf(child);
    expect(await owner.stderrTail()).toBe(expected);
  });

  it('a child still running, a child the harness killed, and no child at all have nothing to say', async () => {
    expect(await createChildOwner().stderrTail()).toBe('');
    const owner = createChildOwner();
    const child = owner.spawn(options({ args: ['-e', "process.stderr.write('started'); setInterval(() => {}, 1000)"] }));
    children.push(child as unknown as ChildProcess);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await owner.stderrTail()).toBe('');
    const exit = exitOf(child);
    expect(owner.kill()).toBe('killed');
    await exit;
    expect(await owner.stderrTail()).toBe('');
  });

  it('a child ended by a signal the harness did not send speaks', async () => {
    const owner = createChildOwner();
    const child = owner.spawn(options({ args: ['-e', "process.stderr.write('before the signal'); setInterval(() => {}, 1000)"] }));
    children.push(child as unknown as ChildProcess);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const exit = exitOf(child);
    // Sent to the process directly, as anything outside the harness might: not through the owner.
    child.kill('SIGTERM');
    await expect(exit).resolves.toBe('SIGTERM');
    expect(await owner.stderrTail()).toBe('before the signal');
  });

  it('with two that ended badly, the later one speaks', async () => {
    const owner = createChildOwner();
    for (const word of ['first', 'second']) {
      const child = owner.spawn(options({ args: ['-e', `process.stderr.write('${word}', () => process.exit(1))`] }));
      children.push(child as unknown as ChildProcess);
      await exitOf(child);
    }
    expect(await owner.stderrTail()).toBe('second');
  });

  it('stand-in processes from a test spawn function have nothing to say', async () => {
    const owner = createChildOwner(() => stub({ exitCode: 1 }));
    owner.spawn(options());
    expect(await owner.stderrTail()).toBe('');
  });
});

describe('createChildOwner: the harness holds every process it started for a run', () => {
  it('owns nothing until its spawn function is called, and a kill then says so and signals nothing', () => {
    const owner = createChildOwner(() => stub());
    expect(owner.owned()).toBe(false);
    expect(owner.kill()).toBe('not-owned');
  });

  it('hands the spawn options to the spawn function unchanged and returns its process', () => {
    const seen: SdkSpawnOptions[] = [];
    const child = stub();
    const owner = createChildOwner((o) => (seen.push(o), child));
    const given = options();
    expect(owner.spawn(given)).toBe(child);
    expect(seen).toEqual([given]);
    expect(seen[0]).toBe(given);
    expect(owner.owned()).toBe(true);
  });

  it('kills with SIGKILL, once, and says killed', () => {
    const child = stub();
    const owner = createChildOwner(() => child);
    owner.spawn(options());
    expect(owner.kill()).toBe('killed');
    expect(child.sent).toEqual(['SIGKILL']);
  });

  it.each([
    ['an exit code', { exitCode: 0 }],
    ['a signal', { signalCode: 'SIGTERM' as const }],
  ])('a process that has already ended with %s is already-gone and is not signalled', (_name, state) => {
    const child = stub(state);
    const owner = createChildOwner(() => child);
    owner.spawn(options());
    expect(owner.kill()).toBe('already-gone');
    expect(child.sent).toEqual([]);
  });

  it.each([
    ['returns false', () => false],
    [
      'throws',
      () => {
        throw new Error('kill EPERM');
      },
    ],
  ])('a kill that %s is failed, never a throw', (_name, kill) => {
    const owner = createChildOwner(() => stub({ kill }));
    owner.spawn(options());
    expect(owner.kill()).toBe('failed');
  });

  it('kills every process it started, and the worst outcome is the one reported', () => {
    const [a, b, c] = [stub(), stub({ exitCode: 1 }), stub({ kill: () => false })];
    const queue = [a, b, c];
    const owner = createChildOwner(() => queue.shift() as Stub);
    owner.spawn(options());
    owner.spawn(options());
    expect(owner.kill()).toBe('killed');
    owner.spawn(options());
    expect(owner.kill()).toBe('failed');
    expect(a.sent).toEqual(['SIGKILL', 'SIGKILL']);
    expect(b.sent).toEqual([]);
    expect(c.sent).toEqual(['SIGKILL']);
  });

  it('a spawn function that throws owns nothing, and the throw reaches the caller', () => {
    const owner = createChildOwner(() => {
      throw new Error('spawn failed');
    });
    expect(() => owner.spawn(options())).toThrow('spawn failed');
    expect(owner.owned()).toBe(false);
  });

  it('each owner is its own', () => {
    const one = createChildOwner(() => stub());
    const two = createChildOwner(() => stub());
    one.spawn(options());
    expect(two.owned()).toBe(false);
  });

  it('by default it really starts a process and really kills it', async () => {
    const owner = createChildOwner();
    const child = owner.spawn(options());
    children.push(child as unknown as ChildProcess);
    const exit = exitOf(child);
    expect(owner.kill()).toBe('killed');
    await expect(exit).resolves.toBe('SIGKILL');
    expect(owner.kill()).toBe('already-gone');
  });
});

