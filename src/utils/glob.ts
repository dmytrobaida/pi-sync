/**
 * Match a path against pi-sync include and exclude patterns.
 *
 * Supported syntax, which is all the config needs:
 *   `**` crosses path segments, `*` stays inside one, `?` is one character.
 * Everything else is literal, so `lib/**` and `pi-memory-extension.json` both
 * behave the way they read.
 */

/**
 * Convert a glob pattern into an anchored regular expression.
 *
 * @param pattern Glob pattern.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");

  return new RegExp(`^${escaped}$`);
}

/**
 * Test a path against any pattern in a list.
 *
 * @param value Path to test, with POSIX separators.
 * @param patterns Compiled patterns.
 */
export function matchesGlob(
  value: string,
  patterns: readonly RegExp[],
): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

/**
 * Return the first path segment of a pattern, or an empty string when the
 * pattern can match at any depth.
 *
 * @param pattern Glob pattern.
 */
export function patternHead(pattern: string): string {
  const head = pattern.split("/")[0] ?? "";

  return head.includes("*") || head.includes("?") ? "" : head;
}
