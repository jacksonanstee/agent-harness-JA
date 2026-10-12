import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_TURNS } from './limits.js';

// The `run` fallback turn count, hoisted out of the eval layer (#128 review
// follow-up). The value is part of the observable CLI default, so it is pinned.
describe('DEFAULT_MAX_TURNS', () => {
  it('is 10', () => {
    expect(DEFAULT_MAX_TURNS).toBe(10);
  });
});
