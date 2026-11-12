import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import matter from 'gray-matter';
import { hasUnsafeFenceLanguage, MAX_FILE_BYTES, SAFE_MATTER_OPTIONS } from '../internal/frontmatter.js';
import { sanitizeControlChars, stripBidi, truncateTailWellFormed } from '../internal/sanitize.js';
import type { SettingSource } from './sdk-settings.js';

/**
 * Agent-definition scan (issue #229, the second #225 change; ADR-0046).
 *
 * The bundled CLI loads subagent definitions from Markdown files, and a
 * definition's frontmatter applies when the `Agent` call omits the field
 * (`isolation`), or regardless of the call (`permissionMode`, `hooks`,
 * `mcpServers`). The pre-tool hook sees only the call's own arguments, so it
 * cannot see these (ADR-0045 D4). This module lists the directories the CLI
 * loads definitions from and refuses any file whose frontmatter would take a
 * subagent out of reach of the harness hooks. Read from the SDK 0.3.312 binary
 * (CLI 2.1.312), not run; see ADR-0046 for the evidence.
 */

/** Which loader a root belongs to. `local` settings add no agents directory. */
export type AgentSource = 'managed' | 'user' | 'project';

export interface AgentRoot {
  readonly source: AgentSource;
  readonly dir: string;
}

/** Why a file was refused: a frontmatter key, or a reason the scan could not vouch for it. */
export type AgentRefusalReason = 'isolation' | 'permissionMode' | 'hooks' | 'mcpServers' | 'unparsable' | 'unreadable' | 'limit';

export interface AgentRefusal {
  readonly source: AgentSource;
  /** Root-relative, control characters stripped, bounded. Never a frontmatter value. */
  readonly path: string;
  readonly reason: AgentRefusalReason;
}

export interface AgentScanResult {
  /** The frontmatter `name` of each scanned, clean file (the CLI drops a definition without a string name). */
  readonly admittedNames: ReadonlySet<string>;
  readonly refusals: readonly AgentRefusal[];
  readonly filesScanned: number;
}

export type AgentFileVerdict =
  | { readonly ok: true; readonly name: string | null }
  | { readonly ok: false; readonly reason: AgentRefusalReason };

/**
 * The bundled agent definitions in the 0.3.312 binary (`source:"built-in"`
 * objects, read 08/11/2026). `teammate` is built with a caller-chosen name, so
 * no fixed name admits it. The parity test checks each name is still quoted in
 * the installed binary.
 */
export const BUNDLED_AGENT_NAMES: ReadonlySet<string> = new Set([
  'general-purpose',
  'Explore',
  'Plan',
  'statusline-setup',
  'claude-code-guide',
  'web-fetch',
  'fork',
  'claude',
  'comment-thread-analyst',
  'workflow-subagent',
  'worker',
]);

export const AGENT_SCAN_MAX_DEPTH = 16;
export const AGENT_SCAN_MAX_FILES = 2_000;
const MAX_REPORTED_PATH = 200;
const MAX_LISTED_REFUSALS = 8;

/** The frontmatter keys that can move a subagent out of reach of the harness hooks. */
const GUARDED_KEYS = ['isolation', 'permissionMode', 'hooks', 'mcpServers'] as const;
type GuardedKey = (typeof GUARDED_KEYS)[number];

/** The one isolation value that keeps a subagent in process, where the harness hooks fire. */
const LOCAL_ISOLATION = 'worktree';

/**
 * The CLI's own frontmatter split (`dT` in `Gl`, CLI 2.1.312, read): after a
 * BOM strip, and only when a second `---` exists, the block runs from a leading
 * `---` line to the FIRST `---` anywhere after it, whatever follows. The scan
 * judges exactly this block, so it cannot skip one the CLI reads (security
 * review 08/11/2026). The parity test checks the binary still holds this regex.
 */
export const CLI_FRONTMATTER = /^---\s*\n([\s\S]*?)---\s*\n?/;

/** The block the CLI would read as frontmatter, or null when it reads none. */
export function cliFrontmatterBlock(raw: string): string | null {
  const text = raw.replace(/^\uFEFF/, '');
  if (text.indexOf('---', 3) < 0) return null;
  const match = CLI_FRONTMATTER.exec(text);
  return match === null ? null : (match[1] ?? '');
}

