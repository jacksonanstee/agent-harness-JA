/**
 * Which environment variable NAMES reach a bundled-CLI child (issue #251 and
 * the allowlist item of #261; ADR-0040 D-8 as amended 13/11/2026 and
 * 20/11/2026).
 *
 * The bundled CLI reads several hundred variables whose names start with the
 * vendor's prefixes, and one of them turned every harness hook off (see
 * `BARE_MODE_SWITCH` in `child-env.ts`). The harness cannot rule on each
 * name, so it rules on the prefixes: a name that carries one reaches a child
 * only when it is on the keep list. This module is the single source for
 * that rule. `child-env.ts` builds the two child environments from it, and
 * the settings-env scan refuses a settings file whose `env` block names any
 * vendor name at all, kept or not (owner ruling 13/11/2026: the keep list is
 * for the inherited environment only).
 *
 * What the rule does NOT cover: the CLI also reads variables with no vendor
 * prefix (READ: the binary names many). The primary child carries those,
 * because its tools need the operator's environment; the tool-less children
 * get an allowlist and so do not.
 *
 * The stripped set is a PREDICATE on purpose, not a list: a list would have to
 * name every switch, including ones not yet found or not yet public.
 *
 * Names compare without regard to case (upper-cased first). On Windows the
 * environment is case-insensitive, so `claude_code_x` IS the variable the CLI
 * reads; on other platforms the comparison strips, keeps or allows a few more
 * spellings than the CLI would read, which costs nothing. INFERRED from how
 * Node documents `process.env` on Windows; not run on Windows.
 */

/** A process environment as Node and the SDK type it: a name maps to a string, or to undefined when unset. */
export type ChildEnv = Record<string, string | undefined>;

/**
 * Name prefixes of the vendor namespace, upper case. The underscore-led forms are in it because the
 * binary reads names of that shape too (READ; found by the security review of this change).
 */
const VENDOR_PREFIXES: readonly string[] = Object.freeze(['CLAUDE_', 'ANTHROPIC_', '_CLAUDE_', '_ANTHROPIC_']);
/** Whole names in the vendor namespace that carry no prefix, upper case. The CLI sets this one in the shells it starts (READ). */
const VENDOR_EXACT_NAMES: readonly string[] = Object.freeze(['CLAUDECODE']);

/**
 * Every vendor name, upper-cased, contains at least one of these. A text that
 * holds none of them therefore names no vendor variable, which is what lets
 * the settings-env scan pass such a file without parsing it.
 */
export const VENDOR_NAME_NEEDLES: readonly string[] = Object.freeze(['CLAUDE_', 'ANTHROPIC_', 'CLAUDECODE']);

/** True for a name in the vendor namespace: `CLAUDE_*`, `ANTHROPIC_*`, either with one leading underscore, or `CLAUDECODE`, in any letter case. */
export function isVendorName(name: string): boolean {
  const upper = name.toUpperCase();
  return VENDOR_EXACT_NAMES.includes(upper) || VENDOR_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * The vendor names a child may inherit (owner rulings 13/11/2026: credentials,
 * endpoint, provider selection, the config directory and the traffic
 * opt-out, and nothing else; there is no operator setting that adds to it). Every name is READ in the
 * 2.1.312 binary, and the SDK parity test fails when one leaves it. What each
 * does is the vendor's documentation or a binary reading, not a run, except
 * the four the keyless probe sets on every run but the `-notraffic` ones,
 * which leave the fourth out (marked OBSERVED; run
 * `final-control` under `tasks/issue-251-evidence/impl2/out`, not tracked,
 * for the first three, and `after-control-notraffic-1` beside it for the
 * fourth).
 *
 * - Credentials: the API key (OBSERVED: the probe's dummy key reached the
 *   mock), a bearer token, an OAuth token.
 * - Endpoint: the base URL (OBSERVED: the child called the loopback mock) and
 *   custom request headers. The headers are kept because a gateway that
 *   authenticates by header is unreachable without them; the value goes to
 *   the endpoint the operator already chose and is not read as a CLI switch
 *   (INFERRED from the documentation; no reading found another use).
 * - Providers (Bedrock, Vertex, Foundry): the switch that selects each, its
 *   base URL, its skip-auth switch for a gateway that signs requests itself,
 *   and the project, resource and credential names in the vendor namespace.
 *   Their region and cloud credentials live outside the namespace (`AWS_*`,
 *   `CLOUD_ML_REGION`, `GOOGLE_*`, `AZURE_*`) and are not this list's concern.
 * - The config directory (OBSERVED: the child used the directory given).
 * - The traffic opt-out. It only turns traffic off, so carrying it cannot
 *   weaken a control (owner ruling). OBSERVED, 13/11/2026 and again
 *   20/11/2026: without it the CLI made a session-title request that sent the
 *   prompt to the endpoint a second time and listed one more tool; with it,
 *   neither.
 *
 * Not kept, each a cost to an operator who relied on it: model overrides
 * (`ANTHROPIC_MODEL` and the default-model names; the harness passes the model
 * itself), client certificates for mutual TLS, the vendor-namespace proxy
 * names, and the newer provider switches the ruling did not name.
 */
export const KEPT_VENDOR_NAMES: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]);

