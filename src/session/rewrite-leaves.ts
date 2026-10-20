// The model-facing rewrite walk and the fail-closed shape keeper (issue #84
// D1, issue #203). Hoisted from session.ts so the keeper's SDK-derived literal
// table has one home that a parity test can read (precedent: sdk-refusal.ts,
// judged-scan-constants.ts). Not re-exported from the package or the session
// index: internal to the session.

/**
 * Aggregate bounds on the model-facing rewrite walk (issue #84, D1, G-7).
 * `JSON.parse` accepts nesting and breadth a recursive walk cannot survive, so
 * a tool author could crash the callback and lose the rewrite. Beyond either
 * bound the walk is SKIPPED (output left raw, warning + telemetry row), never a
 * throw and never a wrong-shaped return. Re-derived by test, not hand-copied.
 */
export const MAX_REWRITE_NODES = 100_000;
export const MAX_REWRITE_DEPTH = 200;

/** Non-error early-exit for the bounded, iterative rewrite walk. */
class RewriteSkip extends Error {}

/**
 * Shape-preserving, ITERATIVE walk over the JSON value the SDK delivered (issue
 * #84, D1). String leaves go through `fn`; arrays and plain objects are rebuilt
 * with their element/key ORDER intact (keys are never rewritten — a key is
 * schema, and a changed key is a changed shape the SDK silently drops); numbers,
 * booleans and null pass through. A non-JSON value (a function, a class instance),
 * a repeated object reference (a cycle OR a non-cyclic shared node, both caught by
 * the visited set: unreachable from the SDK's JSON, which is a tree, and fail-safe
 * either way), or a value exceeding `MAX_REWRITE_NODES`/`MAX_REWRITE_DEPTH` returns
 * `{ skipped: true }` with the INPUT unchanged, never a wrong-shaped rewrite.
 * Explicit stack, no recursion (G-7). Returns a NEW value (immutability).
 */
export function rewriteStringLeaves(
  input: unknown,
  fn: (leaf: string, key: string | null) => string,
): { value: unknown; skipped: boolean } {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const root: { out: unknown } = { out: undefined };
  interface Frame {
    value: unknown;
    depth: number;
    key: string | null;
    assign: (result: unknown) => void;
  }
  const stack: Frame[] = [{ value: input, depth: 0, key: null, assign: (r) => { root.out = r; } }];
  try {
    while (stack.length > 0) {
      const frame = stack.pop() as Frame;
      nodes += 1;
      if (nodes > MAX_REWRITE_NODES || frame.depth > MAX_REWRITE_DEPTH) throw new RewriteSkip();
      const v = frame.value;
      if (typeof v === 'string') {
        frame.assign(fn(v, frame.key));
        continue;
      }
      if (v === null || typeof v === 'number' || typeof v === 'boolean') {
        frame.assign(v);
        continue;
      }
      if (Array.isArray(v)) {
        if (seen.has(v)) throw new RewriteSkip();
        seen.add(v);
        const arr: unknown[] = new Array(v.length);
        frame.assign(arr);
        for (let i = 0; i < v.length; i += 1) {
          const idx = i;
          stack.push({ value: v[i], depth: frame.depth + 1, key: null, assign: (r) => { arr[idx] = r; } });
        }
        continue;
      }
      if (typeof v === 'object') {
        const proto = Object.getPrototypeOf(v) as unknown;
        if (proto !== Object.prototype && proto !== null) throw new RewriteSkip();
        if (seen.has(v)) throw new RewriteSkip();
        seen.add(v);
        const source = v as Record<string, unknown>;
        const obj: Record<string, unknown> = {};
        // Establish every key up front so key ORDER survives regardless of the
        // stack's LIFO resolution order.
        for (const key of Object.keys(source)) obj[key] = undefined;
        frame.assign(obj);
        for (const key of Object.keys(source)) {
          const k = key;
          stack.push({ value: source[key], depth: frame.depth + 1, key: k, assign: (r) => { obj[k] = r; } });
        }
        continue;
      }
      // function, symbol, bigint, undefined: not JSON.
      throw new RewriteSkip();
    }
  } catch (error: unknown) {
    if (error instanceof RewriteSkip) return { value: input, skipped: true };
    throw error;
  }
  return { value: root.out, skipped: false };
}

