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
