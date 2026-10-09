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
  createJudgedScanner,
  scan,
  // Issue #96 PR-B1: the judge-wiring values a consumer needs to configure and
  // read the judge; `hasJudgeKey` is composition plumbing and stays off (ADR-0023).
  // Issue #152: `JUDGE_REFUSED_RULE_ID` joins the two session-side ids (spec D15).
  JUDGE_OVERSIZED_RULE_ID,
  JUDGE_REDACTED_RULE_ID,
  JUDGE_REFUSED_RULE_ID,
  JUDGE_WORST_CASE_USD_PER_CALL,
  JudgeSettingsError,
  MAX_JUDGE_CALLS_PER_RUN,
  parseJudgeSettings,
  DEFAULT_INJECTION_RULES,
  JUDGE_ERROR_KINDS,
  JUDGE_MODES,
  JUDGE_RULE_IDS,
  JUDGE_TIMEOUT_MS,
  MAX_JUDGE_INPUT_BYTES,
  STARTER_CORPUS,
  toInjectionJudge,
  // The judge's values a consumer needs to compose, configure or validate it
  // are public: the tuples behind JudgeMode and JudgeErrorKind (a consumer
  // who builds a JudgeCall narrows errorKind against the latter), the rule
  // ids and the caps. verdictRank / stricterVerdict are the eval arm's
  // internal ordering helpers and stay on the security barrel only (ADR-0023;
  // issue #96 pin 13; architecture lens A-4).
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
  JudgeCall,
  JudgeCallResult,
  JudgedScanner,
  JudgedScannerOptions,
  JudgedScanResult,
  JudgeErrorKind,
  JudgeMode,
  JudgeRunState,
  JudgeSettings,
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
  JUDGE_CALL_ERROR_KINDS,
  JUDGE_CALL_STATES,
  JUDGE_CALL_VERDICTS,
  openTelemetryDatabase,
  // Memory's identically-valued DEFAULT_DB_PATH keeps the unprefixed name
  // (shipped via the memory star export above); aliasing is what lets both
  // constants survive in one surface.
  DEFAULT_DB_PATH as TELEMETRY_DEFAULT_DB_PATH,
  TELEMETRY_EVENT_TYPES,
  TOOL_REWRITE_OUTCOMES,
  TOOL_TRACE_PHASES,
  MIGRATIONS,
  runMigrations,
} from './telemetry/index.js';
export type {
  Migration,
  HookEventKind,
  HookEventPayload,
  JudgeCallErrorKind,
  JudgeCallPayload,
  JudgeCallState,
  JudgeCallVerdict,
  RecordResult,
  TelemetryError,
  TelemetryErrorKind,
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryEventType,
  TelemetryFilter,
  TelemetryStore,
  ToolAnnotationVerdict,
  ToolRewriteOutcome,
  ToolRewritePayload,
  ToolRewriteUnobservedReason,
  ToolTracePayload,
  ToolTracePhase,
  TurnCostPayload,
  TurnUsage,
} from './telemetry/index.js';