/**
 * String-literal vocabulary the CLI's built-in tool OUTPUT schemas constrain,
 * keyed by the object key that carries it (union across tools). Derived from
 * the `*Output` declarations of `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`
 * at SDK 0.3.201; `rewrite-leaves.sdk-parity.test.ts` re-derives it and fails
 * on drift. To regenerate after an SDK bump: run that test, read the diff it
 * prints, update this table (sorted keys, sorted values) and review each new
 * literal against the tool that declares it.
 */
export const SDK_OUTPUT_LITERALS: Readonly<Record<string, readonly string[]>> = {
  action: [
    'auto-merge-disabled',
    'auto-merge-enabled',
    'closed',
    'commented',
    'created',
    'draft',
    'edited',
    'keep',
    'merged',
    'ready',
    'rebased',
    'remove',
  ],
  cell_type: ['code', 'markdown'],
  disabledReason: ['config_off', 'no_transport', 'user_present'],
  kind: ['amended', 'cherry-picked', 'committed'],
  level: ['high', 'low', 'max', 'medium', 'xhigh'],
  method: ['project_delete', 'project_info', 'project_read', 'project_search', 'project_write'],
  mode: ['content', 'count', 'files_with_matches'],
  outcome: ['fixed', 'no_change_needed', 'skipped'],
  service_tier: ['batch', 'priority', 'standard'],
  source: ['seeded'],
  status: ['added', 'async_launched', 'completed', 'in_progress', 'modified', 'pending', 'remote_launched'],
  taskType: ['local_workflow', 'remote_agent'],
  type: [
    'create',
    'file_unchanged',
    'image',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'notebook',
    'parts',
    'pdf',
    'text',
    'update',
  ],
  verdict: ['CONFIRMED', 'PLAUSIBLE'],
};

/** MCP tools are named `mcp__<server>__<tool>`; the CLI never schema-checks their output. */
const MCP_TOOL_PREFIX = 'mcp__';

/**
 * True when a leaf is a structural value the CLI's output-schema check needs
 * intact, so a fail-closed rewrite must leave it unchanged. The CLI (2.1.201)
 * safeParses a built-in tool's rewritten output against the tool's schema and
 * silently reverts to the ORIGINAL output on mismatch (issue #203), which would
 * deliver the raw secret. All three must hold: the tool is not an MCP tool (no
 * check there, so keeping is pure loss); the leaf's object key is one the SDK
 * declares as a string-literal field; the value is EXACTLY a literal declared
 * for that key. An attacker can therefore only pass a word from the CLI's own
 * vocabulary. `key` is null for the root and for array elements.
 */
export function isShapeLeaf(toolName: string, key: string | null, leaf: string): boolean {
  if (key === null || toolName.startsWith(MCP_TOOL_PREFIX)) return false;
  if (!Object.prototype.hasOwnProperty.call(SDK_OUTPUT_LITERALS, key)) return false;
  return (SDK_OUTPUT_LITERALS[key] ?? []).includes(leaf);
}

/**
 * The `type` values of an MCP tool result's content blocks. The CLI's generic
 * MCP mapper renders a block as text only when `type === 'text'` (an image
 * needs `'image'`, and so on); a block whose `type` became a placeholder falls
 * through to a JSON-stringified block, so the rendered copy would carry the
 * placeholder inside a JSON envelope the in-band verifier does not read as a
 * landing (issue #145 review3 H2; CLI 2.1.201, bundled binary, the `SBm`
 * content mapper). Used by the withhold walk ONLY: the redaction keeper does
 * not need it (a failed-closed blackout is not read back as text).
 */
export const MCP_CONTENT_BLOCK_TYPES: readonly string[] = ['text', 'image', 'audio', 'resource', 'resource_link'];

/** True for an MCP tool's `type` leaf holding exactly one of `MCP_CONTENT_BLOCK_TYPES` (CLI vocabulary, not content). */
export function isMcpBlockTypeLeaf(toolName: string, key: string | null, leaf: string): boolean {
  return key === 'type' && toolName.startsWith(MCP_TOOL_PREFIX) && MCP_CONTENT_BLOCK_TYPES.includes(leaf);
}
