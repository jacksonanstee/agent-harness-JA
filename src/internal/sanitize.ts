/**
 * Shared control-character sanitizer (ADR-0008 Revisit-if: telemetry became
 * the fourth copy site, triggering extraction). Strips C0/C1 control chars +
 * Unicode line/paragraph separators so attacker-influenced strings (tool
 * names, hook reasons, error messages, persisted text) cannot carry terminal
 * escapes or log injection. Zero-dependency leaf: importable from any module.
 *
 * The CLI's TERMINAL_UNSAFE in src/cli.ts is deliberately separate — it keeps
 * newline/tab for readable terminal output, a different charset contract.
 */
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/g;

export function sanitizeControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, ' ');
}