/** True for a name on the keep list, in any letter case. */
export function isKeptVendorName(name: string): boolean {
  return KEPT_VENDOR_NAMES.includes(name.toUpperCase());
}

/** True for a vendor name that is not on the keep list: the names no child inherits. */
export function isStrippedVendorName(name: string): boolean {
  return isVendorName(name) && !isKeptVendorName(name);
}

/**
 * The inherited environment without the stripped vendor names: what the
 * primary session's child starts from. Everything outside the vendor
 * namespace is carried, because the agent's tools run in this child and need
 * the operator's environment (PATH, toolchain variables, cloud credentials).
 * Pure: a fresh object, the input untouched.
 */
export function withoutStrippedVendorNames(inherited: Readonly<ChildEnv>): ChildEnv {
  return Object.fromEntries(Object.entries(inherited).filter(([name]) => !isStrippedVendorName(name)));
}

/**
 * Names outside the vendor namespace that a TOOL-LESS child (the judge, the
 * eval adversary) may inherit. Such a child runs no tool, so it needs only
 * what lets the CLI start, find its files and reach its endpoint:
 * - the operating system's basics, POSIX and Windows;
 * - locale and time zone;
 * - proxies and certificate authorities;
 * - the cloud credentials Bedrock, Vertex and Foundry read (by prefix below);
 * - the operator's opt-outs from telemetry, error reports and self-update.
 *   READ in the 2.1.312 binary: each is tested only for being set (or
 *   truthy), and being set only turns that traffic off, so passing one cannot
 *   weaken a control, and dropping one would turn back on, in the judge and
 *   the adversary, traffic the operator had turned off. The primary child
 *   already carries them (they are outside the vendor namespace). Not run.
 * Upper case; a name matches in any letter case, so `http_proxy` and `Path`
 * are covered. Which of these the CLI needs to start was not tested name by
 * name: with this list the judge and the adversary started and called the
 * mock (OBSERVED, macOS, 13/11/2026 and again 20/11/2026, runs
 * `final-judge-ctl` and `final-adversary-ctl`); the Windows names are
 * INFERRED.
 */
export const TOOLLESS_ALLOWED_NAMES: readonly string[] = Object.freeze([
  // POSIX basics
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  // Windows basics
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  // Locale
  'LANG', 'LANGUAGE', 'TZ',
  // Network
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Traffic opt-outs (off-only switches)
  'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER', 'DO_NOT_TRACK',
  // Vertex: region, project and credentials outside the vendor namespace
  'CLOUD_ML_REGION', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'GCLOUD_PROJECT', 'CLOUDSDK_CONFIG',
]);

/**
 * Name prefixes a tool-less child may inherit, upper case: the locale
 * categories, the AWS SDK's names (Bedrock), the per-model Vertex regions and
 * the Azure identity names (Foundry).
 */
export const TOOLLESS_ALLOWED_PREFIXES: readonly string[] = Object.freeze(['LC_', 'AWS_', 'VERTEX_REGION_', 'AZURE_']);

/** True for a name a tool-less child may inherit: on the allowlist or the keep list, in any letter case. */
export function isToollessAllowedName(name: string): boolean {
  const upper = name.toUpperCase();
  return TOOLLESS_ALLOWED_NAMES.includes(upper) || TOOLLESS_ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix)) || KEPT_VENDOR_NAMES.includes(upper);
}

/**
 * The inherited environment cut down to the tool-less allowlist. Pure: a
 * fresh object, the input untouched.
 */
export function onlyToollessAllowedNames(inherited: Readonly<ChildEnv>): ChildEnv {
  return Object.fromEntries(Object.entries(inherited).filter(([name]) => isToollessAllowedName(name)));
}
