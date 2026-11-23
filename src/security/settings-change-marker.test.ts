import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildProtectedRoots, selfProtectionHook, SelfProtectionViolation } from './self-protection.js';
import {
  MARKER_LOCK_STALE_MS,
  MARKER_LOCK_WAIT_MS,
  mergeMarkerEntries,
  readSettingsChangeMarker,
  SETTINGS_CHANGE_MARKER_MAX_BYTES,
  SETTINGS_CHANGE_MARKER_MAX_ENTRIES,
  settingsChangeMarkerPath,
  updateSettingsChangeMarker,
  writeSettingsChangeMarker,
} from './settings-change-marker.js';
import type { SettingsChangeMarkerEntry } from './settings-change-marker.js';

// Issue #264, owner ruling 4: the marker a settings-change stop leaves, so the next run is refused while the file is as it was left.

const home = (): string => mkdtempSync(join(tmpdir(), 'smark-'));
const entry = (over: Partial<SettingsChangeMarkerEntry> = {}): SettingsChangeMarkerEntry => ({
  source: 'user',
  path: '/cfg/settings.json',
  kind: 'content',
  fingerprint: 'file||sha256:abc',
  baseline: 'absent||absent',
  detectedAt: '2026-11-23T01:02:03.000Z',
  ...over,
});
const rmSyncForce = (path: string): void => rmSync(path, { force: true });
const raw = (markerPath: string, text: string): void => {
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, text);
};