/** The CLI's managed-settings directory (`hy()` in the 0.3.312 binary, read). */
export function managedSettingsDir(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

export class AgentDefinitionRefused extends Error {
  readonly refusals: readonly AgentRefusal[];
  constructor(refusals: readonly AgentRefusal[]) {
    const listed = refusals.slice(0, MAX_LISTED_REFUSALS).map((r) => `${r.source}:${r.path} (${r.reason})`);
    const more = refusals.length > MAX_LISTED_REFUSALS ? `; and ${refusals.length - MAX_LISTED_REFUSALS} more` : '';
    super(
      `agent definition refused: ${listed.join('; ')}${more}. A subagent defined this way could run where the harness ` +
        'hooks do not see it; remove or fix the file, or drop the setting source (#229)',
    );
    this.name = 'AgentDefinitionRefused';
    this.refusals = [...refusals];
  }
}

/** Counts a guarded key at a line start (block style, optionally a list item) or after `{`/`,` (flow style). */
function textualKeyCount(block: string, key: GuardedKey): number {
  const quoted = `["']?${key}["']?\\s*:`;
  const lineStart = new RegExp(`^[ \\t]*(?:-[ \\t]+)?${quoted}`, 'gm');
  const flow = new RegExp(`[{,][ \\t]*${quoted}`, 'g');
  return (block.match(lineStart)?.length ?? 0) + (block.match(flow)?.length ?? 0);
}

function parsedKeyReason(data: Record<string, unknown>, key: GuardedKey): boolean {
  if (!Object.hasOwn(data, key)) return false;
  const value = data[key];
  if (key === 'isolation') return value !== LOCAL_ISOLATION;
  if (key === 'mcpServers') return !(Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
  return true;
}

/**
 * Verdict for one agent file. A guarded key is judged twice: on the YAML parse,
 * and on the text, so a parser difference cannot hide one (a key the text shows
 * but the parse did not see at the top level is refused, as is any duplicate).
 */
export function agentFileVerdict(raw: string): AgentFileVerdict {
  if (hasUnsafeFenceLanguage(raw)) return { ok: false, reason: 'unparsable' };
  const text = cliFrontmatterBlock(raw);
  if (text === null) return { ok: true, name: null };
  const counts = GUARDED_KEYS.map((key) => [key, textualKeyCount(text, key)] as const);
  if (counts.some(([, count]) => count > 1)) return { ok: false, reason: 'unparsable' };

  let data: unknown;
  try {
    // Re-fenced so gray-matter parses the CLI's block, not its own idea of one.
    data = matter(`---\n${text}\n---\n`, SAFE_MATTER_OPTIONS).data;
  } catch {
    return { ok: false, reason: 'unparsable' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, reason: 'unparsable' };
  const record = data as Record<string, unknown>;

  for (const key of GUARDED_KEYS) {
    if (parsedKeyReason(record, key)) return { ok: false, reason: key };
  }
  for (const [key, count] of counts) {
    if (count > 0 && !Object.hasOwn(record, key)) return { ok: false, reason: key };
  }
  const name = record['name'];
  return { ok: true, name: typeof name === 'string' ? name : null };
}

export interface AgentRootsInput {
  readonly settingSources: readonly SettingSource[];
  readonly cwd: string;
  readonly homeDir: string;
  readonly env: { readonly CLAUDE_CONFIG_DIR?: string | undefined };
  readonly managedDir: string;
}

/** The main checkout of a linked worktree whose `.git` FILE is at `dotGit`, or null. */
function mainCheckoutOf(dotGit: string): string | null {
  try {
    if (!statSync(dotGit).isFile()) return null;
    const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (match?.[1] === undefined) return null;
    const gitDir = resolve(dirname(dotGit), match[1]);
    const commonDir = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    return dirname(isAbsolute(commonDir) ? commonDir : resolve(gitDir, commonDir));
  } catch {
    return null;
  }
}

/**
 * Every `<dir>/.claude` from cwd up to the git root (inclusive) or $HOME
 * (exclusive), plus a worktree's main checkout: where the CLI looks for
 * project-scoped configuration. Shared with the settings-env scan (#250).
 */
export function projectConfigDirs(cwd: string, homeDir: string): string[] {
  const dirs: string[] = [];
  // resolve() normalises separators and a trailing slash; a case or symlink difference only over-scans.
  const home = resolve(homeDir);
  let dir = resolve(cwd);
  for (;;) {
    if (dir === home) break;
    dirs.push(join(dir, '.claude'));
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) {
      const main = mainCheckoutOf(dotGit);
      if (main !== null && main !== dir) dirs.push(join(main, '.claude'));
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** `<dir>/.claude/agents` for each project configuration directory. */
function projectRoots(cwd: string, homeDir: string): AgentRoot[] {
  return projectConfigDirs(cwd, homeDir).map((dir) => ({ source: 'project' as const, dir: join(dir, 'agents') }));
}

/**
 * Every directory the CLI loads agent files from for these setting sources
 * (0.3.312, read). The managed directory loads whatever the sources say.
 */
export function agentDefinitionRoots(input: AgentRootsInput): AgentRoot[] {
  const roots: AgentRoot[] = [{ source: 'managed', dir: join(input.managedDir, '.claude', 'agents') }];
  if (input.settingSources.includes('user')) {
    const configDir = input.env.CLAUDE_CONFIG_DIR;
    const base = configDir !== undefined && configDir !== '' ? configDir : join(input.homeDir, '.claude');
    roots.push({ source: 'user', dir: join(base, 'agents') });
  }
  if (input.settingSources.includes('project')) roots.push(...projectRoots(input.cwd, input.homeDir));
  return roots;
}

export interface AgentScanLimits {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
}

const reportPath = (rel: string): string =>
  truncateTailWellFormed(stripBidi(sanitizeControlChars(rel === '' ? '(root)' : rel)), MAX_REPORTED_PATH - 1);

/**
 * Walks each root as the CLI does: recursive, `.md` (any case, hidden files
 * too), symlinks followed for files and directories, each directory once.
 * Anything the scan cannot vouch for is refused: an unreadable entry, an
 * unparsable file, or a passed limit. A missing root is skipped.
 */
export function scanAgentDefinitions(roots: readonly AgentRoot[], limits: AgentScanLimits = {}): AgentScanResult {
  const maxFiles = limits.maxFiles ?? AGENT_SCAN_MAX_FILES;
  const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES;
  const admittedNames = new Set<string>();
  const refusals: AgentRefusal[] = [];
  const visited = new Set<string>();
  let filesScanned = 0;
  let stopped = false;

  const scanFile = (root: AgentRoot, full: string, rel: string, stats: Stats): void => {
    filesScanned += 1;
    if (filesScanned > maxFiles) {
      refusals.push({ source: root.source, path: reportPath(rel), reason: 'limit' });
      stopped = true;
      return;
    }
    if (stats.size > maxFileBytes) {
      refusals.push({ source: root.source, path: reportPath(rel), reason: 'limit' });
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(full, 'utf8');
    } catch {
      refusals.push({ source: root.source, path: reportPath(rel), reason: 'unreadable' });
      return;
    }
    const verdict = agentFileVerdict(raw);
    if (!verdict.ok) {
      refusals.push({ source: root.source, path: reportPath(rel), reason: verdict.reason });
      return;
    }
    // Only the frontmatter name: the CLI never names a file agent by its stem (P$t, 2.1.312, read).
    if (verdict.name !== null) admittedNames.add(verdict.name);
  };

  const walk = (root: AgentRoot, dir: string, rel: string, depth: number): void => {
    if (stopped) return;
    if (depth > AGENT_SCAN_MAX_DEPTH) {
      refusals.push({ source: root.source, path: reportPath(rel), reason: 'limit' });
      return;
    }
    let entries: string[];
    try {
      const real = realpathSync(dir);
      // Walked once, across all roots: a second visit would judge the same files with the same admission.
      if (visited.has(real)) return;
      visited.add(real);
      entries = readdirSync(dir).sort();
    } catch {
      refusals.push({ source: root.source, path: reportPath(rel), reason: 'unreadable' });
      return;
    }
    for (const name of entries) {
      if (stopped) return;
      const full = join(dir, name);
      const childRel = rel === '' ? name : join(rel, name);
      const isMarkdown = /\.md$/i.test(name);
      let stats: Stats;
      try {
        stats = statSync(full);
      } catch {
        // A dangling link the CLI would try to read as an agent file is refused, not skipped.
        if (isMarkdown) refusals.push({ source: root.source, path: reportPath(childRel), reason: 'unreadable' });
        continue;
      }
      if (stats.isDirectory()) walk(root, full, childRel, depth + 1);
      else if (stats.isFile() && isMarkdown) scanFile(root, full, childRel, stats);
    }
  };

  for (const root of roots) {
    if (stopped) break;
    let stats: Stats;
    try {
      stats = statSync(root.dir);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') refusals.push({ source: root.source, path: '.', reason: 'unreadable' });
      continue;
    }
    if (stats.isDirectory()) walk(root, root.dir, '', 0);
  }
  return { admittedNames, refusals, filesScanned: Math.min(filesScanned, maxFiles) };
}
