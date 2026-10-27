export {
  canonicalizeCommand,
  canonicalizePathPattern,
  createPermissionEvaluator,
  extractMatchTarget,
  grantFor,
  matchesGlob,
  PermissionDenied,
  permissionHook,
} from './evaluate.js';
export {
  loadSettingsFile,
  mergeLayers,
  parsePermissionSettings,
  PermissionSettingsError,
  type ReadFile,
} from './settings.js';
export type {
  Evaluation,
  EvaluatorOptions,
  GrantPolicy,
  LayeredRule,
  PermissionDecision,
  PermissionEvaluator,
  PermissionRule,
  PermissionSettings,
  Prompter,
  PromptRequest,
  SettingsLayer,
} from './types.js';
