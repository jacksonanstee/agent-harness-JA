import { mkdtempSync, statSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach } from 'vitest';

// Issue #264. The session's default settings watch keeps its marker under the home directory
// (`~/.harness/settings-changed.json`), and the default scans read the files under it. No unit test may
// write the real one. Two layers:
//
// 1. Prevention. Every worker's HOME (and USERPROFILE) is pointed at a temporary directory of its own before
//    any test file is loaded, so `os.homedir()` in the code under test is that directory, whatever seam a
//    test forgot. This works because the pool is `forks` (vitest.config.ts): a worker is a process, and an
//    assignment to its `process.env` reaches the C environment `os.homedir()` reads. It would NOT under the
//    threads pool, where `process.env` is a copy (lesson of 2026-08-28); the check below would then throw.
// 2. A tripwire. The REAL home directory is read from the password database (`os.userInfo()`), which no
//    environment variable moves, and the real marker's state is compared after every test and once more
//    after the file's last one. A test that changed it fails. It reports a leak; it does not undo it.
//
// Added after a mutation run that unwired a seam wrote a marker into the real home (23/11/2026).

/** The marker's state as one string: absent, or its modification time and size. */
export function markerStamp(path: string): string {
  try {
    const stats = statSync(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'absent';
  }
}

/** The real home directory, whatever HOME says. */
export const REAL_HOME = userInfo().homedir;
const REAL_MARKER = join(REAL_HOME, '.harness', 'settings-changed.json');

const WORKER_HOME = mkdtempSync(join(tmpdir(), 'harness-test-home-'));
process.env.HOME = WORKER_HOME;
process.env.USERPROFILE = WORKER_HOME;
if (homedir() !== WORKER_HOME) {
  throw new Error(`#264: os.homedir() is ${homedir()}, not the worker's temporary home ${WORKER_HOME}; the suite must run with pool 'forks'`);
}

const found = markerStamp(REAL_MARKER);
function assertRealMarkerUntouched(): void {
  if (markerStamp(REAL_MARKER) !== found) {
    throw new Error(
      `#264: a test changed the real settings-change marker at ${REAL_MARKER}. A test session must be given ` +
        'watchSettings (noSettingsWatch, or a watch over temporary directories). Read that file, and delete it if a test wrote it.',
    );
  }
}
afterEach(assertRealMarkerUntouched);
afterAll(assertRealMarkerUntouched);
