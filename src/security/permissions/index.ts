export {
  canonicalizePathPattern,
  createPermissionEvaluator,
  extractMatchTarget,
  matchesGlob,
  PermissionDenied,
  permissionHook,
  type PreToolLike,
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
  LayeredRule,
  PermissionDecision,
  PermissionEvaluator,
  PermissionRule,
  PermissionSettings,
  Prompter,
  PromptRequest,
  SettingsLayer,
} from './types.js';
