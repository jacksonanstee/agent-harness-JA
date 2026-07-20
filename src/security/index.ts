export {
  createInjectionScanner,
  scan,
  DEFAULT_INJECTION_RULES,
  STARTER_CORPUS,
} from './injection/index.js';
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
} from './injection/index.js';
export {
  createPermissionEvaluator,
  PermissionDenied,
  loadSettingsFile,
  mergeLayers,
  parsePermissionSettings,
  PermissionSettingsError,
  permissionHook,
} from './permissions/index.js';
export type {
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
} from './permissions/index.js';
export {
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
} from './sandbox/index.js';
export type { Sandbox, SandboxAllowlist, SandboxConfig } from './sandbox/index.js';
export {
  createSecretRedactor,
  redact,
  DEFAULT_SECRET_RULES,
} from './secrets/index.js';
// SECRET_CORPUS / SecretCase omitted: test-only fixture, not published (ADR-0022).
export type {
  RedactResult,
  RedactorOptions,
  SecretFinding,
  SecretPrecision,
  SecretRedactor,
  SecretRule,
} from './secrets/index.js';
