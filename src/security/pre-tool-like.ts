/**
 * Structural subset of the hooks PreToolPayload, typed here so security never
 * imports hooks (peer-leaf rule). Assignable to HookHandler<'pre-tool'> at the
 * composition root. Shared by the permissions and sandbox hooks: one
 * declaration, so the root barrel exports a single `PreToolLike` (ADR-0023).
 */
export interface PreToolLike {
  readonly tool: string;
  readonly args: unknown;
}
