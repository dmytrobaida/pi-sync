/**
 * Runnable check for the include-pattern logic.
 *
 *   node check-glob.ts
 *
 * The manifest decides which local files pi-sync is allowed to touch, so a
 * pattern that silently matches nothing is a silent data-loss bug: pull would
 * delete nothing, push would upload nothing, and the file would look synced
 * while never leaving the machine. This asserts the patterns this fork is
 * configured with actually match the paths they are meant to.
 *
 * Only glob.ts is imported, because it has no internal imports: the rest of the
 * source uses .js specifiers that Node's type stripping does not rewrite, so
 * the wiring is verified end-to-end instead (see the probe in the bundle).
 */
import assert from "node:assert/strict";

import { globToRegExp, patternHead } from "./src/utils/glob.ts";

const match = (value: string, pattern: string): boolean =>
  globToRegExp(pattern).test(value);

// A directory pattern reaches files below it, at any depth.
assert.equal(match("lib/logo.ts", "lib/**"), true);
assert.equal(match("lib/nested/deep.ts", "lib/**"), true);
assert.equal(match("prose/simple-english.md", "prose/**"), true);
assert.equal(match("extensions/pi-automode/config.json", "extensions/**"), true);

// ...but not a sibling with the same prefix, which is how a typo leaks files.
assert.equal(match("library/logo.ts", "lib/**"), false);
assert.equal(match("prose-old/style.md", "prose/**"), false);

// A bare name is a top-level file, not a name anywhere in the tree.
assert.equal(match("pi-memory-extension.json", "pi-memory-extension.json"), true);
assert.equal(
  match("extensions/pi-memory-extension.json", "pi-memory-extension.json"),
  false,
);

// Single star stays inside one segment, so it cannot reach into a subdirectory.
assert.equal(match("lib/logo.ts", "lib/*"), true);
assert.equal(match("lib/nested/logo.ts", "lib/*"), false);

// Regex metacharacters in a path are literal, not active.
assert.equal(match("lib/a+b.ts", "lib/a+b.ts"), true);
assert.equal(match("lib/aab.ts", "lib/a+b.ts"), false);

// The scan uses the head to decide which directories to descend into.
assert.equal(patternHead("lib/**"), "lib");
assert.equal(patternHead("extensions/**"), "extensions");
assert.equal(patternHead("pi-memory-extension.json"), "pi-memory-extension.json");
assert.equal(patternHead("**/*.ts"), "");

console.log("check-glob: all assertions passed");
