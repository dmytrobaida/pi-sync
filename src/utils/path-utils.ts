import os from "node:os";
import path from "node:path";

/**
 * Join a root and relative path while rejecting path traversal escapes.
 *
 * @param root Trusted root directory.
 * @param relativePath Untrusted relative path.
 */
export function safeJoin(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);

  assertWithinRoot(root, target, relativePath);

  return target;
}

/**
 * Join path fragments with POSIX separators for Git repository paths.
 *
 * @param parts Path fragments to join.
 */
export function posixJoin(...parts: string[]): string {
  return parts
    .map((part) => trimSlashes(part))
    .filter((part) => part !== "")
    .join("/");
}

/**
 * Convert platform separators to POSIX separators.
 *
 * @param value Path string to normalize.
 */
export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Trim leading and trailing slashes from a path fragment.
 *
 * @param value Path fragment.
 */
export function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

/**
 * Return the Pi agent configuration directory.
 */
export function agentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

/**
 * Return the pi-sync local state directory.
 */
export function stateDir(): string {
  return path.join(agentDir(), ".pisync");
}

/**
 * Return the local clone directory.
 */
export function repoDir(): string {
  return path.join(stateDir(), "repo");
}

/**
 * Return the local pi-sync config file path.
 */
export function localConfigPath(): string {
  return path.join(agentDir(), "pi-sync.json");
}

/**
 * Return the local sync state file path.
 */
export function statePath(): string {
  return path.join(stateDir(), "state.json");
}

/**
 * Return the local lock file path.
 */
export function lockPath(): string {
  return path.join(stateDir(), "lock");
}

/**
 * Return the Pi agent .env file path used as the local secret store.
 */
export function agentEnvPath(): string {
  return path.join(agentDir(), ".env");
}

/**
 * Return the Pi agent auth.json path where provider API keys are stored.
 */
export function authJsonPath(): string {
  return path.join(agentDir(), "auth.json");
}

/**
 * Return the local age identity file path (never synced, keep private).
 */
export function ageIdentityPath(): string {
  return path.join(stateDir(), "age-identity.txt");
}

/**
 * Return the directory used to back up local secrets state before pull.
 */
export function secretsBackupDir(): string {
  return path.join(stateDir(), "secrets-backups");
}

function assertWithinRoot(root: string, target: string, label = target): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);

  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Unsafe path in snapshot: ${label}`);
  }
}
