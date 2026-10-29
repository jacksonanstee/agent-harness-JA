// Ctrl-C for `run` (issue #187 D5, ADR-0041). Before #187 the harness
// installed no SIGINT handler, so Node's default killed the process with no
// stop hook and no turn-cost row (R-21).

/**
 * Installs a one-shot SIGINT listener that calls `onFirst`. The listener
 * removes itself before calling it, so a SECOND Ctrl-C finds no listener and
 * Node's default action kills the process at once (the hard-kill escape when
 * cleanup hangs). Returns an idempotent uninstall for the end of the run.
 */
export function installSigintHandler(onFirst: () => void): () => void {
  const handler = (): void => {
    process.removeListener('SIGINT', handler);
    onFirst();
  };
  process.on('SIGINT', handler);
  return () => {
    process.removeListener('SIGINT', handler);
  };
}
