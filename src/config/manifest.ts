import fs from "node:fs";

import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, EXTERNAL_FILES } from "../domain/constants.js";
import { globToRegExp, matchesGlob, patternHead } from "../utils/glob.js";
import { localConfigPath } from "../utils/path-utils.js";

/**
 * The set of local paths pi-sync manages, resolved from pi-sync.json.
 *
 * Upstream hardcodes this list in the source. The fork reads `include` and
 * `exclude` from the same config file as the repository, so a directory that is
 * not one of upstream's four (`lib`, `prose`) can be synced without editing
 * code. Entries in `include` are ADDED to the defaults; `exclude` is applied on
 * top of the built-in deny rules.
 */
export type SyncManifest = {
  include: string[];
  exclude: string[];
  includeMatchers: RegExp[];
  excludeMatchers: RegExp[];
  /** Root-level Git pathspecs covering everything in `include`. */
  pathspecs: string[];
  /** First path segments worth descending into while scanning. */
  heads: string[];
  /** Set when a pattern can match at any depth, so every directory is scanned. */
  descendAll: boolean;
};

type ManifestConfig = {
  include?: string[];
  exclude?: string[];
};

let cache: { key: string; manifest: SyncManifest } | undefined;

/**
 * Resolve the manifest, re-reading pi-sync.json when it changes on disk.
 *
 * @param configPath Path to the pi-sync config file.
 */
export function resolveManifest(
  configPath: string = localConfigPath(),
): SyncManifest {
  const key = fileKey(configPath);

  if (cache?.key === key) {
    return cache.manifest;
  }

  const manifest = buildManifest(readManifestConfig(configPath));

  cache = { key, manifest };

  return manifest;
}

/**
 * Build a manifest from config values, applying the upstream defaults.
 *
 * @param config Include and exclude entries from the config file.
 */
export function buildManifest(config: ManifestConfig): SyncManifest {
  const include = dedupe([...DEFAULT_INCLUDE, ...stringList(config.include)]);
  const exclude = dedupe([...DEFAULT_EXCLUDE, ...stringList(config.exclude)]);
  const heads = include.map(patternHead);

  return {
    include,
    exclude,
    includeMatchers: include.map(globToRegExp),
    excludeMatchers: exclude.map(globToRegExp),
    pathspecs: pathspecsFor(include),
    heads: heads.filter((head) => head !== ""),
    descendAll: heads.some((head) => head === ""),
  };
}

/**
 * Check whether a path is managed, by include pattern or as an external file.
 *
 * @param syncPath Path relative to the agent directory.
 * @param manifest Resolved manifest.
 */
export function isInManifest(
  syncPath: string,
  manifest: SyncManifest = resolveManifest(),
): boolean {
  return (
    matchesGlob(syncPath, manifest.includeMatchers) ||
    EXTERNAL_FILES.has(syncPath)
  );
}

/**
 * Check whether a path is excluded by an `exclude` pattern.
 *
 * @param syncPath Path relative to the agent directory.
 * @param manifest Resolved manifest.
 */
export function isExcludedByManifest(
  syncPath: string,
  manifest: SyncManifest = resolveManifest(),
): boolean {
  return matchesGlob(syncPath, manifest.excludeMatchers);
}

/**
 * Check whether a directory could contain an included file, so a scan can skip
 * the rest of the tree.
 *
 * @param relativeDirectory Directory path relative to the agent directory.
 * @param manifest Resolved manifest.
 */
export function shouldDescend(
  relativeDirectory: string,
  manifest: SyncManifest = resolveManifest(),
): boolean {
  if (manifest.descendAll) {
    return true;
  }

  const head = relativeDirectory.split("/")[0] ?? "";

  return manifest.heads.includes(head);
}

/**
 * Root-level Git pathspecs managed by pi-sync.
 *
 * @param manifest Resolved manifest.
 */
export function manifestPathspecs(
  manifest: SyncManifest = resolveManifest(),
): string[] {
  return [...manifest.pathspecs, ...EXTERNAL_FILES];
}

function pathspecsFor(include: readonly string[]): string[] {
  const heads = include
    .map(patternHead)
    .filter((head) => head !== "");

  return dedupe(heads);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function readManifestConfig(configPath: string): ManifestConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as ManifestConfig;
  } catch {
    // Missing or malformed config is handled by loadConfig, which reports it.
    return {};
  }
}

function fileKey(configPath: string): string {
  try {
    const stat = fs.statSync(configPath);

    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}
