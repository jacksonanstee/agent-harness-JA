export const oracle = (result) => ({
  pass: result.resultSubtype === 'success',
  reason: 'checked subtype',
});
