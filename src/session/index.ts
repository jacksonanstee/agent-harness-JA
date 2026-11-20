export { createSession, DEFAULT_DESCRIPTOR } from './session.js';
export { agentScanFor } from './agent-gate.js';
export type { AgentScanFn } from './agent-gate.js';
export { settingsEnvScanFor } from './settings-env-gate.js';
export type { SettingsEnvScanFn } from './settings-env-gate.js';
// #251: the hook canary's error and its fixed reason.
export { CHILD_NOT_OWNED_REASON, ChildNotOwned, HOOK_CANARY_REASON, HookCanaryMissed } from './hook-canary.js';
// #251: what a kill reports. The spawn function and the owner in `child-process.ts` are NOT exported: they are the
// session's workings, and the CLI imports the one it needs from that file (`src/public-surface.test.ts` pins this).
export type { ChildKillOutcome } from './child-process.js';
// #187: the default a caller who names no cap runs under (ADR-0041 D2).
export { DEFAULT_MAX_BUDGET_USD } from '../internal/limits.js';
// The judge BUILDER and its fixed model (issue #96, ADR-0036 D2; PR-B1 D1). Its wire internals
// (buildJudgePrompt, JUDGE_SYSTEM_PROMPT, parseJudgeResponse, ParsedJudgeWire)
// stay off every barrel, as the verifier's do (ADR-0023).
export { buildJudge, JUDGE_MODEL } from './judge.js';
// The judge session-state tuple only (pin 31); the fixed constants stay module exports.
export { JUDGE_SESSION_STATES } from './judged-scan.js';
export type {
  CliDeniedToolCall,
  DeniedToolCall,
  DroppedSkill,
  JudgeSessionState,
  JudgeSummary,
  OutputAnnotation,
  OutputRewrite,
  OutputRewriteKind,
  OutputRewriteOutcome,
  QueryFn,
  QueryOptions,
  RefusalSource,
  SdkAssistantMessage,
  SdkHookCallback,
  SdkHookInput,
  SdkHookMatcher,
  SdkHookOutput,
  SdkHookOutputFor,
  SdkPostToolFailureAnnotateOutput,
  SdkPostToolFailureOutput,
  SdkPostToolOutput,
  SdkPostToolRewriteOutput,
  SdkPostToolUseFailureInput,
  SdkPostToolUseInput,
  SdkPreToolAllowOutput,
  SdkPreToolDenyOutput,
  SdkPreToolOutput,
  SdkPreToolUseInput,
  SdkMessage,
  SdkModelRefusalMessage,
  SdkPermissionDenial,
  SdkResultMessage,
  SdkSystemMessage,
  SdkTextBlock,
  SdkModelUsage,
  SdkSpawnedProcess,
  SdkSpawnOptions,
  SdkUsage,
  SdkUserMessage,
  // #251: the prompt-hook seam `QueryOptions.hooks.UserPromptSubmit` is typed with.
  SdkUserPromptSubmitCallback,
  SdkUserPromptSubmitInput,
  SdkUserPromptSubmitMatcher,
  SdkUserPromptSubmitOutput,
  Session,
  SessionConfig,
  SessionDeps,
  SessionJudge,
  SessionRefusal,
  SkillDropChannel,
  SkillDropReason,
  SessionResult,
  SpawnChildFn,
} from './types.js';
