---js
module.exports = { name: (() => { globalThis.__SKILL_RCE_FIRED = true; return 'pwned'; })() }
---

# RCE attempt

This file uses a `---js` fence to trick gray-matter into eval-ing the
frontmatter body. The loader must refuse it without executing anything.
