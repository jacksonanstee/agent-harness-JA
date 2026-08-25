import { describe, it, expect } from 'vitest';

// SDK types imported in a test only (ADR-0010 decision 2). This file is a
// compile-time parity pin: if the harness's structural hook views drift from
// the installed SDK's declarations, `npm run typecheck` fails here. The single
// runtime assertion exists so vitest counts the file; the real work is the
// type-level constants, which only compile when the relations below hold.
import type {
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  SdkPostToolUseInput,
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
      _rejectsOldField,
    ]).toBeDefined();
  });
});
