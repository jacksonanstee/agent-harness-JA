/**
 * Hostile-file read envelope (ADR-0034), hoisted from the red-team baseline
 * loader on its third consumer (the settings loader; `src/cli/shared.ts`'s
 * scorecard-directory refusal is the second). Zero repo dependencies: node
 * builtins only, so every domain may import it.
 *
 * What it refuses, and why each is a REFUSAL rather than a resolution:
 * - a leaf symlink, or a symlinked ancestor: a cloned repo can commit either
 *   and redirect a read to any file the operator can open. `realpath` is not
 *   used (impure, TOCTOU-racy; the ADR-0015 §2 rule).
 * - a directory (EISDIR at fstat, before any read).
 * - a body over the caller's byte cap (fstat on the same descriptor the read
 *   uses, so the cap and the read see one file).
 * - anything that is not a regular file (a FIFO, a socket, a device): the
 *   open is non-blocking so a FIFO with no writer cannot hang startup, and
 *   the fstat refuses the type before any read (a FIFO's size is 0 and a
 *   device's is unbounded, so the cap alone bounds neither).
 * ENOENT is NOT a refusal: it is rethrown untouched, code intact, so each
 * consumer decides what absence means (the settings loaders read it as an
 * empty layer; the baseline loader names the missing file).
 *
 * Messages carry the path and a reason and never a byte of the file's
 * content; consumers map `refusal` to their own error class and prefix.
 *
 * Restated, not imported, in scripts/check-corpus-numbers.mjs (the docs-links
 * job installs nothing, so it cannot load this module). A change here needs
 * the same change there; src/corpus-gate.test.ts runs this module's refusal
 * cases through both (ADR-0034, 2026-09-01 amendment).
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, sep } from 'node:path';

export type GuardedReadRefusal =
  | 'symlink'
  | 'ancestor-symlink'
  | 'directory'
  | 'not-a-file'
  | 'oversize'
  | 'unreadable';

export class GuardedReadError extends Error {
  readonly refusal: GuardedReadRefusal;
  readonly path: string;
  /** The fs error code when the refusal wraps one (`unreadable`), else undefined. */
  readonly code: string | undefined;

  constructor(refusal: GuardedReadRefusal, path: string, message: string, code?: string) {
    super(message);
    this.name = 'GuardedReadError';
    this.refusal = refusal;
    this.path = path;
    this.code = code;
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Refuses `path` if it is a symlink. Missing is fine (the caller decides what
 * absence means). Any other lstat failure is `unreadable`, code attached.
 * `label` names what the path is for the message ("file", "directory").
 */
export function refuseSymlink(path: string, label: string): void {
  let isLink: boolean;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ENOENT') return;
    throw new GuardedReadError(
      'unreadable',
      path,
      `cannot stat ${label} ${path} (${code ?? 'stat error'})`,
      code,
    );
  }
  if (isLink) {
    throw new GuardedReadError('symlink', path, `${label} ${path} is a symlink`);
  }
}

/**
 * Ancestor-chain guard. A RELATIVE path is repo-internal: every component is
 * attacker-committable under the malicious-cloned-repo threat model, so each
 * accumulating directory is lstat-checked (a committed symlink at `eval`
 * redirects `eval/redteam/baseline.json` wholesale; leaf and parent checks
 * never see it). An ABSOLUTE path is operator-supplied and may legitimately
 * traverse OS-owned symlinks (macOS `/tmp`, `/var`), so it keeps the parent
 * check only: the operator owns that path, the repo does not.
 *
 * The relative walk operates on the RAW components, never `normalize(path)`
 * first: lexical normalisation cancels `symlinkdir/..` textually, dropping an
 * intermediate symlink from the walk while the real `open()` still follows it
 * (a security review found this shape evading the whole check). Splitting the
 * raw path and lstat-checking every accumulating prefix catches a symlink at
 * ANY component: for a symlink at position k, the prefix ending exactly at k
 * has it as its final component, which lstat reports without following.
 * `.`/empty segments are resolution no-ops (dropped); `..` is retained, since
 * lstat on a `..`-terminated prefix is always safe and the symlink one
 * component earlier is already caught.
 */
export function refuseAncestorSymlinks(path: string): void {
  const refuseDir = (dir: string): void => {
    try {
      refuseSymlink(dir, 'directory');
    } catch (error: unknown) {
      if (error instanceof GuardedReadError && error.refusal === 'symlink') {
        throw new GuardedReadError('ancestor-symlink', path, `${error.message} (ancestor of ${path})`);
      }
      throw error;
    }
  };
  if (isAbsolute(path)) {
    refuseDir(dirname(path));
    return;
  }
  const parts = path.split(sep).filter((p) => p !== '' && p !== '.');
  let acc = '';
  for (const part of parts.slice(0, -1)) {
    acc = acc === '' ? part : acc + sep + part;
    refuseDir(acc);
  }
}

// O_NOFOLLOW is a POSIX belt-and-braces backstop for the lstat checks above
// (an fd opened with it can never traverse a leaf symlink, even one raced in
// after the lstat). Absent on platforms without it; the lstat checks remain
// the primary, message-bearing guard everywhere. Proven live by mutation
// (ADR-0034): with refuseSymlink disabled, every leaf-symlink case still
// refused through the ELOOP branch below, and no ancestor case did.
const O_NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;
// O_NONBLOCK makes the open of a FIFO return at once instead of waiting for
// a writer that never comes (a review found the hang by execution). It has
// no effect on the read of a regular file, which is the only type that gets
// past the fstat below.
const O_NONBLOCK: number = fsConstants.O_NONBLOCK ?? 0;

/**
 * Single-descriptor guarded read: refuse symlinks (leaf, then ancestors),
 * open with O_NOFOLLOW and O_NONBLOCK, fstat the SAME descriptor for the
 * type and the byte cap, then read it. ENOENT propagates untouched (see the
 * module header).
 */
export function readFileGuarded(path: string, maxBytes: number): string {
  refuseSymlink(path, 'file');
  refuseAncestorSymlinks(path);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ENOENT') throw error;
    if (code === 'ELOOP') {
      // Reached only if a symlink lands between the lstat above and this
      // open; no suite test can stage that race, so the branch is covered by
      // the refuseSymlink-disabled mutation, not by a test.
      throw new GuardedReadError('symlink', path, `file ${path} is a symlink`, code);
    }
    throw new GuardedReadError('unreadable', path, `cannot read ${path} (${code ?? 'open error'})`, code);
  }
  try {
    const stat = fstatSync(fd);
    if (stat.isDirectory()) {
      throw new GuardedReadError('directory', path, `${path} is a directory`, 'EISDIR');
    }
    if (!stat.isFile()) {
      throw new GuardedReadError('not-a-file', path, `${path} is not a regular file`);
    }
    if (stat.size > maxBytes) {
      throw new GuardedReadError(
        'oversize',
        path,
        `${path} exceeds ${maxBytes} bytes (${stat.size})`,
      );
    }
    return readFileSync(fd, 'utf8');
  } catch (error: unknown) {
    if (error instanceof GuardedReadError) throw error;
    const code = errorCode(error);
    throw new GuardedReadError('unreadable', path, `cannot read ${path} (${code ?? 'read error'})`, code);
  } finally {
    closeSync(fd);
  }
}
