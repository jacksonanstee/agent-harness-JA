import { describe, expect, it } from 'vitest';

import {
  hasHomeShapedPath,
  hasHomeShapedStrings,
  MAX_SCRUB_DEPTH,
  parseScrubPrefix,
  scrubEvent,
  scrubText,
  SCRUB_TRANSFORM_ID,
} from './scrub.js';
import type { TelemetryEvent } from './types.js';

// The two panel-executed counterexamples from the design round are the anchor
// fixtures of this file (ADR-0031 decision 7): a shorter prefix firing inside a
// longer segment name, and a trailing-separator argument missing the bare form.

describe('scrubText — segment-boundary matching', () => {
  it('does NOT fire inside a longer segment name (/home/al vs /home/alice)', () => {
    const result = scrubText('/home/alice/project/file.md', ['/home/al']);
    expect(result.value).toBe('/home/alice/project/file.md');
    expect(result.count).toBe(0);
  });

  it('fires when the prefix is followed by a separator', () => {
    const result = scrubText('/home/al/project/file.md', ['/home/al']);
    expect(result.value).toBe('[scrubbed-prefix-1]/project/file.md');
    expect(result.count).toBe(1);
  });

  it('fires at end-of-string (the bare form)', () => {
    const result = scrubText('cwd is /Users/jackson', ['/Users/jackson']);
    expect(result.value).toBe('cwd is [scrubbed-prefix-1]');
    expect(result.count).toBe(1);
  });

  it('does not fire on punctuation-named sibling directories (review-executed corruption class)', () => {
    // Filename-legal punctuation CONTINUES a segment: firing here corrupted
    // `/Users/jackson (Work Laptop)` to `[marker] (Work Laptop)` with
    // applied=true in the first cut \u2014 the alice-class mis-attribution, found
    // by review with executed counterexamples. Boundary is separator/EOS ONLY.
    const siblings = [
      '/Users/jackson (Work Laptop)/notes.md',
      "/Users/jackson's Documents/x",
      '/Users/jackson,backup/x',
      '/Users/jackson#2/x',
    ];
    for (const text of siblings) {
      const result = scrubText(text, ['/Users/jackson']);
      expect(result.value, text).toBe(text);
      expect(result.count, text).toBe(0);
    }
  });

  it('leaves prose-terminated occurrences in cleartext (named residual, pinned as documented)', () => {
    // The cost of the literal-spec boundary: a path quoted mid-prose and
    // terminated by punctuation or whitespace survives. This pin documents
    // the residual; the post-scrub survivor nudge is what surfaces it.
    const result = scrubText('cd /Users/jackson && ls', ['/Users/jackson']);
    expect(result.value).toBe('cd /Users/jackson && ls');
    expect(result.count).toBe(0);
  });

  it('does not fire when the next character continues the segment (dash, dot, unicode, NFD, astral)', () => {
    expect(scrubText('/Users/jackson-old/x', ['/Users/jackson']).count).toBe(0);
    expect(scrubText('/Users/jackson.bak/x', ['/Users/jackson']).count).toBe(0);
    expect(scrubText('/Users/jackson\u00F1/x', ['/Users/jackson']).count).toBe(0);
    // NFD: combining tilde after the final n \u2014 a DIFFERENT rendered directory
    // name; firing would strand the combining mark on the marker's bracket.
    expect(scrubText('/Users/jackson\u0303/x', ['/Users/jackson']).count).toBe(0);
    // Astral (surrogate pair) continuation: must neither fire nor split the pair.
    const astral = scrubText('/Users/jackson\u{1D4AA}/x', ['/Users/jackson']);
    expect(astral.count).toBe(0);
    expect(astral.value).toBe('/Users/jackson\u{1D4AA}/x');
  });

  it('falls through to a shorter prefix when the longest matches textually but fails its boundary', () => {
    // Review-built mutant: breaking out of the ranked loop on first textual
    // match (ignoring the boundary result) passed every then-existing test.
    // This pin binds the fall-through: `/Users/jackson` matches textually at
    // position 0 but `x` is not a boundary; `/Users` must still fire.
    const result = scrubText('/Users/jacksonx/y', ['/Users/jackson', '/Users']);
    expect(result.value).toBe('[scrubbed-prefix-2]/jacksonx/y');
    expect(result.count).toBe(1);
  });

  it('counts every replacement in the text', () => {
    const result = scrubText('/home/al/a and /home/al/b', ['/home/al']);
    expect(result.value).toBe('[scrubbed-prefix-1]/a and [scrubbed-prefix-1]/b');
    expect(result.count).toBe(2);
  });

  it('fires on an embedded occurrence (file:// URL shape)', () => {
    const result = scrubText('file:///Users/jackson/notes.md', ['/Users/jackson']);
    expect(result.value).toBe('file://[scrubbed-prefix-1]/notes.md');
    expect(result.count).toBe(1);
  });

  it('numbers markers by 1-based argument ordinal, not match order', () => {
    const result = scrubText('/data/x then /home/al/y', ['/home/al', '/data']);
    // '/data' is invalid standalone (1 segment) but scrubText trusts its input:
    // validation lives in parseScrubPrefix. Ordinals follow the array.
    expect(result.value).toBe('[scrubbed-prefix-2]/x then [scrubbed-prefix-1]/y');
    expect(result.count).toBe(2);
  });

  it('prefers the longest matching prefix at a position, keeping its own ordinal', () => {
    const result = scrubText('/Users/jackson/Documents/report.md', [
      '/Users/jackson',
      '/Users/jackson/Documents',
    ]);
    expect(result.value).toBe('[scrubbed-prefix-2]/report.md');
    expect(result.count).toBe(1);
  });

  it('does not rescan replaced output (marker text is inert)', () => {
    // A crafted prefix list where naive re-scanning of the marker could loop or
    // double-count: the output of one replacement must never feed another.
    const result = scrubText('/home/al', ['/home/al']);
    expect(result.value).toBe('[scrubbed-prefix-1]');
    expect(result.count).toBe(1);
  });

  it('leaves a pre-existing (forged) marker alone and does not count it', () => {
    const forged = 'tool said [scrubbed-prefix-1] and the real /home/al/file';
    const result = scrubText(forged, ['/home/al']);
    expect(result.value).toBe('tool said [scrubbed-prefix-1] and the real [scrubbed-prefix-1]/file');
    expect(result.count).toBe(1);
    // The consumer-side counterfeit check this enables is AGGREGATE: total
    // occurrences of ANY ordinal's marker (2) exceed count (1), so one was
    // not produced by the transform.
    const occurrences = result.value.match(/\[scrubbed-prefix-\d+\]/gu)?.length ?? 0;
    expect(occurrences).toBe(2);
    expect(occurrences).toBeGreaterThan(result.count);
  });

  it('the counterfeit check must be aggregate across ordinals, not per marker (review-executed)', () => {
    // A marker planted for ordinal 2 next to a genuine ordinal-1 replacement:
    // per-marker comparison reads 1 vs aggregate count 1 for each ordinal and
    // flags nothing; only total-occurrences (2) > count (1) exposes the plant.
    const text = 'tool output: [scrubbed-prefix-2] then /Users/jackson/x';
    const result = scrubText(text, ['/Users/jackson', '/srv/app']);
    expect(result.value).toBe('tool output: [scrubbed-prefix-2] then [scrubbed-prefix-1]/x');
    expect(result.count).toBe(1);
    const occurrences = result.value.match(/\[scrubbed-prefix-\d+\]/gu)?.length ?? 0;
    expect(occurrences).toBe(2);
    expect(occurrences).toBeGreaterThan(result.count);
  });

  it('returns count 0 and the identical string for a prefix that matches nothing', () => {
    const result = scrubText('/srv/data/file.txt', ['/home/al']);
    expect(result.value).toBe('/srv/data/file.txt');
    expect(result.count).toBe(0);
  });
});

