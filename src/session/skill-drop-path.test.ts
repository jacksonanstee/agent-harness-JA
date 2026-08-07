import { describe, expect, it } from 'vitest';
import { relativeSkillDropPath } from './skill-drop-path.js';

// Mutation gates mirror ADR-0030's, name-level (ADR-0031 decision 6):
// fall-through flipped to populate; positive branch flipped to suppress;
// segment check replaced with startsWith('..'); empty-string arm; the
// enforced precondition guard. Each test below is the binding pin for one.
describe('relativeSkillDropPath', () => {
  it('stores the relative form for a path under the root', () => {
    expect(relativeSkillDropPath('/skills', '/skills/helper.md')).toEqual({
      path: 'helper.md',
      pathForm: 'root-relative',
    });
    expect(relativeSkillDropPath('/skills', '/skills/nested/deep.md')).toEqual({
      path: 'nested/deep.md',
      pathForm: 'root-relative',
    });
  });

  it('never stores a home-directory prefix for an under-root drop', () => {
    const result = relativeSkillDropPath(
      '/Users/op/clients/acme/skills',
      '/Users/op/clients/acme/skills/evil.md',
    );
    expect(result).toEqual({ path: 'evil.md', pathForm: 'root-relative' });
    expect(JSON.stringify(result)).not.toContain('/Users/op');
  });

  it('suppresses every walk-up form, sibling included', () => {
    // relative('/skills', '/other/x.md') === '../other/x.md'
    expect(relativeSkillDropPath('/skills', '/other/x.md')).toEqual({
      path: null,
      pathForm: 'suppressed',
    });
    // The parent itself.
    expect(relativeSkillDropPath('/skills/sub', '/skills/x.md')).toEqual({
      path: null,
      pathForm: 'suppressed',
    });
  });

  it('a directory literally named ..foo under the root stays populated (segment check)', () => {
    expect(relativeSkillDropPath('/skills', '/skills/..foo/x.md')).toEqual({
      path: '..foo/x.md',
      pathForm: 'root-relative',
    });
  });

  it('maps the empty relative form to "." for totality', () => {
    expect(relativeSkillDropPath('/skills', '/skills')).toEqual({
      path: '.',
      pathForm: 'root-relative',
    });
  });

  it('ENFORCED precondition: a non-absolute argument suppresses outright', () => {
    // With relative arguments, relative() re-anchors both operands to the
    // ambient process.cwd() — the executed ADR-0030 verify-round counterexample
    // class. The guard must fire before relative() is ever consulted.
    expect(relativeSkillDropPath('.', '../'.repeat(14) + 'x.md')).toEqual({
      path: null,
      pathForm: 'suppressed',
    });
    expect(relativeSkillDropPath('/skills', 'helper.md')).toEqual({
      path: null,
      pathForm: 'suppressed',
    });
    expect(relativeSkillDropPath('skills', '/skills/helper.md')).toEqual({
      path: null,
      pathForm: 'suppressed',
    });
    // The fixture that BINDS the guard: without it, relative('.', './x.md')
    // is 'x.md' — a clean-looking populate from two ambient-anchored
    // operands. The other fixtures above suppress via the fall-through even
    // with the guard deleted, so this one is the mutation gate's pin.
    expect(relativeSkillDropPath('.', './x.md')).toEqual({
      path: null,
      pathForm: 'suppressed',
    });
  });

  it('DOCUMENTED LIMIT: a root STRICTLY above the home directory stores home segments like any other below-root segment', () => {
    // The home-prefix guarantee holds when the skills root sits at or below
    // $HOME, or disjoint from it. An operator who points the harness at
    // '/Users' (or '/') puts the home directory BELOW the root, and
    // below-root segments store in cleartext by design (ADR-0027 decision 4
    // ceiling). Pinned as intended-and-documented, not accidental (review
    // finding).
    expect(relativeSkillDropPath('/Users', '/Users/op/skills/x.md')).toEqual({
      path: 'op/skills/x.md',
      pathForm: 'root-relative',
    });
  });

  it('BOUNDARY: a root EQUAL to the home directory strips the full home prefix (the guarantee holds at equality)', () => {
    // The verify pass refuted the first wording of the documented limit
    // ("at or above" re-admits home segments): at equality the stored value
    // contains no home segment at all. Pinned so the corrected wording has
    // an executed pin at its exact boundary.
    const result = relativeSkillDropPath('/Users/op', '/Users/op/skills/x.md');
    expect(result).toEqual({ path: 'skills/x.md', pathForm: 'root-relative' });
    expect(JSON.stringify(result)).not.toContain('/Users/op');
    expect(JSON.stringify(result)).not.toContain('op/');
  });

  it('a null root (the no-scan case) suppresses', () => {
    expect(relativeSkillDropPath(null, '/skills/helper.md')).toEqual({
      path: null,
      pathForm: 'suppressed',
    });
  });

  it('is HOME-independent: changing HOME never changes the classification', () => {
    const saved = process.env.HOME;
    try {
      process.env.HOME = '/somewhere/else';
      expect(relativeSkillDropPath('/Users/op/skills', '/Users/op/skills/a.md')).toEqual({
        path: 'a.md',
        pathForm: 'root-relative',
      });
    } finally {
      process.env.HOME = saved;
    }
  });
});
