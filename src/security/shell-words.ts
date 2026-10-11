/**
 * The shell's word grammar, shared by the sandbox command gate and the
 * permissions command canonicaliser so a rule and bash agree on which program
 * a command names (issues #159 and #161).
 *
 * Bash's parser splits words on blanks (space, tab) and newline whatever IFS
 * says (IFS governs splitting of expansions only). JavaScript's `\s` and
 * `trim()` also eat NBSP, U+2028, U+2029, VT, FF, U+3000 and BOM, which bash
 * keeps inside a word (NEL is not `\s`, but bash keeps it in a word too), so
 * `git<NBSP>x` read through `\s` is `git` while bash runs the program named
 * `git<NBSP>x`. Nothing in this module uses `\s`.
 *
 * A newline is a word separator for argv[0] but ends a command rather than
 * separating the words of one, so it is trimmed at the ends and never
 * collapsed into a space (`git\nstatus` is two commands, not `git status`).
 */

/** Trims spaces and tabs only. The sandbox gate uses this: it then denies a newline at either end. */
export function trimBlanks(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** Trims spaces, tabs and newlines at both ends. */
export function trimWordSeparators(value: string): string {
  return value.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
}

/** Collapses each run of spaces and tabs to one space. Newlines are left alone. */
export function collapseBlanks(value: string): string {
  return value.replace(/[ \t]+/g, ' ');
}

/**
 * argv[0] as the shell reads it: leading separators skipped, then everything
 * up to the next one.
 */
export function firstShellWord(command: string): string {
  return command.replace(/^[ \t\n]+/, '').split(/[ \t\n]/, 1)[0] ?? '';
}