describe('parseScrubPrefix — validation', () => {
  it('accepts an absolute path with two or more segments', () => {
    expect(parseScrubPrefix('/Users/jackson')).toEqual({ ok: true, value: '/Users/jackson' });
    expect(parseScrubPrefix('/home/al/projects')).toEqual({
      ok: true,
      value: '/home/al/projects',
    });
  });

  it('strips trailing separators so the bare form still matches', () => {
    // The second panel-executed counterexample: a trailing-separator argument
    // must not miss the bare occurrence.
    expect(parseScrubPrefix('/Users/jackson/')).toEqual({ ok: true, value: '/Users/jackson' });
    expect(parseScrubPrefix('/Users/jackson///')).toEqual({ ok: true, value: '/Users/jackson' });
  });

  it('rejects relative paths', () => {
    expect(parseScrubPrefix('Users/jackson').ok).toBe(false);
    expect(parseScrubPrefix('./x/y').ok).toBe(false);
    expect(parseScrubPrefix('').ok).toBe(false);
  });

  it('rejects fewer than two segments (too broad to be a home prefix)', () => {
    expect(parseScrubPrefix('/').ok).toBe(false);
    expect(parseScrubPrefix('/Users').ok).toBe(false);
    expect(parseScrubPrefix('/Users/').ok).toBe(false);
  });

  it('normalises dot segments and doubled separators before matching (review-executed miss)', () => {
    // An accepted-verbatim `/Users/./jackson` matched nothing while
    // suppressing the nudge — the operator's likeliest typo was the exact
    // case with no signal. Normalise first, then validate.
    expect(parseScrubPrefix('/Users/./jackson')).toEqual({ ok: true, value: '/Users/jackson' });
    expect(parseScrubPrefix('/Users/jackson/../jackson')).toEqual({
      ok: true,
      value: '/Users/jackson',
    });
    expect(parseScrubPrefix('/Users//jackson')).toEqual({ ok: true, value: '/Users/jackson' });
    expect(parseScrubPrefix('/Users/jackson/..').ok).toBe(false);
  });
});

