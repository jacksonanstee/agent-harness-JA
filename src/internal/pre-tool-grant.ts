/**
 * The pre-tool grant value (#140, ADR-0040 D3). A pre-tool hook handler may
 * return one to say "a harness permission RULE allowed this call". Both the
 * security layer (which builds it) and the hooks runtime (which detects it)
 * import this leaf, so the literal cannot drift; security never imports hooks.
 * Zero-dependency leaf, kept off every barrel.
 */
export interface PreToolGrant {
  // A literal, not `typeof PRE_TOOL_GRANT_KIND`: the public-surface walk would then
  // demand the internal const be reachable from the root.
  readonly grant: 'rule';
  readonly reason: string;
}

export const PRE_TOOL_GRANT_KIND: PreToolGrant['grant'] = 'rule';

/** Own `grant === 'rule'` and a string `reason`; nothing else counts (fail closed). */
export function isPreToolGrant(value: unknown): value is PreToolGrant {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, 'grant') &&
    (value as { grant: unknown }).grant === PRE_TOOL_GRANT_KIND &&
    typeof (value as { reason: unknown }).reason === 'string'
  );
}
