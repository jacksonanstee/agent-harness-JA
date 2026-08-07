import { describe, expect, it } from 'vitest';

import {
  hasHomeShapedPath,
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

  it('fires before a non-path-continuation character (quote, space, semicolon)', () => {
    const result = scrubText('path="/Users/jackson"; cd /Users/jackson && ls', ['/Users/jackson']);
    expect(result.value).toBe('path="[scrubbed-prefix-1]"; cd [scrubbed-prefix-1] && ls');
    expect(result.count).toBe(2);
  });

  it('does not fire when the next character continues the segment (dash, dot, unicode letter)', () => {
    expect(scrubText('/Users/jackson-old/x', ['/Users/jackson']).count).toBe(0);
    expect(scrubText('/Users/jackson.bak/x', ['/Users/jackson']).count).toBe(0);
    expect(scrubText('/Users/jackson\u00F1/x', ['/Users/jackson']).count).toBe(0);
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
    // The consumer-side counterfeit check this enables: marker occurrences (2)
    // exceed count (1), so one of them was not produced by the transform.
    const occurrences = result.value.split('[scrubbed-prefix-1]').length - 1;
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
