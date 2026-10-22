import { SETTING_SOURCES } from '../security/index.js';
import type { SettingSource } from '../security/index.js';

// #140, ADR-0040 D2: the operator start line for inherited Claude Code settings.
// Null for the isolated default (`[]`), so a default run prints nothing. The
// members print in SETTING_SOURCES order, deduplicated, whatever the file order.
export function sdkStartLine(sources: readonly SettingSource[]): string | null {
  const inherited = SETTING_SOURCES.filter((source) => sources.includes(source));
  if (inherited.length === 0) return null;
  return `[harness] claude code settings: inherited (${inherited.join(', ')}); their permission rules, hooks, plugins, MCP servers and CLAUDE.md files apply to this run`;
}
