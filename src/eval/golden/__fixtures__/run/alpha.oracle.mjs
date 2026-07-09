export const oracle = (result) => ({
  pass: (result.resultText ?? '').includes('alpha'),
  reason: 'expected alpha in the reply',
});
