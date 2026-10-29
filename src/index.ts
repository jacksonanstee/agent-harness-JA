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
  // #152 review A2: the one definition of "answered" (a verdict or a refusal),
  // public beside JUDGE_ERROR_KINDS so a consumer reading JudgeCallResult
  // never spells it by hand.
  isAnsweredResult,
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
  SHELL_BUILTIN_COMMANDS,
  SHELL_RUNNER_BINARIES,
  createSecretRedactor,
  redact,
  DEFAULT_SECRET_RULES,
  parseSdkSettings,
  SdkSettingsError,
  SETTING_SOURCES,
  parseBudgetSettings,
  BudgetSettingsError,
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
  GrantPolicy,
  LayeredRule,
  PermissionDecision,
  PermissionEvaluator,
  PermissionRule,
  PermissionSettings,
  PreToolLike,
  Prompter,
  PromptRequest,
  ReadFile,
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
  SettingSource,
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
  TOOL_REWRITE_KINDS,
  TOOL_REWRITE_OUTCOMES,
  TOOL_TRACE_PHASES,
  MIGRATIONS,
  runMigrations,
} from './telemetry/index.js';
export type {
  Migration,
  OpenTelemetryDatabaseOptions,
  HookEventKind,
  HookEventPayload,
  JudgeCallErrorKind,
  JudgeCallPayload,
  JudgeCallState,
  JudgeCallVerdict,
  RecordResult,
  SkillDropPathPair,
  SkillDropPayload,
  SkillDropPayloadFields,
  // Telemetry's structural mirror of session's SkillDropReason (the bare name
  // is session's, via its star export); aliased as for DEFAULT_DB_PATH above.
  SkillDropReason as TelemetrySkillDropReason,
  TelemetryError,
  TelemetryErrorKind,
  TelemetryEvent,
  TelemetryEventBase,
  TelemetryEventInput,
  TelemetryInputBase,
  TelemetryEventType,
  TelemetryFilter,
  TelemetryStore,
  ToolAnnotationVerdict,
  ToolRewriteKind,
  ToolRewriteOutcome,
  ToolRewritePayload,
  ToolRewriteUnobservedReason,
  ToolTracePayload,
  ToolTracePhase,
  TurnCostPayload,
  TurnUsage,
} from './telemetry/index.js';
