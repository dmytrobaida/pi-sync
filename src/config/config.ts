import { DEFAULT_BRANCH, DEFAULT_PREFIX, DEFAULT_PROFILE } from "../domain/constants.js";
import { readJsonIfExists } from "../utils/json-utils.js";
import { localConfigPath, trimSlashes } from "../utils/path-utils.js";
import type { PartialConfig, SyncConfig } from "../domain/types.js";

/**
 * Load and validate complete pi-sync configuration.
 */
export async function loadConfig(): Promise<SyncConfig> {
  const partial = await loadPartialConfig();
  const repository = partial.repository;

  if (repository == null || repository === "") {
    throw new Error(
      "Missing pi-sync config: repository. Run /pisync init or set PI_SYNC_REPOSITORY.",
    );
  }

  return {
    repository,
    branch: partial.branch ?? DEFAULT_BRANCH,
    profile: partial.profile ?? DEFAULT_PROFILE,
    prefix: trimSlashes(partial.prefix ?? DEFAULT_PREFIX),
    autoSync: partial.autoSync ?? true,
  };
}

/**
 * Load config from local file and environment overrides.
 */
export async function loadPartialConfig(): Promise<PartialConfig> {
  const fileConfig = (await readJsonIfExists<PartialConfig>(localConfigPath())) ?? {};

  return {
    ...fileConfig,
    repository:
      process.env.PI_SYNC_REPOSITORY ??
      process.env.PI_SYNC_REPO ??
      fileConfig.repository,
    branch: process.env.PI_SYNC_BRANCH ?? fileConfig.branch,
    profile: process.env.PI_SYNC_PROFILE ?? fileConfig.profile,
    prefix: process.env.PI_SYNC_PREFIX ?? fileConfig.prefix,
    autoSync: process.env.PI_SYNC_AUTO_SYNC ?? fileConfig.autoSync,
  };
}

/**
 * Check whether an error represents intentionally missing configuration.
 *
 * @param error Error-like value to inspect.
 */
export function isMissingConfigError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Missing pi-sync config:")
  );
}
