export * from './router/index.js';
export * from './skills/index.js';
export * from './hooks/index.js';
export * from './memory/index.js';
export * from './session/index.js';
export * from './eval/index.js';

// Security and telemetry are re-exported by NAME (eval/index.ts house rule):
// telemetry's DEFAULT_DB_PATH collides with memory's, and under `export *`
// ESM ambiguous-star semantics would silently drop BOTH with no error
// anywhere. Named re-exports make any future collision a compile error and
// keep this file the single audited public surface (V15/V25, ADR-0023).
export {
  createInjectionScanner,
  scan,
  DEFAULT_INJECTION_RULES,
  STARTER_CORPUS,
  createPermissionEvaluator,
  PermissionDenied,
  loadSettingsFile,
  mergeLayers,
  parsePermissionSettings,
  PermissionSettingsError,
  permissionHook,
  createSandbox,
  EXEC_WRAPPER_BINARIES,
  isBlockedFirstToken,
  loadSandboxSettingsFile,
  mergeSandboxLayers,
  parseSandboxSettings,
  sandboxHook,
  SandboxSettingsError,
  SandboxViolation,
  SHELL_RUNNER_BINARIES,
  createSecretRedactor,
  redact,
  DEFAULT_SECRET_RULES,
} from './security/index.js';
export type {
  Confidence,
  InjectionJudge,
  InjectionRule,
  InjectionScanner,
  RedTeamCase,
  RuleFamily,
  ScannerOptions,
  ScanResult,
  Verdict,
  Evaluation,
  EvaluatorOptions,
  LayeredRule,
  PermissionDecision,
  PermissionEvaluator,
  PermissionRule,
  PermissionSettings,
  PreToolLike,
  Prompter,
  PromptRequest,
  SettingsLayer,
  Sandbox,
  SandboxAllowlist,
  SandboxConfig,
  RedactResult,
  RedactorOptions,
  SecretFinding,
  SecretPrecision,
  SecretRedactor,
  SecretRule,
} from './security/index.js';
export {
  createTelemetryStore,
  openTelemetryDatabase,
  // Memory's identically-valued DEFAULT_DB_PATH keeps the unprefixed name
  // (shipped via the memory star export above); aliasing is what lets both
  // constants survive in one surface.
  DEFAULT_DB_PATH as TELEMETRY_DEFAULT_DB_PATH,
  TELEMETRY_EVENT_TYPES,
  MIGRATIONS,
  runMigrations,
} from './telemetry/index.js';
export type {
  Migration,
  HookEventKind,
  HookEventPayload,
  RecordResult,
  TelemetryError,
  TelemetryErrorKind,
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryEventType,
  TelemetryFilter,
  TelemetryStore,
  ToolTracePayload,
  TurnCostPayload,
  TurnUsage,
} from './telemetry/index.js';