describe('the settings-change marker (#264)', () => {
  it("is under the harness's user directory", () => {
    expect(settingsChangeMarkerPath('/home/u')).toBe(join('/home/u', '.harness', 'settings-changed.json'));
  });

  it('nothing at the path is absent, not an empty marker and not unreadable', () => {
    expect(readSettingsChangeMarker(settingsChangeMarkerPath(home()))).toEqual({ state: 'absent' });
    expect(readSettingsChangeMarker(join(home(), 'a-file-not-a-dir', 'x', 'settings-changed.json'))).toEqual({ state: 'absent' });
  });

  it('what is written is what is read, the directory is made, and no temporary file is left', () => {
    const markerPath = settingsChangeMarkerPath(home());
    const entries = [entry(), entry({ source: 'managed', path: '/m/managed-settings.d', kind: 'drop-in-listing', fingerprint: 'listing|x', baseline: 'listing|unlistable' })];
    writeSettingsChangeMarker(markerPath, entries);
    expect(readSettingsChangeMarker(markerPath)).toEqual({ state: 'entries', entries });
    expect(readdirSync(dirname(markerPath))).toEqual(['settings-changed.json']);
    expect(lstatSync(markerPath).mode & 0o077).toBe(0);
  });

  it('writing no entries removes the marker, and removing one that is not there is not an error', () => {
    const markerPath = settingsChangeMarkerPath(home());
    writeSettingsChangeMarker(markerPath, [entry()]);
    writeSettingsChangeMarker(markerPath, []);
    expect(existsSync(markerPath)).toBe(false);
    expect(() => writeSettingsChangeMarker(markerPath, [])).not.toThrow();
  });

  it('a symlink left at the marker path is replaced by the write, never followed, and is unreadable until then', () => {
    const dir = home();
    const markerPath = settingsChangeMarkerPath(dir);
    const target = join(dir, 'target.json');
    writeFileSync(target, 'untouched');
    mkdirSync(dirname(markerPath), { recursive: true });
    symlinkSync(target, markerPath);
    expect(readSettingsChangeMarker(markerPath)).toEqual({ state: 'unreadable' });
    writeSettingsChangeMarker(markerPath, [entry()]);
    expect(lstatSync(markerPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(readSettingsChangeMarker(markerPath).state).toBe('entries');
  });

  it.each([
    ['not JSON', '{ nope'],
    ['JSON that is not an object', '[]'],
    ['another version', JSON.stringify({ version: 2, entries: [] })],
    ['entries that are not a list', JSON.stringify({ version: 1, entries: {} })],
    ['an entry with an unknown source', JSON.stringify({ version: 1, entries: [{ ...entry(), source: 'elsewhere' }] })],
    ['an entry with an unknown kind', JSON.stringify({ version: 1, entries: [{ ...entry(), kind: 'vibes' }] })],
    ['an entry with a relative path', JSON.stringify({ version: 1, entries: [{ ...entry(), path: 'cfg/settings.json' }] })],
    ['an entry with no fingerprint', JSON.stringify({ version: 1, entries: [{ ...entry(), fingerprint: '' }] })],
    ['an entry with no baseline (the first build wrote none)', JSON.stringify({ version: 1, entries: [{ ...entry(), baseline: undefined }] })],
    ['one bad entry beside a good one', JSON.stringify({ version: 1, entries: [entry(), null] })],
    ['more entries than a marker holds', JSON.stringify({ version: 1, entries: Array.from({ length: SETTINGS_CHANGE_MARKER_MAX_ENTRIES + 1 }, () => entry()) })],
    ['a file larger than a marker', ' '.repeat(SETTINGS_CHANGE_MARKER_MAX_BYTES + 1)],
  ])('%s is unreadable, never an empty marker', (_name, text) => {
    const markerPath = settingsChangeMarkerPath(home());
    raw(markerPath, text);
    expect(readSettingsChangeMarker(markerPath)).toEqual({ state: 'unreadable' });
  });

  it('a directory at the marker path is unreadable', () => {
    const markerPath = settingsChangeMarkerPath(home());
    mkdirSync(markerPath, { recursive: true });
    expect(readSettingsChangeMarker(markerPath)).toEqual({ state: 'unreadable' });
  });

  it('R3-4: more entries than a reader accepts are all written, none dropped, and the marker then reads as unreadable', () => {
    const markerPath = settingsChangeMarkerPath(home());
    const many = Array.from({ length: SETTINGS_CHANGE_MARKER_MAX_ENTRIES + 3 }, (_unused, i) => entry({ path: `/cfg/${i}.json` }));
    writeSettingsChangeMarker(markerPath, many);
    expect((JSON.parse(readFileSync(markerPath, 'utf8')) as { entries: { path: string }[] }).entries.map((e) => e.path)).toEqual(many.map((e) => e.path));
    expect(readSettingsChangeMarker(markerPath)).toEqual({ state: 'unreadable' });
    // Exactly at the cap it still reads; a writer is handed everything, past the cap too.
    writeSettingsChangeMarker(markerPath, many.slice(0, SETTINGS_CHANGE_MARKER_MAX_ENTRIES));
    expect(readSettingsChangeMarker(markerPath).state).toBe('entries');
    writeSettingsChangeMarker(markerPath, many);
    let handed = 0;
    updateSettingsChangeMarker(markerPath, (read) => ((handed = read.state === 'entries' ? read.entries.length : -1), null));
    expect(handed).toBe(SETTINGS_CHANGE_MARKER_MAX_ENTRIES + 3);
  });

  it('merging keeps one entry per path: the newer sighting replaces the older and KEEPS its baseline, the earliest start state on record', () => {
    const old = entry({ fingerprint: 'first-write', baseline: 'file||sha256:original' });
    const other = entry({ path: '/p/.claude/settings.json', source: 'project' });
    // A later run started with the planted file in place, so ITS start state is the planted one; the original stays the baseline.
    const fresh = entry({ fingerprint: 'second-write', baseline: 'first-write', kind: 'reported' });
    expect(mergeMarkerEntries([old, other], [fresh])).toEqual([other, { ...fresh, baseline: 'file||sha256:original' }]);
    expect(mergeMarkerEntries([], [fresh])).toEqual([fresh]);
  });

  describe('two writers (review finding: read, merge and write raced between concurrent runs)', () => {
    const quick = (acts: (() => void)[] = []) => {
      const clock = { ms: Date.now() };
      const sleeps: number[] = [];
      return {
        clock,
        sleeps,
        io: {
          now: () => clock.ms,
          sleepSync: (ms: number) => {
            sleeps.push(ms);
            clock.ms += ms;
            acts.shift()?.();
          },
        },
      };
    };

    const TOKEN_A = 'a'.repeat(24);
    const TOKEN_B = 'b'.repeat(24);
    const lockOf = (markerPath: string): string => `${markerPath}.lock`;
    const held = (markerPath: string): string | null => (existsSync(lockOf(markerPath)) ? readFileSync(lockOf(markerPath), 'utf8') : null);
    const age = (path: string, ms: number): void => utimesSync(path, (Date.now() - ms) / 1000, (Date.now() - ms) / 1000);
    const leftovers = (markerPath: string): string[] => readdirSync(dirname(markerPath)).filter((name) => name.includes('.tmp') || name.includes('.claim.'));

    it('an update reads the marker only once it holds the lock, so an entry a second writer adds meanwhile is kept', () => {
      const markerPath = settingsChangeMarkerPath(home());
      const mine = entry({ path: '/cfg/mine.json' });
      const theirs = entry({ path: '/cfg/theirs.json' });
      // The other writer holds the lock; while this one waits, it writes its entry and lets go.
      raw(lockOf(markerPath), TOKEN_A);
      const seam = quick([
        () => {
          writeSettingsChangeMarker(markerPath, [theirs]);
          rmSyncForce(lockOf(markerPath));
        },
      ]);
      updateSettingsChangeMarker(markerPath, (read) => mergeMarkerEntries(read.state === 'entries' ? read.entries : [], [mine]), seam.io);
      expect(seam.sleeps.length).toBe(1);
      expect(readSettingsChangeMarker(markerPath)).toEqual({ state: 'entries', entries: [theirs, mine] });
      expect(existsSync(lockOf(markerPath))).toBe(false);
      expect(leftovers(markerPath)).toEqual([]);
    });

    it('while it works the lock holds a token of its own, and the lock is let go after an update and after one whose function throws', () => {
      const markerPath = settingsChangeMarkerPath(home());
      let during: string | null = null;
      updateSettingsChangeMarker(markerPath, () => ((during = held(markerPath)), [entry()]));
      expect(during).toMatch(/^[0-9a-f]{24}$/);
      expect(existsSync(lockOf(markerPath))).toBe(false);
      expect(() =>
        updateSettingsChangeMarker(markerPath, () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(existsSync(lockOf(markerPath))).toBe(false);
      expect(readSettingsChangeMarker(markerPath).state).toBe('entries');
      expect(leftovers(markerPath)).toEqual([]);
    });

    it('a lock left by a writer that died is taken over once it is stale, with or without a token in it', () => {
      for (const content of [TOKEN_A, '']) {
        const markerPath = settingsChangeMarkerPath(home());
        raw(lockOf(markerPath), content);
        age(lockOf(markerPath), MARKER_LOCK_STALE_MS + 5_000);
        const seam = quick();
        let during: string | null = null;
        updateSettingsChangeMarker(markerPath, () => ((during = held(markerPath)), [entry()]), seam.io);
        expect(seam.sleeps).toEqual([]);
        expect(during).toMatch(/^[0-9a-f]{24}$/);
        expect(during).not.toBe(content);
        expect(readSettingsChangeMarker(markerPath).state).toBe('entries');
        expect(existsSync(lockOf(markerPath))).toBe(false);
        expect(leftovers(markerPath)).toEqual([]);
      }
    });

    it('race 1: of two waiters that see the same stale lock only one takes it over; the other never removes the lock the first has just taken', () => {
      const markerPath = settingsChangeMarkerPath(home());
      raw(lockOf(markerPath), TOKEN_A);
      age(lockOf(markerPath), MARKER_LOCK_STALE_MS + 5_000);
      // The other waiter has claimed this stale lock already (the claim is named after the stale lock's token).
      raw(`${lockOf(markerPath)}.claim.${TOKEN_A}`, '');
      const seen: (string | null)[] = [];
      const seam = quick([
        // It finishes its takeover: the lock is now its own and fresh, and the claim is gone.
        () => {
          seen.push(held(markerPath));
          raw(lockOf(markerPath), TOKEN_B);
          rmSyncForce(`${lockOf(markerPath)}.claim.${TOKEN_A}`);
        },
        () => void seen.push(held(markerPath)),
        // It finishes its work and lets go.
        () => {
          seen.push(held(markerPath));
          writeSettingsChangeMarker(markerPath, [entry({ path: '/cfg/theirs.json' })]);
          rmSyncForce(lockOf(markerPath));
        },
      ]);
      updateSettingsChangeMarker(markerPath, (read) => mergeMarkerEntries(read.state === 'entries' ? read.entries : [], [entry({ path: '/cfg/mine.json' })]), seam.io);
      // At each wait the lock was still there: first the stale one, then the other waiter's, untouched by this writer.
      expect(seen).toEqual([TOKEN_A, TOKEN_B, TOKEN_B]);
      const read = readSettingsChangeMarker(markerPath);
      expect(read.state === 'entries' ? read.entries.map((e) => e.path) : read.state).toEqual(['/cfg/theirs.json', '/cfg/mine.json']);
      expect(leftovers(markerPath)).toEqual([]);
    });

    it('race 1, the other order: a waiter that looked at the stale lock before another one took it over and let its claim go does not take the new lock', () => {
      const markerPath = settingsChangeMarkerPath(home());
      raw(lockOf(markerPath), TOKEN_A);
      age(lockOf(markerPath), MARKER_LOCK_STALE_MS + 5_000);
      const seen: (string | null)[] = [];
      const seam = quick([
        () => void seen.push(held(markerPath)),
        () => {
          seen.push(held(markerPath));
          rmSyncForce(lockOf(markerPath));
        },
      ]);
      let gaps = 0;
      // In the gap between this writer's look and its claim, the other waiter claims, takes over and removes its claim.
      const io = { ...seam.io, beforeClaim: () => ((gaps += 1), gaps === 1 ? raw(lockOf(markerPath), TOKEN_B) : undefined) };
      // This writer has its claim by then, and is turned back by the token: the lock is no longer the stale one it looked at.
      updateSettingsChangeMarker(markerPath, () => [entry()], io);
      expect(gaps).toBe(1);
      expect(seen).toEqual([TOKEN_B, TOKEN_B]);
      expect(leftovers(markerPath)).toEqual([]);
    });

    it('race 2: a writer whose lock was taken over while it worked does not remove the new holder\'s lock', () => {
      const markerPath = settingsChangeMarkerPath(home());
      updateSettingsChangeMarker(markerPath, () => {
        // Another writer judged this one dead and took the lock over.
        raw(lockOf(markerPath), TOKEN_B);
        return [entry()];
      });
      expect(held(markerPath)).toBe(TOKEN_B);
    });

    it('a stale lock that another waiter has already claimed is left alone: this writer waits its time out, then writes without the lock', () => {
      const markerPath = settingsChangeMarkerPath(home());
      raw(lockOf(markerPath), TOKEN_A);
      age(lockOf(markerPath), MARKER_LOCK_STALE_MS + 5_000);
      raw(`${lockOf(markerPath)}.claim.${TOKEN_A}`, '');
      const seam = quick();
      updateSettingsChangeMarker(markerPath, () => [entry()], seam.io);
      expect(held(markerPath)).toBe(TOKEN_A);
      expect(seam.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(MARKER_LOCK_WAIT_MS);
      expect(readSettingsChangeMarker(markerPath).state).toBe('entries');
    });

    it('a writer that cannot get a fresh lock in time writes anyway, and leaves the other writer its lock', () => {
      const markerPath = settingsChangeMarkerPath(home());
      raw(lockOf(markerPath), TOKEN_A);
      const seam = quick();
      // The clock moves with each wait, and the lock's own time is kept fresh, as a live writer's would be.
      const fresh = seam.io.sleepSync;
      seam.io.sleepSync = (ms) => {
        fresh(ms);
        utimesSync(lockOf(markerPath), seam.clock.ms / 1000, seam.clock.ms / 1000);
      };
      updateSettingsChangeMarker(markerPath, () => [entry()], seam.io);
      expect(seam.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(MARKER_LOCK_WAIT_MS);
      expect(seam.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(MARKER_LOCK_WAIT_MS + 100);
      expect(MARKER_LOCK_WAIT_MS).toBe(2000);
      expect(MARKER_LOCK_STALE_MS).toBe(10_000);
      expect(readSettingsChangeMarker(markerPath).state).toBe('entries');
      expect(held(markerPath)).toBe(TOKEN_A);
      expect(leftovers(markerPath)).toEqual([]);
    });

    it('an update that returns null leaves the marker as it is', () => {
      const markerPath = settingsChangeMarkerPath(home());
      writeSettingsChangeMarker(markerPath, [entry()]);
      const before = readFileSync(markerPath, 'utf8');
      updateSettingsChangeMarker(markerPath, () => null);
      expect(readFileSync(markerPath, 'utf8')).toBe(before);
    });
  });

  it('the agent cannot write or remove the marker by name: it is under the protected user directory', async () => {
    const dir = home();
    const project = home();
    const guard = selfProtectionHook(buildProtectedRoots({ userDir: dir, projectDir: project, skillsDir: null, dbPath: null, claudeConfigDir: undefined, managedDir: join(dir, 'managed') }));
    const markerPath = settingsChangeMarkerPath(dir);
    await expect(guard({ tool: 'Write', args: { file_path: markerPath } } as never)).rejects.toThrowError(SelfProtectionViolation);
    await expect(guard({ tool: 'Bash', args: { command: `rm ${markerPath}` } } as never)).rejects.toThrowError(SelfProtectionViolation);
  });
});
