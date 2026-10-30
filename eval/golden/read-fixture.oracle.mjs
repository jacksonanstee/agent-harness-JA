import { readFileSync } from 'node:fs';

// The code word is read from the fixture at run time, never written here, so
// it exists in exactly one file: a reply that names it shows a file tool read
// the fixture inside the working directory (issue #213).
const FIXTURE = new URL('./fixtures/read-fixture.txt', import.meta.url);
const CODE_WORD = (readFileSync(FIXTURE, 'utf8').split('\n')[1] ?? '').trim().toLowerCase();

/** @type {import('agent-harness-ja').OracleFn} */
export const oracle = (result) => {
  if (result.resultSubtype !== 'success') {
    return { pass: false, reason: `expected subtype success, got ${result.resultSubtype}` };
  }
  if (CODE_WORD === '') return { pass: false, reason: 'the fixture has no code word on its second line' };
  const text = (result.resultText ?? '').trim().toLowerCase();
  return text.includes(CODE_WORD)
    ? { pass: true }
    : { pass: false, reason: 'expected the fixture code word in the reply (did a file tool read the fixture?)' };
};
