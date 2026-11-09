import { describe, expect, it } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import { redact } from '../security/index.js';
import type { RedactResult } from '../security/index.js';
import { createSession } from './session.js';
import type { QueryFn, SdkMessage, SessionDeps } from './types.js';

// Issue #111 (S-2): assistant text is redacted one block at a time, and the
// private-key rule needs its BEGIN header. A reply that starts a key, calls a
// tool, then finishes it put the body's second half and its END fence in a
// block with nothing to anchor on, so it reached onText raw. The session now
// carries an open key block from one text block to the next.

const BEGIN = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
const END = '-----END RSA ' + 'PRIVATE KEY-----';
const BODY1 = 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn' + '/ygWyF8PbnGy0AHB7MaGzZ4bU0Ij5h';
const BODY2 = 'Qx7m3yq2Lw9Gk4pH8sVd1Rn6Tc0Zb5' + 'Je2Ua7Wf3Xo9Yi4Kl8Mp1Nq6Rt0Sv2';
const MARKER = '[REDACTED:private-key-block]';

const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sdk-1', tools: [], agents: [] } as SdkMessage;
const RESULT = (text: string): SdkMessage =>
  ({ type: 'result', subtype: 'success', result: text, session_id: 'sdk-1', num_turns: 1, total_cost_usd: 0 }) as SdkMessage;
const assistant = (...texts: string[]): SdkMessage => ({ type: 'assistant', message: { content: texts.map((text) => ({ type: 'text', text })) } });
const toolUse: SdkMessage = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] } } as SdkMessage;

async function emitted(messages: SdkMessage[], { redactSecrets = redact as ((t: string) => RedactResult) | null } = {}) {
  const query: QueryFn = () =>
    (async function* () {
      yield INIT;
      for (const m of messages) yield m;
      yield RESULT('done');
    })();
  const deps: SessionDeps = {
    query,
    hooks: createHookRuntime(),
    memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
    loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
    route,
    scanAgents: () => ({ admittedNames: new Set(), refusals: [], filesScanned: 0 }),
    ...(redactSecrets === null ? {} : { redactSecrets }),
  };
  const chunks: string[] = [];
  const warnings: string[] = [];
  await createSession(deps, { skillsDir: null, onText: (t) => chunks.push(t), onWarning: (w) => warnings.push(w) }).run('hi');
  return { chunks, warnings };
}

describe('#111: a private key split across assistant text blocks is redacted in both', () => {
  it('the issue\'s repro: header and first body line in block 1, the rest and END in block 2 after a tool call (N)', async () => {
    const { chunks, warnings } = await emitted([assistant(`part one:\n${BEGIN}\n${BODY1}`), toolUse, assistant(`part two:\n${BODY2}\n${END}`)]);
    expect(chunks).toEqual([`part one:\n${MARKER}`, `part two:\n${MARKER}`]);
    expect(warnings.some((w) => w.startsWith('secrets redacted in assistant text'))).toBe(true);
  });

  it('the body continues at the start of block 2: redacted through the fence, the prose after it kept', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant(`${BODY2}\n${END}\nThat was the key.`)]);
    expect(chunks).toEqual([MARKER, `${MARKER}\nThat was the key.`]);
  });

  it('two text blocks in ONE message carry the state too', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`, `${BODY2}\n${END}`)]);
    expect(chunks).toEqual([MARKER, MARKER]);
  });

  it('a block that is all body keeps the key open into the next block', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant(BODY2), assistant(`${BODY1}\n${END} ok`)]);
    expect(chunks).toEqual([MARKER, MARKER, `${MARKER} ok`]);
  });

  it('prose after a key that never closed is NOT swallowed: the next block is emitted as written', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant('Sorry, I should not print keys. What else can I help with?')]);
    expect(chunks).toEqual([MARKER, 'Sorry, I should not print keys. What else can I help with?']);
  });

  it('prose closes a key that never closed: a later base64-looking block is emitted as written', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant('Moving on.'), assistant(BODY2)]);
    expect(chunks).toEqual([MARKER, 'Moving on.', BODY2]);
  });

  it('a continued block warns like any redaction, so the operator sees the second half was caught', async () => {
    const { warnings } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant(`${BODY2}\n${END}`)]);
    expect(warnings.filter((w) => w === 'secrets redacted in assistant text (1 finding(s))')).toHaveLength(2);
  });

  it('a closed key in block 1 opens nothing: block 2 body-looking text is emitted as written', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}\n${END}`), assistant(BODY2)]);
    expect(chunks).toEqual([MARKER, BODY2]);
  });

  it('the state is per run: a second run starts closed', async () => {
    const first = await emitted([assistant(`${BEGIN}\n${BODY1}`)]);
    const second = await emitted([assistant(BODY2)]);
    expect(first.chunks).toEqual([MARKER]);
    expect(second.chunks).toEqual([BODY2]);
  });

  it('no redactor injected: text passes raw, as before (nothing configured)', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant(`${BODY2}\n${END}`)], { redactSecrets: null });
    expect(chunks).toEqual([`${BEGIN}\n${BODY1}`, `${BODY2}\n${END}`]);
  });
});