describe('scrubEvent — whole-row transform with per-row signal', () => {
  const baseEvent: TelemetryEvent = {
    id: '00000000-0000-4000-8000-000000000001',
    sessionId: 's1',
    turnId: 't1',
    ts: 100,
    type: 'hook-event',
    payload: {
      kind: 'denied-by-hook',
      event: 'pre-tool',
      tool: 'Write',
      reason: 'permission: deny Write [rule 0, project] for /Users/jackson/notes.md',
      handlerIndex: 0,
    },
  };

  it('scrubs nested payload strings and reports the row count', () => {
    const row = scrubEvent(baseEvent, ['/Users/jackson']);
    expect(row.payload).toEqual({
      kind: 'denied-by-hook',
      event: 'pre-tool',
      tool: 'Write',
      reason: 'permission: deny Write [rule 0, project] for [scrubbed-prefix-1]/notes.md',
      handlerIndex: 0,
    });
    expect(row.scrub).toEqual({ applied: true, count: 1, transform: 'prefix-v1' });
  });

  it('attaches the signal even when nothing matched (visible, not corrective)', () => {
    const row = scrubEvent(baseEvent, ['/home/al']);
    expect(row.payload).toEqual(baseEvent.payload);
    expect(row.scrub).toEqual({ applied: false, count: 0, transform: 'prefix-v1' });
  });

  it('scrubs top-level string fields too (shared-DB rows may carry paths in ids)', () => {
    const foreign = {
      ...baseEvent,
      sessionId: 'run-/Users/jackson',
      payload: { kind: 'hook-fired', event: 'stop', handlersFired: 0 },
    } as TelemetryEvent;
    const row = scrubEvent(foreign, ['/Users/jackson']);
    expect(row.sessionId).toBe('run-[scrubbed-prefix-1]');
    expect(row.scrub.count).toBe(1);
  });

  it('never mutates the input event', () => {
    const snapshot = JSON.parse(JSON.stringify(baseEvent)) as TelemetryEvent;
    scrubEvent(baseEvent, ['/Users/jackson']);
    expect(baseEvent).toEqual(snapshot);
  });

  it('appends scrub as the last key so unscrubbed row bytes are a prefix-shape of the scrubbed row', () => {
    const row = scrubEvent(baseEvent, ['/home/al']);
    const keys = Object.keys(row);
    expect(keys[keys.length - 1]).toBe('scrub');
  });

  it('sums counts across all string sites in the row', () => {
    const busy: TelemetryEvent = {
      ...baseEvent,
      payload: {
        kind: 'hook-error',
        event: 'post-tool',
        reason: '/Users/jackson/a failed reading /Users/jackson/b',
        handlerIndex: 1,
      },
    };
    const row = scrubEvent(busy, ['/Users/jackson']);
    expect(row.scrub).toEqual({ applied: true, count: 2, transform: 'prefix-v1' });
  });

  it('exposes the transform id as a constant', () => {
    expect(SCRUB_TRANSFORM_ID).toBe('prefix-v1');
  });

  it('scrubs payload KEYS too (review-executed: extra keys pass the store validators)', () => {
    // The validators are positive-conjunct checks with no extra-key
    // rejection, so a shared-DB row can carry a home path AS a key. Review
    // executed exactly this shape against the first cut: the key stayed
    // cleartext on a row stamped applied=true.
    const foreign = {
      ...baseEvent,
      payload: {
        kind: 'denied-by-hook',
        event: 'pre-tool',
        tool: 'Read',
        reason: 'denied /Users/jackson/notes.md',
        handlerIndex: 0,
        '/Users/jackson/.ssh/id_ed25519': 'seen',
      },
    } as TelemetryEvent;
    const row = scrubEvent(foreign, ['/Users/jackson']);
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain('/Users/jackson');
    expect(row.scrub).toEqual({ applied: true, count: 2, transform: 'prefix-v1' });
    expect(Object.keys(row.payload)).toContain('[scrubbed-prefix-1]/.ssh/id_ed25519');
  });

  it('scrubs keys in nested objects as well', () => {
    const foreign = {
      ...baseEvent,
      payload: {
        kind: 'hook-fired',
        event: 'stop',
        handlersFired: 0,
        extra: { '/Users/jackson/inner': { '/Users/jackson/deeper': 'v' } },
      },
    } as TelemetryEvent;
    const row = scrubEvent(foreign, ['/Users/jackson']);
    expect(JSON.stringify(row)).not.toContain('/Users/jackson');
    expect(row.scrub.count).toBe(2);
  });

  it('refuses the row loudly when two keys collapse onto one scrubbed form', () => {
    // A planted marker key colliding with a genuine key's scrubbed form:
    // last-one-wins would silently drop data from the artefact.
    const foreign = {
      ...baseEvent,
      payload: {
        kind: 'hook-fired',
        event: 'stop',
        handlersFired: 0,
        '/Users/jackson/x': 1,
        '[scrubbed-prefix-1]/x': 2,
      },
    } as TelemetryEvent;
    expect(() => scrubEvent(foreign, ['/Users/jackson'])).toThrow(/collapse/u);
  });

  it('refuses nesting beyond MAX_SCRUB_DEPTH with a loud error, not a stack overflow', () => {
    const nest = (levels: number): unknown => {
      let value: unknown = '/Users/jackson/leaf';
      for (let i = 0; i < levels; i += 1) value = [value];
      return value;
    };
    const withNest = (levels: number): TelemetryEvent =>
      ({
        ...baseEvent,
        payload: {
          kind: 'hook-fired',
          event: 'stop',
          handlersFired: 0,
          x: nest(levels),
        },
      }) as TelemetryEvent;
    // Boundary pinned by execution at this walk's depth accounting (event=0,
    // payload value=1, its entries' values=2, array k at depth k+1, leaf at
    // k+2; refusal when a call enters above 64): 62 levels is the deepest
    // that scrubs, 63 refuses. Moves if the accounting changes — that is
    // what the pin is for.
    const deepest = scrubEvent(withNest(62), ['/Users/jackson']);
    expect(deepest.scrub.count).toBe(1);
    expect(() => scrubEvent(withNest(63), ['/Users/jackson'])).toThrow(/depth cap/u);
    expect(() => scrubEvent(withNest(5000), ['/Users/jackson'])).toThrow(/depth cap/u);
    expect(MAX_SCRUB_DEPTH).toBe(64);
  });
});

