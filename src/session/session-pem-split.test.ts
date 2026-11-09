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

/** Runs one session over `runs` (one SDK stream per run() call) and collects what reached onText. */
async function emittedRuns(runs: SdkMessage[][], { redactSecrets = redact as ((t: string) => RedactResult) | null } = {}) {
  let call = 0;
  const query: QueryFn = () => {
    const messages = runs[call] ?? [];
    call += 1;
    return (async function* () {
      yield INIT;
      for (const m of messages) yield m;
      yield RESULT('done');
    })();
  };
  const deps: SessionDeps = {
    query,
    hooks: createHookRuntime(),
    memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
    loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
    route,
    scanAgents: () => ({ admittedNames: new Set(), refusals: [], filesScanned: 0 }),
    ...(redactSecrets === null ? {} : { redactSecrets }),
  };
  const perRun: string[][] = [];
  const warnings: string[] = [];
  const session = createSession(deps, { skillsDir: null, onText: (t) => perRun[perRun.length - 1]?.push(t), onWarning: (w) => warnings.push(w) });
  for (let i = 0; i < runs.length; i += 1) {
    perRun.push([]);
    await session.run('hi');
  }
  return { perRun, warnings };
}

async function emitted(messages: SdkMessage[], options: { redactSecrets?: ((t: string) => RedactResult) | null } = {}) {
  const { perRun, warnings } = await emittedRuns([messages], options);
  return { chunks: perRun[0] ?? [], warnings };
}

describe('#111: a private key split across assistant text blocks is redacted in both', () => {
  it('the issue\'s repro: header and first body line in block 1, the rest and END in block 2 after a tool call (N)', async () => {
    const { chunks, warnings } = await emitted([assistant(`part one:\n${BEGIN}\n${BODY1}`), toolUse, assistant(`part two:\n${BODY2}\n${END}`)]);
    expect(chunks).toEqual([`part one:\n${MARKER}`, `part two:\n${MARKER}\n${MARKER}`]);
    expect(warnings.some((w) => w.startsWith('secrets redacted in assistant text'))).toBe(true);
  });

  it('the body continues at the start of block 2: redacted through the fence, the prose after it kept', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant(`${BODY2}\n${END}\nThat was the key.`)]);
    expect(chunks).toEqual([MARKER, `${MARKER}\n${MARKER}\nThat was the key.`]);
  });

  it('two text blocks in ONE message carry the state too', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`, `${BODY2}\n${END}`)]);
    expect(chunks).toEqual([MARKER, `${MARKER}\n${MARKER}`]);
  });

  it('a block that is all body keeps the key open into the next block', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant(BODY2), assistant(`${BODY1}\n${END} ok`)]);
    expect(chunks).toEqual([MARKER, MARKER, `${MARKER}\n${MARKER} ok`]);
  });

  it('prose after a key that never closed is NOT swallowed: the next block is emitted as written', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant('Sorry, I should not print keys. What else can I help with?')]);
    expect(chunks).toEqual([MARKER, 'Sorry, I should not print keys. What else can I help with?']);
  });

  it('review: one prose block between the halves (a tool call each side) does not close the key (N)', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), toolUse, assistant('Let me check the file first.'), toolUse, assistant(`${BODY2}\n${END}`)]);
    expect(chunks).toEqual([MARKER, 'Let me check the file first.', `${MARKER}\n${MARKER}`]);
  });

  it('review: an empty or blank block between the halves does not close the key (N)', async () => {
    for (const blank of ['', '\n', '\n\n']) {
      const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant(blank), assistant(`${BODY2}\n${END}`)]);
      expect(chunks, JSON.stringify(blank)).toEqual([MARKER, blank, `${MARKER}\n${MARKER}`]);
    }
  });

  it('review: a quoted second half (> prefix) has its body replaced (N)', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant(`> ${BODY2}\n> ${END}`)]);
    expect(chunks).toEqual([MARKER, `> ${MARKER}\n> ${MARKER}`]);
  });

  it('three blocks of prose in a row end a key that never closed: a later key-like block is emitted as written', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant('One.'), assistant('Two.'), assistant('Three.'), assistant(BODY2)]);
    expect(chunks).toEqual([MARKER, 'One.', 'Two.', 'Three.', BODY2]);
  });

  it('review: a header mentioned in prose opens nothing, so later hashes, paths and words are emitted as written', async () => {
    const later = ['a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', '/usr/local/bin/node', 'Acknowledgements', 'Version: 1.4.2'];
    const { chunks } = await emitted([assistant(`Look for the line \`${BEGIN}\` at the top of the file.`), ...later.map((t) => assistant(t))]);
    expect(chunks.slice(1)).toEqual(later);
  });

  it('a continued block warns like any redaction, so the operator sees the second half was caught', async () => {
    const { warnings } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant(`${BODY2}\n${END}`)]);
    expect(warnings.filter((w) => w === 'secrets redacted in assistant text (1 finding(s))')).toHaveLength(2);
  });

  it('a closed key in block 1 opens nothing: block 2 body-looking text is emitted as written', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}\n${END}`), assistant(BODY2)]);
    expect(chunks).toEqual([MARKER, BODY2]);
  });

  it('review: an ENCRYPTED key split after its armour headers: the body in block 2 is replaced (N)', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0A1B2C3D4E5F60718293A4B5C6D7E8F9\n\n`), toolUse, assistant(`${BODY1}\n${BODY2}\n${END}`)]);
    expect(chunks[1]).toBe(`${MARKER}\n${MARKER}\n${MARKER}`);
  });

  it('review: a PGP key split after Version/Comment: the body in block 2 is replaced (N)', async () => {
    const pgpBegin = '-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----';
    const pgpEnd = '-----END PGP ' + 'PRIVATE KEY BLOCK-----';
    const { chunks } = await emitted([assistant(`${pgpBegin}\nVersion: GnuPG v2\nComment: test\n\n`), assistant(`${BODY1}\n=Zq8w\n${pgpEnd}`)]);
    expect(chunks[1]).not.toContain(BODY1);
    expect(chunks[1]).not.toContain('-----END');
  });

  it('review: CRLF line endings across blocks', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\r\n${BODY1}\r\n`), assistant(`${BODY2}\r\n${END}\r\nok`)]);
    expect(chunks[1]).toBe(`${MARKER}\r\n${MARKER}\r\nok`);
  });

  it('review: the state is per run: a second run() on the SAME session starts closed', async () => {
    const { perRun } = await emittedRuns([[assistant(`${BEGIN}\n${BODY1}`)], [assistant(BODY2)]]);
    expect(perRun).toEqual([[MARKER], [BODY2]]);
  });

  it('review: a redactor that fails while a key is open: the block fails closed and the key stays open for the next', async () => {
    let n = 0;
    const flaky = (t: string): RedactResult => {
      n += 1;
      if (n === 2) throw new Error('redactor down');
      return redact(t);
    };
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant(BODY2), assistant(`${BODY1}\n${END}`)], { redactSecrets: flaky });
    expect(chunks).toEqual([MARKER, '[REDACTION FAILED]', `${MARKER}\n${MARKER}`]);
  });

  it('no redactor injected: text passes raw, as before (nothing configured)', async () => {
    const { chunks } = await emitted([assistant(`${BEGIN}\n${BODY1}`), assistant(`${BODY2}\n${END}`)], { redactSecrets: null });
    expect(chunks).toEqual([`${BEGIN}\n${BODY1}`, `${BODY2}\n${END}`]);
  });
});
