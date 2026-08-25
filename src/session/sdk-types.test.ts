import { describe, it, expect } from 'vitest';

// SDK types imported in a test only (ADR-0010 decision 2). This file is a
// compile-time parity pin: if the harness's structural hook views drift from
// the installed SDK's declarations, `npm run typecheck` fails here. The single
// runtime assertion exists so vitest counts the file; the real work is the
// type-level constants, which only compile when the relations below hold.
import type {
  HookCallbackMatcher,
  HookJSONOutput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  PreToolUseHookSpecificOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  SdkHookMatcher,
  SdkPostToolUseInput,
  SdkPreToolDenyOutput,
  SdkPreToolUseInput,
} from './types.js';

// True only if A is assignable to B.
type Assignable<A, B> = [A] extends [B] ? true : false;
// True only if the view declares no key the SDK type does not.
type NoExtraKeys<View, Sdk> = [Exclude<keyof View, keyof Sdk>] extends [never] ? true : false;

// The real SDK event is assignable to the harness view (the fields the harness
// reads are all present, with compatible types).
const _preAssignable: Assignable<PreToolUseHookInput, SdkPreToolUseInput> = true;
const _postAssignable: Assignable<PostToolUseHookInput, SdkPostToolUseInput> = true;
// The view invents no field the SDK does not send (this is what a `tool_output`
// field would violate, and did).
const _preNoExtra: NoExtraKeys<SdkPreToolUseInput, PreToolUseHookInput> = true;
const _postNoExtra: NoExtraKeys<SdkPostToolUseInput, PostToolUseHookInput> = true;

// Output side: the deny bridge is the harness's one enforced model-facing
// control, so its shape must be ACCEPTABLE to the SDK (our output assignable to
// the SDK's), and the matcher must invent no key the SDK's matcher lacks. Note
// the direction: for inputs the SDK value flows to us (SDK -> view); for outputs
// our value flows to the SDK (view -> SDK).
const _denyOutputAccepted: Assignable<SdkPreToolDenyOutput, HookJSONOutput> = true;
const _matcherNoExtra: NoExtraKeys<SdkHookMatcher, HookCallbackMatcher> = true;
// Assignability alone does NOT catch a renamed deny key: the SDK declares
// `permissionDecision?`/`permissionDecisionReason?` optional, so a payload that
// renames one stays assignable to `HookJSONOutput` (the rename is caught only
// by the enforced producers, not by this contract pin). Pin the nested payload
// with NoExtraKeys so a renamed or invented key on our deny output reddens HERE
// too, at the contract boundary rather than only at the call site.
const _denyPayloadNoExtra: NoExtraKeys<
  SdkPreToolDenyOutput['hookSpecificOutput'],
  PreToolUseHookSpecificOutput
> = true;

// A literal using the old `tool_output` name no longer type-checks.
const _rejectsOldField: SdkPostToolUseInput = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: {},
  tool_response: { stdout: '' },
  // @ts-expect-error tool_output is not a field the SDK declares on PostToolUse
  tool_output: 'gone',
};

describe('SDK hook-input type parity', () => {
  it('holds at compile time (this file fails typecheck if the views drift)', () => {
    expect([
      _preAssignable,
      _postAssignable,
      _preNoExtra,
      _postNoExtra,
      _denyOutputAccepted,
      _matcherNoExtra,
      _denyPayloadNoExtra,
      _rejectsOldField,
    ]).toBeDefined();
  });
});