describe('hasHomeShapedStrings — raw-value nudge detection', () => {
  const event = (payload: Record<string, unknown>): TelemetryEvent =>
    ({
      id: '00000000-0000-4000-8000-000000000002',
      sessionId: 's1',
      turnId: 't1',
      ts: 1,
      type: 'hook-event',
      payload: { kind: 'hook-fired', event: 'stop', handlersFired: 0, ...payload },
    }) as TelemetryEvent;

  it('detects Windows-shaped paths in RAW values (dead at the serialised seam, review-executed)', () => {
    // JSON.stringify doubles every backslash, so testing the serialised body
    // can never match the single-backslash \Users\ arm. The detector walks
    // raw values precisely so this row nudges.
    expect(hasHomeShapedStrings(event({ reason: 'denied writing C:\\Users\\alice\\notes.md' }))).toBe(
      true,
    );
  });

  it('detects home-shaped paths carried in KEYS and non-ASCII usernames', () => {
    expect(hasHomeShapedStrings(event({ '/Users/jackson/.ssh': 'seen' }))).toBe(true);
    expect(hasHomeShapedStrings(event({ reason: 'saw /Users/中村/notes.md' }))).toBe(true);
  });

  it('stays false for non-home paths and survives hostile nesting without recursion', () => {
    expect(hasHomeShapedStrings(event({ reason: 'saw /srv/data/file.txt' }))).toBe(false);
    let deep: unknown = 'clean leaf';
    for (let i = 0; i < 5000; i += 1) deep = [deep];
    expect(hasHomeShapedStrings(event({ x: deep }))).toBe(false);
  });
});

describe('hasHomeShapedPath — unscrubbed-export nudge trigger', () => {
  it('matches the common home-directory shapes', () => {
    expect(hasHomeShapedPath('saw /Users/jackson/notes.md')).toBe(true);
    expect(hasHomeShapedPath('saw /home/alice/notes.md')).toBe(true);
    expect(hasHomeShapedPath('saw C:\\Users\\alice\\notes.md')).toBe(true);
  });

  it('does not match non-home absolute paths or bare mentions', () => {
    expect(hasHomeShapedPath('saw /srv/data/file.txt')).toBe(false);
    expect(hasHomeShapedPath('the /Users/ directory listing')).toBe(false);
    expect(hasHomeShapedPath('no paths here')).toBe(false);
  });
});
